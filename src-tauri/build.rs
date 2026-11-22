use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(root: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else { return; };
    let mut items: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|x| x.path())).collect();
    items.sort();
    for path in items {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if path.is_dir() {
            collect_files(&path, base, out);
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                let rel_unix = rel.to_string_lossy().replace('\\', "/");
                out.push((rel_unix, path));
            }
        }
    }
}

fn fnv1a_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let project_root = manifest_dir.parent().unwrap();

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(&project_root.join("engine"), project_root, &mut files);
    collect_files(&project_root.join("ui"), project_root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash: u64 = 0xcbf29ce484222325;
    if let Ok(pkg_ver) = env::var("CARGO_PKG_VERSION") {
        hash = fnv1a_update(hash, pkg_ver.as_bytes());
    }
    let mut code = String::new();
    code.push_str("pub static EMBEDDED_FILES: &[(&str, &[u8])] = &[\n");

    for (rel, abs) in &files {
        println!("cargo:rerun-if-changed={}", abs.display());
        if let Ok(data) = fs::read(abs) {
            hash = fnv1a_update(hash, rel.as_bytes());
            hash = fnv1a_update(hash, &data);
        }
        let abs_escaped = abs.to_string_lossy().replace('\\', "\\\\");
        code.push_str(&format!(
            "    ({:?}, include_bytes!(\"{}\")),\n",
            rel, abs_escaped
        ));
    }
    code.push_str("];\n");
    code.push_str(&format!("pub const RUNTIME_HASH: &str = \"{:016x}\";\n", hash));

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out_dir.join("embedded_runtime.rs"), code).expect("write embedded_runtime.rs");

    println!("cargo:rerun-if-changed={}", project_root.join("engine").display());
    println!("cargo:rerun-if-changed={}", project_root.join("ui").display());

    // Register AppManifest permissions for all custom desktop commands so
    // Tauri v2.12+ authorizes them cleanly from http://127.0.0.1:<port>.
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "win_minimize",
        "win_toggle_maximize",
        "win_close",
        "win_hide_to_tray",
        "win_start_dragging",
        "win_ready_show",
        "get_boot_status",
        "retry_engine_boot",
        "app_quit",
        "get_engine_info",
        "update_hotkeys",
        "set_window_theme",
        "apply_staged_update",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to build Tauri v2 metadata");
}

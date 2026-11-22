#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, State, Theme, Window, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_runtime.rs"));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HotkeyConfig {
    #[serde(default = "default_toggle_hk")]
    toggle: String,
    #[serde(default = "default_add1m_hk")]
    add1m: String,
    #[serde(default = "default_add5m_hk")]
    add5m: String,
}

fn default_toggle_hk() -> String {
    "Ctrl+Shift+Space".to_string()
}
fn default_add1m_hk() -> String {
    "Ctrl+Shift+Up".to_string()
}
fn default_add5m_hk() -> String {
    "Ctrl+Shift+Right".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            toggle: default_toggle_hk(),
            add1m: default_add1m_hk(),
            add5m: default_add5m_hk(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ListenEvent {
    event: Option<String>,
    port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
struct BootStatus {
    state: String,
    url: String,
    error: String,
}

impl Default for BootStatus {
    fn default() -> Self {
        Self {
            state: "booting".to_string(),
            url: String::new(),
            error: String::new(),
        }
    }
}

#[derive(Debug, Serialize)]
struct EngineInfo {
    port: u16,
    url: String,
}

struct SharedEngine {
    port: AtomicU16,
    shown: AtomicBool,
    is_dark: AtomicBool,
    child: Mutex<Option<Child>>,
    boot: Mutex<BootStatus>,
}

impl SharedEngine {
    fn new() -> Self {
        Self {
            port: AtomicU16::new(0),
            shown: AtomicBool::new(false),
            is_dark: AtomicBool::new(true),
            child: Mutex::new(None),
            boot: Mutex::new(BootStatus::default()),
        }
    }

    fn set_booting(&self) {
        self.port.store(0, Ordering::SeqCst);
        if let Ok(mut b) = self.boot.lock() {
            *b = BootStatus::default();
        }
    }

    fn set_ready(&self, port: u16, url: String) {
        self.port.store(port, Ordering::SeqCst);
        if let Ok(mut b) = self.boot.lock() {
            b.state = "ready".to_string();
            b.url = url;
            b.error.clear();
        }
    }

    fn set_error(&self, msg: String) {
        if let Ok(mut b) = self.boot.lock() {
            b.state = "error".to_string();
            b.error = msg;
        }
    }

    fn get_boot(&self) -> BootStatus {
        self.boot.lock().map(|b| b.clone()).unwrap_or_default()
    }

    fn kill_child(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct AppState {
    engine: Arc<SharedEngine>,
}

fn bg_color_for(dark: bool) -> Color {
    if dark {
        Color(11, 11, 13, 255) // #0b0b0d (exact --canvas dark)
    } else {
        Color(245, 245, 247, 255) // #f5f5f7 (exact --canvas light)
    }
}

fn show_main_window_once(app: &AppHandle, engine: &SharedEngine) {
    if !engine.shown.swap(true, Ordering::SeqCst) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

// ------------------------------------------------ Native Window Commands ----

#[tauri::command]
fn win_ready_show(app: AppHandle, state: State<'_, AppState>) {
    show_main_window_once(&app, &state.engine);
}

#[tauri::command]
fn win_minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_toggle_maximize(window: Window) -> bool {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

#[tauri::command]
fn win_hide_to_tray(window: Window) {
    let _ = window.hide();
}

#[tauri::command]
fn win_close(app: AppHandle, window: Window, state: State<'_, AppState>, onboarding: Option<bool>) {
    let in_onboarding = onboarding.unwrap_or(false);
    let hide_mode = !in_onboarding && load_registry_close_to_tray();
    if hide_mode && state.engine.port.load(Ordering::SeqCst) > 0 {
        let _ = window.hide();
    } else {
        let port = state.engine.port.load(Ordering::SeqCst);
        if port > 0 {
            post_local_json(port, "/api/app/flush", "{}");
        }
        state.engine.kill_child();
        app.exit(0);
    }
}

#[tauri::command]
fn win_start_dragging(window: Window) {
    let _ = window.start_dragging();
}

#[tauri::command]
fn set_window_theme(window: Window, state: State<'_, AppState>, dark: bool) {
    state.engine.is_dark.store(dark, Ordering::SeqCst);
    let _ = window.set_background_color(Some(bg_color_for(dark)));
}

#[tauri::command]
fn get_boot_status(state: State<'_, AppState>) -> BootStatus {
    state.engine.get_boot()
}

#[tauri::command]
fn retry_engine_boot(app: AppHandle, state: State<'_, AppState>) {
    state.engine.kill_child();
    state.engine.set_booting();
    spawn_local_engine(app, Arc::clone(&state.engine));
}

#[tauri::command]
fn app_quit(app: AppHandle, state: State<'_, AppState>) {
    let port = state.engine.port.load(Ordering::SeqCst);
    if port > 0 {
        post_local_json(port, "/api/app/flush", "{}");
    }
    state.engine.kill_child();
    app.exit(0);
}

#[tauri::command]
fn get_engine_info(state: State<'_, AppState>) -> EngineInfo {
    let port = state.engine.port.load(Ordering::SeqCst);
    EngineInfo {
        port,
        url: if port > 0 {
            format!("http://127.0.0.1:{}", port)
        } else {
            String::new()
        },
    }
}

#[tauri::command]
fn update_hotkeys(app: AppHandle, state: State<'_, AppState>, hotkeys: HotkeyConfig) -> Result<(), String> {
    register_hotkeys(&app, Arc::clone(&state.engine), &hotkeys);
    Ok(())
}

/// Atomically self-update standalone Stream Timer.exe on Windows from a SHA-256 verified staged binary.
#[tauri::command]
fn apply_staged_update(app: AppHandle, state: State<'_, AppState>, staged_path: String) -> Result<(), String> {
    let updates_dir = app_data_root().join("updates");
    let canon_dir = std::fs::canonicalize(&updates_dir)
        .map_err(|e| format!("Updates folder not found: {}", e))?;
    let canon_staged = std::fs::canonicalize(&staged_path)
        .map_err(|e| format!("Staged update file not found: {}", e))?;
    if !canon_staged.starts_with(&canon_dir) || !canon_staged.is_file() {
        return Err("Invalid staged update path".to_string());
    }

    let cur_exe = std::env::current_exe().map_err(|e| format!("Cannot resolve current executable: {}", e))?;
    let old_exe = cur_exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old_exe);

    std::fs::rename(&cur_exe, &old_exe)
        .map_err(|e| format!("Failed staging previous binary: {}", e))?;

    if let Err(err) = std::fs::copy(&canon_staged, &cur_exe) {
        // Instant rollback if copy fails!
        let _ = std::fs::rename(&old_exe, &cur_exe);
        return Err(format!("Failed writing updated binary: {}", err));
    }

    let _ = std::fs::remove_file(&canon_staged);
    let port = state.engine.port.load(Ordering::SeqCst);
    if port > 0 {
        post_local_json(port, "/api/app/flush", "{}");
    }
    state.engine.kill_child();

    // Signal the new instance to wait briefly so this process fully releases WebView2 & port 47120
    let _ = Command::new(&cur_exe)
        .env("STREAM_TIMER_RELAUNCH_WAIT", "1")
        .spawn();
    app.exit(0);
    Ok(())
}

// ------------------------------------------------ Registry & Preferences ----

fn app_data_root() -> PathBuf {
    std::env::var("STREAM_TIMER_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("LOCALAPPDATA")
                .ok()
                .map(|d| PathBuf::from(d).join("StreamTimer"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("StreamTimer"))
}

fn read_registry_json() -> Option<serde_json::Value> {
    let path = app_data_root().join("registry.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw).ok()
}

fn load_saved_hotkeys() -> HotkeyConfig {
    if let Some(val) = read_registry_json() {
        if let Some(hk) = val.get("hotkeys") {
            if let Ok(cfg) = serde_json::from_value::<HotkeyConfig>(hk.clone()) {
                return cfg;
            }
        }
    }
    HotkeyConfig::default()
}

fn load_registry_close_to_tray() -> bool {
    read_registry_json()
        .and_then(|v| v.get("closeToTray").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

fn resolve_initial_dark_mode(system_theme: Option<Theme>) -> bool {
    if let Some(val) = read_registry_json() {
        if let Some(mode) = val.get("appearance").and_then(|s| s.as_str()) {
            if mode == "dark" {
                return true;
            }
            if mode == "light" {
                return false;
            }
        }
    }
    matches!(system_theme, Some(Theme::Dark))
}

// ------------------------------------------------ Local Loopback HTTP -------

fn post_local_json(port: u16, path: &str, json_body: &str) {
    if port == 0 {
        return;
    }
    let path = path.to_string();
    let body = json_body.to_string();
    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{}", port);
        if let Ok(mut stream) = TcpStream::connect(&addr) {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let req = format!(
                "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                path,
                port,
                body.len(),
                body
            );
            let _ = stream.write_all(req.as_bytes());
            let _ = stream.flush();
        }
    });
}

fn trigger_timer_toggle(engine: &SharedEngine) {
    post_local_json(engine.port.load(Ordering::SeqCst), "/api/command/toggle", "{}");
}

fn trigger_timer_add_ms(engine: &SharedEngine, amount_ms: i64) {
    let payload = format!(r#"{{"type":"add","amountMs":{}}}"#, amount_ms);
    post_local_json(engine.port.load(Ordering::SeqCst), "/api/command", &payload);
}

// ------------------------------------------------ Global Shortcuts ----------

fn normalize_shortcut(raw: &str) -> String {
    raw.split('+')
        .map(|part| {
            let t = part.trim();
            match t.to_ascii_lowercase().as_str() {
                "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => "Control".to_string(),
                "cmd" | "command" | "meta" | "super" | "win" => "Super".to_string(),
                "alt" | "option" => "Alt".to_string(),
                "shift" => "Shift".to_string(),
                "up" | "arrowup" => "ArrowUp".to_string(),
                "down" | "arrowdown" => "ArrowDown".to_string(),
                "left" | "arrowleft" => "ArrowLeft".to_string(),
                "right" | "arrowright" => "ArrowRight".to_string(),
                "space" | "spacebar" => "Space".to_string(),
                "enter" | "return" => "Enter".to_string(),
                "esc" | "escape" => "Escape".to_string(),
                "tab" => "Tab".to_string(),
                other if other.len() == 1 && other.chars().all(|c| c.is_ascii_alphabetic()) => {
                    format!("Key{}", other.to_ascii_uppercase())
                }
                other if other.len() == 1 && other.chars().all(|c| c.is_ascii_digit()) => {
                    format!("Digit{}", other)
                }
                _ => t.to_string(),
            }
        })
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn register_single_shortcut(
    app: &AppHandle,
    spec: &str,
    action: impl Fn() + Send + Sync + 'static,
) {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return;
    }
    let normalized = normalize_shortcut(trimmed);
    let parsed = Shortcut::from_str(&normalized).or_else(|_| Shortcut::from_str(trimmed));
    if let Ok(sc) = parsed {
        let _ = app.global_shortcut().on_shortcut(sc, move |_app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                action();
            }
        });
    }
}

fn register_hotkeys(app: &AppHandle, engine: Arc<SharedEngine>, cfg: &HotkeyConfig) {
    let _ = app.global_shortcut().unregister_all();

    {
        let eng = Arc::clone(&engine);
        register_single_shortcut(app, &cfg.toggle, move || trigger_timer_toggle(&eng));
    }
    {
        let eng = Arc::clone(&engine);
        register_single_shortcut(app, &cfg.add1m, move || trigger_timer_add_ms(&eng, 60_000));
    }
    {
        let eng = Arc::clone(&engine);
        register_single_shortcut(app, &cfg.add5m, move || trigger_timer_add_ms(&eng, 300_000));
    }
}

// ------------------------------------------------ Standalone Runtime --------

fn resolve_node_binary() -> PathBuf {
    if let Ok(explicit) = std::env::var("STREAM_TIMER_NODE_BIN") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join("node.exe");
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    let candidates = [
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
    ];
    for c in candidates {
        if c.is_file() {
            return c;
        }
    }
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app).join("Programs").join("nodejs").join("node.exe");
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("node")
}

/// Extract embedded engine/ and ui/ assets to %LOCALAPPDATA%\StreamTimer\runtime\<hash>\
/// so Stream Timer.exe works 100% standalone from Downloads, Desktop, or any folder.
fn ensure_embedded_runtime() -> Result<(PathBuf, PathBuf), String> {
    let runtime_root = app_data_root()
        .join("runtime")
        .join(embedded::RUNTIME_HASH);
    let marker = runtime_root.join(".ready");
    let main_js = runtime_root.join("engine").join("main.js");

    if marker.is_file() && main_js.is_file() {
        return Ok((runtime_root, main_js));
    }

    std::fs::create_dir_all(&runtime_root)
        .map_err(|e| format!("Failed to prepare local runtime directory: {}", e))?;

    for (rel, bytes) in embedded::EMBEDDED_FILES {
        let dest = runtime_root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed creating {}: {}", parent.display(), e))?;
        }
        std::fs::write(&dest, bytes)
            .map_err(|e| format!("Failed extracting {}: {}", rel, e))?;
    }

    let pkg_path = runtime_root.join("package.json");
    let pkg_json = format!(
        r#"{{"name":"stream-timer-runtime","version":"{}","private":true,"type":"module"}}"#,
        env!("CARGO_PKG_VERSION")
    );
    std::fs::write(&pkg_path, pkg_json)
        .map_err(|e| format!("Failed writing runtime package.json: {}", e))?;

    std::fs::write(&marker, embedded::RUNTIME_HASH)
        .map_err(|e| format!("Failed finalizing runtime marker: {}", e))?;

    Ok((runtime_root, main_js))
}

fn resolve_engine_script(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let mut local_roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            local_roots.push(dir.to_path_buf());
        }
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        local_roots.push(res_dir.clone());
        local_roots.push(res_dir.join("_up_"));
    }
    for root in local_roots {
        let candidate = root.join("engine").join("main.js");
        if candidate.is_file() && root.join("ui").join("index.html").is_file() {
            return Ok((root, candidate));
        }
    }

    ensure_embedded_runtime()
}

fn report_boot_error(app: &AppHandle, engine: &SharedEngine, msg: &str) {
    engine.set_error(msg.to_string());
    show_main_window_once(app, engine);
    if let Some(win) = app.get_webview_window("main") {
        let escaped = serde_json::to_string(msg).unwrap_or_else(|_| "\"Startup failed\"".into());
        let _ = win.eval(&format!("window.__setBootError && window.__setBootError({});", escaped));
    }
}

fn spawn_local_engine(app: AppHandle, engine: Arc<SharedEngine>) {
    std::thread::spawn(move || {
        let (work_dir, script_path) = match resolve_engine_script(&app) {
            Ok(pair) => pair,
            Err(err) => {
                report_boot_error(&app, &engine, &err);
                return;
            }
        };

        let node_bin = resolve_node_binary();
        let mut cmd = Command::new(&node_bin);
        cmd.arg(&script_path)
            .current_dir(&work_dir)
            .env("STREAM_TIMER_HOST", "127.0.0.1")
            .env("STREAM_TIMER_PORT", "47120")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(err) => {
                report_boot_error(
                    &app,
                    &engine,
                    &format!("Failed to launch Node.js v24 runtime ({}): {}", node_bin.display(), err),
                );
                return;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Ok(mut guard) = engine.child.lock() {
            *guard = Some(child);
        }

        let last_err = Arc::new(Mutex::new(String::new()));
        if let Some(err_pipe) = stderr {
            let err_buf = Arc::clone(&last_err);
            std::thread::spawn(move || {
                let reader = BufReader::new(err_pipe);
                for line in reader.lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        if let Ok(mut g) = err_buf.lock() {
                            *g = line.clone();
                        }
                    }
                    eprintln!("[engine] {}", line);
                }
            });
        }

        let mut navigated = false;
        if let Some(out_pipe) = stdout {
            let reader = BufReader::new(out_pipe);
            for line in reader.lines().map_while(Result::ok) {
                if !navigated {
                    if let Ok(ev) = serde_json::from_str::<ListenEvent>(&line) {
                        if ev.event.as_deref() == Some("listen") {
                            if let Some(port) = ev.port {
                                let theme_param = if engine.is_dark.load(Ordering::SeqCst) {
                                    "dark"
                                } else {
                                    "light"
                                };
                                let target_url = format!(
                                    "http://127.0.0.1:{}/?desktop=1&theme={}",
                                    port, theme_param
                                );
                                engine.set_ready(port, target_url.clone());
                                navigated = true;

                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.eval(&format!(
                                        "window.location.replace({});",
                                        serde_json::to_string(&target_url).unwrap()
                                    ));
                                }

                                let saved = load_saved_hotkeys();
                                register_hotkeys(&app, Arc::clone(&engine), &saved);
                            }
                        }
                    }
                }
            }
        }

        if !navigated {
            let detail = last_err.lock().map(|s| s.clone()).unwrap_or_default();
            let msg = if detail.is_empty() {
                "Local Node.js v24 engine exited before listening. Verify Node.js v24+ is installed.".to_string()
            } else {
                format!("Local engine failed to start: {}", detail)
            };
            report_boot_error(&app, &engine, &msg);
        }
    });
}

// ------------------------------------------------ System Tray Setup ---------

fn build_tray(app: &AppHandle, engine: Arc<SharedEngine>) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show Stream Timer", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let toggle_item = MenuItem::with_id(app, "toggle", "Pause / Resume Timer", true, None::<&str>)?;
    let add1_item = MenuItem::with_id(app, "add1m", "Add +1 min", true, None::<&str>)?;
    let add5_item = MenuItem::with_id(app, "add5m", "Add +5 min", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Stream Timer", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&show_item, &sep1, &toggle_item, &add1_item, &add5_item, &sep2, &quit_item],
    )?;

    let tray_icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let eng_menu = Arc::clone(&engine);
    TrayIconBuilder::with_id("stream-timer-tray")
        .icon(tray_icon)
        .tooltip("Stream Timer — Local OBS & Creator Studio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "toggle" => trigger_timer_toggle(&eng_menu),
            "add1m" => trigger_timer_add_ms(&eng_menu, 60_000),
            "add5m" => trigger_timer_add_ms(&eng_menu, 300_000),
            "quit" => {
                eng_menu.kill_child();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

// ------------------------------------------------ Main Entrypoint -----------

fn main() {
    // When relaunching right after a self-update, wait cleanly until Windows releases the
    // previous process's image handle (.exe.old) so WebView2 user-data-dir & port 47120 are free.
    let is_relaunch = std::env::var_os("STREAM_TIMER_RELAUNCH_WAIT").is_some();
    if let Ok(cur_exe) = std::env::current_exe() {
        let old_exe = cur_exe.with_extension("exe.old");
        if old_exe.is_file() {
            let max_tries = if is_relaunch { 40 } else { 5 };
            for _ in 0..max_tries {
                if std::fs::remove_file(&old_exe).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    if is_relaunch {
        std::thread::sleep(Duration::from_millis(200));
    }

    let shared_engine = Arc::new(SharedEngine::new());
    let engine_for_setup = Arc::clone(&shared_engine);
    let engine_for_close = Arc::clone(&shared_engine);
    let engine_for_exit = Arc::clone(&shared_engine);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            engine: Arc::clone(&shared_engine),
        })
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_hide_to_tray,
            win_start_dragging,
            win_ready_show,
            set_window_theme,
            get_boot_status,
            retry_engine_boot,
            app_quit,
            get_engine_info,
            update_hotkeys,
            apply_staged_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Match native HWND background to resolved Light/Dark theme BEFORE showing (0 ms white flash)
            if let Some(win) = app.get_webview_window("main") {
                let dark = resolve_initial_dark_mode(win.theme().ok());
                engine_for_setup.is_dark.store(dark, Ordering::SeqCst);
                let _ = win.set_background_color(Some(bg_color_for(dark)));
            }

            // Failsafe: show window after 350ms even if WebView2 hasn't invoked win_ready_show yet
            {
                let h = handle.clone();
                let eng = Arc::clone(&engine_for_setup);
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(350));
                    show_main_window_once(&h, &eng);
                });
            }

            build_tray(&handle, Arc::clone(&engine_for_setup))?;
            spawn_local_engine(handle, Arc::clone(&engine_for_setup));
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if engine_for_close.port.load(Ordering::SeqCst) > 0 && load_registry_close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    engine_for_close.kill_child();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Stream Timer desktop application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            engine_for_exit.kill_child();
        }
    });
}

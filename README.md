# Stream Timer

Apple-grade, 100% local native Windows Subathon Countdown Timer, Multi-Platform Donation Hub, and Creator Revenue Accounting Studio.

Built with **Tauri v2 (Rust + WebView2)** and an embedded **Node 24 + SQLite WAL** local engine — single-file standalone binary (`~5 MB`), zero external servers, zero subscription fees, and built-in automatic updates.

## Download
Download the latest standalone Windows executable (`Stream-Timer.exe`) from [**GitHub Releases**](https://github.com/AyoSan12/stream-timer-desktop/releases/latest).

> All profiles, SQLite databases, timer rules, and financial archives live safely in `%LOCALAPPDATA%\StreamTimer\`. Updating the app never touches your local data.

## Highlights
- **Native Windows Apple Experience**: Unified single 52 px frameless toolbar, zero-flash adaptive Light/Dark mode, Windows System Tray, Global Keyboard Shortcuts (works during fullscreen games), and 8 full UI languages (`EN`, `ID`, `JA`, `KO`, `ZH-CN`, `ZH-TW`, `ES`, `PT-BR`).
- **6-Step Setup Assistant & Multi-Profile Switcher**: Isolated SQLite WAL database per profile, custom operating currency (166 live auto-updating FX rates), and portable `.stbackup` export/import.
- **15 Global & Regional Donation Gateways**:
  - *Zero-tunnel Local WebSockets*: Streamlabs, StreamElements (Astro), Trakteer (Pusher), TipeeeStream, DonationAlerts (Centrifugo), Naver Chzzk (Live Chat Cheese).
  - *1-Click Cloudflare Tunnel Webhooks*: Tako.id, Saweria, SociaBuzz, Ko-fi, Buy Me a Coffee, Tiltify v5, LivePix (PIX), ECPay, Doneru/OFUSE.
- **Zero-Drift Timer & OBS Browser Source**: Integer-millisecond monotonic deadlines with `BEGIN IMMEDIATE` ACID receipts and real-time SSE sync to OBS (`/source`).
- **Creator Finance Suite**: Gross revenue, itemized platform cuts & gateway fees, net take-home, non-destructive session resets, forensic search, and 5 export formats (`.xlsx`, `.csv`, `.json`, `.md`, Print/PDF).
- **Built-In Auto-Updater**: Automatic background checks against GitHub Releases, SHA-256 verification, automatic pre-update `.stbackup` snapshots, stream-safe guard (never restarts while live or attached to OBS), and atomic Windows self-swap.

## Development & Releases
```bash
# Run full automated test suite (Model + SQLite WAL Engine + Playwright UI)
npm test

# Start local engine directly
npm run engine

# Publish a new version (tags, builds, generates latest.json, uploads GitHub Release)
npm run release -- --version 1.0.1 --notes "Release summary"
```

Pushing any `v*` tag (e.g. `git tag v1.0.1 && git push origin v1.0.1`) also triggers the automated GitHub Actions release pipeline in `.github/workflows/release.yml`.

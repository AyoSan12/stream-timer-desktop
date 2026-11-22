# Stream Timer

100% local native Windows Subathon Countdown Timer, Multi-Platform Donation Hub, and Creator Revenue Accounting Studio.

Built with **Tauri v2 (Rust + WebView2)** and an embedded **Node 24 + SQLite WAL** local engine, zero external servers, zero subscription fees, and built-in automatic updates.

## Download
Download from [**GitHub Releases**](https://github.com/AyoSan12/stream-timer-desktop/releases/latest):
- **`Stream-Timer-Setup.exe`** *(Recommended)*, 1-click Windows Installer with **bundled Node 24**, Start Menu & Desktop shortcuts, and zero prerequisites. Ideal for sharing with friends.
- **`Stream-Timer.exe`**, Lightweight portable executable (`~5.1 MB`, requires Node.js 22.5+ / 24 on the PC).

> All profiles, SQLite databases, timer rules, and financial archives live safely in `%LOCALAPPDATA%\StreamTimer\`. Updating the app never touches your local data.

## Highlights
- **Native Windows Desktop Experience**: Unified 7-tab frameless toolbar (`Home | Timer | Donations | Finance | OBS | Integrations | Settings`), zero-flash adaptive Light/Dark mode, Windows System Tray, Global Keyboard Shortcuts, and 8 full UI languages (`EN`, `ID`, `JA`, `KO`, `ZH-CN`, `ZH-TW`, `ES`, `PT-BR`).
- **6-Step Setup Assistant & Multi-Profile Switcher**: Isolated SQLite WAL database per profile, custom operating currency (166 live auto-updating FX rates), and portable `.stbackup` export/import.
- **4-Layer YouTube Membership Smart Matching**: Automatic matching across capitalization, emojis, Unicode, saved aliases, and safe typo guards, plus zero-drop live fallback and 1-click auto-detected tier mapping with retroactive Finance & timer updates.
- **15 Global & Regional Donation Gateways**:
  - *Zero-tunnel Local WebSockets*: Streamlabs, StreamElements (Astro), Trakteer (Pusher), TipeeeStream, DonationAlerts (Centrifugo), Naver Chzzk (Live Chat Cheese).
  - *1-Click Cloudflare Tunnel Webhooks*: Tako.id, Saweria, SociaBuzz, Ko-fi, Buy Me a Coffee, Tiltify v5, LivePix (PIX), ECPay, Doneru/OFUSE.
- **Zero-Drift Timer & OBS Browser Source**: Integer-millisecond monotonic deadlines with `BEGIN IMMEDIATE` ACID receipts, unified `Controls | Donation Tiers | Triggers` workspace, and automatic OBS Browser Source refresh after updates.
- **Creator Finance Suite**: Gross revenue, itemized platform cuts & gateway fees, net take-home, non-destructive session resets, forensic search, and 5 export formats (`.xlsx`, `.csv`, `.json`, `.md`, Print/PDF).
- **Built-In Auto-Updater**: Automatic background checks against GitHub Releases, SHA-256 verification, automatic pre-update `.stbackup` snapshots, SQLite WAL checkpoints, and seamless Windows self-swap (works even while OBS Browser Source stays connected).

## Development & Releases
```bash
# Run full automated test suite (Model + SQLite WAL Engine + Playwright UI)
npm test

# Start local engine directly
npm run engine

# Build Windows Installer (Stream-Timer-Setup.exe) + Portable Binary (Stream Timer.exe)
npm run build:installer
```

Pushing any `v*` tag (e.g. `git tag v1.0.6 && git push origin v1.0.6`) also triggers the automated GitHub Actions release pipeline in `.github/workflows/release.yml`.

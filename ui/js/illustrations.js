// Crisp Apple-style inline SVG illustrations for Onboarding & Setup Guides.
// Automatically adapts to Light & Dark Mode via CSS custom properties.

export const APP_MARK_SVG = `
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="13.2" r="7.8"/>
  <path d="M12 9.2v4l2.7 1.6"/>
  <path d="M9.5 2.4h5"/>
  <path d="M17.8 6.4l1.4-1.4"/>
</svg>`;

export const STREAMLABS_GUIDE_SVG = `
<svg viewBox="0 0 540 164" fill="none" xmlns="http://www.w3.org/2000/svg" class="guide-svg" role="img" aria-label="Visual guide: Streamlabs Dashboard -> Settings -> API Settings -> API Tokens -> Copy Socket API Token">
  <rect x="1" y="1" width="538" height="162" rx="16" fill="var(--surface)" stroke="var(--border-soft)" stroke-width="1.5"/>
  <!-- Top macOS-like bar -->
  <rect x="1" y="1" width="538" height="28" rx="16" fill="var(--bg)"/>
  <line x1="1" y1="29" x2="539" y2="29" stroke="var(--border-soft)"/>
  <circle cx="18" cy="15" r="4" fill="#ff5f57"/>
  <circle cx="31" cy="15" r="4" fill="#febc2e"/>
  <circle cx="44" cy="15" r="4" fill="#28c840"/>
  <text x="270" y="19" text-anchor="middle" fill="var(--muted)" font-size="10.5" font-family="-apple-system, Inter, sans-serif" font-weight="600">streamlabs.com/dashboard  →  Settings  →  API Settings  →  API Tokens</text>

  <!-- Sidebar panel (Step 1) -->
  <rect x="14" y="40" width="118" height="110" rx="10" fill="var(--bg)" stroke="var(--border-soft)"/>
  <text x="26" y="59" fill="var(--muted)" font-size="9.5" font-weight="600" font-family="Inter, sans-serif">ACCOUNT</text>
  <rect x="22" y="68" width="102" height="22" rx="6" fill="var(--surface)"/>
  <text x="32" y="82" fill="var(--muted)" font-size="10.5" font-family="Inter, sans-serif">Alert Box</text>
  <rect x="22" y="96" width="102" height="24" rx="6" fill="rgba(0, 113, 227, 0.14)" stroke="#0071e3" stroke-width="1.3"/>
  <text x="32" y="111.5" fill="#0071e3" font-size="10.5" font-weight="700" font-family="Inter, sans-serif">1. Settings</text>
  <rect x="22" y="125" width="102" height="18" rx="5" fill="var(--surface)"/>
  <text x="32" y="137" fill="var(--fg-2)" font-size="9.5" font-weight="600" font-family="Inter, sans-serif">→ API Settings</text>

  <!-- Main API Tokens panel (Step 2 & 3) -->
  <rect x="146" y="40" width="380" height="110" rx="10" fill="var(--bg)" stroke="var(--border-soft)"/>
  <!-- Tabs -->
  <rect x="158" y="50" width="84" height="22" rx="6" fill="var(--surface)"/>
  <text x="200" y="64" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="Inter, sans-serif">OAuth Clients</text>
  <rect x="248" y="50" width="96" height="22" rx="6" fill="rgba(0, 113, 227, 0.14)" stroke="#0071e3" stroke-width="1.3"/>
  <text x="296" y="64" text-anchor="middle" fill="#0071e3" font-size="10" font-weight="700" font-family="Inter, sans-serif">2. API Tokens</text>

  <!-- Token field + Copy CTA -->
  <text x="160" y="92" fill="var(--fg)" font-size="10.5" font-weight="600" font-family="Inter, sans-serif">Your Socket API Token</text>
  <rect x="158" y="99" width="268" height="32" rx="8" fill="var(--surface)" stroke="var(--border)"/>
  <text x="170" y="119" fill="var(--muted)" font-size="11" font-family="JetBrains Mono, monospace">eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...</text>
  <rect x="434" y="99" width="80" height="32" rx="16" fill="#0071e3"/>
  <text x="474" y="119" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="600" font-family="Inter, sans-serif">3. Copy</text>
</svg>`;

export const OBS_GUIDE_SVG = `
<svg viewBox="0 0 540 120" fill="none" xmlns="http://www.w3.org/2000/svg" class="guide-svg" role="img" aria-label="OBS Browser Source setup diagram">
  <rect x="1" y="1" width="538" height="118" rx="16" fill="var(--surface)" stroke="var(--border-soft)" stroke-width="1.5"/>
  <rect x="18" y="20" width="144" height="80" rx="10" fill="var(--bg)" stroke="var(--border-soft)"/>
  <text x="32" y="42" fill="var(--muted)" font-size="10" font-weight="600" font-family="Inter, sans-serif">1. OBS SOURCES</text>
  <rect x="30" y="52" width="120" height="28" rx="7" fill="rgba(0,113,227,0.12)" stroke="#0071e3"/>
  <text x="90" y="70" text-anchor="middle" fill="#0071e3" font-size="11" font-weight="600" font-family="Inter, sans-serif">+ Browser Source</text>

  <path d="M172 60h22" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M189 55l5 5-5 5" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>

  <rect x="204" y="20" width="170" height="80" rx="10" fill="var(--bg)" stroke="var(--border-soft)"/>
  <text x="218" y="42" fill="var(--muted)" font-size="10" font-weight="600" font-family="Inter, sans-serif">2. PASTE LOCAL URL</text>
  <rect x="216" y="52" width="146" height="28" rx="7" fill="var(--surface)" stroke="var(--border)"/>
  <text x="224" y="70" fill="var(--fg)" font-size="9.5" font-family="JetBrains Mono, monospace">127.0.0.1/source?token=…</text>

  <path d="M384 60h22" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M401 55l5 5-5 5" stroke="var(--muted)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>

  <rect x="416" y="20" width="106" height="80" rx="10" fill="#000000"/>
  <text x="469" y="46" text-anchor="middle" fill="#2997ff" font-size="9" font-weight="700" font-family="Inter, sans-serif">STREAM TIMER</text>
  <text x="469" y="72" text-anchor="middle" fill="#ffffff" font-size="16" font-weight="700" font-family="JetBrains Mono, monospace">02:45:00</text>
  <text x="469" y="88" text-anchor="middle" fill="#30d158" font-size="9" font-weight="600" font-family="Inter, sans-serif">0 ms Drift</text>
</svg>`;

// Self-healing SSE + authoritative fallback timer link.

import { applySnapshot } from './timer-client.js';

export function createTimerLink({
  streamUrl = '/api/stream',
  stateUrl = '/api/state',
  onFrame,
  onFreshness,
  onOverlay,
  onActivity,
  onProfileChanged,
}) {
  let current = null;
  let es = null;
  let fresh = false;
  let stopped = false;
  let pollTimer = null;

  function setFresh(next) {
    if (fresh === next) return;
    fresh = next;
    if (typeof onFreshness === 'function') onFreshness(fresh);
  }

  function ingestState(snap) {
    if (!snap || typeof snap.revision !== 'number') return;
    current = applySnapshot(current, snap, performance.now());
    setFresh(true);
    if (typeof onFrame === 'function') onFrame(current);
  }

  async function refresh() {
    try {
      const res = await fetch(stateUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 200) {
        ingestState(await res.json());
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function resetAnchor() {
    current = null;
  }

  function start() {
    if (stopped) return;
    if (es) { try { es.close(); } catch { /* ignore */ } }
    es = new EventSource(streamUrl);
    es.addEventListener('state', (ev) => {
      try { ingestState(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener('overlay', (ev) => {
      try { if (typeof onOverlay === 'function') onOverlay(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener('activity', (ev) => {
      try { if (typeof onActivity === 'function') onActivity(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.addEventListener('profile_changed', (ev) => {
      current = null;
      try { if (typeof onProfileChanged === 'function') onProfileChanged(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    es.onopen = () => setFresh(true);
    es.onerror = () => setFresh(false);

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!fresh) refresh();
    }, 4000);
    refresh();
  }

  function stop() {
    stopped = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
  }

  return { start, stop, refresh, resetAnchor };
}

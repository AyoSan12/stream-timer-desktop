// Real-time Server-Sent Events (SSE) hub with per-role client counting
// so Home -> Integration Readiness can report exact connected OBS sources.

const HEARTBEAT_MS = 15_000;
const clients = new Map(); // res -> { role: 'panel' | 'obs', profileId }

function formatEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function addClient(res, { role = 'panel', profileId = null } = {}) {
  clients.set(res, { role, profileId });
}

export function removeClient(res) {
  clients.delete(res);
}

export function broadcastEvent(eventName, payload, { profileId = null } = {}) {
  const frame = formatEvent(eventName, payload);
  for (const [res, meta] of clients) {
    if (profileId && meta.profileId && meta.profileId !== profileId) continue;
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

export function broadcast(snapshot, opts = {}) {
  broadcastEvent('state', snapshot, opts);
}

export function clientStats() {
  let panel = 0;
  let obs = 0;
  for (const meta of clients.values()) {
    if (meta.role === 'obs') obs += 1;
    else panel += 1;
  }
  return { total: clients.size, panel, obs };
}

const heartbeat = setInterval(() => {
  for (const res of clients.keys()) {
    try { res.write(': ping\n\n'); } catch { clients.delete(res); }
  }
}, HEARTBEAT_MS);
if (typeof heartbeat.unref === 'function') heartbeat.unref();

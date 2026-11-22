// Pure anti-drift client countdown projection.

export function applySnapshot(current, snapshot, localNowMs) {
  if (current !== null) {
    if (snapshot.revision < current.revision) return current;
    if (snapshot.revision === current.revision && snapshot.serverTimeMs <= current.serverTimeMs) return current;
  }
  return {
    revision: snapshot.revision,
    state: snapshot.state,
    remainingMs: snapshot.remainingMs,
    serverTimeMs: snapshot.serverTimeMs,
    receivedAtLocalMs: localNowMs,
  };
}

export function remainingAt(record, localNowMs) {
  if (record === null) return null;
  if (record.state === 'paused') return Math.max(0, record.remainingMs);
  const elapsed = Math.max(0, localNowMs - record.receivedAtLocalMs);
  return Math.max(0, record.remainingMs - elapsed);
}

export function formatSeconds(remainingMs) {
  return Math.ceil(Math.max(0, remainingMs) / 1000);
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

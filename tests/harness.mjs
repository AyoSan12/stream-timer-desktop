export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function runCases(cases) {
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const notes = await c.fn();
      results.push({ id: c.id, verdict: 'pass', durationMs: Date.now() - t0, notes });
    } catch (err) {
      results.push({ id: c.id, verdict: 'fail', durationMs: Date.now() - t0, error: String(err && err.stack || err) });
    }
  }
  return results;
}

export function summarize(results) {
  const pass = results.filter((r) => r.verdict === 'pass').length;
  const fail = results.length - pass;
  return { total: results.length, pass, fail };
}

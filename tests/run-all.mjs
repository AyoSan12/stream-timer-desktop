// Unified test runner for Stream Timer Desktop (Model + SQLite WAL Engine + Playwright Apple UI).

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUITES = [
  ['Domain / FX / Finance Model', 'tests/model.test.mjs'],
  ['Local SQLite WAL Engine & Multi-Profile', 'tests/engine.test.mjs'],
  ['Apple UI, Onboarding, 8-Language & Dark Mode (Playwright)', 'tests/browser.test.mjs'],
];

let failed = 0;
for (const [label, rel] of SUITES) {
  console.log(`\n=== ${label} (${rel}) ===`);
  const res = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed.`);
  process.exit(1);
}
console.log('\nALL SUITES PASSED.');

// Canonical UTC epoch milliseconds clock.
// All timer anchors, receipts, donation timestamps, and finance session boundaries
// use integer epoch milliseconds end-to-end.

export function nowMs() {
  return Date.now();
}

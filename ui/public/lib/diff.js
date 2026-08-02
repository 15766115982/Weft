// lib/diff.js — minimal LCS line diff for the review queue (C2).
// Same purpose as the thin viewer's client-side diff; baseline comes from
// /api/diff (git HEAD, null when the KB has no git — S4 graceful degradation).
export function lineDiff(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const m = a.length, n = b.length;
  // LCS table (trim guard: KB pages are ≤ a few thousand lines at our scale)
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ t: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', text: a[i] }); i++; }
    else { ops.push({ t: '+', text: b[j] }); j++; }
  }
  while (i < m) ops.push({ t: '-', text: a[i++] });
  while (j < n) ops.push({ t: '+', text: b[j++] });
  return ops;
}

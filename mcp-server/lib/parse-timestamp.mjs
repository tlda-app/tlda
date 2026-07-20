/**
 * Parse a flexible timestamp value into an ISO string.
 *
 * Accepts:
 *   'now'             → current time
 *   '20m' / '-20m'   → 20 minutes ago
 *   '2h'  / '-2h'    → 2 hours ago
 *   '1d'  / '-1d'    → 1 day ago
 *   (and 'min','hr','day','hours','days',... variants)
 *   parseable date    → normalized to UTC ISO
 *   null/undefined    → returned as-is
 */
export function parseTimestamp(val) {
  if (val == null) return val;
  const s = String(val).trim().toLowerCase();
  if (s === 'now') return new Date(Date.now()).toISOString();
  const m = s.match(/^-?(\d+(?:\.\d+)?)\s*(m(?:in(?:utes?)?)?|h(?:r(?:s)?|ours?)?|d(?:ays?)?)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0]; // 'm', 'h', or 'd'
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return new Date(Date.now() - n * ms).toISOString();
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? val : d.toISOString();
}

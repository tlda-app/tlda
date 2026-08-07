/**
 * Parse a flexible timestamp value into an ISO string.
 *
 * Accepts:
 *   'now'             → current time
 *   '30s' / '-30s'   → 30 seconds ago
 *   '20m' / '-20m'   → 20 minutes ago
 *   '2h'  / '-2h'    → 2 hours ago
 *   '1d'  / '-1d'    → 1 day ago
 *   (and 'sec','min','hr','day','hours','days',... variants)
 *   parseable date    → normalized to UTC ISO
 *   null/undefined    → null, meaning no bound
 *
 * Anything else throws. A time bound that cannot be read must not become no
 * bound: the value reaches SQLite as a TEXT comparison against an ISO
 * timestamp, so an unparsed `'150s'` compares as `'1' < '2'` and every row in
 * the table passes. The caller asked for the last 150 seconds and silently got
 * the whole corpus. That is the same failure fleet-search's name resolver
 * already refuses — an unmatched name yields an impossible id so a typo returns
 * nothing rather than everything — and widening is the more dangerous
 * direction of the two.
 */
export function parseTimestamp(val) {
  if (val == null) return null;
  const s = String(val).trim().toLowerCase();
  if (s === 'now') return new Date(Date.now()).toISOString();
  const m = s.match(/^-?(\d+(?:\.\d+)?)\s*(s(?:ec(?:s|onds?)?)?|m(?:in(?:utes?)?)?|h(?:r(?:s)?|ours?)?|d(?:ays?)?)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0]; // 's', 'm', 'h', or 'd'
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
    return new Date(Date.now() - n * ms).toISOString();
  }
  const d = new Date(val);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  throw new TimeBoundError(val);
}

/**
 * Names the value that could not be read and the units that exist, because the
 * next action differs: a typo gets retyped, an unsupported unit gets rewritten
 * in one that exists, and an empty string means the parameter should have been
 * omitted.
 */
export class TimeBoundError extends Error {
  constructor(val) {
    super(
      `"${val}" is not a time I can read. Use an ISO timestamp, "now", or a relative ` +
      `span — 30s, 20m, 2h, 1d. Weeks and months are spellable inside a search QUERY ` +
      `(since:1w, since:3mo) but not as a since/until parameter; write 7d or 90d. ` +
      `Omit the parameter to search with no bound.`,
    );
    this.name = 'TimeBoundError';
    this.value = val;
  }
}

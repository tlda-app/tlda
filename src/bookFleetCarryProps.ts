/**
 * Which panel props a book teleport carries into the new chapter's room.
 *
 * Ownership (userId/deviceId) and geometry (x/y/w/h) are handled by the carry
 * mechanism itself, never by this table. What remains is panel CONTENT, and the
 * rule is default-deny: only room-independent state crosses. A docview pinned
 * to the old chapter's page 3 must not arrive pointing at the new chapter's
 * page 3, and a source editor open on the old chapter's file must not reopen
 * that path against another project — so doc-bound content resets to the
 * panel's defaults in the new room instead of carrying verbatim.
 *
 * Zero imports, so the rule stays exercisable directly in node.
 */

/** Props that cross chapters, per panel type. Absent type: nothing crosses. */
export const FLEET_CARRY_PROP_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // Fleet-scoped conversation filters (the layout recreator already preserves
  // these across rebuilds) plus the panel's own search text.
  'fleet-chat': ['filter', 'query'],
  // A fleet-history query; the room it was typed in is irrelevant.
  'fleet-search': ['query'],
  // Live-session participant keys re-resolve in the new room; dropping them
  // would blank a call in progress.
  'fleet-video': ['tileKeys', 'title'],
  // A server artifact URL names its target wherever it is read from.
  'fleet-report-artifact': ['url', 'title'],
  // Doc-bound: position, sources, and labels name the chapter left behind.
  'fleet-docview': [],
  // Project-bound: file and line name the chapter left behind.
  'fleet-source-editor': [],
  // Nothing beyond geometry and ownership.
  'fleet-agents': [],
  'fleet-inbox': [],
  'fleet-notifications': [],
}

/** The props of `sourceProps` that may cross into a new room. */
export function carriedPropsFor(type: string, sourceProps: Record<string, unknown>): Record<string, unknown> {
  const allowed = FLEET_CARRY_PROP_ALLOWLIST[type] ?? []
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in sourceProps) out[key] = sourceProps[key]
  }
  return out
}

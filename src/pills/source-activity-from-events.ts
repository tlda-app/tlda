// Who is editing a source file, and who last changed it — derived from the
// events the client already receives.
//
// Skip, 2026-08-18: "you can just push to the pill like we push to chat", and
// "it's just a different filter on events". This is that filter.
//
// It replaces a bespoke `/:name/source-activity` route polled every 1000ms per
// open file, which answered by reading an entire attribution log synchronously —
// the 809ms stall that made the fleet unreachable on 2026-08-17 — and then a
// bespoke `signal:source-activity` broadcast that was a second push mechanism
// beside the one the client already had.
//
// DISPLAY ONLY, and deliberately approximate. Skip, 2026-08-18: "our statuses
// including thinking are garbage — display only", "not to be trusted", and on
// whether to track turn ends for this: "who gives a fuck about turns".
//
// So there is no turn tracking here and no status here. Recent activity on the
// file means someone is editing it; that is the whole rule. It is a label, and
// nothing that decides delivery, liveness, authority or cleanup may take its
// answer from it. If you are importing this to make a decision rather than to
// draw a line of text, that is the bug.

export type SourceActivityEvent = {
  type?: string
  event_type?: string
  from?: string | null
  from_id?: string | null
  agentId?: string | null
  timestamp?: string | number | null
  metadata?: { project?: string | null; sourceFile?: string | null } | null
}

export type SourceActivityView = {
  editors: { id: string; name: string }[]
  lastChangedAt: number | null
  lastChangedBy: string | null
}

const typeOf = (e: SourceActivityEvent) => e.event_type || e.type || ''
const actorOf = (e: SourceActivityEvent) => e.from || e.from_id || e.agentId || null
const timeOf = (e: SourceActivityEvent): number => {
  const t = e.timestamp
  if (typeof t === 'number') return t
  if (typeof t === 'string') return Date.parse(t) || 0
  return 0
}

/**
 * @param events   events newest-last or newest-first; order is not assumed
 * @param project  the project the pill is showing
 * @param file     the source file the pill is showing
 * @param nameOf   agent id -> display name
 */
const EDITING_WINDOW_MS = 90_000

export function sourceActivityFromEvents(
  events: SourceActivityEvent[],
  project: string,
  file: string,
  nameOf: (id: string) => string = (id) => id,
  now: number = Date.now(),
): SourceActivityView {
  const lastEditByAgent = new Map<string, number>()
  let lastChangedAt: number | null = null
  let lastChangedBy: string | null = null

  for (const event of events || []) {
    const actor = actorOf(event)
    if (!actor) continue
    const at = timeOf(event)
    const type = typeOf(event)

    if (type !== 'activity') continue
    // The doc room carries a project's whole traffic, so a sibling file's edits
    // arrive here too.
    if (event.metadata?.project !== project || event.metadata?.sourceFile !== file) continue

    if (at >= (lastEditByAgent.get(actor) ?? 0)) lastEditByAgent.set(actor, at)
    if (lastChangedAt === null || at > lastChangedAt) {
      lastChangedAt = at
      lastChangedBy = actor
    }
  }

  // Editing = touched the file inside the window. Approximate on purpose.
  const cutoff = now - EDITING_WINDOW_MS
  const editors = [...lastEditByAgent.entries()]
    .filter(([, editedAt]) => editedAt >= cutoff)
    .map(([agent]) => ({ id: agent, name: nameOf(agent) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    editors,
    lastChangedAt,
    lastChangedBy: lastChangedBy ? nameOf(lastChangedBy) : null,
  }
}

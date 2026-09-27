// revision-actor-trailers.mjs — the act, recorded on the revision that did it.
//
// A revision commit carries its actor as git trailers in the message body:
//
//   Tlda-Actor: <agent or person id, when one was observed>
//   Tlda-Actor-Unknown: <reason, when none was>
//   Tlda-Daemon: <the sync that wrote the commit>
//
// Exactly one of Tlda-Actor / Tlda-Actor-Unknown is present on every commit
// this code writes. Absence means the commit predates recording — that
// distinction is the whole value of the field, so an unknown is stamped
// explicitly rather than left blank.
//
// The reason vocabulary, each true in exactly one context:
//   no-members          the commit has no edit cluster behind it (recovery,
//                       republication, or a combine of one)
//   no-observed-edit    members exist but no edit was seen in the window
//   lookup-failed       the resolver threw; the commit was still written
//   browser-actor-unwired  the browser leg has no observed identity (held work)
//   projection-derived  a projection of another revision; the act is on the parent
//   actor-unresolved    no resolver was wired at all (defensive default)
//   predates-recording  stamped by the reader, never the writer: a commit
//                       from before trailers existed
//   trailer-unreadable  stamped by the reader: the commit could not be read
//   record-failed       stamped by the writer's last-resort catch
//
// One actor per revision is lossy by construction: a revision carries a whole
// tree and its files can have different authors. Do not read unit-level
// fidelity into this stamp from Skip's §7 schema — it answers "whose push",
// never "whose line".

const TRAILER_RE = /^Tlda-(Actor|Actor-Unknown|Daemon):\s*(.+?)\s*$/

function clean(value) {
  if (typeof value !== 'string') return null
  const line = value.split('\n', 1)[0].replace(/\r/g, '').trim()
  return line || null
}

export function formatActorTrailers({ actor = null, daemon = null, unknown = null } = {}) {
  const cleanActor = clean(actor)
  const cleanUnknown = clean(unknown)
  if (!!cleanActor === !!cleanUnknown) {
    throw new Error('actor trailers need exactly one of actor and unknown')
  }
  const lines = [cleanActor ? `Tlda-Actor: ${cleanActor}` : `Tlda-Actor-Unknown: ${cleanUnknown}`]
  const cleanDaemon = clean(daemon)
  if (cleanDaemon) lines.push(`Tlda-Daemon: ${cleanDaemon}`)
  return lines.join('\n')
}

export function parseActorTrailers(message) {
  const found = { actor: null, daemon: null, unknown: null }
  if (typeof message !== 'string') return found
  for (const line of message.split('\n')) {
    const match = TRAILER_RE.exec(line.trim())
    if (!match) continue
    const [, key, value] = match
    if (key === 'Actor' && !found.actor) found.actor = value
    else if (key === 'Daemon' && !found.daemon) found.daemon = value
    else if (key === 'Actor-Unknown' && !found.unknown) found.unknown = value
  }
  return found
}

/**
 * Display-time formatting — the one place a stored instant becomes a string a
 * person reads.
 *
 * THE RULE: convert at the point of display, never at the point of storage.
 * Everything written to the database, emitted in a JSON log line, put in an API
 * payload, or compared/sorted stays UTC/ISO. A timezone-shifted stored timestamp
 * is data corruption. If you are reaching for this module to decide what to
 * WRITE, you are in the wrong module.
 *
 * The zone comes from `timezone:` in server.yaml (an IANA name such as
 * "America/New_York"). When the key is absent the host machine's own zone is
 * used — which is why this exists at all: the Fly container's own zone is UTC,
 * so a surface rendered there read as UTC no matter where the reader was.
 *
 * Not for the browser. A browser already knows its viewer's zone, so client
 * code should keep using toLocaleString() with no explicit timeZone.
 */

import { loadServerConfig } from './config.mjs'

let cached = null

/**
 * The IANA zone human-readable times render in.
 *
 * Resolution is one step, not a chain: server.yaml's `timezone` if set,
 * otherwise this machine's own zone. An unreadable or absent server.yaml is not
 * a reason to fail a log line, so the machine zone stands in — the value is a
 * display preference, and every other consumer of server.yaml already fails
 * loudly at startup if the file is broken.
 */
export function getDisplayTimeZone() {
  if (cached) return cached
  let zone = null
  try {
    zone = loadServerConfig().timezone || null
  } catch {
    // server.yaml absent/malformed: the server and daemon already refuse to
    // start on that, so anything still running here is a CLI on a box without
    // one. Fall through to the machine zone rather than break its output.
    zone = null
  }
  cached = zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return cached
}

/** Test seam — config is read once per process, so tests must be able to reset. */
export function resetDisplayTimeZoneCache() {
  cached = null
}

/**
 * Spread into an existing toLocaleString/toLocaleTimeString options object to
 * pin it to the display zone and label which zone that is. Every other option
 * the call site already passes is preserved, so the format does not change —
 * `11:27 PM` becomes `11:27 PM EDT`, not a different layout.
 *
 * The label is the point, not decoration: a bare `3:04 PM` from a fleet tool is
 * a value the reader cannot check, and an agent relaying it to a person states
 * a time with confidence in a zone it never established.
 */
export function displayZoneOptions() {
  return { timeZone: getDisplayTimeZone(), timeZoneName: 'short' }
}

function toDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value !== 'string' || !value.trim()) return null
  // SQLite writes "YYYY-MM-DD HH:MM:SS" with no zone designator. Those are UTC
  // (they come from CURRENT_TIMESTAMP), but Date parses a bare space-separated
  // stamp as LOCAL time, which would shift them twice. Normalize to explicit
  // UTC before parsing. See the T-vs-space hazard noted in AGENTS.md.
  let text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) {
    text = text.replace(' ', 'T') + 'Z'
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

function parts(date, zone) {
  const fields = {}
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date)) fields[part.type] = part.value
  // en-CA renders midnight as "24" in some ICU versions; the date is right.
  if (fields.hour === '24') fields.hour = '00'
  return fields
}

/**
 * "2026-07-26 23:27:14 EDT" — the same shape as the ISO-with-Z form these call
 * sites printed before, with the zone label telling the truth instead of always
 * claiming UTC.
 */
export function formatDisplayTimestamp(value, { seconds = true, zoneLabel = true } = {}) {
  const date = toDate(value)
  if (!date) return typeof value === 'string' ? value : ''
  const zone = getDisplayTimeZone()
  const f = parts(date, zone)
  const clock = seconds ? `${f.hour}:${f.minute}:${f.second}` : `${f.hour}:${f.minute}`
  return `${f.year}-${f.month}-${f.day} ${clock}${zoneLabel ? ` ${f.timeZoneName}` : ''}`
}

/** "23:27:14 EDT" — for surfaces that already establish the date elsewhere. */
export function formatDisplayClock(value, { seconds = true, zoneLabel = true } = {}) {
  const date = toDate(value)
  if (!date) return typeof value === 'string' ? value : ''
  const f = parts(date, getDisplayTimeZone())
  const clock = seconds ? `${f.hour}:${f.minute}:${f.second}` : `${f.hour}:${f.minute}`
  return `${clock}${zoneLabel ? ` ${f.timeZoneName}` : ''}`
}

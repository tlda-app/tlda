// One input path for all status evidence into the daemon's machines.
//
// Every status source — process probe, hooks, transcript tails, structured
// harness events, pane scraping, server-observed acts — is evidence, none
// of them a status. The
// machines decide; the server reports the verdict. Sources call
// admitEvidence() and set only the fields they can prove; omitting a field
// is how a source declines to speak, and the machines treat omission as
// silence, never as a negative.
//
// This module is one function with callers, not a registry: sources are not
// registered, journalled, or plugged in. The envelope shape is the whole
// contract:
//
//   { agentId, source, atMs, process?, activity?, tool? }
//
//   agentId   fleet id. Required.
//   source    one of EVIDENCE_SOURCE. Required. Provenance for the log.
//   atMs      when observed, source clock. Required. Evidence older than
//             EVIDENCE_STALE_MS is dropped: a stale sighting must not move
//             a machine.
//   process   'alive' | 'dead'. Present ONLY when the source observes
//             process existence. A missing hook is silence, not death, so
//             only the probe and harness terminal events set this.
//   activity  'thinking' | 'idle' | 'compacting' | 'active' | 'unknown'.
//             Toil evidence. 'active' means observed doing something,
//             classification pending (transcript rows). 'unknown' means
//             observed with no reading (pane capture failed) — distinct
//             from omission, which means no observation at all. Never
//             implies process on its own.
//   tool      optional context carried through to the activity reading
//             (which tool is acting). Metadata, not evidence.
//
// Invalid envelopes are dropped with a warning, never thrown: a malformed
// call must not break the sweep it arrived in. Pane scrape claiming
// process is a caller bug — dead panes capture fine — so the claim is
// dropped (the activity half is still admitted) and warned.

export const EVIDENCE_SOURCE = Object.freeze({
  PROCESS_PROBE: 'process-probe',
  HOOK: 'hook',
  TRANSCRIPT: 'transcript',
  HARNESS_EVENT: 'harness-event',
  PANE_SCRAPE: 'pane-scrape',
  SERVER_OBSERVED: 'server-observed',
})

const SOURCES = new Set(Object.values(EVIDENCE_SOURCE))
const PROCESSES = new Set(['alive', 'dead'])
const ACTIVITIES = new Set(['thinking', 'idle', 'compacting', 'active', 'unknown'])

// Sweeps run every few seconds and hooks fire in seconds; only forwarded
// evidence can be old, and a minute is generous for any of it.
export const EVIDENCE_STALE_MS = 60_000

export function createEvidenceAdmission({ liveness, activity, log, now = () => Date.now() } = {}) {
  // Drops are log-only: no counter, no alert, no surface. A quiet log is an
  // unchecked instrument, not proof — grep for 'evidence dropped' before
  // believing a window was clean.
  function drop(reason, envelope) {
    log?.warn?.(`evidence dropped (${reason}): agent=${envelope?.agentId || '?'} source=${envelope?.source || '?'}`)
  }

  return function admitEvidence(envelope = {}) {
    const { agentId, source, atMs, tool } = envelope
    let { process, activity: activityValue } = envelope
    if (!agentId || typeof agentId !== 'string') return drop('no agent', envelope)
    if (!SOURCES.has(source)) return drop('unknown source', envelope)
    if (!Number.isFinite(atMs)) return drop('no observation time', envelope)
    if (now() - atMs > EVIDENCE_STALE_MS) return drop('stale', envelope)
    if (process !== undefined && !PROCESSES.has(process)) return drop('bad process claim', envelope)
    if (activityValue !== undefined && !ACTIVITIES.has(activityValue)) return drop('bad activity claim', envelope)
    if (source === EVIDENCE_SOURCE.PANE_SCRAPE && process !== undefined) {
      log?.warn?.(`evidence dropped (scrape claims process): agent=${agentId}; activity half admitted`)
      process = undefined
    }
    if (tool !== undefined && typeof tool !== 'string') return drop('bad tool', envelope)
    const meta = { source, atMs, tool: tool ?? null }
    return {
      process: process !== undefined ? liveness?.consumeProcess?.(agentId, process, meta) : undefined,
      activity: activityValue !== undefined ? activity?.consumeActivity?.(agentId, activityValue, meta) : undefined,
    }
  }
}

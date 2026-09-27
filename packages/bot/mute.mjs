// mute.mjs — per-recipient `shut-up-<bot>` suppression for bot sends.
//
// A recipient that carries the label `shut-up-<key>` (where <key> is the bot's
// canonical name, e.g. `shut-up-todd`) does not receive that bot's chats. The
// check is per recipient, at send time, in the bot — and it is SYNCHRONOUS.
// That is a constraint, not a preference: `chat()` writes to the socket on the
// same tick it is called, and main's send-state and canonical-recheck suites
// pin that (zero-tick and one-turn asserts after `chat()`). Any asynchronous
// lookup in the send path defers the write past those asserts, so the filter
// reads a label cache and never awaits.
//
// The cache is fed by roster data the bot already holds — sweep reads, login
// results, `agents-delta` batches — via `noteAgents`, plus a background warmer
// that resolves cache misses without ever holding up a send. Unknown means
// deliver: an id with no cached labels, an expired entry, a non-id recipient
// (a label or filter expression, which resolves server-side where this process
// cannot see the set), and a failed warming lookup all deliver rather than
// drop. A missed suppression costs noise; a wrongly-suppressed message costs a
// message; those are not the same price.
//
// Used by the harness (`createBot.chat`) and by out-of-repo bots with their
// own socket (todd) alike — the mute state is the shared rule, the call site
// is whatever sends.

const FLEET_ID_RE = /^fleet:[a-zA-Z0-9_-]+$/;

// How long a cached label set is trusted. Past this the entry reads as unknown
// (deliver + rewarm) rather than as its last value, so removing a mute label
// takes effect without a restart.
//
// Product property, stated so nobody later files it as a bug: applying
// `shut-up-<bot>` can be followed by up to this long of arriving traffic.
// Sweeps re-note on every pass from the same roster read that selects their
// recipients, so a sweep suppresses a muted recipient within that same sweep —
// the expiry only governs sends to agents the bot has not recently read.
const DEFAULT_MAX_AGE_MS = 60_000;

/** The mute label for a bot key: `shut-up-todd`. */
export function shutUpLabel(botKey) {
  return `shut-up-${String(botKey || '').toLowerCase()}`;
}

/** True when a label set carries the bot's mute label. Non-arrays are unmuted. */
export function isMutedByLabels(labels, botKey) {
  return Array.isArray(labels) && labels.includes(shutUpLabel(botKey));
}

/**
 * Batched roster lookup of explicit labels: ids → Map(id → labels[]).
 * One HTTP round trip for the whole set. Throws on failure — the warmer
 * treats that as "still unknown", which delivers.
 */
export async function fetchLabelsById(server, ids, { timeoutMs = 10_000 } = {}) {
  const wanted = [...new Set((ids || []).filter(id => FLEET_ID_RE.test(id || '')))];
  const out = new Map();
  if (!wanted.length) return out;
  const url = new URL('/api/agents/lookup', server);
  url.searchParams.set('ids', wanted.join(','));
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`agent lookup failed: HTTP ${res.status}`);
  const agents = (await res.json())?.agents || [];
  for (const agent of agents) {
    if (agent?.id) out.set(agent.id, agent.labels || []);
  }
  return out;
}

/**
 * One bot's mute state: a label cache, a sync per-recipient filter over it,
 * and a background warmer for misses.
 *
 * `server` + `fetchLabels` drive warming (`fetchLabels(ids)` → Map, injectable
 * for tests; production passes nothing and gets the roster lookup). `log`, when
 * given, is called with the suppression line for each suppressed id —
 * suppression announces when it fires, because a bot that quietly stops
 * sending is indistinguishable from a bot that broke. Warming is silent by
 * design: it is best-effort cache fill, not a send decision.
 */
export function createMuteState({
  botKey, server = null, fetchLabels = null, maxAgeMs = DEFAULT_MAX_AGE_MS,
  log = null, now = () => Date.now(),
} = {}) {
  // id → { labels, at }. Only fleet ids are stored; anything else is not an
  // agent and can never be muted.
  const cache = new Map();
  const resolveLabels = fetchLabels || ((ids) => fetchLabelsById(server, ids));
  // Warming is batched per tick: a sweep's fifty misses become one lookup,
  // not fifty. The flush is a microtask so a second `warm()` in the same
  // synchronous sweep joins the pending batch rather than starting another.
  let pendingWarm = null;
  let warmScheduled = false;

  function cachedLabels(id) {
    const entry = cache.get(id);
    if (!entry) return null;
    if (now() - entry.at > maxAgeMs) {
      cache.delete(id);
      return null;
    }
    return entry.labels;
  }

  function noteAgents(agents) {
    const at = now();
    for (const agent of agents || []) {
      if (agent?.id && FLEET_ID_RE.test(agent.id)) {
        cache.set(agent.id, { labels: agent.labels || [], at });
      }
    }
  }

  // Sync by contract (see the header): unknown ids deliver, muted ids drop.
  function filter(recipients) {
    const list = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);
    const deliver = [];
    const suppressed = [];
    const unknown = [];
    for (const r of list) {
      if (!FLEET_ID_RE.test(r || '')) {
        deliver.push(r);
        continue;
      }
      const labels = cachedLabels(r);
      if (labels === null) {
        deliver.push(r);
        unknown.push(r);
        continue;
      }
      if (isMutedByLabels(labels, botKey)) suppressed.push(r);
      else deliver.push(r);
    }
    if (log) {
      for (const id of suppressed) log(`suppressed chat → ${id} (carries ${shutUpLabel(botKey)})`);
    }
    return { deliver, suppressed, unknown };
  }

  function warm(recipients) {
    const list = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);
    const misses = list.filter(r => FLEET_ID_RE.test(r || '') && cachedLabels(r) === null);
    if (!misses.length) return;
    if (!pendingWarm) pendingWarm = new Set();
    for (const id of misses) pendingWarm.add(id);
    if (warmScheduled) return;
    warmScheduled = true;
    queueMicrotask(async () => {
      warmScheduled = false;
      const ids = [...pendingWarm];
      pendingWarm = null;
      try {
        const found = await resolveLabels(ids);
        const at = now();
        for (const id of ids) {
          if (found?.has(id)) cache.set(id, { labels: found.get(id), at });
          // Answered-for-but-absent, and lookup failures below, stay unknown:
          // the next send re-warms rather than trusting a gap.
        }
      } catch {
        // Warming never fails a send — the send already went out unfiltered.
      }
    });
  }

  return { noteAgents, filter, warm };
}

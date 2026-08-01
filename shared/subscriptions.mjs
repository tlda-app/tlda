// One definition of what an agent is subscribed to without having subscribed.
//
// Two consumers need it and they run in different processes: the store's
// matching layer decides delivery from it, and the agents panel renders it. If
// each had its own copy they would drift, and the drift would show up as an
// agent the panel says is reachable that is not — which is the failure this
// whole change is removing.

// The floor. Every living agent is subscribed to what is addressed to it.
//
// It is computed, never stored and never configured. A row can be missed by a
// migration; a file can be absent, and the Fly server has no daemon.yaml at all
// (`readYamlFile` returns `{}` for a missing file, silently). Either would
// express itself as an agent that is quietly unreachable, with no error
// anywhere — the exact eighteen-hour failure of 2026-08-01. So this is a
// property of existing, not a grant that can be lost.
//
// You can add subscriptions. You cannot remove this one.
export function floorSubscription(agentId) {
  return {
    subscription_id: null,
    query: `to:${agentId}`,
    notification_policy: 'immediate',
    origin: 'floor',
  }
}

// The named subscription sets declared in daemon.yaml, in the `{ default,
// values }` form `models:` and `environments:` already use. Purely additive on
// top of the floor: where there is no daemon.yaml, this is empty and every
// agent is still reachable.
export function subscriptionSetsFromDaemonConfig(daemonConfig) {
  const block = daemonConfig?.subscriptions
  if (!block || typeof block !== 'object') return { defaultSet: null, sets: {} }
  const sets = {}
  for (const [name, entries] of Object.entries(block.values || {})) {
    if (!Array.isArray(entries)) continue
    sets[name] = entries
      .map(e => (typeof e === 'string'
        ? { query: e, notification_policy: 'immediate' }
        : { query: e?.query, notification_policy: e?.policy || e?.notification_policy || 'immediate' }))
      .filter(e => typeof e.query === 'string' && e.query.length > 0)
  }
  const defaultSet = typeof block.default === 'string' && block.default in sets ? block.default : null
  return { defaultSet, sets }
}

// Everything an agent holds by virtue of existing: the floor, plus the
// default set if daemon.yaml declares one. Marked by origin so the panel can
// say which is which and neither looks like something the agent chose.
export function grantedSubscriptionsFor(agentId, daemonConfig) {
  const granted = [floorSubscription(agentId)]
  const { defaultSet, sets } = subscriptionSetsFromDaemonConfig(daemonConfig)
  if (!defaultSet) return granted
  for (const entry of sets[defaultSet] || []) {
    granted.push({
      subscription_id: null,
      query: entry.query,
      notification_policy: entry.notification_policy,
      origin: 'granted',
      set: defaultSet,
    })
  }
  return granted
}

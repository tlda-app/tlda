// What an agent is subscribed to when it is created.
//
// The daemon reads these at mint and sends them with the shell reservation; the
// server stores them as ordinary subscription rows. There is no floor in code, no default synthesised at match
// time, and no delivery decided outside the matching layer: an agent is
// notified because a subscription of its own matched, the same way every other
// notification happens.
//
// That is Skip's specification, and it took four attempts to get here. The
// default was implemented to spec on 7/12, rewritten to `to:<id>` because
// `my_labels` had been bound to the wrong label set, deleted on 7/28 as
// "inert", and finally hard-coded in JS on 8/1 — which is when he said
// "conceptually subscriptions are being fucking hard coded. In the code. Not
// cool." The binding was the defect; see `identityLabelsForAgent`.

// The default subscription: everything addressed to any label I answer to.
//
// `my_labels` is subscriber-relative and evaluated at match time, never
// expanded when the row is written — "Store the symbolic query. Do not expand
// labels into a static list when the row is created; labels may change later."
// A resolution stored at mint would freeze the labels an agent held at that
// moment, so a label gained afterwards would silently stop delivering.
//
// He raised `any(my_labels)` as the nicer spelling and then settled for this
// one with a tech-debt note ("as long as the schema is in place and all the
// stuff works, that's fine"), because the grammar has no fold operator and
// inventing one for a single use was not worth it.
export const DEFAULT_SUBSCRIPTION_QUERY = 'to:my_labels'
export const DEFAULT_SUBSCRIPTION_POLICY = 'immediate'

export function defaultSubscription() {
  return { query: DEFAULT_SUBSCRIPTION_QUERY, notification_policy: DEFAULT_SUBSCRIPTION_POLICY }
}

// The named subscription sets declared in daemon.yaml, in the `{ default,
// values }` form `models:` and `environments:` use. Skip, 8/1 01:15 EDT, on
// which of the two existing shapes this should take: "It's fucking default and
// value."
//
// These are read on the machine that HAS the daemon config, by the daemon, and
// sent with the mint. The server never reads daemon.yaml to decide delivery,
// which is why none of this depends on a file existing next to the server —
// "no shit phi has no demon dot YAML. It doesn't run a fucking daemon."
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

// Everything an agent is given at mint: the default, plus the entries of
// whichever named set daemon.yaml makes default on this machine.
//
// Additive and ordinary. An agent may unsubscribe from any of it afterwards —
// "if someone wants to, like, have their agents be completely unaddressable,
// that's their fucking choice." Nothing here refuses to let that happen.
export function mintSubscriptionsFor(daemonConfig) {
  const wanted = [defaultSubscription()]
  const { defaultSet, sets } = subscriptionSetsFromDaemonConfig(daemonConfig)
  if (defaultSet) {
    for (const entry of sets[defaultSet] || []) {
      wanted.push({ query: entry.query, notification_policy: entry.notification_policy, set: defaultSet })
    }
  }
  return wanted
}

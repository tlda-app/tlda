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

// The other slot: mail addressed to me, as opposed to mail addressed to a set I
// happen to be in.
//
// Those are two different kinds of being talked to and they deserve separate
// volumes — your own mail on `immediate` while the `awake` firehose sits on
// `hold` is an obvious thing to want, and it is unaskable while both arrive
// through one subscription.
//
// Anchored to `me`, which resolves to the subscriber's id. Not to the name: names
// move between agents and ids do not, so a slot anchored to a name would follow
// the name to whoever holds it next.
// The slots an agent is minted with, when server.yaml declares none.
//
// The queries belong in the config file. This is only what happens with the key
// absent, and it exists because an agent with no slots hears nothing at all.
export const MINT_SLOTS = Object.freeze([
  { query: 'to:me', policy: DEFAULT_SUBSCRIPTION_POLICY },
  { query: DEFAULT_SUBSCRIPTION_QUERY, policy: DEFAULT_SUBSCRIPTION_POLICY },
])

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
  const { defaultSet, sets } = subscriptionSetsFromDaemonConfig(daemonConfig)
  // Additive on top of the default, which is what the sentence above says and
  // what the code did not do: it returned the named set alone, so a machine
  // whose daemon.yaml declared any set at all minted agents *without*
  // `to:my_labels` — unable to receive their own mail — and a machine with no
  // subscriptions block minted them with nothing whatsoever.
  //
  // It went unnoticed because the set on this machine happens to be exactly the
  // default, so the two agree here and nowhere else.
  const out = [{ query: DEFAULT_SUBSCRIPTION_QUERY, notification_policy: DEFAULT_SUBSCRIPTION_POLICY, set: null }]
  for (const entry of sets[defaultSet] || []) {
    if (out.some(existing => existing.query === entry.query)) continue
    out.push({ query: entry.query, notification_policy: entry.notification_policy, set: defaultSet })
  }
  return out
}

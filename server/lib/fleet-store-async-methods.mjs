// The FleetStore methods whose result is a Promise, and therefore MUST be
// awaited at every call site.
//
// This list is the single source of truth for two things that must never
// disagree: the `await-fleet-store` lint rule, and (once the store moves onto a
// worker thread) the set of methods the main-thread client proxies across the
// boundary. Deriving both from one list is what stops a method from becoming
// async while its call sites quietly keep treating it as synchronous.
//
// WHY A LIST AND NOT "EVERY METHOD". The store is being moved off the event
// loop one piece at a time. A rule that flagged every `fleetStore.x()` call
// today would report all 401 sites at once, which is a rule nobody can act on —
// and per eslint.config.js, a lint everyone must ignore is a lint that catches
// nothing. Adding a name here is the act that turns on enforcement for that
// method's call sites, so the check grows with the conversion instead of
// arriving as a wall at the end.
//
// THE HAZARD THIS EXISTS FOR. A missed `await` does not throw. It yields a
// Promise, and a Promise is truthy with every property `undefined`:
//
//     const agent = fleetStore.getAgent(id)   // forgot await
//     if (agent.dead) { … }                   // `undefined` -> reads as ALIVE
//
// So a dead agent reads as alive, live agents get reaped, and todd kicks agents
// that are working. Silent and catastrophic, which is the AGENTS.md criterion
// for something that earns a real check rather than care.

export const FLEET_STORE_ASYNC_METHODS = Object.freeze([
  'acknowledgeInboxRead',
  'adoptIntoLineage',
  'backfillSessionEntries',
  'insertSessionEntries',
  'pop',
  'renameAgentFriendlyName',
  'share',
  'swap',
])

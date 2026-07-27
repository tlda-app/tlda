// The FleetStore methods whose result is a Promise, and therefore MUST be
// awaited at every call site.
//
// This list is the single source of truth for two things that must never
// disagree: the `await-fleet-store` lint rule, and (once the store moves onto a
// worker thread) the set of methods the main-thread client proxies across the
// boundary. Deriving both from one list is what stops a method from becoming
// async while its call sites quietly keep treating it as synchronous.
//
// IT IS NOW EVERY METHOD, and the ratchet has done its job. While the store was
// being moved one piece at a time, a rule that flagged all 400-odd sites at once
// would have been a rule nobody could act on — and per eslint.config.js, a lint
// everyone must ignore is a lint that catches nothing. So the list grew with the
// conversion. The store now runs on a worker thread in its entirety, so every
// public method returns a Promise, and the list is the manifest itself. Keeping
// them as one expression is what stops a method being added to the store and
// silently escaping the check.
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

import { FLEET_STORE_METHODS } from './fleet-store-methods.mjs'

export const FLEET_STORE_ASYNC_METHODS = FLEET_STORE_METHODS

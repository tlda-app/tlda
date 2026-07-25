// Reactive epoch for fleet identity (human id + device id + device readiness).
//
// TLDraw caches getShapeVisibility per shape record via createComputedCache,
// which only recomputes when the record changes or when a SIGNAL read inside
// it changes. Identity lives in plain module state in fleet-data.mjs, so
// without this atom a shape's hidden/visible verdict is pinned at first
// evaluation: own shapes stay hidden until something writes to them (which is
// what the meta._visTick touch in FleetHUD works around), and shapes that stop
// being yours keep their stale verdict.
import { atom } from '@tldraw/state'

const _identityEpoch = atom('fleetIdentityEpoch', 0)

/** Call whenever _humanId, _deviceId, or _deviceReady changes. */
export function bumpIdentityEpoch() {
  _identityEpoch.set(_identityEpoch.get() + 1)
}

/** Read inside reactive computations so they re-run when identity changes. */
export function readIdentityEpoch() {
  return _identityEpoch.get()
}

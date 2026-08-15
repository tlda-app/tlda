import {
  ManagedSurfaceLifecycle,
  type ManagedSurfaceRequest,
} from '../../packages/tldraw-wm/src/managed-surfaces.ts'
import type { WMCore } from '../../packages/tldraw-wm/src/wm-core.ts'

export * from '../../packages/tldraw-wm/src/managed-surfaces.ts'

export interface ManagedSurfaceOwner {
  userId: string
  deviceId: string
  [key: string]: string
}

export function createManagedSurfaceOwner(userId = '', deviceId = ''): ManagedSurfaceOwner {
  return { userId, deviceId }
}

export function requireManagedSurfaceOwner(
  owner: Partial<ManagedSurfaceOwner> | undefined,
  context = 'managed surface',
): ManagedSurfaceOwner {
  const resolved = createManagedSurfaceOwner(owner?.userId, owner?.deviceId)
  if (!resolved.userId || !resolved.deviceId) {
    throw new Error(`${context} requires owner userId and deviceId`)
  }
  return resolved
}

const lifecycles = new WeakMap<EventTarget, ManagedSurfaceLifecycle<ManagedSurfaceOwner, string>>()
const appliedPolicies = new WeakMap<EventTarget, Map<string, ManagedSurfaceRequest<unknown, string, ManagedSurfaceOwner, string>>>()
const managedSurfaceCores = new WeakMap<EventTarget, WMCore>()

function policyMap(target: EventTarget) {
  let map = appliedPolicies.get(target)
  if (!map) {
    map = new Map()
    appliedPolicies.set(target, map)
  }
  return map
}

function updateAppliedPolicy(
  target: EventTarget,
  request: ManagedSurfaceRequest<unknown, string, ManagedSurfaceOwner, string>,
) {
  policyMap(target).set(request.surfaceId, request)
}

function persistenceStorage(target: EventTarget): Storage | null {
  try {
    return 'sessionStorage' in target ? (target as Window).sessionStorage : null
  } catch {
    return null
  }
}

function persistenceKey(surfaceId: string) {
  return `tlda-managed-surface:${surfaceId}`
}

function lifecycleFor(target: EventTarget) {
  let lifecycle = lifecycles.get(target)
  if (!lifecycle) {
    const dismiss = (request: ManagedSurfaceRequest<unknown, string, ManagedSurfaceOwner, string>, action: string) => {
      policyMap(target).delete(request.surfaceId)
      const wm = managedSurfaceCores.get(target)
      if (wm?.hasLayer(request.layerId)) wm.removeLayer(request.layerId)
      target.dispatchEvent(new CustomEvent('wm-managed-surface-dismiss', {
        detail: { kind: request.kind, surfaceId: request.surfaceId, action },
      }))
    }
    lifecycle = new ManagedSurfaceLifecycle({
      sameOwner: (a, b) => a.userId === b.userId && a.deviceId === b.deviceId,
      show: request => target.dispatchEvent(new CustomEvent('wm-managed-surface-request', { detail: { request } })),
      remove: request => dismiss(request, 'remove-surface'),
      hide: request => dismiss(request, 'hide-surface'),
      preserve: request => dismiss(request, 'preserve-shape'),
      applyPlacement: request => {
        if (request.placement.left !== undefined && request.placement.left !== request.extent.x) {
          throw new Error(`Managed surface "${request.surfaceId}" placement does not match its extent.`)
        }
        if (request.placement.top !== undefined && request.placement.top !== request.extent.y) {
          throw new Error(`Managed surface "${request.surfaceId}" placement does not match its extent.`)
        }
        updateAppliedPolicy(target, request)
      },
      applyCameraPolicy: request => {
        updateAppliedPolicy(target, request)
        const wm = managedSurfaceCores.get(target)
        wm?.defineOrUpdateLayer(request.layerId, {
          parent: wm.rootLayerId,
          policy: request.cameraPolicy,
        })
      },
      applyHitPolicy: request => updateAppliedPolicy(target, request),
      persist: request => persistenceStorage(target)?.setItem(persistenceKey(request.surfaceId), JSON.stringify(request)),
      clearPersistence: request => persistenceStorage(target)?.removeItem(persistenceKey(request.surfaceId)),
    })
    lifecycles.set(target, lifecycle)
  }
  return lifecycle
}

/** Connect the host's managed-surface lifecycle to its local editor view. */
export function registerManagedSurfaceCore(target: EventTarget, wm: WMCore) {
  managedSurfaceCores.set(target, wm)
  for (const request of policyMap(target).values()) {
    wm.defineOrUpdateLayer(request.layerId, { parent: wm.rootLayerId, policy: request.cameraPolicy })
  }
}

export function requestManagedSurface<TPayload, TKind extends string>(
  target: EventTarget,
  request: ManagedSurfaceRequest<TPayload, TKind, ManagedSurfaceOwner, string>,
) {
  return lifecycleFor(target).request(request)
}

export function dismissManagedSurface(target: EventTarget, kind: string): boolean {
  return lifecycleFor(target).closeKind(kind)
}

export function getManagedSurfacePolicy(target: EventTarget, surfaceId: string) {
  return policyMap(target).get(surfaceId)
}

import type { CSSProperties } from 'react'
import { getPref } from './preferences'
import { getDeviceId } from './fleet/fleet-data.mjs'
import {
  DEFAULT_READABILITY_PROFILE,
  DEFAULT_READABILITY_PROFILES,
  type ReadabilityProfile,
  type ReadabilityProfiles,
} from './readabilityDefaults'

export { DEFAULT_READABILITY_PROFILE, DEFAULT_READABILITY_PROFILES, type ReadabilityProfile, type ReadabilityProfiles }

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function currentDeviceId() {
  return getDeviceId() || 'this-device'
}

function cleanProfile(value: Partial<ReadabilityProfile> | undefined): ReadabilityProfile {
  const base = DEFAULT_READABILITY_PROFILE
  const p = { ...base, ...(value ?? {}) }
  return {
    fontSize: clamp(Number(p.fontSize) || base.fontSize, 8, 24),
    lineHeight: clamp(Number(p.lineHeight) || base.lineHeight, 1.15, 1.8),
    touchTarget: clamp(Number(p.touchTarget) || base.touchTarget, 24, 64),
    chromeOpacity: clamp(Number(p.chromeOpacity) || base.chromeOpacity, 0, 1.5),
    contentOpacity: clamp(Number(p.contentOpacity) || base.contentOpacity, 0, 1),
    ageFade: !!p.ageFade,
    layoutHeightFrac: clamp(Number(p.layoutHeightFrac) || base.layoutHeightFrac, 0.1, 1),
    railAspect: clamp(Number(p.railAspect) || base.railAspect, 0.2, 2),
    chatAspect: clamp(Number(p.chatAspect) || base.chatAspect, 0.2, 2),
    marginAspect: clamp(Number(p.marginAspect) || base.marginAspect, 0, 0.4),
    agentsFrac: clamp(Number(p.agentsFrac) || base.agentsFrac, 0.25, 0.6),
  }
}

export function getCurrentReadabilityDeviceId(): string {
  return currentDeviceId()
}

export function getReadabilityProfiles(): ReadabilityProfiles {
  return getPref('readability-profiles') as ReadabilityProfiles
}

export function getReadabilityProfile(deviceId: string = currentDeviceId()): ReadabilityProfile {
  return cleanProfile(getReadabilityProfiles()[deviceId])
}

export function readabilityStyleVars(deviceId?: string): CSSProperties {
  const p = getReadabilityProfile(deviceId)
  return {
    '--fleet-base-font': `${p.fontSize}px`,
    '--fleet-line-height': String(p.lineHeight),
    '--fleet-touch-target': `${p.touchTarget}px`,
    '--fleet-chrome-alpha': String(p.chromeOpacity),
    '--fleet-content-alpha': String(p.contentOpacity),
    '--fleet-age-fade': p.ageFade ? '1' : '0',
  } as CSSProperties
}

export function getLayoutReadabilityTokens(
  viewport: { w: number; h: number },
  deviceId: string = currentDeviceId(),
) {
  const p = getReadabilityProfile(deviceId)
  const w = Math.max(1, Number(viewport.w) || 1)
  const h = Math.max(1, Number(viewport.h) || 1)
  const totalH = Math.round(h * p.layoutHeightFrac)
  return {
    gap: Math.round(Math.max(8, p.touchTarget * 0.35)),
    leftW: Math.round(clamp(totalH * p.railAspect, 160, w)),
    chatW: Math.round(clamp(totalH * p.chatAspect, 180, w)),
    marginGap: Math.round(clamp(totalH * p.marginAspect, 0, Math.max(0, w * 0.25))),
    totalH,
    agentsH: Math.round(h * p.agentsFrac),
  }
}

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
  const stored = value as Partial<ReadabilityProfile> | undefined
  const p = { ...base, ...(stored ?? {}) }
  const columnAspect = clamp(Number(p.columnAspect) || base.columnAspect, 0.2, 2)
  return {
    fontSize: clamp(Number(p.fontSize) || base.fontSize, 8, 24),
    lineHeight: clamp(Number(p.lineHeight) || base.lineHeight, 1.15, 1.8),
    touchTarget: clamp(Number(p.touchTarget) || base.touchTarget, 24, 64),
    faint: Boolean(p.faint),
    chromeOpacity: clamp(Number(p.chromeOpacity) || base.chromeOpacity, 0, 1.5),
    contentOpacity: clamp(Number(p.contentOpacity) || base.contentOpacity, 0, 1),
    layoutHeightFrac: clamp(Number(p.layoutHeightFrac) || base.layoutHeightFrac, 0.1, 1),
    railAspect: clamp(Number(p.railAspect) || base.railAspect, 0.2, 2),
    columnAspect,
    columnMinAspect: Math.min(
      columnAspect,
      clamp(Number(p.columnMinAspect) || base.columnMinAspect, 0.1, 2),
    ),
    marginAspect: clamp(Number(p.marginAspect) || base.marginAspect, 0, 0.4),
    agentsFrac: clamp(Number(p.agentsFrac) || base.agentsFrac, 0.25, 0.6),
    // Not `|| base`: 0 is a meaningful value here — it turns soft snap off.
    nudgeStrength: clamp(Number.isFinite(Number(p.nudgeStrength)) ? Number(p.nudgeStrength) : base.nudgeStrength, 0, 4),
  }
}

/**
 * How close a fleet panel must be before a soft snap takes it, in screen px.
 * Inside this it goes to the line; outside it nothing happens. The setting is
 * in em so it tracks the device's own text size: 3 CSS px is nothing on a
 * high-DPI tablet, one line of text is the same apparent distance everywhere.
 */
export function getFleetNudgeStrengthPx(deviceId?: string): number {
  const p = getReadabilityProfile(deviceId)
  return p.nudgeStrength * p.fontSize
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
    columnW: Math.round(clamp(totalH * p.columnAspect, 1, w)),
    columnMinW: Math.round(clamp(totalH * p.columnMinAspect, 1, w)),
    marginGap: Math.round(clamp(totalH * p.marginAspect, 0, Math.max(0, w * 0.25))),
    totalH,
    agentsH: Math.round(h * p.agentsFrac),
  }
}

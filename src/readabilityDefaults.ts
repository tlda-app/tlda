export type ReadabilityProfile = {
  fontSize: number
  lineHeight: number
  touchTarget: number
  faint: boolean
  chromeOpacity: number
  contentOpacity: number
  layoutHeightFrac: number
  railAspect: number
  chatAspect: number
  marginAspect: number
  agentsFrac: number
  /** Soft-snap pull between fleet panels, in em of the profile's font size. */
  nudgeStrength: number
}

export type ReadabilityProfiles = Record<string, Partial<ReadabilityProfile>>

export const DEFAULT_READABILITY_PROFILE: ReadabilityProfile = {
  fontSize: 11,
  lineHeight: 1.5,
  touchTarget: 28,
  faint: false,
  chromeOpacity: 1,
  contentOpacity: 1,
  layoutHeightFrac: 0.7,
  // Column widths are a fraction of the layout's height, which is deliberate --
  // you pan across, not up and down, so height is the fixed dimension. These
  // aspects are what decides how much of the screen is left for the document,
  // and they were set too wide: the layout occupies leftW + 2*chatW + gaps at
  // 1:1 screen px, so at 0.54/0.66 a 13" Air M2 was left 287px for the page and
  // rendered it at 36% of its width, against 61% on Skip's own larger screen.
  // The document is the point, so the aspects give it back the difference.
  railAspect: 0.40,
  chatAspect: 0.50,
  marginAspect: 0.06,
  agentsFrac: 0.4,
  nudgeStrength: 1,
}

export const DEFAULT_READABILITY_PROFILES: ReadabilityProfiles = {}

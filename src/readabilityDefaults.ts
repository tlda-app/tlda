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
  // Skip, 2026-08-18: "if 14 is standard, let's use 14" — "let's just do
  // standard shit." He reads at 13 himself and did not want that to become the
  // default; where a conventional value exists it wins over his personal one.
  fontSize: 14,
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
  //
  // chatAspect is Skip's own setting, read off his settings panel on the M2 Air
  // rather than derived: he runs 0.8 and has been doing so for long enough to
  // call the default "too narrow". Skip, 2026-08-18: "what I'm using for my
  // three column layout in my settings is 70% height, aspect ratio point eight."
  // The other three here already match what he runs, so this is the one value
  // between a first-time reader and the layout the expert user chose.
  railAspect: 0.40,
  chatAspect: 0.80,
  marginAspect: 0.06,
  agentsFrac: 0.4,
  nudgeStrength: 1,
}

export const DEFAULT_READABILITY_PROFILES: ReadabilityProfiles = {}

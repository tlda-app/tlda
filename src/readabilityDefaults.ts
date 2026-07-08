export type ReadabilityProfile = {
  fontSize: number
  lineHeight: number
  touchTarget: number
  chromeOpacity: number
  contentOpacity: number
  ageFade: boolean
  layoutHeightFrac: number
  railAspect: number
  chatAspect: number
  marginAspect: number
  agentsFrac: number
}

export type ReadabilityProfiles = Record<string, Partial<ReadabilityProfile>>

export const DEFAULT_READABILITY_PROFILE: ReadabilityProfile = {
  fontSize: 11,
  lineHeight: 1.5,
  touchTarget: 28,
  chromeOpacity: 1,
  contentOpacity: 1,
  ageFade: true,
  layoutHeightFrac: 0.7,
  railAspect: 0.54,
  chatAspect: 0.66,
  marginAspect: 0.06,
  agentsFrac: 0.4,
}

export const DEFAULT_READABILITY_PROFILES: ReadabilityProfiles = {}

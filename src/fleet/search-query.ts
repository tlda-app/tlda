// @ts-ignore — shared ESM module used by both Node and Vite.
export {
  buildFleetSearchFilters,
  parseAgentSelector,
  parseSearchQuery,
  rankSearchResults,
  resolveTimeFilter,
} from '../../shared/fleet-search-query.mjs'

export type FleetSearchScope = 'any' | 'from' | 'to'
export type FleetSearchExpansion = 'stack' | 'self'
export type FleetSearchMatch = 'auto' | 'exact' | 'substring'
export type FleetSearchPhase = 'bare' | 'dawn' | 'day' | 'dusk' | 'night' | 'zombie'

export interface ReflogRange {
  from: number | null
  to: number | null
}

export interface AgentResolveRequest {
  fragment: string
  scope?: FleetSearchScope
  expansion?: FleetSearchExpansion
  match?: FleetSearchMatch
  phase?: FleetSearchPhase | null
  position?: number
  range?: ReflogRange
}

export interface SearchFilters {
  filterExpression?: string
  from?: string
  to?: string
  agent?: string
  role?: string
  before?: string
  after?: string
  since?: string
  type?: string
  agentResolve?: AgentResolveRequest
  naturalAgentQuery?: string
}

export interface ParsedSearchQuery {
  query: string
  filters: SearchFilters
}

export interface FleetSearchPayloadFilters {
  agent?: string
  agentQuery?: string
  agentResolve?: AgentResolveRequest
  naturalAgentQuery?: string
  fromOnly?: boolean
  role?: string
  since?: string
  before?: string
  filterExpression?: string
  eventType?: string
}

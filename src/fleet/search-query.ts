// @ts-ignore — shared ESM module used by both Node and Vite.
export {
  buildFleetSearchFilters,
  groupFleetSearchResults,
  parseAgentSelector,
  parseSearchQuery,
  rankSearchResults,
  resolveTimeFilter,
} from '../../shared/fleet-search-query.mjs'

export type FleetSearchScope = 'any' | 'from' | 'to'
export type FleetSearchExpansion = 'stack' | 'self'
export type FleetSearchMatch = 'auto' | 'exact' | 'substring'

export interface ReflogRange {
  from: number | null
  to: number | null
}

export interface AgentResolveRequest {
  fragment: string
  scope?: FleetSearchScope
  expansion?: FleetSearchExpansion
  match?: FleetSearchMatch
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
  cwd?: string
  project?: string
  agentResolve?: AgentResolveRequest
  naturalAgentQuery?: string
  naturalAgentQueries?: string[]
  naturalTextQuery?: string
}

export interface ParsedSearchQuery {
  query: string
  filters: SearchFilters
}

export interface FleetSearchPayloadFilters {
  agent?: string
  me?: string
  agentQuery?: string
  agentResolve?: AgentResolveRequest
  naturalAgentQuery?: string
  naturalAgentQueries?: string[]
  naturalTextQuery?: string
  fromOnly?: boolean
  role?: string
  since?: string
  before?: string
  filterExpression?: string
  eventType?: string
  cwd?: string
  project?: string
  currentProject?: string
}

export interface FleetSearchResultGroup {
  id: string
  label: string
  detail: string
  results: any[]
}

import {
  buildFleetAgentFilter,
  buildFleetDmFilter,
} from '../../shared/filter-semantics.mjs'

export type FleetAgentFilterChoiceMode = 'dm' | 'agent'
export type FleetFilterUpdate = {
  filter: [string, string][][]
  trafficMode: 'normal'
}

export function fleetAgentFilterChoiceUpdate(
  humanLabel: string,
  label: string,
  mode: FleetAgentFilterChoiceMode,
): FleetFilterUpdate {
  const filter = mode === 'dm'
    ? buildFleetDmFilter(humanLabel, label) as [string, string][][]
    : buildFleetAgentFilter(label) as [string, string][][]
  return { filter, trafficMode: 'normal' }
}

import {
  FLEET_TEAM_FROM_ROLE,
  FLEET_TEAM_TO_ROLE,
} from '../../shared/filter-semantics.mjs'

export type FleetPillDropFilter = [string, string][][]

export function fleetFilterForPillDrop(
  pillType: string | undefined,
  value: string,
): FleetPillDropFilter {
  if (!value) return []
  if (pillType === 'team') {
    return [
      [[FLEET_TEAM_TO_ROLE, value]],
      [[FLEET_TEAM_FROM_ROLE, value]],
    ]
  }
  return [
    [['to', value]],
    [['from', value]],
  ]
}

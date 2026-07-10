import {
  defineHostedPanelApps,
  hostedPanelAppMap,
  hostedPanelDefaultProps,
  hostedPanelSizeMap,
  type HostedPanelAppDefinition,
} from '../wm/hosted-panel-registry'

export type FleetPanelType =
  | 'fleet-chat'
  | 'fleet-agents'
  | 'fleet-search'
  | 'fleet-docview'
  | 'fleet-source-editor'
  | 'fleet-inbox'
  | 'fleet-touch-inbox'
  | 'fleet-notifications'
  | 'fleet-video'

export type FleetPanelDefinition = HostedPanelAppDefinition<FleetPanelType>

export const FLEET_PANEL_DEFINITIONS = defineHostedPanelApps([
  { type: 'fleet-chat', defaultSize: { w: 400, h: 600 }, defaultProps: { filter: [] } },
  { type: 'fleet-agents', defaultSize: { w: 400, h: 500 } },
  { type: 'fleet-search', defaultSize: { w: 400, h: 300 } },
  { type: 'fleet-docview', defaultSize: { w: 400, h: 300 } },
  { type: 'fleet-source-editor', defaultSize: { w: 560, h: 520 }, defaultProps: { file: '', line: 1, title: 'Source' } },
  { type: 'fleet-inbox', defaultSize: { w: 360, h: 560 } },
  { type: 'fleet-touch-inbox', defaultSize: { w: 380, h: 680 } },
  { type: 'fleet-notifications', defaultSize: { w: 360, h: 220 } },
  { type: 'fleet-video', defaultSize: { w: 260, h: 172 }, defaultProps: { tileKeys: '[]' } },
] satisfies readonly FleetPanelDefinition[])

export const FLEET_PANEL_REGISTRY: ReadonlyMap<FleetPanelType, FleetPanelDefinition> =
  hostedPanelAppMap(FLEET_PANEL_DEFINITIONS)

/** Canonical list of fleet shape types — the single source of truth for
 *  ownership filtering, visibility, copy gating, and hit-test exclusion. */
export const FLEET_SHAPE_TYPES: Set<string> = new Set(FLEET_PANEL_DEFINITIONS.map(definition => definition.type))

export const FLEET_SHAPE_SELECTOR = [...FLEET_SHAPE_TYPES]
  .map(type => `[data-shape-type="${type}"]`)
  .join(', ')

export const FLEET_INTERACTION_SHAPE_SELECTOR = `${FLEET_SHAPE_SELECTOR}, [data-shape-type="fleet-pill"]`

/** Panel dimensions per fleet tool — shared by tools and cursor ghost preview. */
export const FLEET_TOOL_DIMS: Record<string, { w: number; h: number }> =
  hostedPanelSizeMap(FLEET_PANEL_DEFINITIONS)

export function fleetPanelDefaultProps(type: string): Record<string, unknown> {
  return hostedPanelDefaultProps(FLEET_PANEL_REGISTRY, type)
}

export type FleetOwnerProps = Record<string, unknown> & { userId?: string; deviceId?: string }

export function shouldRepairFleetPanelOwnership(isFleetPanel: boolean, props: FleetOwnerProps): boolean {
  return isFleetPanel && (!props.userId || !props.deviceId)
}

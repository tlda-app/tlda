type FleetAgentCountInput = {
  dead?: boolean
  human?: boolean
  runtime_status?: { status?: string }
}

export function countAwakeFleetAgents(agents: FleetAgentCountInput[]): number {
  return agents.filter(agent => !agent.dead && !agent.human && agent.runtime_status?.status === 'awake').length
}

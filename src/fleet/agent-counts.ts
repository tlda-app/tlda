type FleetAgentCountInput = {
  dead?: boolean
  human?: boolean
  status?: string
}

export function countAwakeFleetAgents(agents: FleetAgentCountInput[]): number {
  return agents.filter(agent => !agent.dead && !agent.human && agent.status === 'awake').length
}

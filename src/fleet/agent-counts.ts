type FleetAgentCountInput = {
  dead?: boolean
  human?: boolean
  runtime_status?:
    | { kind: 'human'; status: 'here' | 'away' }
    | { kind: 'ai'; status: 'awake' | 'hibernating' | 'dead' }
}

export function countAwakeFleetAgents(agents: FleetAgentCountInput[]): number {
  return agents.filter(agent => !agent.dead && !agent.human && agent.runtime_status?.status === 'awake').length
}

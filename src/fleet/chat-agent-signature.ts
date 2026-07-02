export function chatAgentSignature(agents: any[]): string {
  return JSON.stringify(agents.map((a: any) => [
    a.id,
    a.friendly_name,
    a.name,
    !!a.human,
    !!a.dead,
    a.is_manager,
    a.labels || [],
    a.metadata?.inPlanMode,
    a.metadata?.permission_mode,
    a.metadata?.planModeType,
  ]))
}

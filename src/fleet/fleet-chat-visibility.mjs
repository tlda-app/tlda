// Terminal routing is agent-id -> current durable seat. tmux_session is no
// longer server roster truth, so requiring it hides valid awake terminals.
export function isTerminalAvailableForAgent(agent) {
  return !!agent?.id && !agent?.dead && !agent?.hibernating && agent?.status !== 'hibernating' && agent?.status !== 'shell'
}

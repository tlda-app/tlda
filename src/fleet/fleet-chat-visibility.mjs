import { isRuntimeHibernating, isTerminalRoutable, runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

// Terminal routing is agent-id -> current durable seat. tmux_session is no
// longer server roster truth, so requiring it hides valid awake terminals.
export function isTerminalAvailableForAgent(agent) {
  const status = runtimeStatusName(agent)
  return !!agent?.id && !agent?.dead && !agent?.hibernating && status !== 'shell' && !isRuntimeHibernating(agent) && isTerminalRoutable(agent)
}

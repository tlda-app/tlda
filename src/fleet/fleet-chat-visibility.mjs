import { isTerminalRoutable, runtimeStatusName } from '../../shared/fleet-runtime-status.mjs'

// Terminal routing is agent-id -> current durable seat. tmux_session is no
// longer server roster truth, so requiring it hides valid awake terminals.
// Hibernation does NOT hide the terminal: a hibernating agent's pane still
// exists and is exactly what the user needs to inspect when something is
// stuck (Skip, 7/17: "there is a terminal hover so that I can see the
// terminal because shit breaks sometimes"). Routability is the criterion.
export function isTerminalAvailableForAgent(agent) {
  const status = runtimeStatusName(agent)
  return !!agent?.id && !agent?.dead && status !== 'shell' && isTerminalRoutable(agent)
}

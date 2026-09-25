// A stored hibernating flag never vetoes observation: hibernating means no
// running process, so a binding with a terminal session is observable and the
// read itself (pane capture / session list) determines liveness at that moment.
// Gating the scan on the flag is a self-reinforcing loop — only a scan can
// clear a wrong flag, so a skipped scan sticks it forever.
export function isObservableDaemonProcessBinding(binding) {
  return !!binding && !binding.dead && !binding.human && !!binding.tmux_session
}

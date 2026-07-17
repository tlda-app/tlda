export function isObservableDaemonProcessBinding(binding) {
  return !!binding && !binding.dead && !binding.human && !binding.hibernating && !!binding.tmux_session
}

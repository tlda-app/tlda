export function assertCodexKickoffDelivered(delivered, tmuxSession) {
  if (delivered) return
  const error = new Error(`Codex fleet kickoff was not delivered in tmux session ${tmuxSession}`)
  error.name = 'SpawnError'
  error.code = 'launch-failed'
  error.reason = 'launch-failed'
  error.detail = { tmuxSession }
  throw error
}

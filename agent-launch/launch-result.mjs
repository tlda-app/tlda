import fs from 'fs'
import path from 'path'

// A codex kickoff that misses its deadline is the one launch failure with no
// reader. `injectCodexPrompt` withdraws the prompt on the way out -- it sends
// C-u so nothing is left half-typed in the composer -- and then throws, in the
// CLI process that ran the mint. The daemon never sees it: measured
// 2026-09-13 on `fleet-daemon.testing.log`, `failed` appears 330 times and
// `SpawnError` zero.
//
// So the throw reaches one terminal and no file, while what it leaves behind is
// a mint with `joined_at` NULL and a live codex process parked at an unused
// prompt. From outside that is indistinguishable from an agent nobody started,
// which is how 15 of them accumulated over 12 days with nobody able to say why.
//
// This writes the reason where the rest of that agent's launch diagnostics
// already go -- the per-agent spawn crash log -- rather than opening a second
// place to look. Best-effort by construction: a launch is already failing here,
// and a diagnostic that can raise its own error would replace that failure with
// a worse one.
export function recordKickoffFailure(tmuxSession, crashLogPath, detail = {}, event = 'codex-kickoff-not-delivered') {
  if (!crashLogPath) return false
  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true })
    const line = JSON.stringify({
      t: new Date().toISOString(),
      event,
      tmux_session: tmuxSession || null,
      pid: process.pid,
      ...detail,
    })
    fs.appendFileSync(crashLogPath, `\n=== ${event} ${new Date().toISOString()} session=${tmuxSession} ===\n${line}\n`)
    return true
  } catch {
    return false
  }
}

export function assertCodexKickoffDelivered(delivered, tmuxSession, { crashLogPath = null, detail = {} } = {}) {
  if (delivered) return
  recordKickoffFailure(tmuxSession, crashLogPath, detail)
  const error = new Error(`Codex fleet kickoff was not delivered in tmux session ${tmuxSession}`)
  error.name = 'SpawnError'
  error.code = 'launch-failed'
  error.reason = 'launch-failed'
  error.detail = { tmuxSession }
  throw error
}

export function assertAgyKickoffDelivered(delivered, tmuxSession, { crashLogPath = null, detail = {} } = {}) {
  if (delivered) return
  recordKickoffFailure(tmuxSession, crashLogPath, detail, 'agy-kickoff-not-delivered')
  const stage = typeof detail?.stage === 'string' && detail.stage ? ` (stage: ${detail.stage})` : ''
  const error = new Error(`agy fleet kickoff was not delivered in tmux session ${tmuxSession}${stage}`)
  error.name = 'SpawnError'
  error.code = 'launch-failed'
  error.reason = 'launch-failed'
  error.detail = { tmuxSession, ...detail }
  throw error
}

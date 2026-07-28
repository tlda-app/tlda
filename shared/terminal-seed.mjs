import { exactTmuxWindowTarget } from './tmux-target.mjs'

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g

function normalizeLineCount(lines, defaultLines = 50, maxLines = 5000) {
  return Math.max(1, Math.min(parseInt(lines, 10) || defaultLines, maxLines))
}

export function terminalVisibleCaptureArgs(tmuxSession, { ansi = false } = {}) {
  const args = ['capture-pane', '-t', exactTmuxWindowTarget(tmuxSession), '-p']
  if (ansi) args.push('-e')
  return args
}

export function terminalBackscrollCaptureArgs(tmuxSession, lines, { ansi = false, defaultLines = 50, maxLines = 5000 } = {}) {
  const start = `-${normalizeLineCount(lines, defaultLines, maxLines)}`
  const args = ['capture-pane', '-t', exactTmuxWindowTarget(tmuxSession), '-p']
  if (ansi) args.push('-e')
  args.push('-S', start)
  return args
}

export function trimTerminalSeedBlankRows(text) {
  const lines = String(text || '').split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1].replace(ANSI_RE, '').trim() === '') {
    lines.pop()
  }
  return lines.join('\n') + '\n'
}

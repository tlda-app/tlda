const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function trimTerminalSeedBlankRows(text) {
  const lines = String(text || '').split(/\r?\n/)
  while (lines.length > 1 && lines[lines.length - 1].replace(ANSI_RE, '').trim() === '') {
    lines.pop()
  }
  return lines.join('\n') + '\n'
}

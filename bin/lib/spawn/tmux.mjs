import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export function tmuxArgs(tmuxSocket, ...args) {
  return [...(tmuxSocket ? ['-L', tmuxSocket] : []), ...args]
}

async function tmux(tmuxSocket, ...args) {
  return execFileP('tmux', tmuxArgs(tmuxSocket, ...args), {
    timeout: 5000,
    encoding: 'utf8',
    env: { ...process.env, TMUX: '' },
  })
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

async function enableCrashCapture(session, logPath, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `\n=== spawn ${new Date().toISOString()} session=${session} ===\n`)
  try { await tmux(tmuxSocket, 'set-option', '-t', session, 'remain-on-exit', 'on') } catch {
    // Diagnostic only; the launch should continue even if tmux cannot preserve panes.
  }
  try { await tmux(tmuxSocket, 'pipe-pane', '-o', '-t', session, `cat >> ${shellQuote(logPath)}`) } catch {
    // Diagnostic only; startup probing still provides the slower fallback.
  }
}

async function pasteLiteral(session, text, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const buffer = `tlda-prompt-${process.pid}-${Date.now()}`
  await tmux(tmuxSocket, 'set-buffer', '-b', buffer, text)
  await tmux(tmuxSocket, 'paste-buffer', '-dp', '-b', buffer, '-t', session)
}

async function sendLiteral(session, text, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const chunkSize = 800
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    await tmux(tmuxSocket, 'send-keys', '-t', session, '-l', text.slice(offset, offset + chunkSize))
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export async function uniqueSessionName(base, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  let session = base
  let n = 2
  while (true) {
    try {
      await tmux(tmuxSocket, 'has-session', '-t', session)
      session = `${base}-${n++}`
    } catch {
      return session
    }
  }
}

export async function sessionHasRuntime(session, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  try {
    const panes = await tmux(tmuxSocket, 'list-panes', '-t', session, '-F', '#{pane_pid}')
    const panePids = panes.stdout.trim().split(/\s+/).filter(Boolean)
    if (!panePids.length) return false
    const ps = await execFileP('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' })
    const children = new Map()
    const argsByPid = new Map()
    for (const line of ps.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const [, pid, ppid, args] = m
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(pid)
      argsByPid.set(pid, args)
    }
    const stack = [...panePids]
    const seen = new Set()
    while (stack.length) {
      const pid = stack.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      const args = argsByPid.get(pid) || ''
      if (/(?:^|\s|\/)(claude|codex|goose)(?:\s|$)/.test(args)) return true
      stack.push(...(children.get(pid) || []))
    }
  } catch {
    // Missing tmux sessions or ps failures mean no confirmed runtime.
  }
  return false
}

export async function spawnTmux(session, cwd, cmd, { autoDismiss = true, sendKeys = false, tmuxSocket = process.env.TMUX_SOCKET || null, crashLogPath = null } = {}) {
  const launchViaShell = sendKeys || !!crashLogPath
  try {
    const args = ['respawn-pane', '-t', session, '-c', cwd]
    if (!launchViaShell) args.push(cmd)
    await tmux(tmuxSocket, ...args)
  } catch {
    if (await sessionHasRuntime(session, { tmuxSocket })) return false
    try { await tmux(tmuxSocket, 'kill-session', '-t', session) } catch {
      // Stale-session cleanup is best effort before creating a fresh session.
    }
    const args = ['new-session', '-d', '-s', session, '-c', cwd]
    if (!launchViaShell) args.push(cmd)
    await tmux(tmuxSocket, ...args)
    try { await tmux(tmuxSocket, 'set-option', '-t', session, 'remain-on-exit', 'on') } catch {
      // remain-on-exit is diagnostic only; launch success does not depend on it.
    }
  }
  await enableCrashCapture(session, crashLogPath, { tmuxSocket })
  await tmux(tmuxSocket, 'set-option', '-t', session, 'window-size', 'manual')
  await tmux(tmuxSocket, 'resize-window', '-t', session, '-x', '120', '-y', '40')
  if (launchViaShell) {
    const script = path.join(os.tmpdir(), `tlda-launch-${process.pid}-${Date.now()}.sh`)
    fs.writeFileSync(script, `${cmd}\n`, { mode: 0o600 })
    await tmux(tmuxSocket, 'send-keys', '-t', session, '--', `source ${script}`)
    await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
  }
  if (autoDismiss) dismissDevchannels(session, { tmuxSocket }).catch(() => {})
  return true
}

export function claudeStartupDialogAction(pane = '') {
  if (/development[- ]channels/i.test(pane) && pane.includes('Enter to confirm')) return 'devchannels'
  if (pane.includes('Resume from summary')) return 'resume-full'
  if (pane.includes('Allow external CLAUDE.md file imports') && pane.includes('Enter to confirm')) return 'allow-external-imports'
  return null
}

async function dismissClaudeStartupDialog(session, action, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  if (action === 'devchannels' || action === 'allow-external-imports') {
    await tmux(tmuxSocket, 'send-keys', '-t', session, '1')
  } else if (action === 'resume-full') {
    await tmux(tmuxSocket, 'send-keys', '-t', session, '2')
  } else {
    return false
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
  return true
}

export async function dismissDevchannels(session, { timeoutMs = 60_000, tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const deadline = Date.now() + timeoutMs
  const noDialogOkAt = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmux(tmuxSocket, 'capture-pane', '-t', session, '-p')
      const action = claudeStartupDialogAction(stdout)
      if (action) {
        await dismissClaudeStartupDialog(session, action, { tmuxSocket })
        return true
      }
      const promptReady = stdout.split('\n').slice(-3).some((line) => line.includes('❯'))
      if (Date.now() > noDialogOkAt && promptReady && !stdout.includes('Enter to confirm')) return false
    } catch {
      // Dialog polling tolerates transient tmux capture failures until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

export async function injectCodexPrompt(session, prompt, { timeoutMs = 60_000, tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const deadline = Date.now() + timeoutMs
  const promptMarker = prompt.slice(0, Math.min(prompt.length, 48))
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmux(tmuxSocket, 'capture-pane', '-t', session, '-p')
      if (stdout.includes('Do you trust the contents of this directory?')) {
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      const promptReady = stdout.split('\n').some((line) => line.trimStart().startsWith('›'))
      const busy = ['Working', 'Transmuting', 'Thinking'].some((marker) => stdout.includes(marker))
      if (promptReady && !busy) {
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'Escape')
        await new Promise((resolve) => setTimeout(resolve, 200))
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'C-u')
        await new Promise((resolve) => setTimeout(resolve, 200))
        await sendLiteral(session, prompt, { tmuxSocket })
        await new Promise((resolve) => setTimeout(resolve, 500))
        const pasted = await tmux(tmuxSocket, 'capture-pane', '-t', session, '-p').catch(() => ({ stdout: '' }))
        if (!pasted.stdout.includes(promptMarker)) continue
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return true
      }
    } catch {
      // Prompt polling tolerates transient tmux capture failures until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

export async function injectClaudePrompt(session, prompt, { timeoutMs = 60_000, tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const deadline = Date.now() + timeoutMs
  await dismissDevchannels(session, { timeoutMs: Math.min(15_000, timeoutMs), tmuxSocket })
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmux(tmuxSocket, 'capture-pane', '-t', session, '-p')
      const action = claudeStartupDialogAction(stdout)
      if (action) {
        await dismissClaudeStartupDialog(session, action, { tmuxSocket })
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      const lower = stdout.toLowerCase()
      if (stdout.includes('Paste text') || lower.includes('paste mode')) {
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      const promptReady = stdout.split('\n').slice(-5).some((line) => line.includes('❯'))
      const busy = ['Thinking', 'Working', 'ESC to interrupt'].some((marker) => stdout.includes(marker))
      if (promptReady && !busy) {
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'C-u')
        await new Promise((resolve) => setTimeout(resolve, 200))
        await tmux(tmuxSocket, 'send-keys', '-t', session, prompt)
        await new Promise((resolve) => setTimeout(resolve, 300))
        await tmux(tmuxSocket, 'send-keys', '-t', session, 'Enter')
        return true
      }
    } catch {
      // Prompt polling tolerates transient tmux capture failures until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

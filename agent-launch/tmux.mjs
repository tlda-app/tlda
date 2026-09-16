import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { exactTmuxTarget, exactTmuxTargets, exactTmuxWindowTarget } from '../shared/tmux-target.mjs'
import { AGY_APPROVAL_RE, AGY_TRUST_DIALOG_RE, composerState as paneComposerState, dialogAwaitingKeypress, kickoffMarker } from '../agent-runtime/status-classifier.mjs'
import { parseProcessTree, walkSubtree } from './process-tree.mjs'

const execFileP = promisify(execFile)
const AGENT_NICE_INCREMENT = 5

export function tmuxArgs(tmuxSocket, ...args) {
  return [...(tmuxSocket ? ['-L', tmuxSocket] : []), ...args]
}

async function tmux(tmuxSocket, ...args) {
  return execFileP('tmux', tmuxArgs(tmuxSocket, ...exactTmuxTargets(args)), {
    timeout: 5000,
    encoding: 'utf8',
    env: { ...process.env, TMUX: '' },
  })
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function nicedAgentCommand(cmd) {
  return `exec /usr/bin/nice -n ${AGENT_NICE_INCREMENT} /bin/zsh -lc ${shellQuote(cmd)}`
}

async function enableCrashCapture(session, logPath, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `\n=== spawn ${new Date().toISOString()} session=${session} ===\n`)
  try { await tmux(tmuxSocket, 'pipe-pane', '-o', '-t', exactTmuxTarget(session), `cat >> ${shellQuote(logPath)}`) } catch {
    // Diagnostic only; startup probing still provides the slower fallback.
  }
}

async function pasteLiteral(session, text, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  const buffer = `tlda-prompt-${process.pid}-${Date.now()}`
  await tmux(tmuxSocket, 'set-buffer', '-b', buffer, text)
  await tmux(tmuxSocket, 'paste-buffer', '-dp', '-b', buffer, '-t', exactTmuxTarget(session))
}

export async function uniqueSessionName(base, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  let session = base
  let n = 2
  while (true) {
    try {
      await tmux(tmuxSocket, 'has-session', '-t', exactTmuxTarget(session))
      session = `${base}-${n++}`
    } catch {
      return session
    }
  }
}

export function runtimeStateFromProcessList(panePids, psText) {
  const { children, argsByPid } = parseProcessTree(psText)
  // FIRST match in traversal order, not a uniqueness requirement -- unlike the
  // harness resolvers, which share the walk but demand exactly one.
  for (const pid of walkSubtree(panePids, children)) {
    const args = argsByPid.get(pid) || ''
    if (/(?:^|\s|[/\\])(agy|claude|codex|goose|muse(?:-bin-[\w.-]+)?)(?:\.exe)?(?:\s|$)/.test(args)
      || /(?:^|\s|[/\\])node(?:\.exe)?(?:\s|$).*?\.mjs\b/.test(args)) {
      const envValue = name => {
        const match = args.match(
          new RegExp(`(?:^|\\s)(?:mcp_servers\\.tlda\\.env\\.)?${name}=(?:"([^"]+)"|'([^']+)'|([^\\s]+))`),
        )
        return match ? (match[1] || match[2] || match[3] || null) : null
      }
      const daemonKey = envValue('FLEET_DAEMON_KEY')
      const fleetId = envValue('FLEET_ID')
      const envName = envValue('TLDA_ENV')
      const mcp = walkSubtree(children.get(pid) || [], children)
        .some(child => /mcp-server[/\\](?:index|fleet-server)\.mjs|(?:^|[/\\])tlda-mcp(?:\s|$)/.test(argsByPid.get(child) || ''))
      return { runtime: true, mcp, daemonKey, fleetId, envName }
    }
  }
  return { runtime: false, mcp: false, daemonKey: null, fleetId: null, envName: null }
}

// `probed` says whether this answer is an observation or a failure to observe.
// `runtime: false` alone cannot tell those apart: it is returned both when tmux
// answered and the session has no runtime, and when the catch below fired
// because tmux was missing or `ps` blew its 5s timeout. Every caller that only
// reads `runtime` treats "I could not look" as "nothing is there", which is
// safe for a retry and unsafe for anything destructive -- and the two diverge
// exactly under load, when `ps` is slowest and the wrong answer is likeliest.
// A caller about to do something irreversible must require `probed`.
export async function sessionRuntimeState(session, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  try {
    const panes = await tmux(tmuxSocket, 'list-panes', '-t', exactTmuxTarget(session), '-F', '#{pane_pid}')
    const panePids = panes.stdout.trim().split(/\s+/).filter(Boolean)
    // tmux answered and the session has no panes. That is an observation.
    if (!panePids.length) return { runtime: false, mcp: false, daemonKey: null, fleetId: null, envName: null, probed: true }
    const ps = await execFileP('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' })
    return { ...runtimeStateFromProcessList(panePids, ps.stdout), probed: true }
  } catch {
    // Missing tmux sessions or ps failures mean no confirmed runtime.
  }
  return { runtime: false, mcp: false, daemonKey: null, fleetId: null, envName: null, probed: false }
}

export async function sessionHasRuntime(session, options = {}) {
  return (await sessionRuntimeState(session, options)).runtime
}

// Which tmux sessions exist, and whether that list is an observation.
//
// `sessionRuntimeState` cannot answer "this session does not exist": its probe
// starts with `list-panes -t <session>`, which fails identically for a session
// that is absent and for a tmux that could not be reached, so both come back
// `probed: false`. A caller deciding whether to spawn needs those apart -- the
// first is proof of absence and the second is proof of nothing.
//
// `no server running` is tmux answering the question: there are no sessions at
// all. Any other failure is a failure to look.
export async function listSessionNames({ tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  try {
    const { stdout } = await tmux(tmuxSocket, 'list-sessions', '-F', '#{session_name}')
    return { probed: true, names: stdout.split('\n').map(line => line.trim()).filter(Boolean) }
  } catch (error) {
    const text = `${error?.stderr || ''} ${error?.message || ''}`
    if (/no server running|no sessions/i.test(text)) return { probed: true, names: [] }
    return { probed: false, names: [] }
  }
}

// Did we observe that nothing is running, as opposed to failing to observe?
// Only a completed probe can answer yes. Callers about to do something
// irreversible -- retiring an identity, marking a seat dead -- must ask this
// rather than negating `runtime`, because `!runtime` is also true when the probe
// never ran.
export function sessionConfirmedDead(state) {
  return !!state?.probed && !state.runtime
}

export async function terminateTmuxSession(session, { tmuxSocket = process.env.TMUX_SOCKET || null } = {}) {
  if (!session) return true
  try {
    await tmux(tmuxSocket, 'kill-session', '-t', exactTmuxTarget(session))
    return true
  } catch {
    try {
      await tmux(tmuxSocket, 'has-session', '-t', exactTmuxTarget(session))
      return false
    } catch {
      return true
    }
  }
}

export async function spawnTmux(session, cwd, cmd, { autoDismiss = true, sendKeys = false, tmuxSocket = process.env.TMUX_SOCKET || null, crashLogPath = null } = {}) {
  const launchViaShell = sendKeys || !!crashLogPath
  const launchCommand = nicedAgentCommand(cmd)
  try {
    const args = ['respawn-pane', '-t', exactTmuxTarget(session), '-c', cwd]
    if (!launchViaShell) args.push(launchCommand)
    await tmux(tmuxSocket, ...args)
  } catch {
    if (await sessionHasRuntime(session, { tmuxSocket })) return false
    try {
      await tmux(tmuxSocket, 'has-session', '-t', exactTmuxTarget(session))
      // A generic launch operation never deletes an existing session, even a
      // shell-only or otherwise unusable one. Its owner must decide whether an
      // explicitly destructive lifecycle operation is appropriate.
      return false
    } catch {
      // No existing session: safe to create a new one.
    }
    const args = ['new-session', '-d', '-s', session, '-c', cwd]
    if (!launchViaShell) args.push(launchCommand)
    await tmux(tmuxSocket, ...args)
  }
  await enableCrashCapture(session, crashLogPath, { tmuxSocket })
  await tmux(tmuxSocket, 'set-option', '-t', exactTmuxTarget(session), 'window-size', 'manual')
  await tmux(tmuxSocket, 'resize-window', '-t', exactTmuxTarget(session), '-x', '120', '-y', '40')
  if (launchViaShell) {
    const script = path.join(os.tmpdir(), `tlda-launch-${process.pid}-${Date.now()}.sh`)
    fs.writeFileSync(script, `${launchCommand}\n`, { mode: 0o600 })
    await tmux(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), '--', `source ${script}`)
    await tmux(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'Enter')
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

async function dismissClaudeStartupDialog(session, action, {
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (action === 'devchannels' || action === 'allow-external-imports') {
    await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), '1')
  } else if (action === 'resume-full') {
    await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), '2')
  } else {
    return false
  }
  await sleep(500)
  await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'Enter')
  return true
}

export async function dismissDevchannels(session, {
  timeoutMs = 60_000,
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  noDialogGraceMs = 8000,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const noDialogOkAt = Date.now() + noDialogGraceMs
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxTarget(session), '-p')
      const action = claudeStartupDialogAction(stdout)
      if (action) {
        await dismissClaudeStartupDialog(session, action, { tmuxSocket, tmuxExec, sleep })
        return true
      }
      const promptReady = stdout.split('\n').slice(-3).some((line) => line.includes('❯'))
      if (Date.now() > noDialogOkAt && promptReady && !stdout.includes('Enter to confirm')) return false
    } catch {
      // Dialog polling tolerates transient tmux capture failures until timeout.
    }
    await sleep(500)
  }
  return false
}

// Codex drives its composer through the window target; Claude through the plain
// session target. The injectors have always differed here, so anything else
// reading the same composer has to differ the same way or it reads a pane the
// keypresses are not going to.
function composerTarget(harnessKind, session) {
  return harnessKind === 'codex' ? exactTmuxWindowTarget(session) : exactTmuxTarget(session)
}

// A live harness whose composer still holds OUR kickoff never started. Press
// Enter -- that is the entire remedy -- and report what was seen and whether it
// took.
//
// It reports the pane it read and when, because the caller's job is to show that
// rather than to name a symptom: a kickoff sitting at the prompt is obvious on
// sight and opaque as a description. And it is bounded to the marker we sent, so
// it never submits a placeholder hint or something a person typed and has not
// sent.
export async function submitParkedKickoff(session, harnessKind, prompt, {
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmMs = 4000,
} = {}) {
  const target = composerTarget(harnessKind, session)
  const marker = kickoffMarker(prompt)
  // `-e` keeps the attributes, and they are the only thing that distinguishes a
  // parked kickoff from a DIM GHOST of one -- a restored unsent draft or a
  // placeholder hint. Without it this function would press Enter at an empty
  // buffer and then report a healthy agent as never started.
  const read = async () => {
    const { stdout } = await tmuxExec(tmuxSocket, 'capture-pane', '-t', target, '-p', '-e')
    return String(stdout || '')
  }
  const composer = (pane) => paneComposerState(harnessKind, pane, marker, { escapes: true })
  let pane
  try {
    pane = await read()
  } catch (error) {
    // Could not look. That is not an observation of a healthy agent, and saying
    // so is the whole point of carrying it separately.
    return { observed: false, observedAt: new Date().toISOString(), pane: null, parked: false, submitted: false, error: error?.message || String(error) }
  }
  const observedAt = new Date().toISOString()
  const state = composer(pane)
  if (!state.containsMarker || state.busyAfter) {
    return { observed: true, observedAt, pane, parked: false, submitted: false }
  }
  // Our kickoff is there. That still does not say the composer has FOCUS.
  // Enter goes to the focused widget, so if a dialog is up this keystroke
  // answers the dialog -- measured on a probe with three queued kickoffs and a
  // dev-channels prompt whose highlighted default was "I am using this for local
  // development". Refuse, name it, and let the caller show the pane: a launcher
  // may not answer a question it cannot read, and that ruling has to bind the
  // code and not just the plan.
  //
  // RAW `pane`, deliberately -- not the ghost-stripped text `composer()` reads
  // two lines up. These two lines read the same variable through different
  // filters on purpose: a safety check does not take a lossily filtered input.
  // It was load-bearing while a greyscale range lived in the ghost filter, which
  // deleted the trust dialog's own `1.` and let this check pass on the pane it
  // exists to catch; that range is reverted, so today it is belt-and-braces.
  if (dialogAwaitingKeypress(pane)) {
    return { observed: true, observedAt, pane, parked: true, submitted: false, blockedByDialog: true }
  }
  await tmuxExec(tmuxSocket, 'send-keys', '-t', target, 'Enter').catch(() => {})
  const deadline = Date.now() + confirmMs
  while (Date.now() < deadline) {
    await sleep(500)
    let after
    try {
      after = await read()
    } catch {
      continue
    }
    const post = composer(after)
    if (post.busyAfter || (post.promptIndex >= 0 && !post.containsMarker)) {
      return { observed: true, observedAt, pane, parked: true, submitted: true, paneAfter: after }
    }
  }
  // Still parked. The kickoff stays where it is: this is the one place that
  // must NOT clear the composer, because nothing else holds the text and
  // clearing it would destroy the only copy of what the agent was asked to do.
  return { observed: true, observedAt, pane, parked: true, submitted: false, paneAfter: await read().catch(() => null) }
}

export async function injectCodexPrompt(session, prompt, {
  timeoutMs = 60_000,
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs
  const promptMarker = kickoffMarker(prompt)
  const composerState = (pane = '') => paneComposerState('codex', pane, promptMarker)
  // The status line says `model: loading` until the model is up. Read the LAST
  // status line, never the whole pane: a resumed Codex pane carries the previous
  // process's transcript, so a stale `model: loading` sits in scrollback under a
  // live ready footer and a whole-pane test blocks forever on it.
  //
  // Asking whether the last status line says loading -- rather than whether it
  // says ready -- is deliberate. `model: loading` is the only positive not-ready
  // signal Codex emits; a loaded model's footer varies with effort and provider,
  // so treating an absent ` default ·` as not-ready hangs on every model that
  // never prints one.
  // Padding is part of this. Codex's STARTUP SPLASH aligns its fields --
  // `model:     loading`, beside `directory: loading` -- while the bottom status
  // line writes the compact `model: loading`. A literal match on the compact
  // form sees nothing during the splash, and "no status line at all" then reads
  // as ready, so the paste went in while the model was genuinely still loading.
  // Measured: 1 run in 6 at a 3s deadline, with the splash still on screen.
  const MODEL_LOADING_RE = /model:\s+loading/
  const modelLoading = (pane = '') => {
    const status = pane.split('\n').findLast((line) =>
      MODEL_LOADING_RE.test(line) || (line.includes(' default') && line.includes('·')))
    return !!status && MODEL_LOADING_RE.test(status)
  }
  // Nothing may abandon this function with the prompt sitting in the composer.
  // A parked prompt is indistinguishable from a dead mint from the outside --
  // the process is alive, the session exists, and no turn was ever produced --
  // so an attempt that cannot finish leaves the composer as it found it, and the
  // caller's launch failure is then the truth about the agent.
  //
  // The keystrokes are in the composer from the moment they are sent, whether or
  // not a capture has rendered them yet -- so this is tracked on having pasted,
  // never on having SEEN the paste. Measured: gating it on the capture left 1 run
  // in 3 parked at a 3s deadline, because the retry path below abandons a paste
  // the capture had not caught up with.
  let pasted = false
  const abandonAfterPaste = async () => {
    if (!pasted) return false
    await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), 'C-u').catch(() => {})
    return false
  }
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxWindowTarget(session), '-p')
      const visibleTail = stdout.split('\n').slice(-20).join('\n')
      const updateDialog = visibleTail.includes('Update available!')
        && visibleTail.includes('Skip until next version')
        && visibleTail.includes('Press enter to continue')
      if (updateDialog) {
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), '2')
        await sleep(200)
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), 'Enter')
        await sleep(500)
        continue
      }
      // A resumed Codex pane contains its durable transcript. Startup warnings
      // in that transcript may belong to the previous process, so they cannot
      // decide whether this prompt delivery succeeded. The paste-marker check
      // below is the authority for delivery in the current process.
      const promptReady = stdout.split('\n').some((line) => line.trimStart().startsWith('›'))
      const busy = ['Working', 'Transmuting', 'Thinking', 'esc to interrupt', 'ESC to interrupt'].some((marker) => stdout.includes(marker))
      const mcpStarting = stdout.includes('Starting MCP servers')
      // Wait for the model BEFORE pasting, not after. Waiting after the paste is
      // what parked prompts in the composer: the wait shared one deadline with
      // harness startup, MCP startup and the paste, so on a loaded box it was
      // the wait that ran out of budget -- and it ran out holding a full
      // composer that nothing ever submitted. Gating the paste on the same
      // signal costs the same wait and cannot produce that state.
      if (promptReady && !busy && !mcpStarting && !modelLoading(stdout)) {
        // Escape cancels Codex MCP startup even after the prompt first appears.
        // A directly observed ready prompt is cleared with C-u; Escape is never a startup action.
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), 'C-u')
        await sleep(200)
        pasted = true
        for (let offset = 0; offset < prompt.length; offset += 800) {
          await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), '-l', prompt.slice(offset, offset + 800))
          await sleep(25)
        }
        await sleep(500)
        const shown = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxWindowTarget(session), '-p').catch(() => ({ stdout: '' }))
        // Not visible yet. Retrying is safe -- the next attempt opens with C-u --
        // but the text is already in there, so the exit below has to clear it.
        if (!composerState(shown.stdout).containsMarker) continue
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), 'Enter')
        while (Date.now() < deadline) {
          await sleep(500)
          let submitted
          try {
            submitted = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxWindowTarget(session), '-p')
          } catch {
            continue
          }
          const state = composerState(submitted.stdout)
          if (state.busyAfter) return true
          if (state.promptIndex >= 0 && !state.containsMarker) return true
          // Still in the composer. Re-send Enter rather than waiting it out: a
          // submitted prompt has already left the composer, so Enter on an empty
          // one does nothing, which makes the retry safe to repeat.
          await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxWindowTarget(session), 'Enter').catch(() => {})
        }
        return await abandonAfterPaste()
      }
    } catch {
      // Prompt polling tolerates transient tmux capture failures until timeout.
    }
    await sleep(1000)
  }
  // Out of budget. If anything was ever pasted it is still in the composer, and
  // this is the last chance to take it back out.
  return await abandonAfterPaste()
}

export async function injectClaudePrompt(session, prompt, {
  timeoutMs = 60_000,
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dialogGraceMs = null,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const promptMarker = kickoffMarker(prompt)
  const composerState = (pane = '') => paneComposerState('claude', pane, promptMarker)
  await dismissDevchannels(session, {
    timeoutMs: Math.min(15_000, timeoutMs),
    tmuxSocket,
    tmuxExec,
    sleep,
    ...(dialogGraceMs === null ? {} : { noDialogGraceMs: dialogGraceMs }),
  })
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxTarget(session), '-p')
      const action = claudeStartupDialogAction(stdout)
      if (action) {
        await dismissClaudeStartupDialog(session, action, { tmuxSocket })
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      const lower = stdout.toLowerCase()
      if (stdout.includes('Paste text') || lower.includes('paste mode')) {
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'Enter')
        await sleep(500)
        continue
      }
      const promptReady = stdout.split('\n').slice(-5).some((line) => line.includes('❯'))
      const busy = ['Thinking', 'Working', 'ESC to interrupt'].some((marker) => stdout.includes(marker))
      if (promptReady && !busy) {
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'C-u')
        await sleep(200)
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), prompt)
        await sleep(300)
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'Enter')
        // Confirm the submission instead of assuming it. This used to `return
        // true` here, having looked at nothing after the keypress -- so a
        // kickoff parked in Claude's composer reported as delivered and every
        // caller believed it. Codex at least knew when it had failed.
        while (Date.now() < deadline) {
          await sleep(500)
          let submitted
          try {
            submitted = await tmuxExec(tmuxSocket, 'capture-pane', '-t', exactTmuxTarget(session), '-p')
          } catch {
            continue
          }
          const state = composerState(submitted.stdout)
          if (state.busyAfter) return true
          if (state.promptIndex >= 0 && !state.containsMarker) return true
          // A submitted prompt has already left the composer, so Enter on an
          // empty one does nothing, which makes the retry safe to repeat.
          await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'Enter').catch(() => {})
        }
        // Never abandon a loaded composer: see injectCodexPrompt.
        await tmuxExec(tmuxSocket, 'send-keys', '-t', exactTmuxTarget(session), 'C-u').catch(() => {})
        return false
      }
    } catch {
      // Prompt polling tolerates transient tmux capture failures until timeout.
    }
    await sleep(1000)
  }
  return false
}

// agy shows a workspace trust dialog on first launch per cwd ("Do you trust
// the contents of this project?", default-highlight Yes). Confirming it is
// safe to automate: the cwd is the daemon's own launch choice, and there is
// no config pre-trust (codex's trust_level file) to write instead. Approval
// dialogs ("Run this command?", "Allow access to this file?") are NEVER
// confirmed here; they surface as blockedByDialog for a human or a bypass
// flag configured by the operator.
function agyTrustConfirmable(pane = '') {
  if (!AGY_TRUST_DIALOG_RE.test(pane)) return false
  if (AGY_APPROVAL_RE.test(pane)) return false
  return pane.split('\n').some((line) =>
    line.trimStart().startsWith('>') && line.includes('Yes, I trust this folder'))
}

function agyApprovalBlocking(pane = '') {
  return AGY_APPROVAL_RE.test(pane)
}

export async function injectAgyPrompt(session, prompt, {
  timeoutMs = 60_000,
  tmuxSocket = process.env.TMUX_SOCKET || null,
  tmuxExec = tmux,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  report = null,
} = {}) {
  const deadline = Date.now() + timeoutMs
  const promptMarker = kickoffMarker(prompt)
  const composerState = (pane = '') => paneComposerState('agy', pane, promptMarker)
  const target = exactTmuxTarget(session)
  const read = async () => String((await tmuxExec(tmuxSocket, 'capture-pane', '-t', target, '-p')).stdout || '')
  let lastPane = ''
  const note = (stage, pane) => {
    if (!report || typeof report !== 'object') return
    report.stage = stage
    report.pane = String(pane || '').slice(-2000)
  }
  // Settle startup: confirm the workspace trust dialog when it is up, refuse
  // approval dialogs, and wait for the idle composer. The trust answer is the
  // only keystroke this function ever aims at a dialog. Readiness is POSITIVE
  // (a `>` composer line with no trust question and no live turn), never the
  // absence of a dialog: right after spawn the pane holds the launch shell,
  // which has neither, and pasting there types the prompt as a shell command.
  // Measured: the first e2e pasted E2E-PING into zsh while agy was still
  // booting, then sat unconfirmed at the trust dialog it never waited for.
  while (Date.now() < deadline) {
    let pane
    try {
      pane = await read()
      lastPane = pane
    } catch {
      await sleep(1000)
      continue
    }
    if (agyApprovalBlocking(pane)) {
      note('approval-blocked', pane)
      return false
    }
    if (agyTrustConfirmable(pane)) {
      await tmuxExec(tmuxSocket, 'send-keys', '-t', target, 'Enter').catch(() => {})
      await sleep(1000)
      continue
    }
    const state = composerState(pane)
    // Busy (a turn already running) means someone else is driving; do not
    // pile on. No composer line yet means the TUI is still booting; wait.
    if (state.busyAfter || state.promptIndex < 0) {
      await sleep(1000)
      continue
    }
    break
  }
  if (Date.now() >= deadline) {
    note('settle-timeout', lastPane)
    return false
  }
  // Paste literally in chunks (shell never sees the text) and submit with a
  // plain Enter -- measured 4/4 across idle and post-response states, and the
  // hostile prompt (quotes, vars, backticks, backslashes, Unicode, long)
  // arrived intact. No pre-clear: agy's C-u behavior is unverified, and a
  // blind control key is worse than appending; launch paths inject into a
  // fresh composer, and a non-empty composer holding foreign text fails the
  // marker check below rather than submitting someone else's words.
  for (let offset = 0; offset < prompt.length; offset += 800) {
    await tmuxExec(tmuxSocket, 'send-keys', '-t', target, '-l', prompt.slice(offset, offset + 800))
    await sleep(25)
  }
  // The keystrokes land instantly but the TUI paints asynchronously: 500ms
  // after a paste the composer can show a PREFIX of the text (measured: 18
  // of 46 chars), which reads as "not parked". Poll for the paint to catch
  // up; only the single paste above ever happens, so waiting cannot duplicate.
  let shown = ''
  const paintDeadline = Date.now() + 8000
  while (Date.now() < deadline && Date.now() < paintDeadline) {
    await sleep(500)
    try {
      shown = await read()
    } catch {
      continue
    }
    if (agyApprovalBlocking(shown)) {
      note('approval-blocked', shown)
      return false
    }
    if (composerState(shown).containsMarker || composerState(shown).busyAfter) break
  }
  if (agyApprovalBlocking(shown)) {
    note('approval-blocked', shown)
    return false
  }
  // Still not visibly parked and no turn started: a repaste would duplicate
  // the prompt, so report failure instead.
  if (!composerState(shown).containsMarker && !composerState(shown).busyAfter) {
    note('paint-timeout', shown)
    return false
  }
  await tmuxExec(tmuxSocket, 'send-keys', '-t', target, 'Enter')
  let submitted = ''
  while (Date.now() < deadline) {
    await sleep(500)
    try {
      submitted = await read()
    } catch {
      continue
    }
    if (agyApprovalBlocking(submitted)) {
      note('approval-blocked', submitted)
      return false
    }
    const state = composerState(submitted)
    if (state.busyAfter) {
      note('submitted', submitted)
      return true
    }
    if (state.promptIndex >= 0 && !state.containsMarker) {
      note('submitted', submitted)
      return true
    }
    // Still parked: Enter on an empty composer is a no-op once submitted, so
    // the retry is safe to repeat. It is NOT sent blindly at dialogs: the
    // approval check above runs first on every pass.
    await tmuxExec(tmuxSocket, 'send-keys', '-t', target, 'Enter').catch(() => {})
  }
  // Out of budget with our text in the composer. Unlike the codex injector
  // this does not withdraw it: no verified composer-clear key exists for agy,
  // and destroying the only copy of the kickoff is worse than leaving it
  // parked where the wake path's submitParkedKickoff can see and resubmit it.
  note('submit-timeout', submitted || shown)
  return false
}

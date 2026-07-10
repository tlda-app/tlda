import { execFile } from 'child_process'
import fs from 'fs'
import { promisify } from 'util'
import { shouldPromptSweepAgent } from '../agent-runtime/status-classifier.mjs'

const execFileP = promisify(execFile)

const MEMORY_PATH_RE = /\.claude\/projects\/[^/]+\/memory\//
const RADIO_PROMPT_RE = /[❯>]\s*1\.\s*Yes/
const YN_PROMPT_RE = /Allow this (?:command|action)\?\s*\(y\/n\)/i
const CODEX_MCP_PROMPT_RE = /Allow the tlda MCP server to run tool ["']?([^"'?\n]+?)["']?\?/

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

function extractPromptContext(stripped) {
  const toolMatch = stripped.match(/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit)\(([^)]*)\)/s)
  if (toolMatch) return `${toolMatch[1]}(${toolMatch[2].trim().slice(0, 120)})`
  const doMatch = stripped.match(/Do you want to (\w+) (.+?)\?/)
  if (doMatch) return `${doMatch[1]} ${doMatch[2]}`
  const allowMatch = stripped.match(/Allow (.+?)\?/i)
  if (allowMatch) return allowMatch[1].trim().slice(0, 120)
  return null
}

function extractPromptBody(stripped) {
  const lines = stripped.split('\n')
  let toolIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[⏺●]\s*(Write|Edit|Bash|Read|NotebookEdit|Agent|Skill)\(/.test(lines[i])) {
      toolIdx = i
      break
    }
  }
  if (toolIdx < 0) return null
  let promptIdx = -1
  for (let i = toolIdx + 1; i < lines.length; i++) {
    if (/Do you want to|Allow this/i.test(lines[i])) {
      promptIdx = i
      break
    }
  }
  if (promptIdx < 0) return null
  const bodyLines = lines.slice(toolIdx, promptIdx)
    .map(line => line.replace(/^\s{0,4}/, ''))
    .filter(line => line.trim())
  if (bodyLines.length === 0) return null
  return bodyLines.join('\n').slice(0, 1000)
}

export function detectPrompt(paneText) {
  const stripped = typeof paneText === 'string' ? stripAnsi(paneText) : ''

  const codexMatch = stripped.match(CODEX_MCP_PROMPT_RE)
  if (codexMatch && /Always allow/.test(stripped)) {
    return { type: 'auto-accept', reason: `codex mcp tool: ${codexMatch[1]}`, acceptKey: '3' }
  }

  if ((stripped.includes('Do you want to') || stripped.includes('Allow this')) && RADIO_PROMPT_RE.test(stripped)) {
    if (MEMORY_PATH_RE.test(stripped)) {
      return { type: 'auto-accept', reason: 'memory file write' }
    }
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  if (YN_PROMPT_RE.test(stripped)) {
    const context = extractPromptContext(stripped)
    const reason = context ? `permission prompt: ${context}` : 'permission prompt (y/n)'
    const snippet = extractPromptBody(stripped)
    return { type: 'surface', reason, snippet }
  }

  return { type: 'none' }
}

export function createPromptPlan({
  tmuxArgs,
  log,
  sendMsg,
  getAgents,
  isArmed,
  hasActiveTerminalWatch,
  autoAcceptPrompt,
  intervalMs = 5000,
}) {
  const TMUX_ARGS = tmuxArgs || []
  const promptCooldowns = new Map()
  const surfacedPrompts = new Map()
  const planModeHashes = new Map()
  const pendingPlanChecks = new Map()
  let autoAcceptInterval = null

  async function checkForPlanModePrompt(agentId) {
    pendingPlanChecks.delete(agentId)
    const agent = getAgents().find(a => a.id === agentId)
    if (!agent?.tmux_session) return

    let pane
    try {
      const { stdout } = await execFileP('tmux',
        [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-e', '-S', '-150'],
        { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      pane = stripAnsi(stdout)
    } catch (e) {
      log.error(`plan-mode capture ${agentId}: ${e.message}`)
      return
    }

    if (!pane.includes("Here is Claude's plan") || !pane.includes('Would you like to')) return
    if (planModeHashes.has(agentId)) return
    planModeHashes.set(agentId, true)

    let planText = ''
    const planFileMatch = pane.match(/\/[^\s]*\.claude\/plans\/[^\s]+\.md/)
    if (planFileMatch) {
      try {
        planText = fs.readFileSync(planFileMatch[0], 'utf8').trim()
        log.info(`plan-mode: read plan file ${planFileMatch[0]}`)
      } catch (e) {
        // Plan file discovery is opportunistic; pane parsing still handles inline text.
        log.warn(`plan-mode: couldn't read plan file ${planFileMatch[0]}: ${e.message}`)
      }
    }

    if (!planText) {
      const lines = pane.split('\n')
      const dividerIdx = []
      for (let i = 0; i < lines.length; i++) {
        if (/^[\s╌]{10,}$/.test(lines[i].trim()) || lines[i].includes('╌╌╌╌')) {
          dividerIdx.push(i)
        }
      }
      for (let d = 0; d < dividerIdx.length - 1; d++) {
        const between = lines.slice(dividerIdx[d] + 1, dividerIdx[d + 1]).join('\n').trim()
        if (between.length > 20) {
          planText = between
          break
        }
      }
    }

    if (!planText) {
      const startIdx = pane.indexOf("Here is Claude's plan")
      const endIdx = pane.indexOf('Would you like to')
      if (startIdx >= 0 && endIdx > startIdx) {
        planText = pane.slice(startIdx + "Here is Claude's plan".length, endIdx).trim()
      }
    }

    if (!planText) planText = '(Plan text could not be extracted - check the agent terminal)'

    sendMsg({
      type: 'plan-mode-prompt',
      agent_id: agentId,
      plan_text: planText,
      tmux_session: agent.tmux_session,
    })
    log.info(`plan-mode-prompt sent for agent ${agentId}`)
  }

  function scheduleCheckForPlanModePrompt(agentId) {
    if (pendingPlanChecks.has(agentId)) return
    const handle = setTimeout(() => checkForPlanModePrompt(agentId), 1500)
    pendingPlanChecks.set(agentId, handle)
  }

  function startAutoAcceptSweep() {
    if (autoAcceptInterval) return
    autoAcceptInterval = setInterval(async () => {
      const sweptSessions = new Set()
      for (const agent of getAgents()) {
        if (!agent.tmux_session) continue
        const surfaced = surfacedPrompts.has(agent.tmux_session)
        if (!shouldPromptSweepAgent(agent, { armed: isArmed(agent.id), surfaced })) continue
        if (sweptSessions.has(agent.tmux_session)) continue
        sweptSessions.add(agent.tmux_session)
        if (hasActiveTerminalWatch(agent.tmux_session)) continue
        try {
          const { stdout } = await execFileP('tmux',
            [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-80'],
            { timeout: 2000, encoding: 'utf8', maxBuffer: 512 * 1024 })
          const stripped = stripAnsi(stdout)
          const result = detectPrompt(stdout)
          if (result.type === 'auto-accept') {
            const lastAccept = promptCooldowns.get(agent.tmux_session)
            if (lastAccept && Date.now() - lastAccept < 10_000) continue
            promptCooldowns.set(agent.tmux_session, Date.now())
            surfacedPrompts.delete(agent.tmux_session)
            await autoAcceptPrompt(agent.tmux_session, result.reason, result.acceptKey)
            sendMsg({ type: 'prompt-auto-accepted', agent_id: agent.id, reason: result.reason, ts: new Date().toISOString() })
          } else if (result.type === 'surface') {
            if (surfacedPrompts.get(agent.tmux_session) === result.reason) continue
            surfacedPrompts.set(agent.tmux_session, result.reason)
            log.info(`surfacing prompt for ${agent.friendly_name || agent.id}: ${result.reason}`)
            sendMsg({ type: 'terminal_attention', agent_id: agent.id, tmux_session: agent.tmux_session, text: result.reason, reason: result.reason, snippet: result.snippet || null })
          } else {
            surfacedPrompts.delete(agent.tmux_session)
          }
          if (stripped.includes("Here is Claude's plan") && stripped.includes('Would you like to')) {
            scheduleCheckForPlanModePrompt(agent.id)
          } else {
            planModeHashes.delete(agent.id)
          }
        } catch {
          // Session gone or capture failed; the next sweep can retry if needed.
        }
      }
    }, intervalMs)
  }

  return {
    detectPrompt,
    hasPlanMode: agentId => planModeHashes.has(agentId),
    promptCooldowns,
    scheduleCheckForPlanModePrompt,
    startAutoAcceptSweep,
    stripAnsi,
    surfacedPrompts,
    clearPlanMode: agentId => planModeHashes.delete(agentId),
  }
}

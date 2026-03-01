/**
 * watch-agent — Autonomous review agent using Claude Code Agent SDK.
 *
 * Spawns a Claude agent with the tldraw-feedback MCP server attached.
 * The agent calls wait_for_feedback in a loop, interprets iPad annotations,
 * and responds with math notes.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_PATH = resolve(__dirname, '../../mcp-server/index.mjs')

// Log to both console and file (SDK may capture stdio from child processes)
const LOG_DIR = join(homedir(), '.config', 'tlda')
const LOG_FILE = join(LOG_DIR, 'watch-agent.log')
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

function buildSystemPrompt(docName, texDir, texFile) {
  const texPath = texDir && texFile ? `${texDir}/${texFile}` : null
  return `You are an autonomous review agent for the LaTeX paper "${docName}".

## Your job

Listen for feedback from the iPad viewer, interpret it, and respond with annotations.

## How to listen

Call wait_for_feedback with doc="${docName}". It blocks for up to 5 minutes, waiting for the reviewer to draw, highlight, select text, edit a note, or tap ping. Then it returns a description of what happened.

**IMPORTANT: Call wait_for_feedback exactly ONCE per cycle.** If it times out with no feedback, just return immediately — the outer loop will call you again. Do NOT retry wait_for_feedback within the same cycle. This saves money and keeps the loop responsive.

## How to interpret

The feedback tells you:
- **Pen strokes**: gesture type (underline, circle, strikethrough, bracket), color, page, source lines, rendered text underneath
- **Highlights**: same as pen but with highlighter
- **Arrows**: start/end lines, direction, any label
- **Text selection**: the selected text and its location
- **Annotations**: new or edited math notes with their content
- **Ping**: the reviewer wants attention — check for recent drawn shapes or just acknowledge. On the FIRST ping, there may be lots of pre-existing annotations from earlier sessions. Don't try to process all of them — just acknowledge and start listening for new feedback.

## How to respond

Use these MCP tools:
- **add_annotation(doc, line, text)** — place a note anchored to a source line
- **reply_annotation(doc, id, text)** — reply to an existing note (adds a tab)
- **send_note(doc, line, text)** — quick note via WebSocket
- **highlight_location(file, line)** — flash a red circle at a source line
- **scroll_to_line(doc, line)** — scroll the viewer to a source line

Notes support KaTeX: use $x^2$ for inline math, $$\\int f$$ for display math.

**Do NOT use screenshot or get_latest_feedback** — they require a browser which isn't available. Use read_pen_annotations if you need to understand drawn marks.

## When to read source

If the feedback references specific lines, read the tex source to understand the context before responding. ${texPath ? `The main tex file is at: ${texPath}` : 'Ask for the tex file location if needed.'}

## Response style

**Short replies** (one-liner acknowledgments, quick answers): use a normal note (default size, right side).

**Long-form responses** (derivations, multi-step explanations, checking a chain of equations): use a wide note on the right side. Pass width=400 and height=500 (or more) to add_annotation. Use display math ($$...$$) generously — this is the equivalent of writing to a scratch file. Color: green for explanations, blue for questions back to the reviewer.

Guidelines:
- For math questions, show the relevant formula
- For unclear marks, ask a clarifying question in a note
- For circles/underlines on equations, check the math and comment on correctness
- For strikethroughs, acknowledge what should be removed or tightened
- For text selections, discuss the selected passage

## Todd (the reception agent)

A triage agent named Todd runs on the server, covering all papers. Todd handles quick acknowledgments and drops notes signed "—Todd". When you start listening on a doc, Todd yields to you on that doc (heartbeat-based). You may find violet notes from Todd flagging things for your attention — these are escalations. Handle them like any other feedback.

Sign your notes "—Claude" so the user can tell you apart from Todd.

**Maintaining Todd's knowledge base:** Todd reads \`~/.config/tlda/todd-knowledge.md\` for project context. When you learn something that would help Todd — what a paper is about, how projects relate, key references, important notation — update that file. Todd covers all papers but can't do deep reading, so keeping this up to date makes him more useful.

## After responding

Return control so the outer loop can call wait_for_feedback again. Do NOT call wait_for_feedback yourself more than once per cycle — the outer loop handles the repetition.

## Start now

Call wait_for_feedback(doc="${docName}") to begin listening.`
}

export async function startWatchAgent({ name, getServer, getToken, texDir, texFile }) {
  const server = getServer()
  const syncServer = server.replace(/^http/, 'ws')
  const token = getToken()

  // Strip CLAUDECODE env to avoid "nested session" rejection when launched from Claude Code
  const { CLAUDECODE: _, ...cleanEnv } = process.env
  const mcpEnv = { ...cleanEnv, TLDA_SERVER: server, SYNC_SERVER: syncServer }
  if (token) mcpEnv.TLDA_TOKEN = token

  const systemPrompt = buildSystemPrompt(name, texDir, texFile)
  let sessionId = null
  let cycle = 0

  // Signal handling — keep running through transient errors
  process.on('SIGTERM', () => {})
  process.on('SIGHUP', () => {})
  process.on('SIGPIPE', () => {})
  process.on('SIGINT', () => {
    log('[watch-agent] Stopping.')
    process.exit(0)
  })

  const mcpConfig = {
    'tldraw-feedback': {
      command: 'node',
      args: [MCP_SERVER_PATH],
      env: mcpEnv,
    }
  }

  const allowedTools = [
    'mcp__tldraw-feedback__wait_for_feedback',
    'mcp__tldraw-feedback__check_feedback',
    'mcp__tldraw-feedback__add_annotation',
    'mcp__tldraw-feedback__reply_annotation',
    'mcp__tldraw-feedback__delete_annotation',
    'mcp__tldraw-feedback__send_note',
    'mcp__tldraw-feedback__read_pen_annotations',
    'mcp__tldraw-feedback__list_annotations',
    'mcp__tldraw-feedback__highlight_location',
    'mcp__tldraw-feedback__scroll_to_line',
    'mcp__tldraw-feedback__signal_reload',
    'Read', 'Glob', 'Grep',
  ]

  while (true) {
    cycle++
    const prompt = cycle === 1
      ? systemPrompt
      : 'Call wait_for_feedback(doc="' + name + '") to listen for the next annotation. Interpret and respond, then return.'

    try {
      for await (const msg of query({
        prompt,
        options: {
          ...(sessionId ? { resume: sessionId } : {}),
          env: cleanEnv,
          mcpServers: mcpConfig,
          allowedTools,
          permissionMode: 'bypassPermissions',
          maxTurns: 10,
        }
      })) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id
        }
        if (msg.type === 'assistant') {
          // Print any text the agent produces
          for (const block of (msg.message?.content || [])) {
            if (block.type === 'text' && block.text?.trim()) {
              log(`[agent] ${block.text.trim().substring(0, 300)}`)
            }
          }
        }
        if (msg.type === 'result') {
          const status = msg.subtype === 'success' ? 'ok' : msg.subtype
          const cost = msg.total_cost_usd ? ` ($${msg.total_cost_usd.toFixed(4)})` : ''
          log(`[cycle ${cycle}] ${status}${cost}`)
          if (msg.subtype !== 'success') {
            log(`[cycle ${cycle}] errors: ${JSON.stringify(msg.errors || msg.result)}`)
          }
        }
      }
    } catch (err) {
      log(`[cycle ${cycle}] Error: ${err.message}`)
      // Brief pause before retrying
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

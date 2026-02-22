/**
 * triage-agent — Always-on agent that covers all documents.
 *
 * Listens for feedback across all active projects via wait_for_any_feedback.
 * Handles lightweight responses (acknowledgments, quick answers, notes).
 * Yields to terminal Claude Code sessions via heartbeat detection.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER_PATH = resolve(__dirname, '../../mcp-server/index.mjs')
const KNOWLEDGE_PATH = join(homedir(), '.config', 'ctd', 'todd-knowledge.md')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
}

const SYSTEM_PROMPT = `You are a triage agent. You listen across all documents and respond with brief notes.

## Rules

1. Call wait_for_any_feedback() ONCE. It blocks until feedback arrives on any document. If it times out, return immediately.
2. Read the feedback. It tells you the doc name, shape type, page, source lines, and rendered text.
3. If the feedback is clear (has source lines or rendered text), respond directly — don't take a screenshot.
   If the feedback is ambiguous (no source lines, no rendered text, unclear what's marked), you may:
   - Call read_pen_annotations to see marks on the page
   - Read source lines to answer a question
   - Take ONE screenshot as a LAST RESORT only if the above don't clarify things
4. Respond by calling add_annotation or send_note. You MUST use a tool to respond — text output alone is invisible to the user. Pass the doc name from the feedback.
5. Return. Do not call wait_for_any_feedback again.

## Old vs. new marks

wait_for_any_feedback only fires on NEW activity. But when you read_pen_annotations or take a screenshot, you'll see old marks too. Use location, timing, and the feedback context to distinguish:
- The feedback tells you what just happened — that's what you're responding to.
- Old marks nearby are context, not things to respond to.
- Don't acknowledge or comment on marks the user drew hours or days ago.

## What to say

- Stroke/highlight near equations: acknowledge what's marked, e.g. "Noted — marking on equation (3.2)"
- Circle or underline: "Flagged this for review"
- Text selection: briefly comment on the selected passage
- Question (text in a note or selection): answer it if you can, reading source lines if needed
- Ping: "Listening"
- Ambiguous mark with no clear source line: take a screenshot, then ask what they'd like to look at
- Anything needing tex edits or deep analysis: drop a violet note (color="violet") saying what's needed

One or two sentences. Use green for answers, blue for questions, violet for escalation.
Notes support KaTeX: $x^2$ for inline, $$\\\\int f$$ for display.

## Multiple-choice notes

When the mark is ambiguous or you want to clarify intent, drop a note with choices:
  add_annotation(doc, line, "What would you like here?", choices=["Expand this step", "Check this bound", "Flag for discussion"])

The user taps an option on the viewer. On the next cycle, wait_for_any_feedback returns a "choice" event with the selected option. Respond accordingly.

## Note threads

Use reply_annotation(doc, id, text) to add a tab to an existing note instead of creating a new one. This keeps the canvas tidy:
- Follow-up to your own note: reply in a new tab rather than creating a second note nearby.
- Answering a user's note: reply_annotation adds your response as a tab on their note.
- Multi-step clarification: each exchange is a tab in the same thread.

## Identity and role

You are Todd, the reception agent. You cover all papers, always on, always listening.

There are also paper-specific terminal agents (Claude) that run in terminal sessions. They can read and edit tex source, do deep math checking, write long derivations. You can't do any of that.

**What you do:**
- Acknowledge marks and selections quickly
- Answer questions by reading source lines, references, and related papers
- Read cited papers and related projects in ~/work to discuss content knowledgeably
- Drop multiple-choice notes to clarify intent
- Escalate to a terminal agent (violet note) when real edits or deep analysis are needed

**What you don't do:**
- Edit tex files
- Make changes to any source
- Write long derivations

**Signing:** End your notes with "—Todd" so the user knows it's you, not a terminal Claude agent. Terminal agents sign "—Claude".

**Colors:** Green for answers, blue for questions, violet for escalation.

## Do NOT

- Try to fix or edit anything
- Call wait_for_any_feedback more than once
- Loop on screenshots — one is enough
- Read files outside ~/work — macOS-managed folders (Desktop, Documents, Downloads, etc.) trigger permission popups

## Project knowledge

Read ${KNOWLEDGE_PATH} on your first cycle for context about the projects you cover — what each paper is about, how they relate, key references. This helps you respond knowledgeably without needing to read source every time.

Call wait_for_any_feedback() now.`

export async function startTriageAgent({ getServer, getToken }) {
  const server = getServer()
  const syncServer = server.replace(/^http/, 'ws')
  const token = getToken()

  // Strip CLAUDECODE from process.env to avoid "nested session" rejection
  // when the Agent SDK spawns Claude Code as a subprocess
  delete process.env.CLAUDECODE
  const cleanEnv = { ...process.env }
  const mcpEnv = { ...cleanEnv, CTD_SERVER: server, SYNC_SERVER: syncServer }
  if (token) mcpEnv.CTD_TOKEN = token

  log(`[triage] Server: ${server}`)

  let sessionId = null
  let cycle = 0

  process.on('SIGTERM', () => {
    log('[triage] Received SIGTERM, stopping.')
    process.exit(0)
  })
  process.on('SIGHUP', () => {})
  process.on('SIGPIPE', () => {})
  process.on('SIGINT', () => {
    log('[triage] Stopping.')
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
    'mcp__tldraw-feedback__wait_for_any_feedback',
    'mcp__tldraw-feedback__add_annotation',
    'mcp__tldraw-feedback__reply_annotation',
    'mcp__tldraw-feedback__send_note',
    'mcp__tldraw-feedback__read_pen_annotations',
    'mcp__tldraw-feedback__list_annotations',
    'mcp__tldraw-feedback__screenshot',
    'mcp__tldraw-feedback__highlight_location',
    'mcp__tldraw-feedback__scroll_to_line',
    'Read', 'Glob', 'Grep',
  ]

  log('[triage] Starting triage agent')

  while (true) {
    cycle++
    const prompt = cycle === 1
      ? SYSTEM_PROMPT
      : 'Call wait_for_any_feedback() to listen for the next feedback on any document. Interpret and respond, then return.'

    try {
      for await (const msg of query({
        prompt,
        options: {
          ...(sessionId ? { resume: sessionId } : {}),
          env: cleanEnv,
          mcpServers: mcpConfig,
          allowedTools,
          permissionMode: 'bypassPermissions',
          maxTurns: 20,
        }
      })) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          sessionId = msg.session_id
        }
        if (msg.type === 'assistant') {
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
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

// Allow running directly: node cli/lib/triage-agent.mjs
if (process.argv[1] && process.argv[1].endsWith('triage-agent.mjs')) {
  const CTD_SERVER = process.env.CTD_SERVER || 'http://localhost:5176'

  // Resolve token: env → config file
  let CTD_TOKEN = process.env.CTD_TOKEN || ''
  if (!CTD_TOKEN) {
    try {
      const configPath = join(homedir(), '.config', 'ctd', 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      CTD_TOKEN = config.tokenRw || config.token || ''
    } catch {}
  }

  startTriageAgent({
    getServer: () => CTD_SERVER,
    getToken: () => CTD_TOKEN,
  }).catch(e => {
    console.error('[triage] Fatal:', e.message)
    process.exit(1)
  })
}

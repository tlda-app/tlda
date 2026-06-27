#!/usr/bin/env node
/**
 * PreToolUse hook: skill qualification — SURFACED, NOT BLOCKING.
 *
 * Fail-open: if the server is down/slow/broken, exit 0. Never block a tool call
 * because the education system itself is broken.
 *
 * IMPORTANT (Skip's #1 pet peeve): this gate must NEVER deadlock. The owed
 * "skills" are tlda/fleet reference docs under ~/work/dot-claude/skills — they are
 * NOT Claude Code skills, so the Skill tool returns "unknown skill" for them, and
 * ~/.claude/skills does not exist. That made the requirement unsatisfiable: agents
 * could not clear it, so the old decision:'block' wedged the whole fleet (no
 * task_done / Edit / report / delegate). The gate now SURFACES the relevant skills
 * as advisory context and ALWAYS allows the tool. It nudges; it never walls.
 *
 * For Read/Skill calls: notifies the server for tracking, never blocks.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import http from 'http'
import https from 'https'
import { getFleetServerUrl } from '../shared/config.mjs'

const FLEET_ID = process.env.FLEET_ID
if (!FLEET_ID) process.exit(0)

// Education state is GLOBAL — it follows the agent onto the fleet (todd/eliza
// watch fleet chat, set owed skills; the agent reads/dismisses). Check the fleet
// server (config.fleetServer -> Fly), the same place dismiss_skill writes.
const SERVER = getFleetServerUrl()

setTimeout(() => process.exit(0), 1500)

let hookInput = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  hookInput = JSON.parse(Buffer.concat(chunks).toString())
} catch {
  process.exit(0)
}

const toolName = hookInput.tool_name || ''
const toolInput = hookInput.tool_input || {}
const filePath = toolInput.file_path || toolInput.path || ''

function httpGet(url) {
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: 1000 }, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch { resolve({}) }
      })
    })
    req.on('error', () => resolve({}))
    req.on('timeout', () => { req.destroy(); resolve({}) })
  })
}

const params = new URLSearchParams()
if (toolName) params.set('tool', toolName)
if (filePath) params.set('file', filePath)
if (toolName === 'Skill' && toolInput.skill) params.set('skill', toolInput.skill)
if (toolName === 'Bash' && toolInput.command) params.set('command', toolInput.command)
if (toolName === 'mcp__tlda__chat' && toolInput.message) {
  params.set('content', String(toolInput.message).slice(0, 4000))
}
const qs = params.toString()
const url = `${SERVER}/api/education/check/${encodeURIComponent(FLEET_ID)}${qs ? '?' + qs : ''}`

// Read/Skill: tracking only, never block.
if (toolName === 'Read') { httpGet(url); process.exit(0) }
if (toolName === 'Skill') { await httpGet(url); process.exit(0) }

const pending = await httpGet(url)
if (!pending || !pending.skill) process.exit(0)

const skills = pending.skills || [pending.skill]
const items = []
for (const skill of skills) {
  // Real skills live under ~/work/dot-claude/skills; ~/.claude/skills may not exist.
  const candidates = [
    join(homedir(), 'work', 'dot-claude', 'skills', skill, 'SKILL.md'),
    join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
  ]
  let desc = '', foundPath = ''
  for (const p of candidates) {
    try {
      const content = readFileSync(p, 'utf8')
      const m = content.match(/^description:\s*"?(.+?)"?\s*$/m)
      desc = m ? m[1] : ''
      foundPath = p
      break
    } catch { /* not present at this candidate path — try the next one */ }
  }
  items.push({ skill, desc, foundPath })
}
if (items.length === 0) process.exit(0)

// SURFACE the relevant skills as advisory context — never block.
let advisory = 'Relevant skill' + (items.length === 1 ? '' : 's') + ' for this action'
advisory += ' (read before proceeding if you have not — these are reference docs you Read, not Skill-tool skills):\n'
for (const { skill, desc, foundPath } of items) {
  advisory += '- ' + skill + (desc ? ' — ' + desc : '')
  advisory += foundPath ? '  (Read ' + foundPath + ')' : '  (no SKILL.md found; informational only)'
  advisory += '\n'
}

const result = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: advisory,
  },
  systemMessage: 'Skill advisory (non-blocking): ' + items.map(i => i.skill).join(', '),
}
process.stdout.write(JSON.stringify(result))
process.exit(0)

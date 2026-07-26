#!/usr/bin/env node
/**
 * PreToolUse hook: skill qualification enforcement.
 *
 * Fail-open: if the server is down/slow/broken, exit 0. Never block a tool call
 * because the education system itself is broken.
 *
 * For Read/Skill calls: notifies the server for tracking, never blocks.
 * For other calls: checks if the agent has unread required skills and blocks
 * until each one is read, loaded, or explicitly dismissed.
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
let SERVER = ''
try {
  SERVER = getFleetServerUrl()
} catch {
  process.exit(0)
}

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
if (toolName === 'Read') { await httpGet(url); process.exit(0) }
if (toolName === 'Skill') { await httpGet(url); process.exit(0) }

const pending = await httpGet(url)
if (!pending || !pending.skill) process.exit(0)

const skills = pending.skills || [pending.skill]
const partialBySkill = new Map((pending.partial || []).map(p => [p.skill, p]))
const items = []
const missing = []
for (const skill of skills) {
  const candidates = [
    join(homedir(), 'work', 'dot-claude', 'skills', skill, 'SKILL.md'),
    join(homedir(), '.codex', 'skills', skill, 'SKILL.md'),
    join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
    join(homedir(), '.agents', 'skills', skill, 'SKILL.md'),
  ]
  let desc = '', foundPath = ''
  for (const p of candidates) {
    try {
      const content = readFileSync(p, 'utf8')
      const m = content.match(/^description:\s*"?(.+?)"?\s*$/m)
      desc = m ? m[1] : ''
      if (desc === '>-' || desc === '|' || desc === '|-') desc = ''
      foundPath = p
      break
    } catch { /* not present at this candidate path — try the next one */ }
  }
  if (foundPath) items.push({ skill, desc, foundPath })
  else missing.push({ skill, candidates })
}

function fmtRange(r) { return r.start === r.end ? String(r.start) : `${r.start}-${r.end}` }
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  process.exit(0)
}

function missingWarning() {
  if (missing.length === 0) return ''
  let text = 'Skill gate configuration warning: the server requires '
  text += missing.length === 1 ? 'a skill that does not resolve to a readable SKILL.md.' : 'skills that do not resolve to readable SKILL.md files.'
  if (toolName) text += '\nTriggering tool: `' + toolName + '`.'
  text += '\n\n'
  for (const { skill, candidates } of missing) {
    text += '- `' + skill + '`\n'
    for (const p of candidates) text += '  - checked `' + p + '`\n'
  }
  text += '\nA missing required skill is a configuration problem. Report the skill name(s), triggering tool, and checked paths so the gate entry can be dropped or the skill can be made to resolve.\n'
  return text
}

if (missing.length > 0) {
  const warning = missingWarning()
  if (items.length === 0) {
    const result = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warning,
      },
      systemMessage: 'Skill gate configuration warning: ' + missing.map(({ skill }) => skill).join(', '),
    }
    process.stdout.write(JSON.stringify(result))
    process.exit(0)
  }
}

if (items.length === 0) process.exit(0)

let reason = missingWarning()
if (reason) reason += '\n'
reason += 'You must clear ' + (items.length === 1 ? 'this required skill' : 'these ' + items.length + ' required skills') + ' before continuing.\n\n'
for (const { skill, desc, foundPath } of items) {
  reason += '- `' + skill + '`' + (desc ? ' - ' + desc : '') + '\n'
  reason += '  Read `' + foundPath + '`.'
  const partial = partialBySkill.get(skill)
  if (partial?.ranges?.length && partial?.missing?.length) {
    reason += `\n  You read lines ${partial.ranges.map(fmtRange).join(', ')}, but you need the whole thing. Remaining lines: ${partial.missing.map(fmtRange).join(', ')}.`
  }
  reason += '\n'
}

reason += '\nThen retry the blocked action.'
reason += '\n\nIf a skill genuinely does not apply to what you are doing, call `dismiss_skill(skills: [' + items.map(({ skill }) => '"' + skill + '"').join(', ') + '], reason: "<why it does not apply>")`, then retry. A reason is required and is shown to Skip.'
block(reason)

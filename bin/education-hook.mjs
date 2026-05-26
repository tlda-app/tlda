#!/usr/bin/env node
/**
 * PreToolUse hook: skill qualification enforcement.
 *
 * Fail-open: if the server is down, slow, or broken, exit 0.
 * Never block a tool call because the education system itself is broken.
 *
 * For Read/Skill calls: notifies the server for tracking, never blocks.
 * For other calls: checks if the agent has unread required skills.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import http from 'http'
import https from 'https'

const FLEET_ID = process.env.FLEET_ID
if (!FLEET_ID) process.exit(0)

const SERVER = process.env.TLDA_SERVER || 'http://localhost:5176'

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
const qs = params.toString()
const url = `${SERVER}/api/education/check/${encodeURIComponent(FLEET_ID)}${qs ? '?' + qs : ''}`

if (toolName === 'Read') {
  httpGet(url)
  process.exit(0)
}

if (toolName === 'Skill') {
  await httpGet(url)
  process.exit(0)
}

const pending = await httpGet(url)
if (!pending || !pending.skill) process.exit(0)

const skills = pending.skills || [pending.skill]
const items = []
for (const skill of skills) {
  const skillPath = join(homedir(), '.claude', 'skills', skill, 'SKILL.md')
  try {
    const content = readFileSync(skillPath, 'utf8')
    const descMatch = content.match(/^description:\s*"?(.+?)"?\s*$/m)
    const desc = descMatch ? descMatch[1] : ''
    items.push({ skill, desc })
  } catch {
    items.push({ skill, desc: '' })
  }
}
if (items.length === 0) process.exit(0)

let reason = '\u26a0\ufe0f **You must read ' + (items.length === 1 ? 'this skill' : 'these ' + items.length + ' skills') + ' before continuing.**\n\n'
for (const { skill, desc } of items) {
  reason += '- **`' + skill + '`**' + (desc ? ' \u2014 ' + desc : '') + '\n'
}
reason += '\nUse the Skill tool to invoke each one (e.g. `Skill({ skill: "' + items[0].skill + '" })`), then retry your edit.'

const result = { decision: 'block', reason }

process.stdout.write(JSON.stringify(result))

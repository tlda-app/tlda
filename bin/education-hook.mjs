#!/usr/bin/env node
/**
 * PreToolUse hook: skill qualification enforcement.
 *
 * Reads tool name and input from stdin (Claude Code hook protocol).
 * Sends the tool name and file path to the server, which checks
 * qualifications.json rules against the agent's read history.
 * If the agent hasn't read a required skill, blocks the tool call
 * with the skill content injected into the agent's context.
 *
 * Skips Read and Skill tool calls (they only track reads, never trigger blocks).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import http from 'http'
import https from 'https'

const FLEET_ID = process.env.FLEET_ID
if (!FLEET_ID) process.exit(0)

const SERVER = process.env.TLDA_SERVER || 'http://localhost:5176'

// Read hook input from stdin
let hookInput = {}
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  hookInput = JSON.parse(Buffer.concat(chunks).toString())
} catch {
  // Fall back to env vars for compatibility
  try {
    hookInput = {
      tool_name: '',
      tool_input: JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}')
    }
  } catch { /* proceed with empty input */ }
}

const toolName = hookInput.tool_name || ''
const toolInput = hookInput.tool_input || {}
const filePath = toolInput.file_path || toolInput.path || ''

if (toolName === 'Read' || toolName === 'Skill') process.exit(0)

function httpGet(url) {
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: 3000 }, res => {
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
const qs = params.toString()
const url = `${SERVER}/api/education/check/${encodeURIComponent(FLEET_ID)}${qs ? '?' + qs : ''}`

const pending = await httpGet(url)
if (!pending.skill) process.exit(0)

const skillDir = join(homedir(), '.claude', 'skills', pending.skill, 'SKILL.md')
let content
try {
  content = readFileSync(skillDir, 'utf8')
} catch {
  content = `(Skill file not found at ${skillDir})`
}

const result = {
  decision: 'block',
  reason: `⚠️ **You must read this skill before continuing.**\n\nSkill: \`${pending.skill}\`\n\n---\n\n${content}\n\n---\n\n**Read the above. Apply it to what you're doing right now. Then continue.**`
}

process.stdout.write(JSON.stringify(result))

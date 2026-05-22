#!/usr/bin/env node
/**
 * PreToolUse hook: enforces Eliza's skill nudges.
 *
 * Checks the server for a pending education record for this agent.
 * If found, reads the skill file locally and blocks the tool call
 * with the full skill content injected into the agent's context.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import http from 'http'
import https from 'https'

const FLEET_ID = process.env.FLEET_ID
if (!FLEET_ID) process.exit(0)

const SERVER = process.env.TLDA_SERVER || 'http://localhost:5176'

function httpGet(url) {
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve, reject) => {
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

function httpDelete(url) {
  const mod = url.startsWith('https') ? https : http
  return new Promise((resolve) => {
    const req = mod.request(url, { method: 'DELETE', timeout: 3000 }, res => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve())
    req.on('timeout', () => { req.destroy(); resolve() })
    req.end()
  })
}

const pending = await httpGet(`${SERVER}/api/education/pending/${encodeURIComponent(FLEET_ID)}`)
if (!pending.skill) process.exit(0)

const skillDir = join(homedir(), '.claude', 'skills', pending.skill, 'SKILL.md')
let content
try {
  content = readFileSync(skillDir, 'utf8')
} catch {
  content = `(Skill file not found at ${skillDir})`
}

await httpDelete(`${SERVER}/api/education/pending/${encodeURIComponent(FLEET_ID)}`)

const result = {
  decision: 'block',
  reason: `⚠️ **Eliza requires you to read this skill before continuing.**\n\nSkill: \`${pending.skill}\`\n\n---\n\n${content}\n\n---\n\n**Read the above. Apply it to what you're doing right now. Then continue.**`
}

process.stdout.write(JSON.stringify(result))

#!/usr/bin/env node
/**
 * tlda-dev — developer commands for hacking on tlda itself.
 *
 * Its own binary so the plain `tlda` namespace stays clean for reviewers.
 * Thin front-end over the main `tlda` CLI: it forwards the command to tlda.mjs
 * (same logic, no duplication) and owns only its own --help.
 *
 * `tlda-dev pw …`, `tlda-dev dev`, `tlda-dev dev-url`, `tlda-dev deploy`.
 */

import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { DEV_HELP } from './lib/dev-commands.mjs'

const args = process.argv.slice(2)
const cmd = args[0]

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(DEV_HELP)
  process.exit(0)
}

// Forward to the main CLI — same code path as `tlda <cmd>`, no logic duplicated.
const tlda = join(dirname(fileURLToPath(import.meta.url)), 'tlda.mjs')
const r = spawnSync(process.execPath, [tlda, ...args], { stdio: 'inherit' })
process.exit(r.status ?? 0)

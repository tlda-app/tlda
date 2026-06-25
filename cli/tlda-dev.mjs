#!/usr/bin/env node
/**
 * tlda-dev — developer commands for hacking on tlda itself.
 *
 * Its own binary so the plain `tlda` namespace stays clean for reviewers.
 * Thin front-end over the main `tlda` CLI: it forwards the command to tlda.mjs
 * (same logic, no duplication) and owns only its own --help.
 *
 * `tlda-dev pw …`, `tlda-dev serve`, `tlda-dev sandbox`, `tlda-dev dev-url`, `tlda-dev deploy`.
 */

import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { DEV_HELP } from './lib/dev-commands.mjs'
import { cmdPw } from './lib/pw.mjs'
import { cmdDevServer } from './lib/dev-server.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const cliDir = dirname(fileURLToPath(import.meta.url))

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(DEV_HELP)
  process.exit(0)
}

// `pw` and `sandbox` live here (not in tlda.mjs) — developer commands, no flat alias.
if (cmd === 'pw') {
  await cmdPw(args.slice(1), join(cliDir, '..'))
  process.exit(0)
}
if (cmd === 'sandbox') {
  await cmdDevServer(args.slice(1), join(cliDir, '..'))
  process.exit(0)
}

// Other dev commands (worktree/dev-url/deploy/restart-mcp) still live in tlda.mjs
// — forward them, with TLDA_DEV_CLI=1 so tlda.mjs lets them past its
// developer-command gate (plain `tlda <devcmd>` is refused; this path is allowed).
const tlda = join(cliDir, 'tlda.mjs')
const r = spawnSync(process.execPath, [tlda, ...args], {
  stdio: 'inherit',
  env: { ...process.env, TLDA_DEV_CLI: '1' },
})
process.exit(r.status ?? 0)

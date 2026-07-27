#!/usr/bin/env node
/**
 * tlda-dev — developer commands for hacking on tlda itself.
 *
 * Its own binary so the plain `tlda` namespace stays clean for reviewers.
 * Thin front-end over the main `tlda` CLI: it forwards the command to tlda.mjs
 * (same logic, no duplication) and owns only its own --help.
 *
 * `tlda-dev pw …`, `tlda-dev serve`, `tlda-dev dev-url`, `tlda-dev deploy`.
 */

import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { DEV_HELP } from './lib/dev-commands.mjs'
import { cmdPw } from './lib/pw.mjs'
import { cmdServeWorktree, cmdShareWorktree } from './lib/dev-worktree.mjs'

const args = process.argv.slice(2)
const cmd = args[0]
const cliDir = dirname(fileURLToPath(import.meta.url))

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(DEV_HELP)
  process.exit(0)
}

// SAFETY: never let a worktree fire raw server/daemon lifecycle. A daemon (or
// server) started from a worktree would read the active config and could point at
// the REAL/prod fleet, polluting the live system — the exact "bad daemon" danger.
// The ONLY dev bring-up path is `tlda-dev serve`, which stands up an isolated
// stack and wires any daemon it starts to that sandbox alone (never prod). So we
// hard-refuse `tlda-dev server …` and `tlda-dev daemon …` here, before the forward.
if (cmd === 'server' || cmd === 'daemon') {
  console.error(
    `\`tlda-dev ${cmd}\` is disabled — a worktree-started ${cmd} could target the real/prod fleet.\n` +
    `  Use \`tlda-dev serve [--sandbox]\` instead: it stands up THIS worktree's stack and any\n` +
    `  daemon it starts is wired only to that sandbox server. For the real fleet, use plain \`tlda ${cmd}\`.`
  )
  process.exit(2)
}

// `pw` lives here (developer command, no flat alias).
if (cmd === 'pw') {
  await cmdPw(args.slice(1), join(cliDir, '..'))
  process.exit(0)
}

// The one dev bring-up command. `tlda-dev serve [--sandbox] [--project X] [--port N]`
// stands up THIS worktree's branch as an isolated, reachable, tokenless stack with
// the SPA config pointed at the reachable host. `--sandbox` is its fully-isolated
// mode (own DB/projects/chat + a daemon wired ONLY to this sandbox). It delegates
// to the real robust `server start` detach, so it survives the launching agent.
if (cmd === 'serve') {
  await cmdServeWorktree(args.slice(1))
  process.exit(0)
}
if (cmd === 'share') {
  await cmdShareWorktree(args.slice(1))
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

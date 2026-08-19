// What a bot is, read from the one place that declares it.
//
// Skip, 2026-08-19: "there shouldn't be a fucking bot recipe. Bots use fucking
// mint and wake like everybody else. The whole recipe garbage is just a recipe
// for fucking disaster. Use the fucking infrastructure that exists."
//
// A bot's script, its name, and where it keeps its pid and heartbeat used to be
// copied into the mint's stored launch recipe and replayed from there on every
// wake. That copy was taken once, at mint time, and `bots.yaml` could be edited
// afterwards — so a bot could be woken for weeks under a script the declaration
// no longer named. One fact, one encoding: the declaration says what a bot is,
// the ledger says whether it exists, and there is no third place.
//
// This module is that one encoding, used by the launcher and by wake, so the two
// cannot disagree about where a bot's files are.

import { join } from 'node:path'
import { CONFIG_DIR, getManagedBots, getActiveEnvName } from './config.mjs'

// `bot:<env>:<model>` is the ledger's key for a bot. It carries both halves of
// the lookup, which is why wake needs nothing threaded through to resolve a
// declaration — it already has the mint id.
const BOT_MINT_ID = /^bot:([^:]+):(.+)$/

export function parseBotMintId(mintId) {
  const match = BOT_MINT_ID.exec(String(mintId || ''))
  if (!match) return null
  return { envName: match[1], model: match[2] }
}

function serviceSuffix(model, envName) {
  const name = String(model || '').trim().replace(/[^A-Za-z0-9_.-]/g, '-')
  if (!name) throw new Error('bot name is required')
  const env = envName ? `.${String(envName).replace(/[^A-Za-z0-9_.-]/g, '-')}` : ''
  return `${name}${env}`
}

// A bot's files, and nothing about a terminal. There is no per-bot launchd label
// — one bot manager supervises every bot on this machine — and no tmux session
// name, which is the string that made the old per-bot supervisor restart a
// healthy bot forever.
export function botServicePaths(model, { configName = null } = {}) {
  const envName = configName
    || getManagedBots().find(bot => bot.name === model)?.environment
    || getActiveEnvName()
  const suffix = serviceSuffix(model, envName)
  return {
    logFile: join(CONFIG_DIR, `${suffix}.log`),
    pidFile: join(CONFIG_DIR, `${suffix}.pid`),
    heartbeatFile: join(CONFIG_DIR, `${suffix}.heartbeat`),
  }
}

export function resolveBotScript(script, repoRoot) {
  if (!script) throw new Error('bot script is required')
  return script.startsWith('/') ? script : join(repoRoot, script)
}

// The launch fields for a bot, from `bots.yaml`. Null when the mint id is not a
// bot's or the declaration no longer names it — a bot removed from the file is
// not woken under the terms it used to have, which is the whole point of reading
// the declaration instead of a snapshot.
export function botLaunchFromDeclaration(mintId, { repoRoot = process.cwd() } = {}) {
  const parsed = parseBotMintId(mintId)
  if (!parsed) return null
  const declared = getManagedBots().find(bot => bot.name === parsed.model)
  if (!declared) return null
  const paths = botServicePaths(parsed.model, { configName: parsed.envName })
  return {
    botScript: resolveBotScript(declared.script, repoRoot),
    botName: parsed.model,
    botPidFile: paths.pidFile,
    botHeartbeatFile: paths.heartbeatFile,
    botWaitChannel: null,
    botEnv: Object.fromEntries(
      Object.entries(declared.env || {}).map(([key, value]) => [key, String(value)]),
    ),
  }
}

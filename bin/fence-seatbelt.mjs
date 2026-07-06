#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_TEMP_WRITE_ROOTS = ['/tmp', '/private/tmp', '/var/folders']
const DEV_NULL = '/dev/null'
const PS_EXEC_RULE = '(allow process-exec (literal "/bin/ps") (with no-sandbox))'
const FLEET_DB_DENY = '/Users/skip/.config/tlda/fleet.db*'

function usage() {
  return 'usage: node bin/fence-seatbelt.mjs --settings <file.json> -- <command> [args...]'
}

function parseArgs(argv) {
  let settings = null
  let commandStart = -1
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--settings') {
      settings = argv[++i]
      if (!settings) throw new Error('--settings requires a file path')
    } else if (arg === '--') {
      commandStart = i + 1
      break
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!settings) throw new Error('--settings is required')
  if (commandStart < 0 || commandStart >= argv.length) throw new Error('command after -- is required')
  return { settings, command: argv.slice(commandStart) }
}

function expandHome(value) {
  const str = String(value || '')
  if (str === '~') return os.homedir()
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2))
  return str
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function sbplString(value) {
  return JSON.stringify(String(value))
}

function sbplRegexString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

function stripGlobSuffix(value) {
  let str = expandHome(value)
  while (str.endsWith('/**')) str = str.slice(0, -3)
  while (str.endsWith('/*')) str = str.slice(0, -2)
  return str || '/'
}

function writeRootMatcher(root) {
  return `(subpath ${sbplString(stripGlobSuffix(root))})`
}

function globToRegex(glob) {
  const input = expandHome(glob)
  let out = '^'
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch === '*') {
      if (input[i + 1] === '*') {
        if (input[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegex(ch)
    }
  }
  return out
}

export function pathPatternMatcher(pattern) {
  const expanded = expandHome(pattern)
  if (expanded.endsWith('/**')) return `(subpath ${sbplString(expanded.slice(0, -3))})`
  if (!/[*?[\]]/.test(expanded)) return `(literal ${sbplString(path.resolve(expanded))})`
  return `(regex #${sbplRegexString(globToRegex(expanded))})`
}

function hasBroadWriteRoot(writeRoots) {
  return (writeRoots || []).some((root) => {
    const value = String(root)
    return value === '/' || value === '/**' || value === '**' || value === '*'
  })
}

function shouldScopeWrites(lease) {
  if (lease.machine_write === true) return false
  return !hasBroadWriteRoot(lease.write_roots || [])
}

function denyBlock(readRoots, writeRoots) {
  const patterns = unique([...(readRoots || []), ...(writeRoots || [])])
    .filter((pattern) => !isFleetDbPattern(pattern))
  if (!patterns.length) return ''
  const matchers = patterns.map(pathPatternMatcher)
  return [
    '(deny file-read* file-write*',
    ...matchers.map((matcher) => `  ${matcher}`),
    ')',
  ].join('\n')
}

function isFleetDbPattern(pattern) {
  return stripGlobSuffix(pattern).includes('/.config/tlda/fleet.db')
}

export function buildSeatbeltProfile(lease) {
  if (!lease || typeof lease !== 'object') throw new Error('settings file must contain an object _tldaLease')
  const lines = ['(version 1)', '(allow default)', PS_EXEC_RULE]

  if (shouldScopeWrites(lease)) {
    const writeRoots = unique([
      ...(lease.write_roots || []),
      ...DEFAULT_TEMP_WRITE_ROOTS,
    ])
    lines.push('(deny file-write* (subpath "/"))')
    lines.push(`(allow file-write* ${writeRoots.map(writeRootMatcher).join(' ')} (literal ${sbplString(DEV_NULL)}))`)
  }

  const deny = denyBlock(lease.deny_read_roots || [], lease.deny_write_roots || [])
  if (deny) lines.push(deny)
  lines.push(`(deny file-write* ${pathPatternMatcher(FLEET_DB_DENY)})`)
  return `${lines.join('\n')}\n`
}

export function loadLease(settingsFile) {
  const raw = fs.readFileSync(settingsFile, 'utf8')
  const settings = JSON.parse(raw)
  if (!settings?._tldaLease || typeof settings._tldaLease !== 'object') {
    throw new Error(`${settingsFile} does not contain _tldaLease`)
  }
  return settings._tldaLease
}

function execSandbox(profile, command) {
  const sandboxExec = '/usr/bin/sandbox-exec'
  const argv = [sandboxExec, '-p', profile, '--', ...command]
  process.execve(sandboxExec, argv, process.env)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const lease = loadLease(args.settings)
  const profile = buildSeatbeltProfile(lease)
  execSandbox(profile, args.command)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err)
    console.error(usage())
    process.exit(2)
  })
}

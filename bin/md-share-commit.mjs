// Per-share markdown versioning — an OPTIONAL, config-driven thing Todd can do.
//
// When an agent shares a markdown file in chat, capture that file's CURRENT
// content (== the version shared, since this fires at share time) into a
// dedicated markdown-versions git repo, in a commit tagged with the chat event
// id. The "every share we check in" timeline, synced to the chat moment.
//
// GENERIC BY DEFAULT: this does nothing unless configured. Todd ships as an
// example bot, so the feature is OFF until ~/.config/tlda/config.json has an
// `mdVersions` block (or the env overrides below are set). No config → no-op.
//
// Config (~/.config/tlda/config.json):
//   "mdVersions": {
//     "enabled": true,
//     "repoDir": "~/work/md-versions",        // the markdown-versions git repo
//     "folders": ["~/work/bregman-lower-bound", "dot-claude", ...]
//        // roots to version md from. Absolute path, or a name resolved under
//        // ~/work. The repo subdir is the root's basename.
//   }
// Env overrides: MD_VERSIONS_ENABLED, MD_VERSIONS_DIR, MD_VERSIONS_FOLDERS (comma-sep).
//
// Called from bin/todd.mjs's chat-event handler. Fire-and-forget: never throws
// into the caller, serializes git ops, logs noisily.
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { loadConfig } from '../shared/config.mjs'
const execFileP = promisify(execFile)

const HOME = os.homedir()
const WORK = path.join(HOME, 'work')

function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? path.join(HOME, p.slice(1).replace(/^[/\\]/, '')) : p
}

// Resolve config once at module load. Todd restarts to pick up config changes.
function resolveConfig() {
  let block = {}
  try { block = loadConfig()?.mdVersions || {} } catch { block = {} }

  const enabled = process.env.MD_VERSIONS_ENABLED != null
    ? /^(1|true|yes)$/i.test(process.env.MD_VERSIONS_ENABLED)
    : !!block.enabled

  const repoDir = expandHome(process.env.MD_VERSIONS_DIR || block.repoDir || '')

  const rawFolders = process.env.MD_VERSIONS_FOLDERS
    ? process.env.MD_VERSIONS_FOLDERS.split(',').map(s => s.trim()).filter(Boolean)
    : (Array.isArray(block.folders) ? block.folders : [])

  // Each folder entry → an absolute root + the repo subdir name (its basename).
  const roots = rawFolders.map(f => {
    const abs = f.startsWith('/') ? f : (f.startsWith('~') ? expandHome(f) : path.join(WORK, f))
    return { root: abs.replace(/\/+$/, ''), name: path.basename(abs.replace(/\/+$/, '')) }
  })

  return { enabled, repoDir, roots }
}

const CFG = resolveConfig()
const ACTIVE = CFG.enabled && CFG.repoDir && CFG.roots.length > 0

// Map an absolute file path to { name, relpath } if under a configured root.
function locate(absPath) {
  if (!absPath) return null
  for (const { root, name } of CFG.roots) {
    const prefix = root + path.sep
    if (absPath.startsWith(prefix)) return { name, relpath: absPath.slice(prefix.length) }
  }
  return null
}

// Serialize commits so concurrent shares can't race on the git index.
let _queue = Promise.resolve()

// Public entry: hand it the broadcast event data ({ id, timestamp, metadata }).
export function commitMdShare(eventData) {
  if (!ACTIVE) return
  try {
    if (!eventData || (eventData.type && eventData.type !== 'chat')) return
    let meta = eventData.metadata
    if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { return } }
    const atts = meta?.inline_attachments
    if (!Array.isArray(atts) || !atts.length) return
    const eventId = eventData.id
    const ts = eventData.timestamp || new Date().toISOString()
    if (!fs.existsSync(path.join(CFG.repoDir, '.git'))) return // repo not set up

    for (const a of atts) {
      const name = a?.name || (a?.path ? path.basename(a.path) : '')
      if (!name.toLowerCase().endsWith('.md')) continue
      const srcPath = a.path
      if (!srcPath || !fs.existsSync(srcPath)) continue
      const loc = locate(srcPath)
      if (!loc) continue
      const job = { project: loc.name, relpath: loc.relpath, srcPath, eventId, ts }
      _queue = _queue.then(() => commitOne(job)).catch(e => console.error('[md-share] commit failed:', e?.message))
    }
  } catch (e) {
    console.error('[md-share] handler error:', e?.message)
  }
}

async function commitOne(job) {
  const MDV = CFG.repoDir
  const dest = path.join(MDV, job.project, job.relpath)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(job.srcPath, dest)
  const repoRel = path.join(job.project, job.relpath)
  await execFileP('git', ['-C', MDV, 'add', '--', repoRel], { timeout: 10000 })
  let hasDiff = false
  try {
    await execFileP('git', ['-C', MDV, 'diff', '--cached', '--quiet', '--', repoRel], { timeout: 10000 })
  } catch { hasDiff = true }
  if (!hasDiff) return
  await execFileP('git', ['-C', MDV, 'commit', '-q', '--only', '-m', `md-share ${job.eventId} ${job.ts}`, '--', repoRel], {
    timeout: 15000,
    env: { ...process.env, GIT_AUTHOR_DATE: job.ts, GIT_COMMITTER_DATE: job.ts },
  })
  console.log(`[md-share] committed ${repoRel} (event ${job.eventId})`)
}

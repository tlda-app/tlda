// Niced child of the fleet daemon. Classifies every session JSONL's owner(s) into
// the owner-cache so the daemon never has to byte-scan files on a spawn. Streams
// { sessionId, owners, endOffset } to the parent over IPC; the parent is the single
// writer of the cursor file. Runs at low priority and yields between files so the
// harvest never competes with the daemon or the user — safe on a fresh machine.
//
// Queue order is most-recently-modified first (recent → old), so the agents you're
// likely to talk to are classified in the first seconds and the long hibernating
// tail trickles in last. (A just-spawned/just-resumed agent's session has a fresh
// mtime, so it naturally sorts to the front — no explicit priority signal needed.)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanFileIdentitySync } from '../agent-runtime/daemon-jsonl-hot-path.mjs'

const HARVEST_DIRS = process.env.TLDA_HARVEST_DIR
  ? [process.env.TLDA_HARVEST_DIR]
  : [
      path.join(os.homedir(), '.claude', 'projects'),
      path.join(os.homedir(), '.codex', 'sessions'),
    ]

// Drop our own scheduling priority; the harvest is strictly background work.
// Best-effort: setPriority can be denied by the OS; harvesting proceeds either way.
try { os.setPriority(process.pid, 10) } catch { /* priority is advisory, ignore */ }

// List every session file with its mtime, most-recent first.
export function listSessionsByRecency(dirs = HARVEST_DIRS) {
  const out = []
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const walk = (current) => {
      let entries
      try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const filePath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(filePath)
          continue
        }
        if (!entry.name.endsWith('.jsonl')) continue
        let mtimeMs = 0
        try { mtimeMs = fs.statSync(filePath).mtimeMs } catch { continue }
        out.push({
          sessionId: entry.name.slice(0, -6),
          filePath,
          mtimeMs,
          harnessKind: filePath.includes('/.codex/sessions/') ? 'codex' : 'claude',
        })
      }
    }
    walk(dir)
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs) // recent -> old
  return out
}

export function listedSessionFiles(filePaths = []) {
  return filePaths.flatMap(filePath => {
    if (!String(filePath).endsWith('.jsonl')) return []
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(filePath).mtimeMs } catch { return [] }
    return [{
      sessionId: path.basename(filePath, '.jsonl'),
      filePath,
      mtimeMs,
      harnessKind: filePath.includes('/.codex/sessions/') ? 'codex' : 'claude',
    }]
  }).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function main() {
  process.on('message', (msg) => { if (msg?.type === 'stop') process.exit(0) })
  // Passing explicit files makes classification of a newly-created session
  // bounded. The startup harvest still scans every session in the background.
  const requestedFiles = process.argv.slice(2)
  const queue = requestedFiles.length ? listedSessionFiles(requestedFiles) : listSessionsByRecency()
  const breathe = () => new Promise((r) => setImmediate(r))
  let count = 0
  for (const item of queue) {
    try {
      const { owners, identity, endOffset } = scanFileIdentitySync(item.filePath)
      process.send?.({
        type: 'owners',
        sessionId: item.sessionId,
        jsonlPath: item.filePath,
        harnessKind: item.harnessKind,
        owners,
        identity,
        endOffset,
      })
      count++
    } catch { /* unreadable file — skip, parent leaves it unclassified */ }
    await breathe() // yield the event loop between files so the harvest stays gentle
  }
  process.send?.({ type: 'harvest-complete', count })
  process.exit(0)
}

// Only run the harvest loop when forked as a child (has an IPC channel), so the
// module can be imported by tests without side effects.
if (process.send) main()

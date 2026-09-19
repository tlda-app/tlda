// Disk sink for the client's always-on sampling profiler.
//
// `src/selfProfiler.ts` samples the browser main thread continuously in rolling
// windows. Without this sink those windows only ever existed in the page,
// reachable solely by typing `window.__tldaProfiler.cpuprofiles()` into that
// tab's devtools — so the instrument ran always-on and nobody could read it.
//
// The tab posts the RAW self-profiling trace and the conversion happens here,
// so the page does not spend main-thread time on the instrument. Each window
// becomes its own `.cpuprofile` file, which speedscope, profview and Chrome
// DevTools open directly. Nothing is ranked, filtered or summarized here: that
// belongs in those tools.
//
// Only a human session reaches here: `src/selfProfiler.ts` does not upload from
// an automated browser. The instrument is one browser a person keeps open, and
// what it records is that person's experience of the app.
//
// Retention is a DISK BUDGET rather than a file count, oldest deleted first,
// because the session is continuous and indefinite while the disk is not. A
// budget keeps the longest span the disk can hold: a quiet day retains many
// hours and a heavy one fewer, which is the right trade in both directions. A
// file count cannot do that, since a window runs from a few KB to a few hundred.
//
// Quiet windows are kept like any other — the question this answers is "where
// did the time go", and the difference between the moments that felt fine and
// the moments that did not is the measurement. A trigger throws away the
// baseline, which is what the long-task path already does.

import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toCpuprofile } from '../../shared/self-profile-to-cpuprofile.mjs'

const FILE_PREFIX = 'profile-'
const FILE_SUFFIX = '.cpuprofile'

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Measured over 40 real captured traces a converted window runs from a few KB to
// 657 KB, six windows a minute from the one session that uploads. 256 MB is
// therefore hours of continuous coverage at the median and still bounded on the
// volume the deploy builds on.
const MAX_BYTES = envNumber('TLDA_CLIENT_PROFILE_MAX_BYTES', 256 * 1024 * 1024)
// A single window is a profile, not a payload of unknown size; anything far
// larger than the measured worst case is malformed and is refused rather than
// written. Checked after conversion, which is where the size actually lands.
const MAX_WINDOW_BYTES = envNumber('TLDA_CLIENT_PROFILE_MAX_WINDOW_BYTES', 8 * 1024 * 1024)

export function clientProfileDirFor(baseDir) {
  return join(baseDir, 'client-profiles')
}

// Oldest first, so trimming is a slice off the front: the timestamp in the name
// is ISO with `:` and `.` replaced, which sorts lexicographically.
async function retainedFiles(dir) {
  try {
    const files = await readdir(dir)
    return files.filter(f => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX)).sort()
  } catch (e) {
    if (e?.code === 'ENOENT') return []
    throw e
  }
}

/** Delete oldest-first until the directory fits the budget. Returns what went. */
async function trim(dir, maxBytes) {
  const files = await retainedFiles(dir)
  const sizes = []
  let total = 0
  for (const f of files) {
    // A window that vanished between listing and sizing contributes nothing;
    // anything else about it is not this function's problem.
    const size = await stat(join(dir, f)).then(s => s.size).catch(() => 0)
    sizes.push([f, size])
    total += size
  }
  let dropped = 0
  // Never the last one. A single window can exceed the whole budget on its own,
  // and without this the trim that follows writing it deletes it again — so the
  // busier the session, the less it retains, ending at nothing. Keeping the
  // newest means the budget is a target that one oversized window may exceed,
  // rather than a rule that can empty the directory.
  for (const [f, size] of sizes.slice(0, -1)) {
    if (total <= maxBytes) break
    // A file already gone is the desired state.
    await rm(join(dir, f), { force: true }).catch(() => {})
    total -= size
    dropped += 1
  }
  return dropped
}

function safeToken(value, fallback) {
  const token = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  return token || fallback
}

/**
 * @param {object} options
 * @param {string} options.baseDir   directory holding the window directory
 * @param {number} [options.maxBytes] disk budget for retained windows
 * @param {object} [options.log]
 */
export function createClientProfileWindowHandler({ baseDir, maxBytes = MAX_BYTES, log = console } = {}) {
  if (!baseDir) throw new Error('client profile window sink requires a base directory')

  let written = 0
  let refused = 0

  return async function clientProfileWindowHandler(req, res) {
    const body = req.body
    const trace = body && typeof body === 'object' ? body.trace : null
    if (!trace || !Array.isArray(trace.samples) || !Array.isArray(trace.stacks) || !Array.isArray(trace.frames)) {
      refused += 1
      return res.status(400).json({ ok: false, error: 'a window must carry a self-profiling trace in `trace`' })
    }

    // Converted here rather than in the tab: this is main-thread time the page
    // would otherwise spend on the instrument instead of on the user.
    // Serialized once, since its length is both what gets written and what the
    // size check is made against.
    const serialized = JSON.stringify(toCpuprofile(trace))
    if (serialized.length > MAX_WINDOW_BYTES) {
      refused += 1
      log.log?.(`[client-profile-window] refused ${serialized.length} bytes, over the ${MAX_WINDOW_BYTES} byte window limit`)
      return res.status(413).json({ ok: false, error: `window is ${serialized.length} bytes, limit is ${MAX_WINDOW_BYTES}` })
    }

    const dir = clientProfileDirFor(baseDir)
    const at = new Date(typeof body.at === 'string' ? body.at : Date.now())
    const stamp = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString().replace(/[:.]/g, '-')
    // Two tabs rolling in the same millisecond would otherwise overwrite each
    // other, and the one that survived would look like the only one profiling.
    const tab = safeToken(body.tab, 'tab')
    const file = join(dir, `${FILE_PREFIX}${stamp}-${tab}${FILE_SUFFIX}`)

    try {
      await mkdir(dir, { recursive: true })
      // The converted object IS the `.cpuprofile` format, written as-is.
      await writeFile(file, serialized)
      written += 1
      const dropped = await trim(dir, maxBytes)
      res.json({ ok: true, file, bytes: serialized.length, written, dropped })
    } catch (error) {
      // A profiler believed to be recording and silently not is worse than one
      // that is off, so the failure names the path and the reason.
      log.log?.(`[client-profile-window] write failed for ${file}: ${error.message}`)
      res.status(500).json({ ok: false, error: `could not write ${file}: ${error.message}` })
    }
  }
}

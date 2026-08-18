import fs from 'node:fs'
import fsp from 'node:fs/promises'

// Nothing in this project rotated a log until 2026-08-18, when `client.log`
// reached 955 MB and `fleet-daemon.testing.log` 342 MB on the machine Skip
// works on, while the volume hit 100% with 179 MiB free.
//
// Rotation, never truncation. `client.log` is the instrument three separate
// findings came out of that night — including his tab going deaf 295 times —
// and a log that resets on a size threshold is a log that has thrown away the
// evidence of whatever made it big.

function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export const LOG_MAX_BYTES = envNumber('TLDA_LOG_MAX_BYTES', 128 * 1024 * 1024)
export const LOG_KEEP = envNumber('TLDA_LOG_KEEP', 4)
export const LOG_SIZE_CHECK_MS = envNumber('TLDA_LOG_SIZE_CHECK_MS', 30_000)

/**
 * Shift `file` to `file.1`, `file.1` to `file.2`, and so on, dropping the
 * oldest. Oldest-first so no generation overwrites one that has not moved yet.
 *
 * Rename rather than copy: a rename is atomic within a filesystem, so a reader
 * holding the old path keeps a complete file rather than half of one.
 */
export function rotateNow(file, { keep = LOG_KEEP } = {}) {
  if (keep <= 0) return false
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    } catch (e) {
      // Only "that generation does not exist yet" is expected, and it is the
      // normal case until the log has rotated `keep` times. Anything else —
      // a permission problem, a full disk, a path that is not writable — is
      // the thing we would need to know about, and swallowing it would make a
      // rotation that never happens look exactly like one that did.
      if (e?.code !== 'ENOENT') throw e
    }
  }
  try {
    fs.renameSync(file, `${file}.1`)
    return true
  } catch (e) {
    // The log not existing is ordinary: nothing has written to it yet.
    if (e?.code === 'ENOENT') return false
    throw e
  }
}

/**
 * Rotate before a writer opens the file, for logs written through a held file
 * descriptor.
 *
 * This is the ONLY safe point for those. `tlda daemon` gives the child an fd
 * from `openSync(logFile, 'a')`, and renaming underneath it does not redirect
 * the writer — the daemon keeps filling the renamed inode while the file at the
 * original path stays empty. That reads as "rotation worked" and is strictly
 * worse than not rotating, because the current log is then the empty one.
 *
 * The daemon restarts on every deploy — seventeen times on 2026-08-18 — so this
 * fires often enough without anything scheduling it.
 */
export function rotateBeforeOpen(file, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP } = {}) {
  if (maxBytes <= 0) return false
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch (e) {
    // No log yet is the ordinary case on a fresh machine, and there is nothing
    // to rotate. Any other stat failure is real and must not be mistaken for it.
    if (e?.code === 'ENOENT') return false
    throw e
  }
  if (size < maxBytes) return false
  return rotateNow(file, { keep })
}

/**
 * An append function that rotates when the file gets large, for logs this
 * process writes by path.
 *
 * The size check is time-throttled rather than per-append: `client.log` takes
 * bursts of hundreds of lines and a `stat` on each one is a syscall per log
 * line on a request path. Overshooting the threshold by one check interval is
 * the cheaper error.
 */
export function createRotatingAppender(file, {
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
  checkEveryMs = LOG_SIZE_CHECK_MS,
  now = () => Date.now(),
  onRotate = null,
  onError = (e) => console.log(`[rotating-log] size check failed: ${e.message}`),
} = {}) {
  let lastCheck = 0
  let rotating = null

  async function maybeRotate() {
    if (maxBytes <= 0) return
    const t = now()
    if (t - lastCheck < checkEveryMs) return
    lastCheck = t
    // One rotation at a time: concurrent appends must not each shift the
    // generations, which would leave .1 holding a few lines and .4 holding
    // everything that mattered.
    if (rotating) return rotating
    rotating = (async () => {
      try {
        const { size } = await fsp.stat(file)
        if (size >= maxBytes && rotateNow(file, { keep })) onRotate?.(file, size)
      } catch (e) {
        // Never fail an append because the size check could not run: dropping a
        // log line to report a rotation problem loses the thing being logged,
        // which on this path is somebody's diagnostic evidence. The next check
        // is `checkEveryMs` away and sees the same oversized file, so a real
        // problem repeats rather than passing silently.
        //
        // ENOENT is not a problem — the log does not exist until the first
        // append lands, so reporting it would put a line in every startup.
        if (e?.code !== 'ENOENT') onError?.(e)
      } finally {
        rotating = null
      }
    })()
    return rotating
  }

  return async function append(text) {
    await maybeRotate()
    await fsp.appendFile(file, text)
  }
}

import fs from 'node:fs'
import path from 'node:path'

// One survey of which bots are beating, shared rather than reimplemented.
//
// It is shared because two bots have to run it and a second copy would drift.
// The dev bot runs it over `testing` and excludes itself; a bot that is down is
// not running its own checks, so dev can never be the thing that reports dev
// missing. That is not a gap to paper over -- it is why the survey has to be
// callable from somewhere other than dev.
//
// The watch set is the declaration UNION every heartbeat file on disk. Taking it
// from `bots.yaml` alone means the single edit that stops a bot -- removing it
// from its environment list -- also removes it from the set being watched. `dev`
// was undeclared on 2026-08-17 to contain a flood and stayed down 32 hours with
// nothing reporting it, because the instrument for exactly that took its
// subjects from the file that had just stopped naming it.
//
// Undeclaring stays legitimate. Being indistinguishable from a death does not.

export function heartbeatFilePath(heartbeatDir, envName, botName) {
  return path.join(heartbeatDir, `${botName}.${envName}.heartbeat`)
}

// Bots that have a heartbeat file for this environment, whatever the
// declaration says about them.
export function botsWithHeartbeatFiles(heartbeatDir, envName, readDir = dir => fs.readdirSync(dir)) {
  const suffix = `.${envName}.heartbeat`
  let entries
  try {
    entries = readDir(heartbeatDir)
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.endsWith(suffix))
    .map(entry => entry.slice(0, -suffix.length).toLowerCase())
    .filter(Boolean)
}

function lastEntry(file, readFile) {
  try {
    const text = readFile(file)
    const line = text.trimEnd().split('\n').pop()
    return line ? JSON.parse(line) : null
  } catch {
    return null
  }
}

// Reads the last ~64KB rather than the file: these grow to tens of megabytes.
function tailText(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(handle).size
    const span = Math.min(size, 65_536)
    const buffer = Buffer.alloc(span)
    fs.readSync(handle, buffer, 0, span, size - span)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * Classify every bot this environment should have a heartbeat for.
 *
 * `stopped` had a heartbeat and lost it — a bot that went down.
 * `deaf` is writing heartbeats without hearing a fleet event — alive, not working.
 * `unmonitored` is declared with no heartbeat instrument at all; it degrades the
 *   survey rather than alarming, because it means "cannot say", not "is down".
 * `undeclared` has a heartbeat file and no declaration — it was running, so
 *   nothing supervises it now.
 */
export function surveyBotHeartbeats({
  declaredBots = [],
  heartbeatDir,
  envName,
  staleMs,
  exclude = [],
  now = () => Date.now(),
  readDir = dir => fs.readdirSync(dir),
  statFile = file => fs.statSync(file),
  readFile = tailText,
} = {}) {
  const excluded = new Set(exclude.map(name => String(name).toLowerCase()))
  const declared = declaredBots
    .map(name => String(name).toLowerCase())
    .filter(name => !excluded.has(name))
  const declaredSet = new Set(declared)
  const undeclaredNames = botsWithHeartbeatFiles(heartbeatDir, envName, readDir)
    .filter(name => !excluded.has(name) && !declaredSet.has(name))

  const currentTime = now()
  const beating = []
  const stopped = []
  const deaf = []
  const unmonitored = []

  for (const name of declared) {
    const file = heartbeatFilePath(heartbeatDir, envName, name)
    let stat
    try {
      stat = statFile(file)
    } catch {
      unmonitored.push({ name, file })
      continue
    }
    const birthtimeMs = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
    const last = lastEntry(file, readFile)
    // A bot writing heartbeats while its fleet event cursor stays at zero is
    // connected to nothing. Judged from birth rather than mtime, because it is
    // beating -- mtime is fresh and says nothing about whether it can hear.
    if (last && Object.hasOwn(last, 'lastFleetEventId')
      && Number(last.lastFleetEventId) === 0
      && currentTime - birthtimeMs >= staleMs) {
      deaf.push({ name, file, staleMin: Math.round((currentTime - birthtimeMs) / 60_000), reason: last.reason || null })
      continue
    }
    const staleMsActual = currentTime - stat.mtimeMs
    if (staleMsActual >= staleMs) stopped.push({ name, file, staleMin: Math.round(staleMsActual / 60_000) })
    else beating.push(name)
  }

  const undeclared = undeclaredNames.map(name => {
    const file = heartbeatFilePath(heartbeatDir, envName, name)
    let staleMin = null
    try {
      staleMin = Math.round((currentTime - statFile(file).mtimeMs) / 60_000)
    } catch {
      staleMin = null
    }
    return { name, file, staleMin }
  })

  return { beating, stopped, deaf, unmonitored, undeclared }
}

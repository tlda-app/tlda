import fs from 'fs'
import path from 'path'

export function persistDeadLetter(file, message, { now = () => new Date().toISOString(), log = null } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ...message, ts: now(), dropped: true }) + '\n')
    return true
  } catch (e) {
    log?.error?.(`failed to write dead-letter: ${e.message}`)
    return false
  }
}

export function replayDeadLetters(file, send, { log = null } = {}) {
  if (!fs.existsSync(file)) return { replayed: 0, remaining: 0, malformed: 0 }
  const lines = fs.readFileSync(file, 'utf8').split(/\n/).filter(line => line.trim())
  const remaining = []
  let replayed = 0
  let malformed = 0
  let stopped = false
  for (const line of lines) {
    if (stopped) {
      remaining.push(line)
      continue
    }
    let message
    try {
      message = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    try {
      if (send(message)) {
        replayed++
        continue
      }
    } catch (e) {
      log?.warn?.(`dead-letter replay send failed: ${e.message}`)
    }
    remaining.push(line)
    stopped = true
  }

  if (remaining.length) {
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, remaining.join('\n') + '\n')
    fs.renameSync(tmp, file)
  } else {
    fs.rmSync(file, { force: true })
  }
  return { replayed, remaining: remaining.length, malformed }
}

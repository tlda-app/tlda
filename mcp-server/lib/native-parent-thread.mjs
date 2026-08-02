import fs from 'node:fs'

export function matchesLocalParentThread(threadId, claudeSession, mintSessionId) {
  return Boolean(threadId && (threadId === claudeSession || threadId === mintSessionId))
}

export function parentTranscriptContainsToolUse(sessionPath, toolUseId) {
  if (!sessionPath || !toolUseId) return false
  let fd
  try {
    fd = fs.openSync(sessionPath, 'r')
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, 1024 * 1024)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8').includes(JSON.stringify(toolUseId))
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

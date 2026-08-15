import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const FFMPEG_BIN = process.env.FFMPEG || 'ffmpeg'

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${FFMPEG_BIN} exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

export async function materializeRecordingAudioClip(
  recordingsDir,
  recordingId,
  { startMs, endMs },
  run = runFfmpeg,
) {
  const source = join(recordingsDir, `${recordingId}.audio`)
  if (!existsSync(source)) throw new Error('Raw recording audio not found')
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    throw new RangeError('Audio clip needs 0 <= startMs < endMs')
  }

  const publishedDir = join(recordingsDir, 'publication')
  mkdirSync(publishedDir, { recursive: true })
  const output = join(publishedDir, `${recordingId}.audio`)
  const pending = `${output}.pending.webm`
  try {
    await run([
      '-y',
      '-i', source,
      '-ss', String(startMs / 1000),
      '-t', String((endMs - startMs) / 1000),
      '-vn',
      '-c:a', 'libopus',
      pending,
    ])
  } catch (error) {
    rmSync(pending, { force: true })
    throw error
  }
  renameSync(pending, output)
  return { path: output, mime: 'audio/webm', duration_ms: endMs - startMs }
}

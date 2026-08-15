import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { materializeRecordingAudioClip } from './recording-audio-clip.mjs'

test('materializes only the bounded interval as a private WebM asset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-audio-'))
  try {
    const source = join(dir, 'lecture-1.audio')
    writeFileSync(source, 'raw')
    let received = null
    const result = await materializeRecordingAudioClip(
      dir,
      'lecture-1',
      { startMs: 2_500, endMs: 8_000 },
      async (args) => {
        received = args
        writeFileSync(args.at(-1), 'clipped')
      },
    )

    assert.deepEqual(received, [
      '-y',
      '-i', source,
      '-ss', '2.5',
      '-t', '5.5',
      '-vn',
      '-c:a', 'libopus',
      join(dir, 'publication', 'lecture-1.audio.pending.webm'),
    ])
    assert.deepEqual(result, {
      path: join(dir, 'publication', 'lecture-1.audio'),
      mime: 'audio/webm',
      duration_ms: 5_500,
    })
    assert.equal(readFileSync(result.path, 'utf8'), 'clipped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses an invalid interval or missing raw audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-audio-'))
  try {
    await assert.rejects(
      materializeRecordingAudioClip(dir, 'missing', { startMs: 0, endMs: 1_000 }),
      /Raw recording audio not found/,
    )
    writeFileSync(join(dir, 'lecture-1.audio'), 'raw')
    await assert.rejects(
      materializeRecordingAudioClip(dir, 'lecture-1', { startMs: 1_000, endMs: 1_000 }),
      RangeError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed materialization leaves no partial student asset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-audio-'))
  try {
    writeFileSync(join(dir, 'lecture-1.audio'), 'raw')
    await assert.rejects(
      materializeRecordingAudioClip(
        dir,
        'lecture-1',
        { startMs: 0, endMs: 1_000 },
        async (args) => {
          writeFileSync(args.at(-1), 'partial')
          throw new Error('ffmpeg failed')
        },
      ),
      /ffmpeg failed/,
    )
    assert.equal(existsSync(join(dir, 'publication', 'lecture-1.audio.pending.webm')), false)
    assert.equal(existsSync(join(dir, 'publication', 'lecture-1.audio')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const EVENT_RULES = [
  { kind: 'browser-connect', layer: 'browser', re: /browser connected/i },
  { kind: 'browser-drop', layer: 'browser', re: /browser disconnected|mic (?:access )?failed|no mic input/i },
  { kind: 'deepgram-connect', layer: 'deepgram', re: /connected to deepgram/i },
  { kind: 'deepgram-drop', layer: 'deepgram', re: /upstream closed|deepgram error|connect failed/i },
  { kind: 'bridge-drop', layer: 'bridge', re: /audio (?:send )?failed|pending audio dropped|socket not open/i },
  { kind: 'stall', layer: 'bridge', re: /idle cutoff|no speech|stale audio|waiting for recognizer/i },
]

function parseTimestamp(line) {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)/)
  return match ? match[1] : null
}

export function buildVoicePipelineSnapshot({ bridgeLines = [], livePerfSamples = [], now = Date.now() } = {}) {
  const events = []
  const counts = {
    browser_connects: 0,
    browser_drops: 0,
    deepgram_connects: 0,
    deepgram_drops: 0,
    bridge_drops: 0,
    stalls: 0,
  }

  for (const raw of bridgeLines.slice(-500)) {
    const line = String(raw || '').trim()
    if (!line) continue
    const rule = EVENT_RULES.find(candidate => candidate.re.test(line))
    if (!rule) continue
    const countKey = `${rule.kind.replaceAll('-', '_')}s`
    if (Object.hasOwn(counts, countKey)) counts[countKey] += 1
    events.push({ timestamp: parseTimestamp(line), layer: rule.layer, kind: rule.kind, detail: line })
  }

  const browser = livePerfSamples.slice(-100).map(sample => ({
    timestamp: sample.ts || null,
    backend: sample.data?.voice?.backend || 'none',
    recording: !!sample.data?.voice?.recording,
    liveness: sample.data?.voice?.liveness || 'unknown',
    health: sample.data?.voice?.healthLabel || 'quiet',
    deepgram_connected: !!sample.data?.voice?.deepgram?.connected,
    mic_stream: !!sample.data?.voice?.deepgram?.hasMicStream,
    last_mic_frame_ms: sample.data?.voice?.deepgram?.lastMicFrameAgoMs ?? null,
    last_audio_chunk_ms: sample.data?.voice?.deepgram?.lastAudioChunkAgoMs ?? null,
  }))
  const latestBrowser = browser.at(-1) || null
  const lastFailure = [...events].reverse().find(event => event.kind.endsWith('drop') || event.kind === 'stall') || null

  return {
    generated_at: new Date(now).toISOString(),
    source: {
      bridge: 'deepgram-sdk-bridge.log',
      bridge_lines_scanned: Math.min(bridgeLines.length, 500),
      browser_samples_scanned: Math.min(livePerfSamples.length, 100),
      read_only: true,
    },
    counts,
    latest_browser: latestBrowser,
    last_failure: lastFailure,
    browser,
    events: events.slice(-100),
  }
}

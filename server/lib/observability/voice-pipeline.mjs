export function buildVoicePipelineSnapshot({ livePerfSamples = [], now = Date.now() } = {}) {
  const browser = livePerfSamples.slice(-100).map(sample => ({
    timestamp: sample.ts || null,
    backend: sample.data?.voice?.backend || 'none',
    recording: !!sample.data?.voice?.recording,
    liveness: sample.data?.voice?.liveness || 'unknown',
    health: sample.data?.voice?.healthLabel || 'quiet',
    relay_connected: !!sample.data?.voice?.deepgram?.relayConnected,
    recognizer_status: sample.data?.voice?.deepgram?.recognizerStatus || null,
    recognizer_connected: !!sample.data?.voice?.deepgram?.recognizerConnected,
    common_state: sample.data?.voice?.deepgram?.commonState || null,
    mic_stream: !!sample.data?.voice?.deepgram?.hasMicStream,
    last_mic_frame_ms: sample.data?.voice?.deepgram?.lastMicFrameAgoMs ?? null,
    last_audio_chunk_ms: sample.data?.voice?.deepgram?.lastAudioChunkAgoMs ?? null,
  }))
  const latestBrowser = browser.at(-1) || null
  return {
    generated_at: new Date(now).toISOString(),
    source: {
      browser_samples_scanned: Math.min(livePerfSamples.length, 100),
      read_only: true,
    },
    latest_browser: latestBrowser,
    browser,
  }
}

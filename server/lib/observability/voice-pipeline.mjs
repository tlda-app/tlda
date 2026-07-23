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
    mic_frame_cadence_ms: sample.data?.voice?.deepgram?.micFrameCadenceMs ?? null,
    last_mic_frame_ms: sample.data?.voice?.deepgram?.lastMicFrameAgoMs ?? null,
    audio_chunk_cadence_ms: sample.data?.voice?.deepgram?.audioChunkCadenceMs ?? null,
    last_audio_chunk_ms: sample.data?.voice?.deepgram?.lastAudioChunkAgoMs ?? null,
    bufferedAmount: sample.data?.voice?.deepgram?.wsBufferedAmount ?? null,
    audioBacklogFrames: sample.data?.voice?.deepgram?.audioBacklogFrames ?? null,
    audioBacklogBytes: sample.data?.voice?.deepgram?.audioBacklogBytes ?? null,
    audioBacklogOldestAgeMs: sample.data?.voice?.deepgram?.audioBacklogOldestAgeMs ?? null,
    droppedAudioFrames: sample.data?.voice?.deepgram?.droppedAudioFrames ?? null,
    flushedAudioFrames: sample.data?.voice?.deepgram?.flushedAudioFrames ?? null,
    proxy_pendingFrames: sample.data?.voice?.deepgram?.proxy?.pendingFrames ?? null,
    proxy_pendingBytes: sample.data?.voice?.deepgram?.proxy?.pendingBytes ?? null,
    proxy_oldestAgeMs: sample.data?.voice?.deepgram?.proxy?.oldestAgeMs ?? null,
    proxy_droppedFrames: sample.data?.voice?.deepgram?.proxy?.droppedFrames ?? null,
    proxy_flushedFrames: sample.data?.voice?.deepgram?.proxy?.flushedFrames ?? null,
    bridge_upstreamConnected: !!sample.data?.voice?.deepgram?.bridge?.upstreamConnected,
    bridge_lastUpstreamAudioAgoMs: sample.data?.voice?.deepgram?.bridge?.lastUpstreamAudioAgoMs ?? null,
    bridge_transcriptLatencyMs: sample.data?.voice?.deepgram?.bridge?.transcriptLatencyMs ?? null,
    bridge_pendingFinalAgeMs: sample.data?.voice?.deepgram?.bridge?.pendingFinalAgeMs ?? null,
    bridge_reconnectCount: sample.data?.voice?.deepgram?.bridge?.reconnectCount ?? null,
    bridge_droppedChunks: sample.data?.voice?.deepgram?.bridge?.droppedChunks ?? null,
    bridge_flushedChunks: sample.data?.voice?.deepgram?.bridge?.flushedChunks ?? null,
  }))
  const latestBrowser = browser.at(-1) || null
  const latestNumber = key => {
    for (let i = browser.length - 1; i >= 0; i--) {
      const value = browser[i][key]
      if (Number.isFinite(value)) return value
    }
    return null
  }
  return {
    generated_at: new Date(now).toISOString(),
    source: {
      browser_samples_scanned: Math.min(livePerfSamples.length, 100),
      read_only: true,
    },
    latest_browser: latestBrowser,
    latest_counters: {
      bufferedAmount: latestNumber('bufferedAmount'),
      audioBacklogFrames: latestNumber('audioBacklogFrames'),
      audioBacklogBytes: latestNumber('audioBacklogBytes'),
      droppedAudioFrames: latestNumber('droppedAudioFrames'),
      flushedAudioFrames: latestNumber('flushedAudioFrames'),
      proxy_pendingFrames: latestNumber('proxy_pendingFrames'),
      proxy_pendingBytes: latestNumber('proxy_pendingBytes'),
      proxy_droppedFrames: latestNumber('proxy_droppedFrames'),
      proxy_flushedFrames: latestNumber('proxy_flushedFrames'),
      bridge_reconnectCount: latestNumber('bridge_reconnectCount'),
      bridge_droppedChunks: latestNumber('bridge_droppedChunks'),
      bridge_flushedChunks: latestNumber('bridge_flushedChunks'),
    },
    browser,
  }
}

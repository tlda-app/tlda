// Soft replay windows for ephemeral custom messages.
//
// These values are a reconnect convenience only: the cache is process memory,
// disappears on server restart, and must not be the source of truth for anything
// whose absence would leave the viewer wrong. Durable viewer state belongs in
// TLDraw/Yjs shapes.
export const SIGNAL_REPLAY_WINDOWS = {
  // Ephemeral build chrome. Durable build errors/warnings live on doc-version.
  'signal:build-status': 600_000,
  'signal:build-progress': 300_000,
  // Presence/navigation hints. Missing one self-corrects on the next heartbeat
  // or user interaction.
  'signal:agent-heartbeat': 30_000,
  // TODO(signal-durability): behavior-gated; replace with doc-viewer-state if
  // confirmed durable per-build review state.
  'signal:diff-review': 86_400_000,
  'signal:diff-summaries': 86_400_000,
  // Rebuild prioritization and presentation hints.
  'signal:viewport': 300_000,
  'signal:presenter': 600_000,
  'signal:slide-index': 600_000,
  'signal:slide-fragment': 600_000,
} as const satisfies Record<string, number>

export type ReplaySignalKey = keyof typeof SIGNAL_REPLAY_WINDOWS

export function getSignalReplayMs(key: string): number | undefined {
  return SIGNAL_REPLAY_WINDOWS[key as ReplaySignalKey]
}

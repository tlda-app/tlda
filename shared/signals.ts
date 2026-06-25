export const SIGNAL_REPLAY_WINDOWS = {
  'signal:build-status': 600_000,
  'signal:build-progress': 300_000,
  'signal:agent-heartbeat': 30_000,
  'signal:diff-review': 86_400_000,
  'signal:diff-summaries': 86_400_000,
  'signal:viewport': 300_000,
  'signal:presenter': 600_000,
  'signal:slide-index': 600_000,
  'signal:slide-fragment': 600_000,
} as const satisfies Record<string, number>

export type ReplaySignalKey = keyof typeof SIGNAL_REPLAY_WINDOWS

export function getSignalReplayMs(key: string): number | undefined {
  return SIGNAL_REPLAY_WINDOWS[key as ReplaySignalKey]
}

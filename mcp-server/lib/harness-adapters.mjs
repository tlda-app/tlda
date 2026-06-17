export const HARNESS_ADAPTERS = {
  claude: {
    kind: 'claude',
    channelNudge: false,
    nudgeSettleMs: 0,
    educationGate: false,
  },
  goose: {
    kind: 'goose',
    channelNudge: true,
    nudgeSettleMs: 0,
    educationGate: true,
  },
  codex: {
    kind: 'codex',
    channelNudge: true,
    nudgeSettleMs: 400,
    educationGate: true,
  },
}

export function harnessKindFromEnv(env = process.env) {
  const kind = env.FLEET_HARNESS || 'claude'
  if (!HARNESS_ADAPTERS[kind]) throw new Error(`unknown FLEET_HARNESS ${kind}`)
  return kind
}

export function harnessFromEnv(env = process.env) {
  return HARNESS_ADAPTERS[harnessKindFromEnv(env)]
}

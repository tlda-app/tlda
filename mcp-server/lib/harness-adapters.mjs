import { HARNESS } from '../../shared/harness.ts'

export const HARNESS_ADAPTERS = HARNESS

export function harnessKindFromEnv(env = process.env) {
  const kind = env.FLEET_HARNESS || 'claude'
  if (!HARNESS_ADAPTERS[kind]) throw new Error(`unknown FLEET_HARNESS ${kind}`)
  return kind
}

export function harnessFromEnv(env = process.env) {
  return HARNESS_ADAPTERS[harnessKindFromEnv(env)]
}

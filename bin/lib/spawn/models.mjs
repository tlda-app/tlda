export const DEFAULT_MODEL = 'claude-opus-4-8[1m]'

export const MODEL_ALIASES = Object.freeze({
  opus: DEFAULT_MODEL,
  opus45: 'claude-opus-4-5',
  opus46: 'claude-opus-4-6[1m]',
  opus47: 'claude-opus-4-7[1m]',
  opus48: 'claude-opus-4-8[1m]',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
})

export const GOOSE_MODELS = Object.freeze({
  cursor: 'cursor-agent/default',
  'cursor-agent': 'cursor-agent/default',
  'cursor-default': 'cursor-agent/default',
  deepseek: 'deepseek/deepseek-v4-pro',
  'deepseek-chat': 'deepseek/deepseek-chat',
  'deepseek-v3': 'deepseek/deepseek-v3.2',
  'deepseek-r1': 'deepseek/deepseek-r1-0528',
  'deepseek-reasoner': 'deepseek/deepseek-r1-0528',
  'deepseek-v4': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  kimi: 'moonshotai/kimi-k2.7-code',
  'kimi-k2.7': 'moonshotai/kimi-k2.7-code',
  qwen: 'qwen/qwen3.7-max',
  'qwen3.7-max': 'qwen/qwen3.7-max',
  glm: 'z-ai/glm-5.1',
  'glm-5.1': 'z-ai/glm-5.1',
  minimax: 'minimax/minimax-m3',
  'minimax-m3': 'minimax/minimax-m3',
  gemini: 'google/gemini-3.5-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  mistral: 'mistralai/mistral-medium-3-5',
  'mistral-medium-3-5': 'mistralai/mistral-medium-3-5',
})

export const GOOSE_VERIFIED = new Set([
  'cursor-agent/default',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-r1-0528',
  'moonshotai/kimi-k2.7-code',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.1',
  'minimax/minimax-m3',
  'mistralai/mistral-medium-3-5',
])

export const CODEX_MODELS = Object.freeze({
  gpt: 'gpt-5.5',
  gpt55: 'gpt-5.5',
  codex: 'gpt-5.5',
})

export function resolveClaudeModel(model) {
  if (!model) return DEFAULT_MODEL
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model]
  if (String(model).startsWith('claude-')) return String(model)
  throw new Error(`Unknown model: ${JSON.stringify(model)}. Valid: ${Object.keys(MODEL_ALIASES).sort().join(', ')}`)
}

export function resolveGooseModel(model) {
  if (!model) return GOOSE_MODELS.deepseek
  if (GOOSE_MODELS[model]) return GOOSE_MODELS[model]
  if (String(model).includes('/')) return String(model)
  throw new Error(`Unknown goose model: ${JSON.stringify(model)}. Valid: ${Object.keys(GOOSE_MODELS).sort().join(', ')} or vendor/model`)
}

export function gooseModelVerified(model) {
  return GOOSE_VERIFIED.has(model)
}

export function resolveCodexModel(model) {
  if (!model) return CODEX_MODELS.gpt
  if (CODEX_MODELS[model]) return CODEX_MODELS[model]
  if (/^gpt/i.test(String(model))) return CODEX_MODELS.gpt
  return String(model)
}

export function inferHarnessKind(kind, model) {
  if (kind) return kind
  const raw = String(model || '')
  if (raw in CODEX_MODELS || raw.startsWith('gpt') || raw === 'codex') return 'codex'
  if (raw in GOOSE_MODELS || raw.includes('/')) return 'goose'
  return 'claude'
}

export function listModels() {
  const models = [
    ...Object.entries(MODEL_ALIASES).sort(([a], [b]) => a.localeCompare(b)).map(([alias, id]) => ({
      alias,
      id,
      verified: true,
      kind: 'claude',
    })),
    ...Object.entries(GOOSE_MODELS).sort(([a], [b]) => a.localeCompare(b)).map(([alias, id]) => ({
      alias,
      id,
      verified: GOOSE_VERIFIED.has(id),
      kind: 'goose',
    })),
    ...Object.entries(CODEX_MODELS).sort(([a], [b]) => a.localeCompare(b)).map(([alias, id]) => ({
      alias,
      id,
      verified: true,
      kind: 'codex',
    })),
  ]
  return {
    default: GOOSE_MODELS.deepseek,
    models,
    verified: [...GOOSE_VERIFIED].sort(),
  }
}

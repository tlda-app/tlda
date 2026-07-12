export type MintInput = {
  doc: string
  name: string | undefined
  model: string | undefined
  options: Record<string, string>
  effort: string | undefined
}

/** Python-call-like mint grammar: three positional tokens, then key:value tokens. */
export function parseMintInput(raw: string): MintInput {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const positional = tokens.filter(token => !token.includes(':'))
  const keywords = new Map(tokens
    .filter(token => token.includes(':'))
    .map(token => {
      const colon = token.indexOf(':')
      return [token.slice(0, colon), token.slice(colon + 1)]
    }))
  const doc = positional[0] || ''
  const name = positional[1] || undefined
  const model = positional[2] || undefined
  const options = Object.fromEntries(keywords)
  return { doc, name, model, options, effort: keywords.get('effort') || undefined }
}

export function activeMintToken(input: string): { pos: number; prefix: string } {
  const trailingSpace = /\s$/.test(input)
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  const current = trailingSpace ? '' : tokens[tokens.length - 1] || ''
  if (current.includes(':')) return { pos: 4, prefix: current }
  const positionalBefore = (trailingSpace ? tokens : tokens.slice(0, -1))
    .filter(token => !token.includes(':')).length
  if (trailingSpace && positionalBefore >= 3) return { pos: 4, prefix: '' }
  return { pos: Math.min(positionalBefore + 1, 3), prefix: current }
}

export function applyMintCandidate(input: string, candidate: string): string {
  const { pos, prefix } = activeMintToken(input)
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (pos === 4) {
    const key = prefix.includes(':') ? prefix.slice(0, prefix.indexOf(':')) : (candidate.includes(':') ? candidate.slice(0, candidate.indexOf(':')) : '')
    const next = candidate.includes(':') ? candidate : `${key}:${candidate}`
    const existingIndex = key ? tokens.findIndex(token => token.startsWith(`${key}:`)) : -1
    if (existingIndex >= 0) tokens[existingIndex] = next
    else tokens.push(next)
    return tokens.join(' ')
  }
  const positionalIndices = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => !token.includes(':'))
  const target = positionalIndices[pos - 1]
  if (target) tokens[target.index] = candidate
  else tokens.push(candidate)
  return tokens.join(' ')
}

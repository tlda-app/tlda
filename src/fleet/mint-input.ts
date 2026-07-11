export type MintInput = {
  doc: string
  name: string | undefined
  model: string | undefined
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
  return { doc, name, model, effort: keywords.get('effort') || undefined }
}

export function activeMintToken(input: string): { pos: number; prefix: string } {
  const trailingSpace = /\s$/.test(input)
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  const current = trailingSpace ? '' : tokens[tokens.length - 1] || ''
  if (current.startsWith('effort:')) return { pos: 4, prefix: current }
  const positionalBefore = (trailingSpace ? tokens : tokens.slice(0, -1))
    .filter(token => !token.includes(':')).length
  return { pos: Math.min(positionalBefore + 1, 3), prefix: current }
}

export function applyMintCandidate(input: string, candidate: string): string {
  const { pos } = activeMintToken(input)
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (pos === 4) {
    const effortIndex = tokens.findIndex(token => token.startsWith('effort:'))
    if (effortIndex >= 0) tokens[effortIndex] = `effort:${candidate}`
    else tokens.push(`effort:${candidate}`)
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

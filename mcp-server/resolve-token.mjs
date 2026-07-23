/**
 * Resolve CTD auth token.
 *
 * Priority: TLDA_TOKEN env → tokenRw from tokens.json → null
 */

import { getRwToken } from '../shared/config.mjs'

let resolved = undefined

export function resolveToken() {
  if (resolved !== undefined) return resolved
  resolved = getRwToken()
  return resolved
}

import * as bot from './harness/bot.mjs'
import * as claude from './harness/claude.mjs'
import * as codex from './harness/codex.mjs'
import * as goose from './harness/goose.mjs'
import * as muse from './harness/muse.mjs'

// The map is derived from what adapters export, never from a harness name
// list. A harness with no resolveLiveSessionIdentity (goose today) is simply
// absent; it works as soon as its adapter exports the function, with no edit
// here or at any call site.
const ADAPTERS = { bot, claude, codex, goose, muse }

export function liveIdentityResolverMap(adapters = ADAPTERS) {
  const map = {}
  for (const [harness, adapter] of Object.entries(adapters || {})) {
    if (typeof adapter?.resolveLiveSessionIdentity === 'function') {
      map[harness] = adapter.resolveLiveSessionIdentity
    }
  }
  return map
}

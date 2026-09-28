/**
 * Pre-send chat linters: configurable binary gates on outbound chat.
 *
 * One explicit contract: a message the sender marks as an outline must be
 * file-backed, because outlines get edited. Nothing is inferred from length or
 * shape — ordinary messages, long or list-shaped, are never gated.
 *
 * Pure functions, no I/O: the server imports this module and runs
 * `lintChatOutbound` at chat ingress, so the executables ship with the deploy
 * and only the declarative config is server-held (`server.yaml` `chatLinters:`
 * — absent means the linter is off).
 *
 * See docs/chat-linters.md for the daemon/server placement boundary.
 */

export const CHAT_LINTER_IDS = Object.freeze(['outline-file-backed'])

const PASS = Object.freeze({ pass: true, linter: null, error: null })

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize the server-held `chatLinters` config. Absent or misshapen config
 * disables the linter rather than breaking chat: this runs on the send path,
 * so a config fault must fail open (and loud, at the call site's log), never
 * refuse a send for a reason the sender cannot fix.
 */
export function normalizeChatLintersConfig(raw) {
  const off = { outlineFileBacked: { enabled: false } }
  if (!isRecord(raw)) return off
  const linterRaw = isRecord(raw.outlineFileBacked) ? raw.outlineFileBacked : null
  return { outlineFileBacked: { enabled: linterRaw?.enabled === true } }
}

function hasFileSource(source) {
  return typeof source?.file === 'string' && source.file.trim().length > 0
}

/**
 * outline-file-backed: a message explicitly marked as an outline fails unless
 * it carries a source file. Unmarked messages pass untouched, whatever their
 * length or shape.
 *
 * The error carries no trailing period: the durable-transport refusal template
 * appends one (`...refused it: <reason>.`), so a period here renders doubled.
 */
export function lintOutlineFileBacked({ source = null, outline = false } = {}, options = {}) {
  if (options.enabled !== true) return PASS
  if (outline !== true) return PASS
  if (hasFileSource(source)) return PASS
  return {
    pass: false,
    linter: 'outline-file-backed',
    error: 'outline-file-backed: this message is marked as an outline but has no source file. '
      + 'Write it in a file first and send it with `file`+`selector` so it can be read and edited in place',
  }
}

/**
 * Run the configured linters in order. One linter today; the entry point stays
 * so the ingress call site does not change when policy does.
 */
export function lintChatOutbound({ source = null, outline = false, config = null } = {}) {
  const normalized = normalizeChatLintersConfig(config)
  return lintOutlineFileBacked({ source, outline }, normalized.outlineFileBacked)
}

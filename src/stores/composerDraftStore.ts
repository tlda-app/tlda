/**
 * Composer draft store — unsent chat text, per composer instance.
 *
 * The chat composer is an uncontrolled <textarea>, so its only copy of the text
 * was the DOM node's value. Anything that unmounts the composer destroyed it:
 * opening filter mode on a chat panel (which a filter pill merely hovering over
 * the panel does on its own), the viewport culling shell, switching threads in
 * the inbox. Skip's rule for this, 2026-04-06: "zero text should vanish."
 *
 * Two buffers, deliberately different lifetimes:
 *
 * - The DRAFT is what he has typed and not sent. Survives remount AND reload,
 *   so it is mirrored to localStorage.
 * - The CLEARED buffer backs the composer's ✕/↺ pair — text he explicitly threw
 *   away and may want back. Memory only: a ↺ button offering to restore text
 *   from a session two days ago is a surprise, not a rescue.
 */

const STORAGE_KEY = 'tlda-chat-drafts'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 50
const WRITE_DEBOUNCE_MS = 300

type StoredDraft = { text: string; ts: number }

const drafts = new Map<string, StoredDraft>()
const cleared = new Map<string, string>()
let hydrated = false
let writeTimer: ReturnType<typeof setTimeout> | null = null

function hydrate() {
  if (hydrated) return
  hydrated = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, StoredDraft>
    const cutoff = Date.now() - MAX_AGE_MS
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry.text !== 'string' || !entry.text) continue
      if (!(entry.ts > cutoff)) continue
      drafts.set(key, entry)
    }
  } catch (e) {
    // Nothing to recover, but say so: silent draft loss is the bug this file exists to fix.
    console.warn('[composer-draft] could not read saved drafts:', e)
  }
}

/** Serialize the in-memory map, dropping stale and surplus entries. */
function persist() {
  writeTimer = null
  const cutoff = Date.now() - MAX_AGE_MS
  for (const [key, entry] of drafts) {
    if (!(entry.ts > cutoff)) drafts.delete(key)
  }
  if (drafts.size > MAX_ENTRIES) {
    const oldestFirst = [...drafts].sort((a, b) => a[1].ts - b[1].ts)
    for (const [key] of oldestFirst.slice(0, drafts.size - MAX_ENTRIES)) drafts.delete(key)
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)))
  } catch (e) {
    // Private mode or quota. The in-memory copy still survives remounts, which is
    // the case that actually bit him; only reload durability is lost. Say which.
    console.warn('[composer-draft] drafts will not survive a reload:', e)
  }
}

/** Text he had typed and not sent, or '' if none. */
export function getComposerDraft(key: string): string {
  hydrate()
  return drafts.get(key)?.text ?? ''
}

/**
 * Record the current text. Debounced: this runs per keystroke, and localStorage
 * writes are synchronous. `flushComposerDraft` is the exact, immediate version
 * for unmount, where there is no later keystroke to coalesce with.
 */
export function saveComposerDraft(key: string, text: string) {
  hydrate()
  if (text) drafts.set(key, { text, ts: Date.now() })
  else drafts.delete(key)
  if (writeTimer) return
  writeTimer = setTimeout(persist, WRITE_DEBOUNCE_MS)
}

/** Record the current text and write through now. Use on unmount. */
export function flushComposerDraft(key: string, text: string) {
  hydrate()
  if (text) drafts.set(key, { text, ts: Date.now() })
  else drafts.delete(key)
  if (writeTimer) clearTimeout(writeTimer)
  persist()
}

/** The message went out — the draft is no longer unsent text. */
export function clearComposerDraft(key: string) {
  flushComposerDraft(key, '')
}

/** ✕ — stash what he threw away so ↺ can put it back. Memory only. */
export function stashClearedComposerDraft(key: string, text: string) {
  if (text) cleared.set(key, text)
  else cleared.delete(key)
}

/** Is there anything for ↺ to restore? */
export function peekClearedComposerDraft(key: string): string | null {
  return cleared.get(key) ?? null
}

/** ↺ — hand back what ✕ took, and forget it. */
export function takeClearedComposerDraft(key: string): string | null {
  const text = cleared.get(key) ?? null
  cleared.delete(key)
  return text
}

/** He typed again, so the cleared text is no longer what ↺ should offer. */
export function dropClearedComposerDraft(key: string) {
  cleared.delete(key)
}

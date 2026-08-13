/**
 * ChatComposer — the shared core chat composer.
 *
 * Extracted from FleetChatShape's input textarea so the fleet chat shape AND the
 * inbox's inline message-shaped chat use the SAME composer: textarea + voice
 * target registration (voice.mjs) + send-on-enter + sent-history. The host owns
 * everything chat-specific (viewer context, ref attachments, plan-mode, the
 * /terminal command, file-drop, escalation reset) and passes it in via callbacks,
 * so the shape can stay byte-identical while the inline chat opts out of the
 * heavy extras.
 *
 * Voice owns text entry. Enter and the voice "send" command submit through the
 * same composer operation.
 */
import { stopEventPropagation } from 'tldraw'
import { useEffect, useRef, useState } from 'react'
// @ts-ignore — vanilla JS module
import { setVoiceTarget, clearVoiceTarget, completeMessageSend, submitWhenVoiceFinal } from '../voice.mjs'
import { getPref, subscribePref } from '../preferences'
import { getComposerDraft, saveComposerDraft, flushComposerDraft, clearComposerDraft } from '../stores/composerDraftStore'

export type ComposerSend = (text: string, targets: string[]) => void
export type VoiceTargetHandle = {
  sendTargets: string[]
  agentNames: Record<string, string>
  getSendTargets: () => string[]
  getAgentNames: () => Record<string, string>
  submitCurrent: (submittedText?: string) => boolean
  submitAlternate?: (submittedText?: string) => boolean
}
/** Pre-send command hook (e.g. /terminal). Gets the textarea so it can clear (or
 *  not) exactly as the original did. Return true if it consumed the input — the
 *  composer then preventDefaults and does NOT send or push history. */
export type ChatCommand = (text: string, targets: string[], ta: HTMLTextAreaElement) => boolean

function shouldSuppressNativeKeyboard(backend: string) {
  return backend === 'chrome' || backend === 'deepgram' || backend === 'deepgram-sdk' || backend === 'whisper'
}

export function ChatComposer({
  sendTargets,
  agentNames,
  onSend,
  onCommand,
  onKeyActivity,
  onDrop,
  onDragOver,
  onPaste,
  inputRef: externalRef,
  className,
  placeholder = '',
  isTouchDevice = false,
  style,
  draftKey,
  voiceTargetSnapshotRef,
  onAlternateSend,
}: {
  sendTargets: string[]
  agentNames: Record<string, string>
  onSend: ComposerSend
  onCommand?: ChatCommand
  onKeyActivity?: () => void
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  className?: string
  placeholder?: string
  isTouchDevice?: boolean
  style?: React.CSSProperties
  /** Identifies this composer's unsent text across unmounts — `chat:<shape.id>`,
   *  `inbox:<partnerId>`. Omit and the draft is not preserved. */
  draftKey?: string
  voiceTargetSnapshotRef?: React.MutableRefObject<(() => VoiceTargetHandle) | null>
  onAlternateSend?: ComposerSend
}) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = externalRef ?? localRef
  useEffect(() => {
    const textarea = inputRef.current
    return () => { if (textarea) clearVoiceTarget(textarea) }
  }, [inputRef])
  // Unsent text outlives the textarea. Anything that unmounts this component —
  // filter mode opening on a chat panel, the viewport culling shell, an inbox
  // thread switch — used to destroy the only copy. Restore on mount, write back
  // on the way out. The field stays uncontrolled: we read and set `.value`, never
  // feed it back through a `value` prop, so the typing path is unchanged.
  useEffect(() => {
    if (!draftKey) return
    const ta = inputRef.current
    if (ta && !ta.value) {
      const saved = getComposerDraft(draftKey)
      if (saved) {
        ta.value = saved
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    return () => { flushComposerDraft(draftKey, ta?.value ?? '') }
  }, [draftKey, inputRef])
  const [voiceBackend, setVoiceBackend] = useState(() => getPref('voice-backend') as string)
  useEffect(() => subscribePref(() => {
    setVoiceBackend(getPref('voice-backend') as string)
  }), [])
  const inputMode = isTouchDevice && shouldSuppressNativeKeyboard(voiceBackend) ? 'none' : undefined
  // Sent-message history (ArrowUp/Down) — composer-owned; the chat shape had no
  // other consumer of these refs.
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  const submitCurrentRef = useRef<(submittedText?: string) => boolean>(() => false)
  const submitAlternateRef = useRef<(submittedText?: string) => boolean>(() => false)
  const voiceTargetRef = useRef<VoiceTargetHandle>({
    sendTargets: [],
    agentNames: {},
    getSendTargets() { return this.sendTargets },
    getAgentNames() { return this.agentNames },
    submitCurrent(submittedText) { return submitCurrentRef.current(submittedText) },
  })
  voiceTargetRef.current.sendTargets = sendTargets
  voiceTargetRef.current.agentNames = agentNames
  voiceTargetRef.current.submitAlternate = onAlternateSend
    ? (submittedText) => submitAlternateRef.current(submittedText)
    : undefined
  if (voiceTargetSnapshotRef) {
    voiceTargetSnapshotRef.current = () => ({
      sendTargets: [...voiceTargetRef.current.sendTargets],
      agentNames: { ...voiceTargetRef.current.agentNames },
      getSendTargets() { return this.sendTargets },
      getAgentNames() { return this.agentNames },
      submitCurrent(submittedText) { return submitCurrentRef.current(submittedText) },
      ...(onAlternateSend ? { submitAlternate(submittedText?: string) { return submitAlternateRef.current(submittedText) } } : {}),
    })
  }

  /** Persist what is in the field right now. Called from every path that changes
   *  `.value`, including the ones that bypass the input event (Escape, history). */
  const recordDraft = (ta: HTMLTextAreaElement) => {
    if (draftKey) saveComposerDraft(draftKey, ta.value)
  }

  const submitCurrent = (submittedText?: string) => {
    const ta = inputRef.current
    const text = ta?.value.trim() || ''
    if (!ta || !text || sendTargets.length === 0) return false
    if (onCommand?.(text, sendTargets, ta)) return true
    onSend(text, sendTargets)
    ta.value = ''
    if (draftKey) clearComposerDraft(draftKey)
    ta.style.height = ''
    // Clearing `.value` does not always make `field-sizing: content` recompute,
    // so a sent multiline message left the composer tall until the next click or
    // keystroke resized it — Skip: "if you send a long message and you hit
    // enter, the composer doesn't resize until you click into it again. Or start
    // typing again." Reading a layout property between an explicit height and
    // clearing it forces the recalculation the send itself should have caused.
    ta.style.height = 'auto'
    void ta.offsetHeight
    ta.style.height = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    completeMessageSend(submittedText ?? text)
    sentHistoryRef.current = [...sentHistoryRef.current, text]
    historyIndexRef.current = -1
    return true
  }
  submitCurrentRef.current = submitCurrent

  /** What Enter calls. When voice has a tail on screen that Deepgram has not committed,
   *  `submitWhenVoiceFinal` takes the send and runs it once the final lands — so the
   *  message carries the revision instead of the interim, and the revision does not
   *  arrive afterwards and land in the emptied field ("playing back", Skip 2026-08-12
   *  20:03:16 EDT). It resolves through `submitCurrentRef` rather than `submitCurrent`
   *  so a deferred send uses the targets current at send time, not at keypress time.
   *  Nothing is cleared or disabled while it waits: the field keeps showing his words
   *  and the transcript path keeps revising them in place. */
  const submitOnVoiceFinal = () => {
    if (submitWhenVoiceFinal(() => submitCurrentRef.current())) return
    submitCurrent()
  }
  submitAlternateRef.current = (submittedText?: string) => {
    if (!onAlternateSend) return false
    const ta = inputRef.current
    const text = ta?.value.trim() || ''
    if (!ta || !text || sendTargets.length === 0) return false
    onAlternateSend(text, sendTargets)
    ta.value = ''
    if (draftKey) clearComposerDraft(draftKey)
    ta.style.height = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    completeMessageSend(submittedText ?? text)
    sentHistoryRef.current = [...sentHistoryRef.current, text]
    historyIndexRef.current = -1
    return true
  }

  return (
    <textarea
      ref={inputRef as any}
      className={className}
      placeholder={placeholder}
      rows={1}
      inputMode={inputMode}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      spellCheck={false}
      onKeyDown={(e) => {
        stopEventPropagation(e)
        const ta = e.currentTarget
        if (e.key === 'Escape') {
          e.preventDefault()
          if (ta.value !== '') {
            ta.value = ''
            ta.style.height = ''
            recordDraft(ta)
          }
          return
        }
        onKeyActivity?.()
        if (e.key === 'ArrowUp') {
          const history = sentHistoryRef.current
          if (history.length === 0) return
          if (historyIndexRef.current === -1 && ta.value !== '') return
          e.preventDefault()
          const nextIdx = historyIndexRef.current + 1
          if (nextIdx < history.length) {
            historyIndexRef.current = nextIdx
            ta.value = history[history.length - 1 - nextIdx]
            ta.setSelectionRange(ta.value.length, ta.value.length)
            recordDraft(ta)
          }
          return
        }
        if (e.key === 'ArrowDown') {
          if (historyIndexRef.current === -1) return
          e.preventDefault()
          const nextIdx = historyIndexRef.current - 1
          historyIndexRef.current = nextIdx
          if (nextIdx < 0) {
            ta.value = ''
            ta.style.height = ''
          } else {
            const history = sentHistoryRef.current
            ta.value = history[history.length - 1 - nextIdx]
            ta.setSelectionRange(ta.value.length, ta.value.length)
          }
          recordDraft(ta)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const val = ta.value
          if (val.trim() === '') {
            e.preventDefault() // suppress on empty
            return
          }
          // Host command (e.g. /terminal) — consumes input without sending. The
          // command owns its own clearing (original cleared only on a resolved
          // target), so the composer just stops here.
          if (onCommand && onCommand(val.trim(), sendTargets, ta)) {
            e.preventDefault()
            return
          }
          // Get text before cursor on current line (blank line = double-enter send,
          // trailing space = newline, otherwise send).
          const before = val.substring(0, ta.selectionStart || val.length)
          const lastNewline = before.lastIndexOf('\n')
          const lineText = before.substring(lastNewline + 1)

          if (lineText.trim() === '') {
            e.preventDefault()
            submitOnVoiceFinal()
          } else if (lineText.endsWith(' ')) {
            return
          } else {
            e.preventDefault()
            submitOnVoiceFinal()
          }
        }
      }}
      onInput={(e) => { recordDraft(e.currentTarget); onKeyActivity?.() }}
      onPointerDown={(e) => {
        stopEventPropagation(e)
        // Register this field as the voice target — dictated text appends here and
        // Voice supplies text; saying "send" invokes the same composer submit as Enter.
        setVoiceTarget(e.currentTarget, voiceTargetRef.current)
      }}
      onFocus={(e) => {
        stopEventPropagation(e)
        setVoiceTarget(e.currentTarget, voiceTargetRef.current)
      }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPaste={onPaste}
      style={style}
    />
  )
}

/**
 * ComposerField — the shared composer primitive.
 *
 * One textarea + voice-target registration + touch inputMode policy + draft
 * persistence + sent-history + injectable key policy, used by both the chat
 * ChatComposer (keyPolicy='chat') and the terminal hover pane
 * (keyPolicy='terminal').
 *
 * The touch/keyboard policy lives here exactly once: the field suppresses the
 * on-screen keyboard only while voice is recording, on touch devices. Both
 * composers converge on it so a change lands once.
 *
 * Deliberately NOT shared: transport (chat message + viewer context vs PTY
 * bytes — the host owns that via onSend), traffic filter (chat-only),
 * source-line/ref attachments (chat-only), PTY controls (terminal-only,
 * via onTerminalControl), hover read-only peek (the terminal pane renders no
 * field at all when unpinned — decided at the call site, not here).
 */
import { stopEventPropagation } from 'tldraw'
import { useEffect, useRef, useState } from 'react'
// @ts-ignore — vanilla JS module
import { setVoiceTarget, clearVoiceTarget, completeMessageSend, submitWhenVoiceFinal, isRecording, onRecordingChange } from '../voice.mjs'
import { getComposerDraft, saveComposerDraft, flushComposerDraft, clearComposerDraft } from '../stores/composerDraftStore'

type DispatchedComposerSend = {
  accepted: true
  settlement: Promise<boolean | void>
}
export type ComposerFieldSend = (text: string, targets: string[]) => boolean | void | Promise<boolean | void> | DispatchedComposerSend
export type ComposerFieldVoiceHandle = {
  sendTargets: string[]
  agentNames: Record<string, string>
  getSendTargets: () => string[]
  getAgentNames: () => Record<string, string>
  getTargetKind?: () => string
  submitCurrent: (submittedText?: string) => boolean
  submitAlternate?: (submittedText?: string) => boolean
}
/** Pre-send command hook (chat only, e.g. /terminal). Return true if consumed. */
export type ComposerFieldCommand = (text: string, targets: string[], ta: HTMLTextAreaElement) => boolean

/** Single touch/keyboard policy source. The on-screen keyboard is suppressed
 *  only while voice is recording on a touch device — available whenever voice
 *  is idle. Both composers use this; neither computes inputMode itself. */
export function composerInputMode(isTouchDevice: boolean, recording: boolean): 'none' | undefined {
  return isTouchDevice && recording ? 'none' : undefined
}

export function ComposerField({
  sendTargets,
  agentNames,
  onSend,
  onCommand,
  onTerminalControl,
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
  keyPolicy,
  voiceKind = 'chat',
  submitViaVoiceFinal = true,
  clearVoiceOnBlur = false,
}: {
  sendTargets: string[]
  agentNames: Record<string, string>
  onSend: ComposerFieldSend
  onCommand?: ComposerFieldCommand
  /** Terminal PTY byte-sender (terminal policy only): Tab / Ctrl-C / Ctrl-D /
   *  Escape-as-byte go through here instead of submitting. */
  onTerminalControl?: (data: string) => void
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
   *  `inbox:<partnerId>`, `terminal:<agentId>`. Omit and the draft is not kept. */
  draftKey?: string
  voiceTargetSnapshotRef?: React.MutableRefObject<(() => ComposerFieldVoiceHandle) | null>
  onAlternateSend?: ComposerFieldSend
  /** 'chat': message-oriented keys. 'terminal': PTY control bytes preserved,
   *  Enter carries the empty-guard, arrows walk sent-history. */
  keyPolicy: 'chat' | 'terminal'
  /** 'terminal' registers getTargetKind so the voice HUD marks the terminal
   *  glyph; 'chat' leaves the default. */
  voiceKind?: 'chat' | 'terminal'
  /** Chat defers Enter through submitWhenVoiceFinal so the dictated tail lands
   *  before send. The terminal submits directly (its long-standing behavior). */
  submitViaVoiceFinal?: boolean
  /** Terminal clears its voice target on blur; chat keeps it until unmount. */
  clearVoiceOnBlur?: boolean
}) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = externalRef ?? localRef
  useEffect(() => {
    const textarea = inputRef.current
    return () => { if (textarea) clearVoiceTarget(textarea) }
  }, [inputRef])
  // Unsent text outlives the textarea. Anything that unmounts this component —
  // filter mode opening on a chat panel, the viewport culling shell, an inbox
  // thread switch, a terminal pane dismiss — used to destroy the only copy.
  // Restore on mount, write back on the way out. The field stays uncontrolled:
  // we read and set `.value`, never feed it back through a `value` prop.
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
  const [recording, setRecording] = useState(() => isRecording())
  useEffect(() => onRecordingChange(setRecording), [])
  const inputMode = composerInputMode(isTouchDevice, recording)
  // Sent-message history (ArrowUp/Down) — composer-owned.
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  const submitCurrentRef = useRef<(submittedText?: string) => boolean>(() => false)
  const submitAlternateRef = useRef<(submittedText?: string) => boolean>(() => false)
  const sendPendingRef = useRef(false)
  const sendOwnerRef = useRef(0)
  useEffect(() => () => { sendOwnerRef.current += 1 }, [])
  const voiceTargetRef = useRef<ComposerFieldVoiceHandle>({
    sendTargets: [],
    agentNames: {},
    getSendTargets() { return this.sendTargets },
    getAgentNames() { return this.agentNames },
    submitCurrent(submittedText) { return submitCurrentRef.current(submittedText) },
  })
  voiceTargetRef.current.sendTargets = sendTargets
  voiceTargetRef.current.agentNames = agentNames
  if (voiceKind === 'terminal') {
    voiceTargetRef.current.getTargetKind = () => 'terminal'
  } else {
    delete voiceTargetRef.current.getTargetKind
  }
  voiceTargetRef.current.submitAlternate = onAlternateSend
    ? (submittedText) => submitAlternateRef.current(submittedText)
    : undefined
  if (voiceTargetSnapshotRef) {
    voiceTargetSnapshotRef.current = () => ({
      sendTargets: [...voiceTargetRef.current.sendTargets],
      agentNames: { ...voiceTargetRef.current.agentNames },
      getSendTargets() { return this.sendTargets },
      getAgentNames() { return this.agentNames },
      ...(voiceKind === 'terminal' ? { getTargetKind: () => 'terminal' as const } : {}),
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
    const rawText = ta?.value || ''
    const text = rawText.trim()
    if (!ta || !text || sendTargets.length === 0 || sendPendingRef.current) return false
    if (keyPolicy === 'chat' && onCommand?.(text, sendTargets, ta)) return true
    const sendOwner = sendOwnerRef.current
    const restore = () => {
      if (sendOwnerRef.current !== sendOwner) return
      ta.value = ta.value ? `${rawText}\n${ta.value}` : rawText
      recordDraft(ta)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const finish = (sent: boolean) => {
      // The textarea that submitted may have been replaced while transport was
      // pending. Its settlement does not own the replacement instance's draft.
      if (sendOwnerRef.current !== sendOwner) return
      sendPendingRef.current = false
      if (!sent) {
        recordDraft(ta)
        return
      }
      // Voice may revise the field while the transport is pending. Clear only
      // the exact text this operation submitted; newer words are the next draft.
      if (ta.value === rawText) {
        ta.value = ''
        if (draftKey) clearComposerDraft(draftKey)
        ta.style.height = ''
        // Clearing `.value` does not always make `field-sizing: content`
        // recompute, so force it the way the chat send does.
        ta.style.height = 'auto'
        void ta.offsetHeight
        ta.style.height = ''
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        recordDraft(ta)
      }
      completeMessageSend(submittedText ?? text)
      sentHistoryRef.current = [...sentHistoryRef.current, text]
      historyIndexRef.current = -1
    }
    const result = onSend(text, sendTargets)
    if (result && typeof result === 'object' && 'accepted' in result && result.accepted === true) {
      finish(true)
      void result.settlement.then(value => { if (value === false) restore() }, restore)
    } else if (result && typeof (result as Promise<boolean | void>).then === 'function') {
      sendPendingRef.current = true
      void Promise.resolve(result).then(value => finish(value !== false), () => finish(false))
    } else {
      finish(result !== false)
    }
    return true
  }
  submitCurrentRef.current = submitCurrent

  /** What Enter calls on the chat policy. When voice has a tail on screen that
   *  Deepgram has not committed, `submitWhenVoiceFinal` takes the send and runs
   *  it once the final lands. The terminal policy submits directly. */
  const submitOnEnter = () => {
    if (submitViaVoiceFinal) {
      if (submitWhenVoiceFinal(() => submitCurrentRef.current())) return
      submitCurrent()
    } else {
      submitCurrent()
    }
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

  const walkHistory = (ta: HTMLTextAreaElement, direction: 1 | -1) => {
    const history = sentHistoryRef.current
    if (history.length === 0) return
    if (direction === 1) {
      if (historyIndexRef.current === -1 && ta.value !== '') return
      const nextIdx = historyIndexRef.current + 1
      if (nextIdx < history.length) {
        historyIndexRef.current = nextIdx
        ta.value = history[history.length - 1 - nextIdx]
        ta.setSelectionRange(ta.value.length, ta.value.length)
        recordDraft(ta)
      }
      return
    }
    if (historyIndexRef.current === -1) return
    const nextIdx = historyIndexRef.current - 1
    historyIndexRef.current = nextIdx
    if (nextIdx < 0) {
      ta.value = ''
      ta.style.height = ''
    } else {
      ta.value = history[history.length - 1 - nextIdx]
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }
    recordDraft(ta)
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
        if (keyPolicy === 'terminal') {
          onKeyActivity?.()
          if (e.key === 'Enter' && !e.shiftKey) {
            const val = ta.value
            if (val.trim() === '') {
              e.preventDefault() // suppress on empty
              return
            }
            e.preventDefault()
            submitOnEnter()
            return
          }
          if (e.key === 'c' && e.ctrlKey) {
            e.preventDefault()
            onTerminalControl?.('\x03')
            ta.value = ''
            ta.style.height = ''
            recordDraft(ta)
            return
          }
          if (e.key === 'd' && e.ctrlKey) {
            e.preventDefault()
            onTerminalControl?.('\x04')
            return
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            onTerminalControl?.('\t')
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            walkHistory(ta, 1)
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            walkHistory(ta, -1)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onTerminalControl?.('\x1b')
            return
          }
          return
        }
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
          walkHistory(ta, 1)
          return
        }
        if (e.key === 'ArrowDown') {
          if (historyIndexRef.current === -1) return
          e.preventDefault()
          walkHistory(ta, -1)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          const val = ta.value
          if (val.trim() === '') {
            e.preventDefault() // suppress on empty
            return
          }
          // Host command (e.g. /terminal) — consumes input without sending. The
          // command owns its own clearing, so the composer just stops here.
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
            submitOnEnter()
          } else if (lineText.endsWith(' ')) {
            return
          } else {
            e.preventDefault()
            submitOnEnter()
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
      onBlur={clearVoiceOnBlur ? (e) => { clearVoiceTarget(e.currentTarget); e.currentTarget.style.boxShadow = '' } : undefined}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPaste={onPaste}
      style={style}
    />
  )
}

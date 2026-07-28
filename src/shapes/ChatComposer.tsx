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
import { setVoiceTarget, clearVoiceTarget, completeMessageSend } from '../voice.mjs'
import { getPref, subscribePref } from '../preferences'

export type ComposerSend = (text: string, targets: string[]) => void
type VoiceTargetHandle = {
  sendTargets: string[]
  agentNames: Record<string, string>
  getSendTargets: () => string[]
  getAgentNames: () => Record<string, string>
  submitCurrent: () => boolean
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
  inputRef: externalRef,
  className,
  placeholder = '',
  isTouchDevice = false,
  style,
}: {
  sendTargets: string[]
  agentNames: Record<string, string>
  onSend: ComposerSend
  onCommand?: ChatCommand
  onKeyActivity?: () => void
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
  className?: string
  placeholder?: string
  isTouchDevice?: boolean
  style?: React.CSSProperties
}) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = externalRef ?? localRef
  useEffect(() => {
    const textarea = inputRef.current
    return () => { if (textarea) clearVoiceTarget(textarea) }
  }, [inputRef])
  const [voiceBackend, setVoiceBackend] = useState(() => getPref('voice-backend') as string)
  useEffect(() => subscribePref(() => {
    setVoiceBackend(getPref('voice-backend') as string)
  }), [])
  const inputMode = isTouchDevice && shouldSuppressNativeKeyboard(voiceBackend) ? 'none' : undefined
  // Sent-message history (ArrowUp/Down) — composer-owned; the chat shape had no
  // other consumer of these refs.
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  const submitCurrentRef = useRef<() => boolean>(() => false)
  const voiceTargetRef = useRef<VoiceTargetHandle>({
    sendTargets: [],
    agentNames: {},
    getSendTargets() { return this.sendTargets },
    getAgentNames() { return this.agentNames },
    submitCurrent() { return submitCurrentRef.current() },
  })
  voiceTargetRef.current.sendTargets = sendTargets
  voiceTargetRef.current.agentNames = agentNames

  const submitCurrent = () => {
    const ta = inputRef.current
    const text = ta?.value.trim() || ''
    if (!ta || !text || sendTargets.length === 0) return false
    if (onCommand?.(text, sendTargets, ta)) return true
    onSend(text, sendTargets)
    ta.value = ''
    ta.style.height = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    completeMessageSend(text)
    sentHistoryRef.current = [...sentHistoryRef.current, text]
    historyIndexRef.current = -1
    return true
  }
  submitCurrentRef.current = submitCurrent

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
            submitCurrent()
          } else if (lineText.endsWith(' ')) {
            return
          } else {
            e.preventDefault()
            submitCurrent()
          }
        }
      }}
      onInput={() => { onKeyActivity?.() }}
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
      style={style}
    />
  )
}

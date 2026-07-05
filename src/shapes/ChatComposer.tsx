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
 * Keyboard and voice send are DISTINCT paths in the original chat (keyboard:
 * inject → clear → restart-mic → history → context → plan → send; voice:
 * context → inject → send, no plan), so they're separate host callbacks here —
 * faithfully preserving each.
 */
import { stopEventPropagation } from 'tldraw'
import { useRef } from 'react'
// @ts-ignore — vanilla JS module
import { setVoiceTarget, resetTranscript, restartRecording } from '../voice.mjs'

export type KeyboardSend = (text: string, targets: string[]) => void
export type VoiceSend = (targets: string[], text: string) => void | Promise<void>
type VoiceTargetHandle = {
  sendTargets: string[]
  agentNames: Record<string, string>
  onVoiceSend: VoiceSend
  getSendTargets: () => string[]
  getAgentNames: () => Record<string, string>
  sendVoice: (targets: string[], text: string) => void | Promise<void>
}
type VoiceSubmitKeyboardEvent = KeyboardEvent & { __tldaVoiceSubmit?: boolean }
/** Pre-send command hook (e.g. /terminal). Gets the textarea so it can clear (or
 *  not) exactly as the original did. Return true if it consumed the input — the
 *  composer then preventDefaults and does NOT send or push history. */
export type ChatCommand = (text: string, targets: string[], ta: HTMLTextAreaElement) => boolean

export function ChatComposer({
  sendTargets,
  agentNames,
  onKeyboardSend,
  onVoiceSend,
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
  onKeyboardSend: KeyboardSend
  onVoiceSend: VoiceSend
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
  // Sent-message history (ArrowUp/Down) — composer-owned; the chat shape had no
  // other consumer of these refs.
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  const voiceTargetRef = useRef<VoiceTargetHandle>({
    sendTargets: [],
    agentNames: {},
    onVoiceSend: () => {},
    getSendTargets() { return this.sendTargets },
    getAgentNames() { return this.agentNames },
    sendVoice(targets, text) { return this.onVoiceSend(targets, text) },
  })
  voiceTargetRef.current.sendTargets = sendTargets
  voiceTargetRef.current.agentNames = agentNames
  voiceTargetRef.current.onVoiceSend = onVoiceSend

  return (
    <textarea
      ref={inputRef as any}
      className={className}
      placeholder={placeholder}
      rows={1}
      inputMode={isTouchDevice ? 'none' : undefined}
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

          const doSend = () => {
            const text = val.trim()
            if (!text || sendTargets.length === 0) return
            const nativeEvent = e.nativeEvent as VoiceSubmitKeyboardEvent
            const isVoiceSubmit = !!nativeEvent.__tldaVoiceSubmit
            // Call the host send FIRST: its synchronous prefix (optimistic echo)
            // runs before it yields at its first await, then we clear the field
            // synchronously — preserving the original "echo + clear before any
            // awaited work" ordering that prevents Enter-mash duplicate sends.
            if (isVoiceSubmit) onVoiceSend(sendTargets, text)
            else onKeyboardSend(text, sendTargets)
            ta.value = ''
            ta.style.height = ''
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            resetTranscript(text)
            restartRecording()
            sentHistoryRef.current = [...sentHistoryRef.current, text]
            historyIndexRef.current = -1
          }

          if (lineText.trim() === '') {
            e.preventDefault()
            doSend()
          } else if (lineText.endsWith(' ')) {
            return
          } else {
            e.preventDefault()
            doSend()
          }
        }
      }}
      onInput={() => { onKeyActivity?.() }}
      onPointerDown={(e) => {
        stopEventPropagation(e)
        // Register this field as the voice target — dictated text appends here and
        // saying "send" fires onVoiceSend (same registration the main chat uses).
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

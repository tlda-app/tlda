/**
 * ChatComposer — the chat-side composer.
 *
 * A thin wrapper around the shared ComposerField primitive (keyPolicy='chat'):
 * textarea + voice registration + recording-gated touch inputMode + draft
 * persistence + sent-history. The host owns everything chat-specific (viewer
 * context, ref attachments, plan-mode, the /terminal command, file-drop,
 * escalation reset) and passes it in via callbacks.
 *
 * Voice owns text entry. Enter and the voice "send" command submit through the
 * same composer operation.
 */
import { ComposerField } from './ComposerField'
import type { ComposerFieldSend, ComposerFieldVoiceHandle, ComposerFieldCommand } from './ComposerField'

export type ComposerSend = ComposerFieldSend
export type VoiceTargetHandle = ComposerFieldVoiceHandle
export type ChatCommand = ComposerFieldCommand

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
  return (
    <ComposerField
      sendTargets={sendTargets}
      agentNames={agentNames}
      onSend={onSend}
      onCommand={onCommand}
      onKeyActivity={onKeyActivity}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPaste={onPaste}
      inputRef={externalRef}
      className={className}
      placeholder={placeholder}
      isTouchDevice={isTouchDevice}
      style={style}
      draftKey={draftKey}
      voiceTargetSnapshotRef={voiceTargetSnapshotRef}
      onAlternateSend={onAlternateSend}
      keyPolicy="chat"
      voiceKind="chat"
      submitViaVoiceFinal
      clearVoiceOnBlur={false}
    />
  )
}

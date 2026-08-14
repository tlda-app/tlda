import type { PenCorrectionTarget } from './penCorrectionTarget'

const PEN_CORRECTION_EVENT = 'tlda-pen-correction'

type ChatMessage = { _dbId?: number; from?: string; recipients?: string[] }
type SendCorrection = (to: string, text: string) => Promise<unknown>

export function correctionRecipients(message: ChatMessage, humanId: string | null): string {
  const ids = message.from === humanId ? message.recipients ?? [] : [message.from ?? '']
  return ids.filter(Boolean).join(' | ')
}

export function correctionMessage(target: PenCorrectionTarget, transcription: string): string {
  const original = target.word ? `“${target.word}”` : `the marked text in message ${target.messageId}`
  return `Correction to message ${target.messageId}: ${original} was meant to be “${transcription}”.`
}

export function installPenCorrectionConsumer({
  element,
  messages,
  humanId,
  send,
  recognize,
}: {
  element: HTMLElement
  messages: () => ChatMessage[]
  humanId: () => string | null
  send: SendCorrection
  recognize: (inkShapeId: string) => Promise<string | null>
}): () => void {
  const consume = async (event: Event) => {
    const target = (event as CustomEvent<PenCorrectionTarget>).detail
    if (!target?.inkShapeId || !target.messageId) return
    const message = messages().find(item => String(item._dbId ?? '') === target.messageId)
    if (!message) return
    const to = correctionRecipients(message, humanId())
    if (!to) return
    const transcription = await recognize(target.inkShapeId)
    if (!transcription) return
    await send(to, correctionMessage(target, transcription))
  }
  const onCorrection = (event: Event) => {
    void consume(event).catch(error => console.error('[pen-correction] delivery failed', error))
  }
  element.addEventListener(PEN_CORRECTION_EVENT, onCorrection)
  return () => element.removeEventListener(PEN_CORRECTION_EVENT, onCorrection)
}

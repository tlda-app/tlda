type ClientPoint = { x: number; y: number }

export type FleetChatInputDropTarget = {
  chatId: string
  rect: DOMRect
}

const dropPreviewBus = new EventTarget()
let activePreviewChatId: string | null = null

export function findFleetChatInputDropTarget(point: ClientPoint): FleetChatInputDropTarget | null {
  if (typeof document === 'undefined') return null
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>('[data-fleet-chat-input-drop-target]')
  )

  for (let i = targets.length - 1; i >= 0; i--) {
    const el = targets[i]
    const chatId = el.dataset.fleetChatInputDropTarget
    if (!chatId) continue
    const rect = el.getBoundingClientRect()
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return { chatId, rect }
    }
  }

  return null
}

export function setFleetChatInputDropPreview(chatId: string | null) {
  if (activePreviewChatId === chatId) return
  activePreviewChatId = chatId
  dropPreviewBus.dispatchEvent(new CustomEvent('change', { detail: { chatId } }))
}

export function subscribeFleetChatInputDropPreview(
  chatId: string,
  callback: (active: boolean) => void,
) {
  callback(activePreviewChatId === chatId)
  const handler = (event: Event) => {
    const nextChatId = (event as CustomEvent<{ chatId: string | null }>).detail.chatId
    callback(nextChatId === chatId)
  }
  dropPreviewBus.addEventListener('change', handler)
  return () => dropPreviewBus.removeEventListener('change', handler)
}

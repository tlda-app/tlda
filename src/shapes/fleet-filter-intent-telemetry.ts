import type { TLShapeId } from 'tldraw'
import { hashUiIntentState, type UiIntentTransaction } from '../uiIntentTelemetry'

type FleetFilter = [string, string][][]

export type FleetChatShapeRecord = {
  id: TLShapeId
  type: 'fleet-chat'
  isLocked?: boolean
  props?: {
    filter?: FleetFilter
  }
}

type FleetChatUpdate = {
  id: TLShapeId
  type: 'fleet-chat'
  isLocked?: boolean
  props?: { filter: FleetFilter }
}

export type FleetFilterIntentEditor = {
  getShape(id: TLShapeId): unknown
  updateShape(update: FleetChatUpdate): void
}

type RenderScheduler = (check: () => void) => void

const defaultScheduleRenderCheck: RenderScheduler = (check) => {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(check)
  } else {
    check()
  }
}

function filterHash(shape: FleetChatShapeRecord | undefined) {
  return hashUiIntentState(shape?.props?.filter || [])
}

function asFleetChatShape(value: unknown): FleetChatShapeRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const shape = value as Partial<FleetChatShapeRecord>
  return shape.type === 'fleet-chat' && shape.id ? shape as FleetChatShapeRecord : undefined
}

export function applyFilterPreviewWithIntent(
  editor: FleetFilterIntentEditor,
  targetChat: FleetChatShapeRecord,
  preview: FleetFilter,
  intent: UiIntentTransaction | null,
  scheduleRenderCheck: RenderScheduler = defaultScheduleRenderCheck,
) {
  const wasLocked = targetChat.isLocked
  const beforeHash = hashUiIntentState(targetChat.props?.filter || [])
  const expectedHash = hashUiIntentState(preview)
  const target = { shapeId: targetChat.id, type: 'fleet-chat' }
  intent?.mutationRequest({
    target,
    stateHashBefore: beforeHash,
    requestedStateHash: expectedHash,
  })
  if (wasLocked) editor.updateShape({ id: targetChat.id, type: 'fleet-chat', isLocked: false })
  editor.updateShape({ id: targetChat.id, type: 'fleet-chat', props: { filter: preview } })
  if (wasLocked) editor.updateShape({ id: targetChat.id, type: 'fleet-chat', isLocked: true })

  const updated = asFleetChatShape(editor.getShape(targetChat.id))
  const committedHash = filterHash(updated)
  if (committedHash === beforeHash) {
    intent?.failure('no-state-change', {
      target,
      stateHashBefore: beforeHash,
      stateHashAfter: committedHash,
      expectedStateHash: expectedHash,
    })
    return { committed: false, reason: 'no-state-change', stateHashAfter: committedHash }
  }
  if (committedHash !== expectedHash) {
    intent?.failure('state-mismatch', {
      target,
      stateHashBefore: beforeHash,
      stateHashAfter: committedHash,
      expectedStateHash: expectedHash,
    })
    return { committed: false, reason: 'state-mismatch', stateHashAfter: committedHash }
  }

  intent?.mutationCommit({
    target,
    stateHashBefore: beforeHash,
    stateHashAfter: committedHash,
    changed: true,
  })
  if (intent) {
    scheduleRenderCheck(() => {
      const rendered = asFleetChatShape(editor.getShape(targetChat.id))
      const renderedHash = filterHash(rendered)
      if (renderedHash === expectedHash) {
        intent.renderConfirmed({
          renderCheck: 'fleet-chat.props.filter',
          stateHashAfter: renderedHash,
          expectedStateHash: expectedHash,
        })
      } else {
        intent.failure('render-mismatch', {
          target,
          renderCheck: 'fleet-chat.props.filter',
          stateHashAfter: renderedHash,
          expectedStateHash: expectedHash,
        })
      }
    })
  }
  return { committed: true, stateHashAfter: committedHash }
}

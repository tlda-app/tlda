/**
 * The real chat, on the project index.
 *
 * The index page used to carry its own chat: a second render loop over the same
 * `renderChatLine`/`renderActivityGroup` the panel uses, a hard last-24-messages
 * slice, and a cut-down copy of the scroll model. Everything the panel does
 * around those renderers — earlier history, folds, thread and operation cards,
 * image retry, linkified references, filter modes, the unread rail — the index
 * page simply did not have, because it was a different implementation rather
 * than a different configuration.
 *
 * This renders `FleetChatMounted`, the same component the canvas shape renders,
 * inside an index editor. The chat asks its editor for the things a panel needs
 * and gets real answers for its own state and deliberate nothing for the canvas.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContext, TldrawUiToastsProvider, useValue } from 'tldraw'
import { FleetChatMounted } from '../shapes/FleetChatShape'
import { asEditorContextValue, createIndexEditor } from './index-editor'
// @ts-ignore — vanilla JS module
import { getHumanId, getDeviceId } from './fleet-data.mjs'

export const INDEX_CHAT_SHAPE_ID = 'shape:index-chat'

type ChatFilter = [string, string][][]

function indexChatShape(filter: ChatFilter, w: number, h: number) {
  return {
    id: INDEX_CHAT_SHAPE_ID,
    type: 'fleet-chat',
    x: 0,
    y: 0,
    props: {
      w,
      h,
      filter,
      trafficMode: 'normal',
      userId: getHumanId() || '',
      deviceId: getDeviceId() || '',
    },
  } as any
}

export function IndexChatPanel({ filter, className }: { filter: ChatFilter; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [editor] = useState(() => createIndexEditor([indexChatShape(filter, 0, 0)]))

  // The panel sizes itself from its shape's w/h, which on the canvas is the box
  // you dragged. Here the box is the DOM element, so the element's size IS the
  // shape's size and the chat lays out against its container the way it lays out
  // against its frame.
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const rect = element.getBoundingClientRect()
      editor.updateShape({ id: INDEX_CHAT_SHAPE_ID, props: { w: rect.width, h: rect.height } })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [editor])

  // Picking an agent on the index sets the chat's filter — the same value the
  // filter pane writes, through the same path, so choosing an agent and editing
  // the filter by hand cannot end up as two sources of truth.
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    editor.updateShape({ id: INDEX_CHAT_SHAPE_ID, props: { filter } })
    // filterKey is the value; `filter` is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, filterKey])

  // Identity arrives after login, and ownership checks in the chat read these
  // off the shape, so they are written when they land rather than at mount.
  const identityReady = useValue('index-chat-identity', () => Boolean(getHumanId() && getDeviceId()), [])
  useEffect(() => {
    if (!identityReady) return
    editor.updateShape({
      id: INDEX_CHAT_SHAPE_ID,
      props: { userId: getHumanId() || '', deviceId: getDeviceId() || '' },
    })
  }, [editor, identityReady])

  const shape = useValue('index-chat-shape', () => editor.getShape(INDEX_CHAT_SHAPE_ID), [editor])
  const contextValue = useMemo(() => asEditorContextValue(editor), [editor])

  return (
    <div ref={containerRef} className={className}>
      {shape && (
        <EditorContext.Provider value={contextValue}>
          <TldrawUiToastsProvider>
            <FleetChatMounted shape={shape} />
          </TldrawUiToastsProvider>
        </EditorContext.Provider>
      )}
    </div>
  )
}

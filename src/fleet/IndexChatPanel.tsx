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
import { asEditorContextValue, createIndexEditor, type IndexEditorShape } from './index-editor'
import { useFleetIdentity } from '../fleet-data-adapter'
// @ts-ignore — vanilla JS module
import { getDeviceId } from './fleet-data.mjs'

export const INDEX_CHAT_SHAPE_ID = 'shape:index-chat'

type ChatFilter = [string, string][][]

function indexChatShape(filter: ChatFilter): IndexEditorShape {
  return {
    id: INDEX_CHAT_SHAPE_ID,
    type: 'fleet-chat',
    x: 0,
    y: 0,
    // Size arrives from the container measurement below; ownership arrives with
    // identity. Both are written once they are known rather than guessed here.
    props: { w: 0, h: 0, filter, trafficMode: 'normal', userId: '', deviceId: '' },
  }
}

export function IndexChatPanel({ filter, className }: { filter: ChatFilter; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const identity = useFleetIdentity()
  const [editor] = useState(() => createIndexEditor([indexChatShape(filter)]))

  // The panel sizes itself from its shape's w/h, which on the canvas is the box
  // you dragged. Here the box is the DOM element, so the element's size IS the
  // shape's size and the chat lays out against its container the way it lays out
  // against its frame.
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    // clientWidth/clientHeight, not getBoundingClientRect: the wrapper has a
    // border, and the panel has to fit inside it rather than over it.
    const apply = () => {
      editor.updateShape({
        id: INDEX_CHAT_SHAPE_ID,
        props: { w: element.clientWidth, h: element.clientHeight },
      })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [editor])

  // Picking an agent on the index sets the chat's filter — the same value the
  // filter pane writes, through the same path, so choosing an agent and editing
  // the filter by hand cannot end up as two sources of truth.
  // Keyed on the serialised filter rather than the array, which is a fresh
  // object every render — and read back out of the key, so the effect has no
  // dependency it does not declare.
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    editor.updateShape({ id: INDEX_CHAT_SHAPE_ID, props: { filter: JSON.parse(filterKey) } })
  }, [editor, filterKey])

  // Identity arrives after login and ownership checks in the chat read it off
  // the shape, so it is written when it lands rather than guessed at mount.
  useEffect(() => {
    if (!identity.id) return
    editor.updateShape({
      id: INDEX_CHAT_SHAPE_ID,
      props: { userId: identity.id, deviceId: getDeviceId() || '' },
    })
  }, [editor, identity.id])

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

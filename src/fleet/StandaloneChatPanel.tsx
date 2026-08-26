/**
 * The real chat, on a surface that has no canvas shape behind it.
 *
 * Two places in this app used to carry their own chat: the project index, and
 * the inbox's thread view. Each was a second render loop over the same
 * `renderChatLine` the panel uses, with its own cut-down scroll model and a bare
 * composer. Everything the panel does around those renderers — earlier history,
 * folds, thread and operation cards, image retry, linkified references, filter
 * modes, the unread rail — neither had, because each was a different
 * implementation rather than a different configuration.
 *
 * Skip, 2026-08-25, on the inbox: "rn the like, inbox chat is kind of a lesser
 * thing ... let's just have a proper chat in the inbox. same exact thing; normal
 * chat when you click into a thread. normal chat composer, all that. that way
 * like, the inbox is kind of a reasonable stand-alone tool."
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

type ChatFilter = [string, string][][]

/**
 * Each mount is its own panel with its own state, so it gets its own shape id.
 * Two of these on one page — an index chat and an inbox thread — must not share
 * a filter because they happen to share a component.
 */
function panelShapeId(panelKey: string) {
  return `shape:standalone-chat:${panelKey}`
}

function standaloneChatShape(id: string, filter: ChatFilter): IndexEditorShape {
  return {
    id,
    type: 'fleet-chat',
    x: 0,
    y: 0,
    // Size arrives from the container measurement below; ownership arrives with
    // identity. Both are written once they are known rather than guessed here.
    props: { w: 0, h: 0, filter, trafficMode: 'normal', userId: '', deviceId: '' },
  }
}

export function StandaloneChatPanel({
  filter,
  className,
  panelKey = 'index',
}: {
  filter: ChatFilter
  className?: string
  /** Distinguishes one panel's state from another's. See panelShapeId. */
  panelKey?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const identity = useFleetIdentity()
  const shapeId = useMemo(() => panelShapeId(panelKey), [panelKey])
  const [editor] = useState(() => createIndexEditor([standaloneChatShape(panelShapeId(panelKey), filter)]))

  // The panel sizes itself from its shape's w/h, which on the canvas is the box
  // you dragged. Here the box is the DOM element, so the element's size IS the
  // shape's size and the chat lays out against its container the way it lays out
  // against its frame.
  //
  // The element must also be a positioning context, which `.standalone-chat-panel`
  // makes it. tldraw's HTMLContainer is `position: absolute; top: 0; left: 0`,
  // and with a static wrapper it resolves against the page instead — measured on
  // the deployed index page, the chat drew at viewport x=0 while its box sat
  // centred at x=462, and `overflow: hidden` could not clip it because the
  // containing block was outside. Skip: "index page chat is like, working great
  // but not where the old shitty one was".
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    // clientWidth/clientHeight, not getBoundingClientRect: the wrapper has a
    // border, and the panel has to fit inside it rather than over it.
    const apply = () => {
      editor.updateShape({
        id: shapeId,
        props: { w: element.clientWidth, h: element.clientHeight },
      })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [editor, shapeId])

  // Picking an agent on the index sets the chat's filter — the same value the
  // filter pane writes, through the same path, so choosing an agent and editing
  // the filter by hand cannot end up as two sources of truth.
  // Keyed on the serialised filter rather than the array, which is a fresh
  // object every render — and read back out of the key, so the effect has no
  // dependency it does not declare.
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    editor.updateShape({ id: shapeId, props: { filter: JSON.parse(filterKey) } })
  }, [editor, shapeId, filterKey])

  // Identity arrives after login and ownership checks in the chat read it off
  // the shape, so it is written when it lands rather than guessed at mount.
  useEffect(() => {
    if (!identity.id) return
    editor.updateShape({
      id: shapeId,
      props: { userId: identity.id, deviceId: getDeviceId() || '' },
    })
  }, [editor, shapeId, identity.id])

  const shape = useValue('standalone-chat-shape', () => editor.getShape(shapeId), [editor, shapeId])
  const contextValue = useMemo(() => asEditorContextValue(editor), [editor])

  return (
    <div ref={containerRef} className={`standalone-chat-panel${className ? ` ${className}` : ''}`}>
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

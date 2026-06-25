import { useValue } from "@tldraw/state-react";
import { useEffect, useMemo } from "react";
import { DEFAULT_VIEWPORT_ID } from "../editor/viewports/TLViewport.mjs";
import { tlenv } from "../globals/environment.mjs";
import {
  elementShouldCaptureKeys,
  preventDefault,
  releasePointerCapture,
  setPointerCapture
} from "../utils/dom.mjs";
import { getPointerInfo } from "../utils/getPointerInfo.mjs";
import { getPointerEventButton, isDirectDisplayPen, isSecondaryClickEvent } from "../utils/pointer.mjs";
import { useEditor } from "./useEditor.mjs";
let activePointerOwner;
function useCanvasEvents(opts) {
  const editor = useEditor();
  const ownerDocument = editor.getContainerDocument();
  const currentTool = useValue("current tool", () => editor.getCurrentTool(), [editor]);
  const viewportId = opts?.viewportId ?? DEFAULT_VIEWPORT_ID;
  const isDefaultViewport = viewportId === DEFAULT_VIEWPORT_ID;
  const eventViewportId = isDefaultViewport ? void 0 : viewportId;
  const events = useMemo(
    function canvasEvents() {
      let isSecondaryClickPointerDown = false;
      function onPointerDown(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        const button = getPointerEventButton(e);
        isSecondaryClickPointerDown = button === 2;
        if (button === 2 && !editor.options.rightClickPanning) {
          editor.dispatch({
            type: "pointer",
            target: "canvas",
            name: "right_click",
            ...getPointerInfo(editor, e, { viewportId: eventViewportId })
          });
          return;
        }
        if (button !== 0 && button !== 1 && button !== 2 && button !== 5) return;
        const isPenDirect = isDirectDisplayPen(e);
        setPointerCapture(e.currentTarget, e);
        activePointerOwner = { pointerId: e.pointerId, viewportId, editor };
        editor.dispatch({
          type: "pointer",
          target: "canvas",
          name: "pointer_down",
          ...getPointerInfo(editor, e, { viewportId: eventViewportId }),
          isPenDirect
        });
      }
      function onPointerUp(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        const owner = activePointerOwner?.pointerId === e.pointerId && activePointerOwner.editor === editor ? activePointerOwner : void 0;
        const button = isSecondaryClickPointerDown ? 2 : getPointerEventButton(e);
        if (button !== 0 && button !== 1 && button !== 2 && button !== 5) return;
        const rightClickPanning = editor.options.rightClickPanning;
        const wasRightClickPanning = rightClickPanning && button === 2 && editor.inputs.getIsPanning();
        releasePointerCapture(e.currentTarget, e);
        editor.dispatch({
          type: "pointer",
          target: "canvas",
          name: "pointer_up",
          ...getPointerInfo(editor, e, {
            viewportId: owner && owner.viewportId !== DEFAULT_VIEWPORT_ID ? owner.viewportId : eventViewportId
          }),
          button
        });
        if (rightClickPanning && button === 2 && !wasRightClickPanning) {
          const contextMenuEvent = new PointerEvent("contextmenu", {
            bubbles: true,
            clientX: e.clientX,
            clientY: e.clientY,
            button: 2,
            buttons: 0,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            isPrimary: e.isPrimary
          });
          e.currentTarget.dispatchEvent(contextMenuEvent);
        }
        isSecondaryClickPointerDown = false;
        if (activePointerOwner?.pointerId === e.pointerId) activePointerOwner = void 0;
      }
      function onPointerCancel(e) {
        if (activePointerOwner?.pointerId === e.pointerId && activePointerOwner.editor === editor) {
          activePointerOwner = void 0;
        }
      }
      function onPointerEnter(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        if (editor.getInstanceState().isPenMode && e.pointerType !== "pen") return;
        const canHover = e.pointerType === "mouse" || e.pointerType === "pen";
        editor.updateInstanceState({ isHoveringCanvas: canHover ? true : null });
      }
      function onPointerLeave(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        if (editor.getInstanceState().isPenMode && e.pointerType !== "pen") return;
        const canHover = e.pointerType === "mouse" || e.pointerType === "pen";
        editor.updateInstanceState({ isHoveringCanvas: canHover ? false : null });
      }
      function onTouchStart(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        editor.markEventAsHandled(e);
        preventDefault(e);
      }
      function onTouchEnd(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        editor.markEventAsHandled(e);
        if (!(e.target instanceof editor.getContainerWindow().HTMLElement)) return;
        const editingShapeId = editor.getEditingShapeId();
        if (
          // if the target is not inside the editing shape
          !(editingShapeId && e.target.closest(`[data-shape-id="${editingShapeId}"]`)) && // and the target is not an clickable element
          e.target.tagName !== "A" && // and the target is not an editable element
          !elementShouldCaptureKeys(e.target, false)
        ) {
          preventDefault(e);
        }
      }
      function onDragOver(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        preventDefault(e);
      }
      async function onDrop(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        preventDefault(e);
        e.stopPropagation();
        const pagePoint = editor.screenToPage(
          { x: e.clientX, y: e.clientY },
          { viewportId: eventViewportId }
        );
        if (editor.options.experimental__onDropOnCanvas) {
          const handled = editor.options.experimental__onDropOnCanvas({
            point: pagePoint,
            event: e
          });
          if (handled) return;
        }
        if (e.dataTransfer?.files?.length) {
          const files = Array.from(e.dataTransfer.files);
          await editor.putExternalContent({
            type: "files",
            files,
            point: pagePoint
          });
          return;
        }
        const url = e.dataTransfer.getData("url");
        if (url) {
          await editor.putExternalContent({
            type: "url",
            url,
            point: pagePoint
          });
          return;
        }
      }
      function onClick(e) {
        if (editor.wasEventAlreadyHandled(e)) return;
        e.stopPropagation();
      }
      function onContextMenu(e) {
        if (!editor.options.rightClickPanning) return;
        if (!e.nativeEvent.isTrusted) return;
        if (!isSecondaryClickEvent(e)) return;
        preventDefault(e);
      }
      return {
        onPointerDown,
        onPointerUp,
        onPointerCancel,
        onPointerEnter,
        onPointerLeave,
        onDragOver,
        onDrop,
        onTouchStart,
        onTouchEnd,
        onClick,
        onContextMenu
      };
    },
    [editor, eventViewportId, viewportId]
  );
  useEffect(() => {
    let lastX, lastY;
    function onPointerMove(e) {
      const owner = activePointerOwner;
      if (owner && owner.editor !== editor) return;
      if (owner && owner.pointerId !== e.pointerId) return;
      if (owner && owner.viewportId !== viewportId) return;
      if (!owner && !isDefaultViewport) return;
      if (editor.wasEventAlreadyHandled(e)) return;
      editor.markEventAsHandled(e);
      if (e.clientX === lastX && e.clientY === lastY) return;
      lastX = e.clientX;
      lastY = e.clientY;
      const events2 = !tlenv.isIos && currentTool.useCoalescedEvents && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const singleEvent of events2) {
        editor.dispatch({
          type: "pointer",
          target: "canvas",
          name: "pointer_move",
          ...getPointerInfo(editor, singleEvent, {
            viewportId: owner && owner.viewportId !== DEFAULT_VIEWPORT_ID ? owner.viewportId : eventViewportId
          })
        });
      }
    }
    ownerDocument.body.addEventListener("pointermove", onPointerMove);
    return () => {
      ownerDocument.body.removeEventListener("pointermove", onPointerMove);
    };
  }, [editor, currentTool, eventViewportId, ownerDocument, isDefaultViewport, viewportId]);
  return events;
}
export {
  useCanvasEvents
};
//# sourceMappingURL=useCanvasEvents.mjs.map

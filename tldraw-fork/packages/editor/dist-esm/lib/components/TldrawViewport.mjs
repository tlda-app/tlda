import { jsx, jsxs } from "react/jsx-runtime";
import { useQuickReactor, useValue } from "@tldraw/state-react";
import { objectMapValues } from "@tldraw/utils";
import classNames from "classnames";
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { useEditorComponents } from "../hooks/EditorComponentsContext.mjs";
import { useCanvasEvents } from "../hooks/useCanvasEvents.mjs";
import { useEditor } from "../hooks/useEditor.mjs";
import { ShapeCullingProvider, useShapeCulling } from "../hooks/useShapeCulling.mjs";
import { Box } from "../primitives/Box.mjs";
import { toDomPrecision } from "../primitives/utils.mjs";
import { debugFlags } from "../utils/debug-flags.mjs";
import { setStyleProperty } from "../utils/dom.mjs";
import { normalizeWheel } from "../utils/normalizeWheel.mjs";
import { Shape } from "./Shape.mjs";
function TldrawViewport({
  id,
  camera,
  pageId,
  className,
  onCameraChange
}) {
  const editor = useEditor();
  const { Background, Grid, SvgDefs } = useEditorComponents();
  const rCanvas = useRef(null);
  const rHtmlLayer = useRef(null);
  const rTouchPan = useRef(null);
  const [screenBounds, setScreenBounds] = useState(null);
  const events = useCanvasEvents({ viewportId: id });
  useLayoutEffect(() => {
    const canvas = rCanvas.current;
    if (!canvas) return;
    const updateBounds = () => {
      const rect = canvas.getBoundingClientRect();
      setScreenBounds(
        new Box(rect.left || rect.x, rect.top || rect.y, rect.width || 1, rect.height || 1)
      );
    };
    updateBounds();
    const resizeObserver = new ResizeObserver(updateBounds);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", updateBounds);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, []);
  useLayoutEffect(() => {
    if (!screenBounds) return;
    return editor.registerViewport({
      id,
      pageId: pageId ?? editor.getCurrentPageId(),
      screenBounds: screenBounds.toJson(),
      camera
    });
  }, [camera, editor, id, pageId, screenBounds]);
  useQuickReactor(
    "position viewport layers",
    () => {
      const { x, y, z } = camera;
      setStyleProperty(
        rHtmlLayer.current,
        "transform",
        `scale(${toDomPrecision(z)}) translate(${toDomPrecision(x)}px,${toDomPrecision(y)}px)`
      );
    },
    [camera]
  );
  const onWheel = useCallback(
    (event) => {
      if (!onCameraChange) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = normalizeWheel(event.nativeEvent);
      if (!event.ctrlKey && !event.metaKey) {
        onCameraChange({
          x: camera.x - delta.x / camera.z,
          y: camera.y - delta.y / camera.z,
          z: camera.z
        });
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const pagePoint = screenToPage(screenPoint, camera);
      const nextZ = Math.max(0.05, Math.min(8, camera.z * Math.exp(-delta.y / 500)));
      onCameraChange({
        x: screenPoint.x / nextZ - pagePoint.x,
        y: screenPoint.y / nextZ - pagePoint.y,
        z: nextZ
      });
    },
    [camera, onCameraChange]
  );
  const shouldPanWithTouch = useCallback(
    (event) => {
      if (!onCameraChange || event.pointerType !== "touch" || !event.isPrimary) return false;
      const toolId = editor.getCurrentToolId();
      return toolId === "select" || toolId === "hand";
    },
    [editor, onCameraChange]
  );
  const onPointerDown = useCallback(
    (event) => {
      if (!shouldPanWithTouch(event)) {
        events.onPointerDown?.(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      rTouchPan.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        camera
      };
    },
    [camera, events, shouldPanWithTouch]
  );
  const onPointerMove = useCallback(
    (event) => {
      const touchPan = rTouchPan.current;
      if (!touchPan || touchPan.pointerId !== event.pointerId || !onCameraChange) return;
      event.preventDefault();
      event.stopPropagation();
      onCameraChange({
        x: touchPan.camera.x + (event.clientX - touchPan.x) / touchPan.camera.z,
        y: touchPan.camera.y + (event.clientY - touchPan.y) / touchPan.camera.z,
        z: touchPan.camera.z
      });
    },
    [onCameraChange]
  );
  const onPointerUp = useCallback(
    (event) => {
      const touchPan = rTouchPan.current;
      if (!touchPan || touchPan.pointerId !== event.pointerId) {
        events.onPointerUp?.(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      rTouchPan.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    [events]
  );
  const onPointerCancel = useCallback(
    (event) => {
      if (rTouchPan.current?.pointerId === event.pointerId) {
        rTouchPan.current = null;
      }
      events.onPointerCancel?.(event);
    },
    [events]
  );
  const shapeSvgDefs = useShapeSvgDefs();
  const isGridMode = useValue("viewport grid mode", () => editor.getInstanceState().isGridMode, [
    editor
  ]);
  const gridSize = useValue("viewport grid size", () => editor.getDocumentSettings().gridSize, [
    editor
  ]);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      ref: rCanvas,
      draggable: false,
      className: classNames("tl-canvas", "tl-viewport", className),
      "data-testid": "tldraw-viewport",
      onWheel,
      ...events,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      children: [
        /* @__PURE__ */ jsx("svg", { className: "tl-svg-context", "aria-hidden": "true", children: /* @__PURE__ */ jsxs("defs", { children: [
          shapeSvgDefs,
          SvgDefs && /* @__PURE__ */ jsx(SvgDefs, {})
        ] }) }),
        Background && /* @__PURE__ */ jsx("div", { className: "tl-background__wrapper", children: /* @__PURE__ */ jsx(Background, {}) }),
        isGridMode && Grid && /* @__PURE__ */ jsx(Grid, { x: camera.x, y: camera.y, z: camera.z, size: gridSize }),
        /* @__PURE__ */ jsx("div", { ref: rHtmlLayer, className: "tl-html-layer tl-shapes", draggable: false, children: /* @__PURE__ */ jsx(ViewportShapesLayer, { viewportId: id }) })
      ]
    }
  );
}
function useShapeSvgDefs() {
  const editor = useEditor();
  return useValue(
    "viewport shapeSvgDefs",
    () => {
      const shapeSvgDefsByKey = /* @__PURE__ */ new Map();
      for (const util of objectMapValues(editor.shapeUtils)) {
        if (!util) return;
        const defs = util.getCanvasSvgDefs();
        for (const { key, component: Component } of defs) {
          if (shapeSvgDefsByKey.has(key)) continue;
          shapeSvgDefsByKey.set(key, /* @__PURE__ */ jsx(Component, {}, key));
        }
      }
      return [...shapeSvgDefsByKey.values()];
    },
    [editor]
  );
}
function ViewportShapesLayer({ viewportId }) {
  const editor = useEditor();
  const debugSvg = useValue("viewport debug svg", () => debugFlags.debugSvg.get(), [debugFlags]);
  const renderingShapes = useValue(
    "viewport rendering shapes",
    () => editor.getRenderingShapes({ viewportId }),
    [editor, viewportId]
  );
  return /* @__PURE__ */ jsxs(ShapeCullingProvider, { children: [
    renderingShapes.map(
      (result) => debugSvg ? /* @__PURE__ */ jsx(Fragment, { children: /* @__PURE__ */ jsx(Shape, { ...result }) }, result.id + "_fragment") : /* @__PURE__ */ jsx(Shape, { ...result }, result.id + "_shape")
    ),
    /* @__PURE__ */ jsx(ViewportCullingController, { viewportId })
  ] });
}
function ViewportCullingController({ viewportId }) {
  const editor = useEditor();
  const { updateCulling } = useShapeCulling();
  useQuickReactor(
    "update viewport shape culling",
    () => {
      updateCulling(editor.getCulledShapes({ viewportId }));
    },
    [editor, updateCulling, viewportId]
  );
  return null;
}
function screenToPage(point, camera) {
  return {
    x: point.x / camera.z - camera.x,
    y: point.y / camera.z - camera.y
  };
}
export {
  TldrawViewport
};
//# sourceMappingURL=TldrawViewport.mjs.map

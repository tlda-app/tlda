"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var TldrawViewport_exports = {};
__export(TldrawViewport_exports, {
  TldrawViewport: () => TldrawViewport
});
module.exports = __toCommonJS(TldrawViewport_exports);
var import_jsx_runtime = require("react/jsx-runtime");
var import_state_react = require("@tldraw/state-react");
var import_utils = require("@tldraw/utils");
var import_classnames = __toESM(require("classnames"), 1);
var import_react = require("react");
var import_EditorComponentsContext = require("../hooks/EditorComponentsContext");
var import_useCanvasEvents = require("../hooks/useCanvasEvents");
var import_useEditor = require("../hooks/useEditor");
var import_useShapeCulling = require("../hooks/useShapeCulling");
var import_Box = require("../primitives/Box");
var import_utils2 = require("../primitives/utils");
var import_debug_flags = require("../utils/debug-flags");
var import_dom = require("../utils/dom");
var import_normalizeWheel = require("../utils/normalizeWheel");
var import_Shape = require("./Shape");
function TldrawViewport({
  id,
  camera,
  pageId,
  className,
  onCameraChange
}) {
  const editor = (0, import_useEditor.useEditor)();
  const { Background, Grid, SvgDefs } = (0, import_EditorComponentsContext.useEditorComponents)();
  const rCanvas = (0, import_react.useRef)(null);
  const rHtmlLayer = (0, import_react.useRef)(null);
  const rTouchPan = (0, import_react.useRef)(null);
  const [screenBounds, setScreenBounds] = (0, import_react.useState)(null);
  const events = (0, import_useCanvasEvents.useCanvasEvents)({ viewportId: id });
  (0, import_react.useLayoutEffect)(() => {
    const canvas = rCanvas.current;
    if (!canvas) return;
    const updateBounds = () => {
      const rect = canvas.getBoundingClientRect();
      setScreenBounds(
        new import_Box.Box(rect.left || rect.x, rect.top || rect.y, rect.width || 1, rect.height || 1)
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
  (0, import_react.useLayoutEffect)(() => {
    if (!screenBounds) return;
    return editor.registerViewport({
      id,
      pageId: pageId ?? editor.getCurrentPageId(),
      screenBounds: screenBounds.toJson(),
      camera
    });
  }, [camera, editor, id, pageId, screenBounds]);
  (0, import_state_react.useQuickReactor)(
    "position viewport layers",
    () => {
      const { x, y, z } = camera;
      (0, import_dom.setStyleProperty)(
        rHtmlLayer.current,
        "transform",
        `scale(${(0, import_utils2.toDomPrecision)(z)}) translate(${(0, import_utils2.toDomPrecision)(x)}px,${(0, import_utils2.toDomPrecision)(y)}px)`
      );
    },
    [camera]
  );
  const onWheel = (0, import_react.useCallback)(
    (event) => {
      if (!onCameraChange) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = (0, import_normalizeWheel.normalizeWheel)(event.nativeEvent);
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
  const shouldPanWithTouch = (0, import_react.useCallback)(
    (event) => {
      if (!onCameraChange || event.pointerType !== "touch" || !event.isPrimary) return false;
      const toolId = editor.getCurrentToolId();
      return toolId === "select" || toolId === "hand";
    },
    [editor, onCameraChange]
  );
  const onPointerDown = (0, import_react.useCallback)(
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
  const onPointerMove = (0, import_react.useCallback)(
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
  const onPointerUp = (0, import_react.useCallback)(
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
  const onPointerCancel = (0, import_react.useCallback)(
    (event) => {
      if (rTouchPan.current?.pointerId === event.pointerId) {
        rTouchPan.current = null;
      }
      events.onPointerCancel?.(event);
    },
    [events]
  );
  const shapeSvgDefs = useShapeSvgDefs();
  const isGridMode = (0, import_state_react.useValue)("viewport grid mode", () => editor.getInstanceState().isGridMode, [
    editor
  ]);
  const gridSize = (0, import_state_react.useValue)("viewport grid size", () => editor.getDocumentSettings().gridSize, [
    editor
  ]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      ref: rCanvas,
      draggable: false,
      className: (0, import_classnames.default)("tl-canvas", "tl-viewport", className),
      "data-testid": "tldraw-viewport",
      onWheel,
      ...events,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { className: "tl-svg-context", "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("defs", { children: [
          shapeSvgDefs,
          SvgDefs && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SvgDefs, {})
        ] }) }),
        Background && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "tl-background__wrapper", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Background, {}) }),
        isGridMode && Grid && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Grid, { x: camera.x, y: camera.y, z: camera.z, size: gridSize }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: rHtmlLayer, className: "tl-html-layer tl-shapes", draggable: false, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ViewportShapesLayer, { viewportId: id }) })
      ]
    }
  );
}
function useShapeSvgDefs() {
  const editor = (0, import_useEditor.useEditor)();
  return (0, import_state_react.useValue)(
    "viewport shapeSvgDefs",
    () => {
      const shapeSvgDefsByKey = /* @__PURE__ */ new Map();
      for (const util of (0, import_utils.objectMapValues)(editor.shapeUtils)) {
        if (!util) return;
        const defs = util.getCanvasSvgDefs();
        for (const { key, component: Component } of defs) {
          if (shapeSvgDefsByKey.has(key)) continue;
          shapeSvgDefsByKey.set(key, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Component, {}, key));
        }
      }
      return [...shapeSvgDefsByKey.values()];
    },
    [editor]
  );
}
function ViewportShapesLayer({ viewportId }) {
  const editor = (0, import_useEditor.useEditor)();
  const debugSvg = (0, import_state_react.useValue)("viewport debug svg", () => import_debug_flags.debugFlags.debugSvg.get(), [import_debug_flags.debugFlags]);
  const renderingShapes = (0, import_state_react.useValue)(
    "viewport rendering shapes",
    () => editor.getRenderingShapes({ viewportId }),
    [editor, viewportId]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_useShapeCulling.ShapeCullingProvider, { children: [
    renderingShapes.map(
      (result) => debugSvg ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react.Fragment, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_Shape.Shape, { ...result }) }, result.id + "_fragment") : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_Shape.Shape, { ...result }, result.id + "_shape")
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ViewportCullingController, { viewportId })
  ] });
}
function ViewportCullingController({ viewportId }) {
  const editor = (0, import_useEditor.useEditor)();
  const { updateCulling } = (0, import_useShapeCulling.useShapeCulling)();
  (0, import_state_react.useQuickReactor)(
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
//# sourceMappingURL=TldrawViewport.js.map

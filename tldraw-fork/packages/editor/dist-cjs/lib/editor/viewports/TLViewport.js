"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var TLViewport_exports = {};
__export(TLViewport_exports, {
  DEFAULT_VIEWPORT_ID: () => DEFAULT_VIEWPORT_ID,
  getViewportPageBounds: () => getViewportPageBounds
});
module.exports = __toCommonJS(TLViewport_exports);
var import_Box = require("../../primitives/Box");
const DEFAULT_VIEWPORT_ID = "default";
function getViewportPageBounds(viewport) {
  const { w, h } = viewport.screenBounds;
  const { x, y, z } = viewport.camera;
  return new import_Box.Box(-x, -y, w / z, h / z);
}
//# sourceMappingURL=TLViewport.js.map

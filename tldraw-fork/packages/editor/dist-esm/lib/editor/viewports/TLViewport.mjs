import { Box } from "../../primitives/Box.mjs";
const DEFAULT_VIEWPORT_ID = "default";
function getViewportPageBounds(viewport) {
  const { w, h } = viewport.screenBounds;
  const { x, y, z } = viewport.camera;
  return new Box(-x, -y, w / z, h / z);
}
export {
  DEFAULT_VIEWPORT_ID,
  getViewportPageBounds
};
//# sourceMappingURL=TLViewport.mjs.map

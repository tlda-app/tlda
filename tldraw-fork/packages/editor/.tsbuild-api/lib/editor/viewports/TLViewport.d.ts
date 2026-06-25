import { BoxModel, TLCamera, TLPageId } from '@tldraw/tlschema';
import { Box } from '../../primitives/Box';
/** @public */
export type TLViewportId = string;
/** @public */
export declare const DEFAULT_VIEWPORT_ID: TLViewportId;
/** @public */
export interface TLViewport {
    id: TLViewportId;
    pageId?: TLPageId;
    screenBounds: BoxModel;
    camera: Pick<TLCamera, 'x' | 'y' | 'z'>;
}
/** @public */
export interface TLViewportOptions {
    viewportId?: TLViewportId;
    viewport?: TLViewport;
}
/** @public */
export declare function getViewportPageBounds(viewport: Pick<TLViewport, 'camera' | 'screenBounds'>): Box;
//# sourceMappingURL=TLViewport.d.ts.map
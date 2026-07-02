import type { TLShape } from '@tldraw/tlschema';
import { TLViewport, TLViewportId } from '../editor/viewports/TLViewport';
/** @public */
export interface TldrawViewportProps {
    id: TLViewportId;
    camera: TLViewport['camera'];
    pageId?: TLViewport['pageId'];
    className?: string;
    disableCulling?: boolean;
    shapePredicate?(shape: TLShape): boolean;
    onCameraChange?(camera: TLViewport['camera']): void;
}
/** @public @react */
export declare function TldrawViewport({ id, camera, pageId, className, disableCulling, shapePredicate, onCameraChange, }: TldrawViewportProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawViewport.d.ts.map
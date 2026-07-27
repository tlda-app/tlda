import { TLViewport, TLViewportId } from '../editor/viewports/TLViewport';
/** @public */
export interface TldrawViewportProps {
    id: TLViewportId;
    camera: TLViewport['camera'];
    pageId?: TLViewport['pageId'];
    className?: string;
    onCameraChange?(camera: TLViewport['camera']): void;
    shapePredicate?(shape: TLShape): boolean;
}
/** @public @react */
export declare function TldrawViewport({ id, camera, pageId, className, onCameraChange }: TldrawViewportProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawViewport.d.ts.map
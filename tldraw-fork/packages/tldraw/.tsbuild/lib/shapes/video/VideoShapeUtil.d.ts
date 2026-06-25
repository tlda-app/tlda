import { BaseBoxShapeUtil, SvgExportContext, TLAsset, TLShapePartial, TLVideoShape, VecModel } from '@tldraw/editor';
import type { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface VideoShapeUtilDisplayValues {
}
/** @public */
export interface VideoShapeOptions extends ShapeOptionsWithDisplayValues<TLVideoShape, VideoShapeUtilDisplayValues> {
    /**
     * Should videos play automatically?
     */
    autoplay: boolean;
}
/** @public */
export declare class VideoShapeUtil extends BaseBoxShapeUtil<TLVideoShape> {
    static type: "video";
    static props: import("@tldraw/tlschema").RecordProps<TLVideoShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    static handledAssetTypes: readonly ["video"];
    options: VideoShapeOptions;
    canEdit(shape: TLVideoShape): boolean;
    isAspectRatioLocked(shape: TLVideoShape): boolean;
    getDefaultProps(): TLVideoShape['props'];
    createShapeForAsset(asset: TLAsset, position: VecModel): TLShapePartial | null;
    getAriaDescriptor(shape: TLVideoShape): string;
    component(shape: TLVideoShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLVideoShape): Path2D;
    toSvg(shape: TLVideoShape, ctx: SvgExportContext): Promise<import("react/jsx-runtime").JSX.Element | null>;
}
//# sourceMappingURL=VideoShapeUtil.d.ts.map
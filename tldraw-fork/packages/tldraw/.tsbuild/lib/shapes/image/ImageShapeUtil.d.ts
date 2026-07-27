import { BaseBoxShapeUtil, Geometry2d, SvgExportContext, TLAsset, TLImageShape, TLImageShapeProps, TLResizeInfo, TLShapePartial, VecModel } from '@tldraw/editor';
import type { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface ImageShapeUtilDisplayValues {
}
/** @public */
export interface ImageShapeOptions extends ShapeOptionsWithDisplayValues<TLImageShape, ImageShapeUtilDisplayValues> {
}
/** @public */
export declare class ImageShapeUtil extends BaseBoxShapeUtil<TLImageShape> {
    static type: "image";
    static props: import("@tldraw/tlschema").RecordProps<TLImageShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    static handledAssetTypes: readonly ["image"];
    options: ImageShapeOptions;
    isAspectRatioLocked(shape: TLImageShape): boolean;
    canCrop(shape: TLImageShape): boolean;
    isExportBoundsContainer(): boolean;
    getDefaultProps(): TLImageShape['props'];
    createShapeForAsset(asset: TLAsset, position: VecModel): TLShapePartial | null;
    getGeometry(shape: TLImageShape): Geometry2d;
    getAriaDescriptor(shape: TLImageShape): string;
    onResize(shape: TLImageShape, info: TLResizeInfo<TLImageShape>): TLImageShape;
    component(shape: TLImageShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLImageShape): Path2D | undefined;
    toSvg(shape: TLImageShape, ctx: SvgExportContext): Promise<import("react/jsx-runtime").JSX.Element | null>;
    onDoubleClickEdge(shape: TLImageShape): void;
    getInterpolatedProps(startShape: TLImageShape, endShape: TLImageShape, t: number): TLImageShapeProps;
}
//# sourceMappingURL=ImageShapeUtil.d.ts.map
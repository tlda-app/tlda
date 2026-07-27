import { BaseBoxShapeUtil, Rectangle2d, TLAssetId, TLBookmarkShape, TLBookmarkShapeProps } from '@tldraw/editor';
import type { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export type BookmarkShapeUtilDisplayValues = object;
/** @public */
export interface BookmarkShapeOptions extends ShapeOptionsWithDisplayValues<TLBookmarkShape, BookmarkShapeUtilDisplayValues> {
}
/** @public */
export declare class BookmarkShapeUtil extends BaseBoxShapeUtil<TLBookmarkShape> {
    static type: "bookmark";
    static props: import("@tldraw/tlschema").RecordProps<TLBookmarkShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: BookmarkShapeOptions;
    canResize(shape: TLBookmarkShape): boolean;
    hideSelectionBoundsFg(shape: TLBookmarkShape): boolean;
    getText(shape: TLBookmarkShape): string;
    getAriaDescriptor(shape: TLBookmarkShape): string | undefined;
    getDefaultProps(): TLBookmarkShape['props'];
    getGeometry(shape: TLBookmarkShape): Rectangle2d;
    component(shape: TLBookmarkShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLBookmarkShape): Path2D;
    onBeforeCreate(next: TLBookmarkShape): {
        id: import("@tldraw/tlschema").TLShapeId;
        typeName: "shape";
        type: "bookmark";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            w: number;
            assetId: TLAssetId | null;
            url: string;
            h: number;
        };
    };
    onBeforeUpdate(prev: TLBookmarkShape, shape: TLBookmarkShape): {
        id: import("@tldraw/tlschema").TLShapeId;
        typeName: "shape";
        type: "bookmark";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            w: number;
            assetId: TLAssetId | null;
            url: string;
            h: number;
        };
    } | undefined;
    getInterpolatedProps(startShape: TLBookmarkShape, endShape: TLBookmarkShape, t: number): TLBookmarkShapeProps;
}
export declare function BookmarkShapeComponent({ assetId, rotation, url, h, showImageContainer }: {
    assetId: TLAssetId | null;
    rotation: number;
    h: number;
    url: string;
    showImageContainer?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=BookmarkShapeUtil.d.ts.map
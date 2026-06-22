import { Editor } from '@tldraw/editor';
/** @internal */
export declare function buildFromV1Document(editor: Editor, _document: unknown): void;
/** @internal */
export interface TLV1Handle {
    id: string;
    index: number;
    point: number[];
    canBind?: boolean;
    bindingId?: string;
}
/** @internal */
export interface TLV1BaseBinding {
    id: string;
    toId: string;
    fromId: string;
}
/** @internal */
export declare const TLV1ShapeType: {
    readonly Sticky: "sticky";
    readonly Ellipse: "ellipse";
    readonly Rectangle: "rectangle";
    readonly Triangle: "triangle";
    readonly Draw: "draw";
    readonly Arrow: "arrow";
    readonly Text: "text";
    readonly Group: "group";
    readonly Image: "image";
    readonly Video: "video";
};
/** @internal */
export type TLV1ShapeType = (typeof TLV1ShapeType)[keyof typeof TLV1ShapeType];
/** @internal */
export declare const TLV1ColorStyle: {
    readonly White: "white";
    readonly LightGray: "lightGray";
    readonly Gray: "gray";
    readonly Black: "black";
    readonly Green: "green";
    readonly Cyan: "cyan";
    readonly Blue: "blue";
    readonly Indigo: "indigo";
    readonly Violet: "violet";
    readonly Red: "red";
    readonly Orange: "orange";
    readonly Yellow: "yellow";
};
/** @internal */
export type TLV1ColorStyle = (typeof TLV1ColorStyle)[keyof typeof TLV1ColorStyle];
/** @internal */
export declare const TLV1SizeStyle: {
    readonly Small: "small";
    readonly Medium: "medium";
    readonly Large: "large";
};
/** @internal */
export type TLV1SizeStyle = (typeof TLV1SizeStyle)[keyof typeof TLV1SizeStyle];
/** @internal */
export declare const TLV1DashStyle: {
    readonly Draw: "draw";
    readonly Solid: "solid";
    readonly Dashed: "dashed";
    readonly Dotted: "dotted";
};
/** @internal */
export type TLV1DashStyle = (typeof TLV1DashStyle)[keyof typeof TLV1DashStyle];
/** @internal */
export declare const TLV1AlignStyle: {
    readonly Start: "start";
    readonly Middle: "middle";
    readonly End: "end";
    readonly Justify: "justify";
};
/** @internal */
export type TLV1AlignStyle = (typeof TLV1AlignStyle)[keyof typeof TLV1AlignStyle];
/** @internal */
export declare const TLV1FontStyle: {
    readonly Script: "script";
    readonly Sans: "sans";
    readonly Serif: "serif";
    readonly Mono: "mono";
};
/** @internal */
export type TLV1FontStyle = (typeof TLV1FontStyle)[keyof typeof TLV1FontStyle];
/** @internal */
export interface TLV1ShapeStyles {
    color: TLV1ColorStyle;
    size: TLV1SizeStyle;
    dash: TLV1DashStyle;
    font?: TLV1FontStyle;
    textAlign?: TLV1AlignStyle;
    isFilled?: boolean;
    scale?: number;
}
/** @internal */
export interface TLV1BaseShape {
    id: string;
    parentId: string;
    childIndex: number;
    name: string;
    point: number[];
    assetId?: string;
    rotation?: number;
    children?: string[];
    isGhost?: boolean;
    isHidden?: boolean;
    isLocked?: boolean;
    isGenerated?: boolean;
    isAspectRatioLocked?: boolean;
    style: TLV1ShapeStyles;
    type: TLV1ShapeType;
    label?: string;
    handles?: Record<string, TLV1Handle>;
}
/** @internal */
export interface TLV1DrawShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Draw;
    points: number[][];
    isComplete: boolean;
}
/** @internal */
export interface TLV1RectangleShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Rectangle;
    size: number[];
    label?: string;
    labelPoint?: number[];
}
/** @internal */
export interface TLV1EllipseShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Ellipse;
    radius: number[];
    label?: string;
    labelPoint?: number[];
}
/** @internal */
export interface TLV1TriangleShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Triangle;
    size: number[];
    label?: string;
    labelPoint?: number[];
}
/** @internal */
export declare const TLV1Decoration: {
    readonly Arrow: "arrow";
};
/** @internal */
export type TLV1Decoration = (typeof TLV1Decoration)[keyof typeof TLV1Decoration];
/** @internal */
export interface TLV1ArrowShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Arrow;
    bend: number;
    handles: {
        start: TLV1Handle;
        bend: TLV1Handle;
        end: TLV1Handle;
    };
    decorations?: {
        start?: TLV1Decoration;
        end?: TLV1Decoration;
        middle?: TLV1Decoration;
    };
    label?: string;
    labelPoint?: number[];
}
/** @internal */
export interface TLV1ArrowBinding extends TLV1BaseBinding {
    handleId: keyof TLV1ArrowShape['handles'];
    distance: number;
    point: number[];
}
/** @internal */
export type TLV1Binding = TLV1ArrowBinding;
/** @internal */
export interface TLV1ImageShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Image;
    size: number[];
    assetId: string;
}
/** @internal */
export interface TLV1VideoShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Video;
    size: number[];
    assetId: string;
    isPlaying: boolean;
    currentTime: number;
}
/** @internal */
export interface TLV1TextShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Text;
    text: string;
}
/** @internal */
export interface TLV1StickyShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Sticky;
    size: number[];
    text: string;
}
/** @internal */
export interface TLV1GroupShape extends TLV1BaseShape {
    type: typeof TLV1ShapeType.Group;
    size: number[];
    children: string[];
}
/** @internal */
export type TLV1Shape = TLV1RectangleShape | TLV1EllipseShape | TLV1TriangleShape | TLV1DrawShape | TLV1ArrowShape | TLV1TextShape | TLV1GroupShape | TLV1StickyShape | TLV1ImageShape | TLV1VideoShape;
/** @internal */
export interface TLV1Page {
    id: string;
    name?: string;
    childIndex?: number;
    shapes: Record<string, TLV1Shape>;
    bindings: Record<string, TLV1Binding>;
}
/** @internal */
export interface TLV1Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    rotation?: number;
}
/** @internal */
export interface TLV1PageState {
    id: string;
    selectedIds: string[];
    camera: {
        point: number[];
        zoom: number;
    };
    brush?: TLV1Bounds | null;
    pointedId?: string | null;
    hoveredId?: string | null;
    editingId?: string | null;
    bindingId?: string | null;
}
/** @internal */
export declare const TLV1AssetType: {
    readonly Image: "image";
    readonly Video: "video";
};
/** @internal */
export type TLV1AssetType = (typeof TLV1AssetType)[keyof typeof TLV1AssetType];
/** @internal */
export interface TLV1ImageAsset extends TLV1BaseAsset {
    type: typeof TLV1AssetType.Image;
    fileName: string;
    src: string;
    size: number[];
}
/** @internal */
export interface TLV1VideoAsset extends TLV1BaseAsset {
    type: typeof TLV1AssetType.Video;
    fileName: string;
    src: string;
    size: number[];
}
/** @internal */
export interface TLV1BaseAsset {
    id: string;
    type: string;
}
/** @internal */
export type TLV1Asset = TLV1ImageAsset | TLV1VideoAsset;
/** @internal */
export interface TLV1Document {
    id: string;
    name: string;
    version: number;
    pages: Record<string, TLV1Page>;
    pageStates: Record<string, TLV1PageState>;
    assets: Record<string, TLV1Asset>;
}
//# sourceMappingURL=buildFromV1Document.d.ts.map
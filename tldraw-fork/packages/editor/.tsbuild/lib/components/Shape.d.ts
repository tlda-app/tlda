import { TLShape, TLShapeId } from '@tldraw/tlschema';
import { ShapeUtil } from '../editor/shapes/ShapeUtil';
export declare const Shape: import("react").NamedExoticComponent<{
    id: TLShapeId;
    shape: TLShape;
    util: ShapeUtil<TLShape>;
    index: number;
    backgroundIndex: number;
    opacity: number;
}>;
export declare const InnerShape: import("react").MemoExoticComponent<<T extends TLShape>({ shape, util }: {
    shape: T;
    util: ShapeUtil<T>;
}) => any>;
export declare const InnerShapeBackground: import("react").MemoExoticComponent<<T extends TLShape>({ shape, util, }: {
    shape: T;
    util: ShapeUtil<T>;
}) => any>;
//# sourceMappingURL=Shape.d.ts.map
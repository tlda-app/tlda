import { TLGroupShape } from '@tldraw/tlschema';
import { Geometry2d } from '../../../primitives/geometry/Geometry2d';
import { ShapeUtil } from '../ShapeUtil';
/** @public */
export declare class GroupShapeUtil extends ShapeUtil<TLGroupShape> {
    static type: "group";
    static props: import("@tldraw/tlschema").RecordProps<TLGroupShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    hideSelectionBoundsFg(shape: TLGroupShape): boolean;
    canBind(): boolean;
    canResize(): boolean;
    canResizeChildren(): boolean;
    getDefaultProps(): TLGroupShape['props'];
    getGeometry(shape: TLGroupShape): Geometry2d;
    component(shape: TLGroupShape): import("react/jsx-runtime").JSX.Element | null;
    getIndicatorPath(shape: TLGroupShape): Path2D;
    onChildrenChange(group: TLGroupShape): void;
}
//# sourceMappingURL=GroupShapeUtil.d.ts.map
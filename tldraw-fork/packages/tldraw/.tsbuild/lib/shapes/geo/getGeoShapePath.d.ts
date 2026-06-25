import { TLGeoShape } from '@tldraw/editor';
import { PathBuilder } from '../shared/PathBuilder';
/**
 * Defines the behavior for a geo shape type. Every built-in geo type is
 * registered through this same interface (see {@link defaultGeoTypeDefinitions}),
 * and consumers can register additional types via
 * {@link @tldraw/tldraw#GeoShapeUtil.configure | GeoShapeUtil.configure()}.
 *
 * @public
 */
export interface GeoTypeDefinition {
    /**
     * Generate the path geometry for this geo type.
     *
     * @param w - The width of the shape (already clamped to min 1)
     * @param h - The height of the shape (already clamped to min 1, includes growY)
     * @param shape - The full geo shape record, for access to props like id, dash, fill, etc.
     * @param strokeWidth - The scaled stroke width (strokeWidth * scale)
     */
    getPath(w: number, h: number, shape: TLGeoShape, strokeWidth: number): PathBuilder;
    /** Snap behavior: 'polygon' snaps to vertices + center, 'blobby' snaps to center only. */
    snapType: 'polygon' | 'blobby';
    /** Default creation size when clicking (not dragging). Defaults to 200x200. */
    defaultSize?: {
        w: number;
        h: number;
    };
    /** Icon name for the style panel geo picker. */
    icon: string;
    /**
     * Optional double-click handler. Return an object with partial props to update the shape,
     * or void to do nothing.
     */
    onDoubleClick?(shape: TLGeoShape): {
        props: Partial<TLGeoShape['props']>;
    } | void;
}
/**
 * Built-in geo type definitions keyed by their `geo` prop value. Every default
 * geo type (rectangle, ellipse, cloud, etc.) is registered here. The same
 * registry powers path generation, handle snapping, the style panel picker,
 * and creation defaults — so custom types added through
 * {@link @tldraw/tldraw#GeoShapeUtil.configure | GeoShapeUtil.configure()} get
 * the same treatment as the built-ins.
 *
 * The key order here defines the visual order of items in the geo style panel
 * picker.
 *
 * @public
 */
export declare const defaultGeoTypeDefinitions: {
    readonly rectangle: {
        readonly snapType: "polygon";
        readonly icon: "geo-rectangle";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly ellipse: {
        readonly snapType: "blobby";
        readonly icon: "geo-ellipse";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly triangle: {
        readonly snapType: "polygon";
        readonly icon: "geo-triangle";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly diamond: {
        readonly snapType: "polygon";
        readonly icon: "geo-diamond";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly star: {
        readonly snapType: "polygon";
        readonly icon: "geo-star";
        readonly defaultSize: {
            readonly w: 200;
            readonly h: 190;
        };
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly pentagon: {
        readonly snapType: "polygon";
        readonly icon: "geo-pentagon";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly hexagon: {
        readonly snapType: "polygon";
        readonly icon: "geo-hexagon";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly octagon: {
        readonly snapType: "polygon";
        readonly icon: "geo-octagon";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly rhombus: {
        readonly snapType: "polygon";
        readonly icon: "geo-rhombus";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'rhombus-2': {
        readonly snapType: "polygon";
        readonly icon: "geo-rhombus-2";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly oval: {
        readonly snapType: "blobby";
        readonly icon: "geo-oval";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly trapezoid: {
        readonly snapType: "polygon";
        readonly icon: "geo-trapezoid";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'arrow-left': {
        readonly snapType: "polygon";
        readonly icon: "geo-arrow-left";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'arrow-up': {
        readonly snapType: "polygon";
        readonly icon: "geo-arrow-up";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'arrow-down': {
        readonly snapType: "polygon";
        readonly icon: "geo-arrow-down";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'arrow-right': {
        readonly snapType: "polygon";
        readonly icon: "geo-arrow-right";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly cloud: {
        readonly snapType: "blobby";
        readonly icon: "geo-cloud";
        readonly defaultSize: {
            readonly w: 300;
            readonly h: 180;
        };
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly 'x-box': {
        readonly snapType: "polygon";
        readonly icon: "geo-x-box";
        readonly getPath: (w: number, h: number, shape: TLGeoShape, strokeWidth: number) => PathBuilder;
    };
    readonly 'check-box': {
        readonly snapType: "polygon";
        readonly icon: "geo-check-box";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
    readonly heart: {
        readonly snapType: "blobby";
        readonly icon: "geo-heart";
        readonly getPath: (w: number, h: number, shape: TLGeoShape) => PathBuilder;
    };
};
/**
 * Look up a geo type definition by name, checking custom types first then
 * falling back to the built-in registry.
 *
 * @public
 */
export declare function getGeoTypeDefinition(name: string, customGeoTypes?: Record<string, GeoTypeDefinition>): GeoTypeDefinition | undefined;
export declare function getGeoShapePath(shape: TLGeoShape, strokeWidth: number, customGeoTypes?: Record<string, GeoTypeDefinition>): PathBuilder;
//# sourceMappingURL=getGeoShapePath.d.ts.map
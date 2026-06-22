import { TLAsset, TLAssetId, TLBinding, TLBindingCreate, TLBindingId, TLShape, TLShapeId, TLShapePartial } from '@tldraw/editor';
import React from 'react';
export { base64ToPoints, createDrawSegments, pointsToBase64 } from '../lib/utils/test-helpers';
interface CommonShapeProps {
    x?: number;
    y?: number;
    id?: TLShapeId;
    rotation?: number;
    isLocked?: number;
    ref?: string;
    children?: React.JSX.Element | React.JSX.Element[];
    opacity?: number;
}
type FormatShapeProps<Props extends object> = {
    [K in keyof Props]?: Props[K] extends TLAssetId ? TLAssetId | React.JSX.Element : Props[K] extends TLAssetId | null ? TLAssetId | React.JSX.Element | null : Props[K];
};
type PropsForShape<Type extends TLShape['type']> = CommonShapeProps & FormatShapeProps<TLShape<Type>['props']>;
interface BindingReactConnections {
    from?: string | TLShapeId;
    to: string | TLShapeId;
}
interface CommonBindingReactProps extends BindingReactConnections {
    ref?: string;
    id?: TLBindingId;
}
type ReactPropsForBinding<Type extends TLBinding['type']> = CommonBindingReactProps & Partial<TLBinding<Type>['props']>;
/**
 * TL - jsx helpers for creating tldraw shapes in test cases
 */
export declare const TL: {
    asset: {
        bookmark: (props: Partial<{
            title: string;
            description: string;
            image: string;
            favicon: string;
            src: string | null;
        }>) => null;
        image: (props: Partial<{
            w: number;
            h: number;
            name: string;
            isAnimated: boolean;
            mimeType: string | null;
            src: string | null;
            fileSize?: number | undefined;
            pixelRatio?: number | undefined;
        }>) => null;
        video: (props: Partial<{
            w: number;
            h: number;
            name: string;
            isAnimated: boolean;
            mimeType: string | null;
            src: string | null;
            fileSize?: number | undefined;
        }>) => null;
    } & Record<string, (props: Record<string, unknown>) => null>;
    binding: {
        arrow: (props: ReactPropsForBinding<"arrow">) => null;
        test: (props: ReactPropsForBinding<"test">) => null;
    };
} & {
    arrow: (props: PropsForShape<"arrow">) => null;
    bezier: (props: PropsForShape<"bezier">) => null;
    blorg: (props: PropsForShape<"blorg">) => null;
    bookmark: (props: PropsForShape<"bookmark">) => null;
    card: (props: PropsForShape<"card">) => null;
    "circle-clip": (props: PropsForShape<"circle-clip">) => null;
    draw: (props: PropsForShape<"draw">) => null;
    embed: (props: PropsForShape<"embed">) => null;
    frame: (props: PropsForShape<"frame">) => null;
    geo: (props: PropsForShape<"geo">) => null;
    group: (props: PropsForShape<"group">) => null;
    highlight: (props: PropsForShape<"highlight">) => null;
    image: (props: PropsForShape<"image">) => null;
    line: (props: PropsForShape<"line">) => null;
    "my-counter-shape": (props: PropsForShape<"my-counter-shape">) => null;
    "my-grid-shape": (props: PropsForShape<"my-grid-shape">) => null;
    "my-reject-shape": (props: PropsForShape<"my-reject-shape">) => null;
    myCustomShape: (props: PropsForShape<"myCustomShape">) => null;
    "not-visible-test-shape": (props: PropsForShape<"not-visible-test-shape">) => null;
    note: (props: PropsForShape<"note">) => null;
    test1: (props: PropsForShape<"test1">) => null;
    test2: (props: PropsForShape<"test2">) => null;
    text: (props: PropsForShape<"text">) => null;
    uncullable: (props: PropsForShape<"uncullable">) => null;
    video: (props: PropsForShape<"video">) => null;
} & Record<string, (props: CommonShapeProps & Record<string, unknown>) => null>;
export declare function shapesFromJsx(shapes: React.JSX.Element | Array<React.JSX.Element>, idPrefix?: string): {
    ids: Record<string, TLShapeId> & {
        bindings: Record<string, TLBindingId>;
    };
    shapes: TLShapePartial[];
    assets: TLAsset[];
    bindings: TLBindingCreate[];
};
//# sourceMappingURL=test-jsx.d.ts.map
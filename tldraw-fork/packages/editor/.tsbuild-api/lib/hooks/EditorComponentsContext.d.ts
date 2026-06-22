import { ComponentType, RefAttributes } from 'react';
import type { TLCanvasComponentProps } from '../components/default-components/DefaultCanvas';
import type { TLErrorFallbackComponent } from '../components/default-components/DefaultErrorFallback';
import type { TLGridProps } from '../components/default-components/DefaultGrid';
import type { TLSelectionBackgroundProps } from '../components/default-components/DefaultSelectionBackground';
import type { TLShapeErrorFallbackComponent } from '../components/default-components/DefaultShapeErrorFallback';
import type { TLShapeWrapperProps } from '../components/default-components/DefaultShapeWrapper';
/** @public */
export interface TLEditorComponents {
    Background?: ComponentType | null;
    Canvas?: ComponentType<TLCanvasComponentProps> | null;
    Grid?: ComponentType<TLGridProps> | null;
    InFrontOfTheCanvas?: ComponentType | null;
    LoadingScreen?: ComponentType | null;
    OnTheCanvas?: ComponentType | null;
    SelectionBackground?: ComponentType<TLSelectionBackgroundProps> | null;
    ShapeWrapper?: ComponentType<TLShapeWrapperProps & RefAttributes<HTMLDivElement>> | null;
    Spinner?: ComponentType<React.SVGProps<SVGSVGElement>> | null;
    SvgDefs?: ComponentType | null;
    ErrorFallback?: TLErrorFallbackComponent;
    ShapeErrorFallback?: TLShapeErrorFallbackComponent;
}
export declare const EditorComponentsContext: import("react").Context<null | Required<TLEditorComponents>>;
/** @public */
export declare function useEditorComponents(): Required<TLEditorComponents>;
//# sourceMappingURL=EditorComponentsContext.d.ts.map
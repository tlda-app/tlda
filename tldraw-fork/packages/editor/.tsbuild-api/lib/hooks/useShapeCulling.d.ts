import { TLShapeId } from '@tldraw/tlschema';
interface ShapeCullingContextValue {
    register(id: TLShapeId, container: HTMLDivElement, bgContainer: HTMLDivElement | null, isCulled: boolean): void;
    unregister(id: TLShapeId): void;
    updateCulling(culledShapes: Set<TLShapeId>): void;
}
/** @internal */
export interface ShapeCullingProviderProps {
    children: React.ReactNode;
}
/**
 * Provides centralized culling management for shape containers.
 * This allows a single reactor to update all shape display states
 * instead of each shape having its own subscription.
 *
 * @internal
 */
export declare function ShapeCullingProvider({ children }: ShapeCullingProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * Hook to access the shape culling context for container registration.
 *
 * @internal
 */
export declare function useShapeCulling(): ShapeCullingContextValue;
export {};
//# sourceMappingURL=useShapeCulling.d.ts.map
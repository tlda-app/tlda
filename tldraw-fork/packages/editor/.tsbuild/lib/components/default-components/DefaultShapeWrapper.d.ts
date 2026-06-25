import { TLShape } from '@tldraw/tlschema';
import { ReactNode } from 'react';
/** @public */
export interface TLShapeWrapperProps extends React.HTMLAttributes<HTMLDivElement> {
    /** The shape being rendered. */
    shape: TLShape;
    /** Whether this is the shapes regular, or background component. */
    isBackground: boolean;
    /** The shape's rendered component. */
    children: ReactNode;
}
/** @public @react */
export declare const DefaultShapeWrapper: import("react").ForwardRefExoticComponent<TLShapeWrapperProps & import("react").RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=DefaultShapeWrapper.d.ts.map
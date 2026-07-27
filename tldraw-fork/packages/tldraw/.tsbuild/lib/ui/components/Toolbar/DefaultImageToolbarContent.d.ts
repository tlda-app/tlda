import { TLImageShape } from '@tldraw/editor';
/** @public */
export interface DefaultImageToolbarContentProps {
    imageShapeId: TLImageShape['id'];
    isManipulating: boolean;
    onEditAltTextStart(): void;
    onManipulatingStart(): void;
    onManipulatingEnd(): void;
}
/** @public @react */
export declare const DefaultImageToolbarContent: import("react").NamedExoticComponent<DefaultImageToolbarContentProps>;
//# sourceMappingURL=DefaultImageToolbarContent.d.ts.map
import { TLPageId } from '@tldraw/editor';
/** @public */
export interface PageItemInputProps {
    name: string;
    id: TLPageId;
    isCurrentPage: boolean;
    onCancel(): void;
    onComplete?(): void;
}
/** @public @react */
export declare const PageItemInput: ({ name, id, isCurrentPage, onCancel, onComplete, }: PageItemInputProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PageItemInput.d.ts.map
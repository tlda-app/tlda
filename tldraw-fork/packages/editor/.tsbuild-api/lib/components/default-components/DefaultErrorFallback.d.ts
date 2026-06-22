import { ComponentType } from 'react';
import { Editor } from '../../editor/Editor';
/** @public */
export type TLErrorFallbackComponent = ComponentType<{
    editor?: Editor;
    error: unknown;
}>;
/** @public @react */
export declare const DefaultErrorFallback: TLErrorFallbackComponent;
//# sourceMappingURL=DefaultErrorFallback.d.ts.map
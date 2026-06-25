import { DebugFlag } from '@tldraw/editor';
import React from 'react';
/** @public */
export interface CustomDebugFlags {
    customDebugFlags?: Record<string, DebugFlag<boolean>>;
    customFeatureFlags?: Record<string, DebugFlag<boolean>>;
}
/** @public @react */
export declare function DefaultDebugMenuContent({ customDebugFlags, customFeatureFlags }: CustomDebugFlags): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface DebugFlagsProps {
    customDebugFlags?: Record<string, DebugFlag<boolean>> | undefined;
}
/** @public @react */
export declare function DebugFlags(props: DebugFlagsProps): import("react/jsx-runtime").JSX.Element | null;
/** @public */
export interface FeatureFlagsProps {
    customFeatureFlags?: Record<string, DebugFlag<boolean>> | undefined;
}
/** @public @react */
export declare function FeatureFlags(props: FeatureFlagsProps): import("react/jsx-runtime").JSX.Element | null;
/** @public */
export interface ExampleDialogProps {
    title?: string;
    body?: React.ReactNode;
    cancel?: string;
    confirm?: string;
    displayDontShowAgain?: boolean;
    maxWidth?: string;
    onCancel(): void;
    onContinue(): void;
}
/** @public @react */
export declare function ExampleDialog({ title, body, cancel, confirm, displayDontShowAgain, maxWidth, onCancel, onContinue }: ExampleDialogProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=DefaultDebugMenuContent.d.ts.map
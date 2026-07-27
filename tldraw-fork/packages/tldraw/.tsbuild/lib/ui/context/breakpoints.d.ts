import { ReactNode } from 'react';
/** @public */
export interface BreakPointProviderProps {
    forceMobile?: boolean;
    children: ReactNode;
}
/** @public @react */
export declare function BreakPointProvider({ forceMobile, children }: BreakPointProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useBreakpoint(): number;
//# sourceMappingURL=breakpoints.d.ts.map
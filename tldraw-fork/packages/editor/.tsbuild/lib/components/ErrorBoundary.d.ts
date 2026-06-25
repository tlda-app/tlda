import * as React from 'react';
import type { TLErrorFallbackComponent } from './default-components/DefaultErrorFallback';
/** @public */
export interface TLErrorBoundaryProps {
    children: React.ReactNode;
    onError?: ((error: unknown) => void) | null;
    fallback: TLErrorFallbackComponent;
}
/** @public */
export declare class ErrorBoundary extends React.Component<React.PropsWithChildren<TLErrorBoundaryProps>, {
    error: Error | null;
}> {
    static getDerivedStateFromError(error: Error): {
        error: Error;
    };
    state: {
        error: null;
    };
    componentDidCatch(error: unknown): void;
    render(): string | number | bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<React.ReactNode> | Promise<string | number | bigint | boolean | Iterable<React.ReactNode> | React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | React.ReactPortal | null | undefined> | null | undefined;
}
/** @internal */
export declare function OptionalErrorBoundary({ children, fallback, ...props }: Omit<TLErrorBoundaryProps, 'fallback'> & {
    fallback: TLErrorFallbackComponent;
}): string | number | bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<React.ReactNode> | Promise<string | number | bigint | boolean | Iterable<React.ReactNode> | React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | React.ReactPortal | null | undefined> | null | undefined;
//# sourceMappingURL=ErrorBoundary.d.ts.map
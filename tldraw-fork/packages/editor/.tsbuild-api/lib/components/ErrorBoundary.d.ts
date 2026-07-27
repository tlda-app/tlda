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
    render(): bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<React.ReactNode> | null | number | Promise<bigint | boolean | Iterable<React.ReactNode> | null | number | React.ReactElement<unknown, React.JSXElementConstructor<any> | string> | React.ReactPortal | string | undefined> | string | undefined;
}
/** @internal */
export declare function OptionalErrorBoundary({ children, fallback, ...props }: Omit<TLErrorBoundaryProps, 'fallback'> & {
    fallback: TLErrorFallbackComponent;
}): bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<React.ReactNode> | null | number | Promise<bigint | boolean | Iterable<React.ReactNode> | null | number | React.ReactElement<unknown, React.JSXElementConstructor<any> | string> | React.ReactPortal | string | undefined> | string | undefined;
//# sourceMappingURL=ErrorBoundary.d.ts.map
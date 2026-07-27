/** @public */
export interface ContainerProviderProps {
    container: HTMLElement;
    children: React.ReactNode;
}
/**
 * @public
 * @react
 */
export declare function ContainerProvider({ container, children }: ContainerProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useContainer(): HTMLElement;
/** @public */
export declare function useContainerIfExists(): HTMLElement | null;
//# sourceMappingURL=useContainer.d.ts.map
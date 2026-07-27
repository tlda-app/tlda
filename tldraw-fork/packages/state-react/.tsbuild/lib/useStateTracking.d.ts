/**
 * Wraps some synchronous react render logic in a reactive tracking context.
 *
 * This allows you to use reactive values transparently.
 *
 * See the `track` component wrapper, which uses this under the hood.
 *
 * @param name - A debug name for the reactive tracking context
 * @param render - The render function that accesses reactive values
 * @param deps - Optional dependency array to control when the tracking context is recreated
 * @returns The result of calling the render function
 *
 * @example
 * ```ts
 * function MyComponent() {
 *   return useStateTracking('MyComponent', () => {
 *     const editor = useEditor()
 *     return <div>Num shapes: {editor.getCurrentPageShapes().length}</div>
 *   })
 * }
 * ```
 *
 *
 * @public
 */
export declare function useStateTracking<T>(name: string, render: () => T, deps?: unknown[]): T;
//# sourceMappingURL=useStateTracking.d.ts.map
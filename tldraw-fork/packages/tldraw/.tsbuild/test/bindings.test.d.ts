declare const TEST_TYPE = "test";
declare module '@tldraw/tlschema' {
    interface TLGlobalBindingPropsMap {
        [TEST_TYPE]: Record<string, never>;
    }
}
export {};
//# sourceMappingURL=bindings.test.d.ts.map
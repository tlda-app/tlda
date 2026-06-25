declare const MY_CUSTOM_SHAPE_TYPE = "my-custom-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [MY_CUSTOM_SHAPE_TYPE]: {
            h: number;
            isFilled: boolean;
            text: string | undefined;
            w: number;
        };
    }
}
export {};
//# sourceMappingURL=Editor.test.d.ts.map
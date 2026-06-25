declare const MY_CUSTOM_SHAPE_TYPE = "my-custom-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [MY_CUSTOM_SHAPE_TYPE]: {
            w: number;
            h: number;
            text: string | undefined;
            isFilled: boolean;
        };
    }
}
export {};
//# sourceMappingURL=Editor.test.d.ts.map
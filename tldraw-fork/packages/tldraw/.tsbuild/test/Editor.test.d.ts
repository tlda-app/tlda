declare const BLORG_TYPE = "blorg";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [BLORG_TYPE]: {
            w: number;
            h: number;
        };
    }
}
declare const MY_CUSTOM_SHAPE_TYPE = "myCustomShape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [MY_CUSTOM_SHAPE_TYPE]: {
            w: number;
            h: number;
        };
    }
}
export {};
//# sourceMappingURL=Editor.test.d.ts.map
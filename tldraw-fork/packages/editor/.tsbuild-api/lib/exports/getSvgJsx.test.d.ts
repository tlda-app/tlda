declare const TEST_SHAPE_TYPE = "test-shape";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [TEST_SHAPE_TYPE]: {
            h: number;
            isContainer?: boolean;
            w: number;
            x: number;
            y: number;
        };
    }
}
export {};
//# sourceMappingURL=getSvgJsx.test.d.ts.map
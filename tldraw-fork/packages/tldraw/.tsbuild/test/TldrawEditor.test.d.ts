declare const CARD_TYPE = "card";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [CARD_TYPE]: {
            w: number;
            h: number;
        };
    }
}
export {};
//# sourceMappingURL=TldrawEditor.test.d.ts.map
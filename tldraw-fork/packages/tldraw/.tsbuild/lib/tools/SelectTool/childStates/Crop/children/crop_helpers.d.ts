import { Editor, ShapeWithCrop, Vec } from '@tldraw/editor';
export declare function getTranslateCroppedImageChange(editor: Editor, shape: ShapeWithCrop, delta: Vec): ({
    id: import("@tldraw/tlschema").TLShapeId;
    type: "image";
    props?: Partial<import("@tldraw/tlschema").TLImageShapeProps> | undefined;
    meta?: Partial<import("@tldraw/utils").JsonObject> | undefined;
} & Partial<Omit<import("@tldraw/tlschema").TLImageShape, "id" | "meta" | "props" | "type">>) | undefined;
//# sourceMappingURL=crop_helpers.d.ts.map
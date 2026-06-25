import { ExtractShapeByProps } from '@tldraw/editor';
import { TLUiDialogProps } from '../context/dialogs';
type ShapeWithUrl = ExtractShapeByProps<{
    url: string;
}>;
export declare const EditLinkDialog: import("react").NamedExoticComponent<TLUiDialogProps>;
export declare const EditLinkDialogInner: import("react").NamedExoticComponent<TLUiDialogProps & {
    selectedShape: ShapeWithUrl;
}>;
export {};
//# sourceMappingURL=EditLinkDialog.d.ts.map
import { TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
import { TLSvgExportOptions } from '../editor/types/misc-types';
export declare function exportToSvg(editor: Editor, shapeIds: TLShapeId[], opts?: TLSvgExportOptions): Promise<{
    height: number;
    svg: SVGSVGElement;
    trimPadding: number;
    width: number;
} | undefined>;
//# sourceMappingURL=exportToSvg.d.ts.map
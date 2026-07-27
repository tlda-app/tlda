import { ShapeWithCrop, TLCropInfo, TLImageShape, TLShapeCrop, TLShapeId } from '@tldraw/editor';
/** @internal */
export declare const MIN_CROP_SIZE = 8;
/** @public */
export interface CropBoxOptions {
    minWidth?: number;
    minHeight?: number;
}
/** @public */
export declare function getDefaultCrop(): TLShapeCrop;
/** @public */
export type ASPECT_RATIO_OPTION = 'original' | 'square' | 'circle' | 'landscape' | 'portrait' | 'wide';
/** @public */
export declare const ASPECT_RATIO_OPTIONS: ASPECT_RATIO_OPTION[];
/** @public */
export declare const ASPECT_RATIO_TO_VALUE: Record<ASPECT_RATIO_OPTION, number>;
/**
 * Original (uncropped) width and height of shape.
 *
 * @public
 */
export declare function getUncroppedSize(shapeSize: {
    w: number;
    h: number;
}, crop: TLShapeCrop | null): {
    w: number;
    h: number;
};
/** @public */
export declare function getCropBox<T extends ShapeWithCrop>(shape: T, info: TLCropInfo<T>, opts?: CropBoxOptions): {
    id: TLShapeId;
    type: T['type'];
    x: number;
    y: number;
    props: ShapeWithCrop['props'];
} | undefined;
interface CropChange {
    crop: {
        topLeft: {
            x: number;
            y: number;
        };
        bottomRight: {
            x: number;
            y: number;
        };
        isCircle?: boolean;
    };
    w: number;
    h: number;
    x: number;
    y: number;
}
/** @internal */
export declare const MAX_ZOOM = 3;
/**
 * Calculate new crop dimensions and position when zooming
 */
export declare function getCroppedImageDataWhenZooming(zoom: number, imageShape: TLImageShape, maxZoom?: number): CropChange;
/**
 * Calculate new crop dimensions and position when replacing an image
 */
export declare function getCroppedImageDataForReplacedImage(imageShape: TLImageShape, newImageWidth: number, newImageHeight: number): CropChange;
/**
 * Calculate new crop dimensions and position when changing aspect ratio
 */
export declare function getCroppedImageDataForAspectRatio(aspectRatioOption: ASPECT_RATIO_OPTION, imageShape: TLImageShape): CropChange;
export {};
//# sourceMappingURL=crop.d.ts.map
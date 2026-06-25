import { T } from '@tldraw/validate';
import { TLAssetId } from '../records/TLAsset';
import { RecordProps } from '../recordsWithProps';
import { TLShapeCrop } from './ShapeWithCrop';
import { TLBaseShape } from './TLBaseShape';
/**
 * Validator for image shape crop data. Defines the structure for cropping an image,
 * specifying the visible region within the original image bounds.
 *
 * @public
 * @example
 * ```ts
 * const cropData: TLShapeCrop = {
 *   topLeft: { x: 0.1, y: 0.1 },
 *   bottomRight: { x: 0.9, y: 0.9 },
 *   isCircle: false
 * }
 *
 * const isValid = ImageShapeCrop.isValid(cropData)
 * ```
 */
export declare const ImageShapeCrop: T.ObjectValidator<TLShapeCrop>;
/**
 * Properties for an image shape. Image shapes display raster images on the canvas,
 * with support for cropping, flipping, and asset management.
 *
 * @public
 * @example
 * ```ts
 * const imageProps: TLImageShapeProps = {
 *   w: 300,
 *   h: 200,
 *   playing: true,
 *   url: 'https://example.com/image.jpg',
 *   assetId: 'asset:image123',
 *   crop: null,
 *   flipX: false,
 *   flipY: false,
 *   altText: 'A sample image'
 * }
 * ```
 */
export interface TLImageShapeProps {
    /** Width of the image shape in canvas units */
    w: number;
    /** Height of the image shape in canvas units */
    h: number;
    /** Whether animated images (like GIFs) should play */
    playing: boolean;
    /** URL of the image resource */
    url: string;
    /** ID of the associated asset record, null if no asset */
    assetId: TLAssetId | null;
    /** Crop data defining visible region of the image, null for no cropping */
    crop: TLShapeCrop | null;
    /** Whether to flip the image horizontally */
    flipX: boolean;
    /** Whether to flip the image vertically */
    flipY: boolean;
    /** Alternative text for accessibility and when image fails to load */
    altText: string;
}
/**
 * An image shape representing a raster image on the canvas. Image shapes can display
 * various image formats and support features like cropping, flipping, and asset management.
 *
 * @public
 * @example
 * ```ts
 * const imageShape: TLImageShape = {
 *   id: 'shape:image1',
 *   type: 'image',
 *   x: 100,
 *   y: 100,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:main',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     w: 400,
 *     h: 300,
 *     playing: true,
 *     url: '',
 *     assetId: 'asset:photo1',
 *     crop: null,
 *     flipX: false,
 *     flipY: false,
 *     altText: 'Sample photo'
 *   },
 *   meta: {},
 *   typeName: 'shape'
 * }
 * ```
 */
export type TLImageShape = TLBaseShape<'image', TLImageShapeProps>;
/**
 * Validation schema for image shape properties. Defines the runtime validation rules
 * for all properties of image shapes, ensuring data integrity and type safety.
 *
 * @public
 * @example
 * ```ts
 * import { imageShapeProps } from '@tldraw/tlschema'
 *
 * // Used internally by the validation system
 * const validator = T.object(imageShapeProps)
 * const validatedProps = validator.validate(someImageProps)
 * ```
 */
export declare const imageShapeProps: RecordProps<TLImageShape>;
declare const Versions: {
    readonly AddUrlProp: "com.tldraw.shape.image/1";
    readonly AddCropProp: "com.tldraw.shape.image/2";
    readonly MakeUrlsValid: "com.tldraw.shape.image/3";
    readonly AddFlipProps: "com.tldraw.shape.image/4";
    readonly AddAltText: "com.tldraw.shape.image/5";
};
/**
 * Version identifiers for image shape migrations. These version numbers track
 * schema changes over time to enable proper data migration between versions.
 *
 * @public
 */
export { Versions as imageShapeVersions };
/**
 * Migration sequence for image shapes. Handles schema evolution over time by defining
 * how to upgrade and downgrade image shape data between different versions. Includes
 * migrations for URL properties, crop functionality, flip properties, and accessibility features.
 *
 * @public
 */
export declare const imageShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLImageShape.d.ts.map
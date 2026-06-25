/** @public */
export interface ErrorAnnotations {
    tags: Record<string, number | string | boolean | bigint | symbol | null | undefined>;
    extras: Record<string, unknown>;
}
/**
 * Annotate an error with tags and additional data. Annotations won't overwrite existing ones.
 * Retrieve them with `getErrorAnnotations`.
 *
 * @param error - The error object to annotate
 * @param annotations - Partial annotations to add (tags and/or extras)
 * @returns void
 * @example
 * ```ts
 * const error = new Error('Something went wrong')
 * annotateError(error, {
 *   tags: { userId: '123', operation: 'save' },
 *   extras: { timestamp: Date.now() }
 * })
 * ```
 *
 * @internal
 */
export declare function annotateError(error: unknown, annotations: Partial<ErrorAnnotations>): void;
/**
 * Retrieve annotations that have been added to an error object.
 *
 * @param error - The error object to get annotations from
 * @returns The error annotations (tags and extras) or empty objects if none exist
 * @example
 * ```ts
 * const error = new Error('Something went wrong')
 * annotateError(error, { tags: { userId: '123' } })
 * const annotations = getErrorAnnotations(error)
 * console.log(annotations.tags.userId) // '123'
 * ```
 *
 * @internal
 */
export declare function getErrorAnnotations(error: Error): ErrorAnnotations;
//# sourceMappingURL=error.d.ts.map
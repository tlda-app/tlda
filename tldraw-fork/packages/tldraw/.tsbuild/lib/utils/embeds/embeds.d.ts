import { TLEmbedDefinition } from '../../defaultEmbedDefinitions';
/** @public */
export declare function matchEmbedUrl(definitions: readonly TLEmbedDefinition[], url: string): {
    definition: TLEmbedDefinition;
    url: string;
    embedUrl: string;
} | undefined;
/** @public */
export declare function matchUrl(definitions: readonly TLEmbedDefinition[], url: string, embedConfig?: Record<string, unknown>): {
    definition: TLEmbedDefinition;
    embedUrl: string;
    url: string;
} | undefined;
/** @public */
export type TLEmbedResult = {
    definition: TLEmbedDefinition;
    url: string;
    embedUrl: string;
} | undefined;
/**
 * Tests whether an URL supports embedding and returns the result. If we encounter an error, we
 * return undefined.
 *
 * @param inputUrl - The URL to match
 * @param embedConfig - Optional per-embed config, keyed by embed type, passed to `toEmbedUrl`
 * @public
 */
export declare function getEmbedInfo(definitions: readonly TLEmbedDefinition[], inputUrl: string, embedConfig?: Record<string, unknown>): TLEmbedResult;
//# sourceMappingURL=embeds.d.ts.map
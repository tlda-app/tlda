import { T } from '@tldraw/validate';
/**
 * A user of tldraw
 *
 * @public
 */
export interface TLUserPreferences {
    id: string;
    name?: string | null;
    color?: string | null;
    locale?: string | null;
    animationSpeed?: number | null;
    areKeyboardShortcutsEnabled?: boolean | null;
    edgeScrollSpeed?: number | null;
    colorScheme?: 'light' | 'dark' | 'system';
    isSnapMode?: boolean | null;
    isWrapMode?: boolean | null;
    isDynamicSizeMode?: boolean | null;
    isPasteAtCursorMode?: boolean | null;
    enhancedA11yMode?: boolean | null;
    inputMode?: 'trackpad' | 'mouse' | null;
    isZoomDirectionInverted?: boolean | null;
}
/** @public */
export declare const userTypeValidator: T.Validator<TLUserPreferences>;
/** @internal */
export declare const USER_COLORS: readonly ["#FF802B", "#EC5E41", "#F2555A", "#F04F88", "#E34BA9", "#BD54C6", "#9D5BD2", "#7B66DC", "#02B1CC", "#11B3A3", "#39B178", "#55B467"];
/** @internal */
export declare function userPrefersReducedMotion(): boolean;
/** @public */
export declare const defaultUserPreferences: Readonly<{
    name: "";
    locale: "ar" | "bn" | "ca" | "cs" | "da" | "de" | "el" | "en" | "es" | "fa" | "fi" | "fr" | "gl" | "gu-in" | "he" | "hi-in" | "hr" | "hu" | "id" | "it" | "ja" | "km-kh" | "kn" | "ko-kr" | "ml" | "mr" | "ms" | "ne" | "nl" | "no" | "pa" | "pl" | "pt-br" | "pt-pt" | "ro" | "ru" | "sl" | "so" | "sv" | "ta" | "te" | "th" | "tl" | "tr" | "uk" | "ur" | "vi" | "zh-cn" | "zh-tw";
    color: "#02B1CC" | "#11B3A3" | "#39B178" | "#55B467" | "#7B66DC" | "#9D5BD2" | "#BD54C6" | "#E34BA9" | "#EC5E41" | "#F04F88" | "#F2555A" | "#FF802B";
    edgeScrollSpeed: 1;
    animationSpeed: 0 | 1;
    areKeyboardShortcutsEnabled: true;
    isSnapMode: false;
    isWrapMode: false;
    isDynamicSizeMode: false;
    isPasteAtCursorMode: false;
    enhancedA11yMode: false;
    colorScheme: "light";
    inputMode: null;
    isZoomDirectionInverted: false;
}>;
/** @public */
export declare function getFreshUserPreferences(): TLUserPreferences;
/** @public */
export declare function setUserPreferences(user: TLUserPreferences): void;
/** @public */
export declare function getUserPreferences(): TLUserPreferences;
//# sourceMappingURL=TLUserPreferences.d.ts.map
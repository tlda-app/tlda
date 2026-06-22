import { TLTheme, TLThemeId, TLThemes } from '@tldraw/tlschema';
import type { Editor } from '../../Editor';
/**
 * Resolve a partial set of user-provided themes into a complete `TLThemes`
 * record by merging with `DEFAULT_THEME`. The result is suitable for passing to
 * `registerColorsFromThemes`, `registerFontsFromThemes`, and the
 * `ThemeManager` constructor.
 *
 * @public
 */
export declare function resolveThemes(themes?: Partial<TLThemes>): TLThemes;
/**
 * Manages the editor's color themes.
 *
 * Stores named theme definitions (each containing light and dark color palettes
 * alongside shared properties like font size). The current theme is resolved by
 * combining the current theme name with the user's color mode preference.
 *
 * **Terminology:**
 * - **Theme** (`TLTheme`): A named set of colors and typographic values for both light and dark modes.
 * - **Color mode** (`'light' | 'dark'`): The resolved appearance mode, derived from the user's
 *   `colorScheme` preference (`'light' | 'dark' | 'system'`). Access via `getColorMode()`.
 *
 * @public
 */
export declare class ThemeManager {
    private readonly editor;
    private readonly _themes;
    private readonly _currentThemeId;
    constructor(editor: Editor, options: {
        initial: TLThemeId;
        themes: TLThemes;
    });
    /** Get the current color mode based on the user's dark mode preference. */
    getColorMode(): 'dark' | 'light';
    /** Get all registered theme definitions. */
    getThemes(): TLThemes;
    /** Get a single theme definition by id. */
    getTheme(id: TLThemeId): TLTheme | undefined;
    /** Get the id of the current theme. */
    getCurrentThemeId(): TLThemeId;
    getCurrentTheme(): TLTheme;
    /** Set the current theme by id. The theme must have been previously registered. */
    setCurrentTheme(id: TLThemeId): void;
    /** Replace all theme definitions, or update them via a callback that receives a deep copy. */
    updateThemes(themes: ((themes: TLThemes) => TLThemes) | TLThemes): void;
    /** Register or update a named theme definition. */
    updateTheme(theme: TLTheme): void;
    /** Clean up any resources held by the manager. */
    dispose(): void;
}
//# sourceMappingURL=ThemeManager.d.ts.map
import { TLUserId } from '@tldraw/tlschema';
import { TLCurrentUser } from '../../../config/createTLCurrentUser';
import { TLUserPreferences } from '../../../config/TLUserPreferences';
/** @public */
export declare class UserPreferencesManager {
    private readonly user;
    private readonly colorScheme;
    systemColorScheme: import("@tldraw/state").Atom<"dark" | "light", unknown>;
    disposables: Set<() => void>;
    dispose(): void;
    constructor(user: TLCurrentUser, colorScheme: 'light' | 'dark' | 'system');
    updateUserPreferences(userPreferences: Partial<TLUserPreferences>): void;
    getUserPreferences(): {
        id: string;
        name: string;
        locale: string;
        color: string;
        animationSpeed: number;
        areKeyboardShortcutsEnabled: boolean;
        isSnapMode: boolean;
        colorScheme: "dark" | "light" | "system" | undefined;
        isDarkMode: boolean;
        isWrapMode: boolean;
        isDynamicResizeMode: boolean;
        enhancedA11yMode: boolean;
        inputMode: "mouse" | "trackpad" | null;
        isZoomDirectionInverted: boolean;
    };
    getIsDarkMode(): boolean;
    /**
     * The speed at which the user can scroll by dragging toward the edge of the screen.
     */
    getEdgeScrollSpeed(): number;
    getAnimationSpeed(): number;
    getAreKeyboardShortcutsEnabled(): boolean;
    /**
     * The current user's raw, app-provided id — the value set in the user's
     * {@link @tldraw/editor#TLUserPreferences}. Use this when you need the id your application
     * assigned to the user. To compare against or look up store records, use
     * {@link UserPreferencesManager.getRecordId} instead.
     */
    getExternalId(): string;
    /**
     * @deprecated Use {@link UserPreferencesManager.getExternalId} for the raw app-provided id, or
     * {@link UserPreferencesManager.getRecordId} for the prefixed `TLUserId` record id.
     */
    getId(): string;
    /**
     * The current user's id as a tldraw {@link @tldraw/tlschema#TLUserId} record id (prefixed
     * with `user:`). Use this when comparing against or looking up store records, such as a
     * presence record's `userId` or `followingUserId`. For the raw, app-provided id, use
     * {@link UserPreferencesManager.getExternalId}.
     */
    getRecordId(): TLUserId;
    getName(): string;
    getLocale(): string;
    getColor(): string;
    getIsSnapMode(): boolean;
    getIsWrapMode(): boolean;
    getIsDynamicResizeMode(): boolean;
    getIsPasteAtCursorMode(): boolean;
    getEnhancedA11yMode(): boolean;
    getInputMode(): "mouse" | "trackpad" | null;
    getIsZoomDirectionInverted(): boolean;
}
//# sourceMappingURL=UserPreferencesManager.d.ts.map
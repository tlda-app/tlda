/** @public */
export declare const tlmenus: {
    /**
     * A set of strings representing any open menus. When menus are open,
     * certain interactions will behave differently; for example, when a
     * draw tool is selected and a menu is open, a pointer-down will not
     * create a dot (because the user is probably trying to close the menu)
     * however a pointer-down event followed by a drag will begin drawing
     * a line (because the user is BOTH trying to close the menu AND start
     * drawing a line).
     *
     * @public
     */
    menus: import("@tldraw/state").Atom<string[], unknown>;
    /**
     * Get the current open menus.
     *
     * @param contextId - An optional context to get menus for.
     *
     * @public
     */
    getOpenMenus(contextId?: string | undefined): string[];
    /**
     * Add an open menu.
     *
     * @example
     * ```ts
     * addOpenMenu('menu-id')
     * addOpenMenu('menu-id', myEditorId)
     * ```
     *
     * @param id - The id of the menu to add.
     * @param contextId - An optional context to add the menu to.
     *
     * @public
     */
    addOpenMenu(id: string, contextId?: string): void;
    /**
     * Delete an open menu.
     *
     * @example
     * ```ts
     * deleteOpenMenu('menu-id')
     * deleteOpenMenu('menu-id', myEditorId)
     * ```
     *
     * @param id - The id of the menu to delete.
     * @param contextId - An optional context to delete the menu from.
     *
     * @public
     */
    deleteOpenMenu(id: string, contextId?: string): void;
    /**
     * Clear all open menus.
     *
     * @example
     * ```ts
     * clearOpenMenus()
     * clearOpenMenus(myEditorId)
     * ```
     *
     * @param contextId - An optional context to clear menus for.
     *
     * @public
     */
    clearOpenMenus(contextId?: string | undefined): void;
    _hiddenMenus: string[];
    /**
     * Hide all open menus. Restore them with the `showOpenMenus` method.
     *
     * @example
     * ```ts
     * hideOpenMenus()
     * hideOpenMenus(myEditorId)
     * ```
     *
     * @param contextId - An optional context to hide menus for.
     *
     * @public
     */
    hideOpenMenus(contextId?: string | undefined): void;
    /**
     * Show all hidden menus.
     *
     * @example
     * ```ts
     * showOpenMenus()
     * showOpenMenus(myEditorId)
     * ```
     *
     * @param contextId - An optional context to show menus for.
     *
     * @public
     */
    showOpenMenus(contextId?: string | undefined): void;
    /**
     * Get whether a menu is open for a given context.
     *
     * @example
     * ```ts
     * isMenuOpem(id, myEditorId)
     * ```
     *
     * @param id - The id of the menu to check.
     * @param contextId - An optional context to check menus for.
     *
     * @public
     */
    isMenuOpen(id: string, contextId?: string | undefined): boolean;
    /**
     * Get whether any menus are open for a given context.
     *
     * @example
     * ```ts
     * hasOpenMenus(myEditorId)
     * ```
     *
     * @param contextId - A context to check menus for.
     *
     * @public
     */
    hasOpenMenus(contextId: string): boolean;
    /**
     * Get whether any menus are open for any context.
     *
     * @example
     * ```ts
     * hasAnyOpenMenus()
     * ```
     *
     * @public
     */
    hasAnyOpenMenus(): boolean;
    forContext(contextId: string): {
        getOpenMenus: () => string[];
        addOpenMenu: (id: string) => void;
        deleteOpenMenu: (id: string) => void;
        clearOpenMenus: () => void;
        isMenuOpen: (id: string) => boolean;
        hasOpenMenus: () => boolean;
        hasAnyOpenMenus: () => boolean;
    };
};
//# sourceMappingURL=menus.d.ts.map
/*!
 * The kbd-string splitter (`getKeys`) and the form-input filter pattern in `shouldSkipEvent`
 * (including its list of non-text INPUT types) are adapted from hotkeys-js, which this hook
 * previously depended on.
 *
 * MIT License: https://github.com/jaywcjlove/hotkeys-js/blob/master/LICENSE
 * Copyright (c) 2015-present, Kenny Wong
 * Copyright (c) 2011-2013 Thomas Fuchs (https://github.com/madrobby/keymaster)
 * Source: https://github.com/jaywcjlove/hotkeys-js
 */
import { Editor } from '@tldraw/editor';
/** @public */
export declare function useKeyboardShortcuts(): void;
export declare function areShortcutsDisabled(editor: Editor): {};
/**
 * @internal
 */
export interface ParsedKbd {
    key: string;
    shift: boolean;
    alt: boolean;
    ctrl: boolean;
    meta: boolean;
}
/**
 * @internal
 */
export declare function parseKbd(kbd: string): ParsedKbd[];
/**
 * The "raw" kbd here will look something like "a" or a combination of keys
 * "del,backspace". We need to first split them up by comma, then parse each
 * key to ensure backwards compatibility with the old kbd format. We used to
 * have symbols to denote cmd/alt/shift, using ! for shift, $ for cmd, and ?
 * for alt.
 *
 * @internal
 */
export declare function getHotkeysStringFromKbd(kbd: string): string;
//# sourceMappingURL=useKeyboardShortcuts.d.ts.map
import { TLPointerEventInfo } from '@tldraw/editor';
import { TLUiEventSource } from '../../../context/events';
import { TLUiIconJsx } from '../TldrawUiIcon';
/** @public */
export interface TLUiMenuItemProps<TranslationKey extends string = string, IconType extends string = string> {
    id: string;
    /**
     * The icon to display on the item. Icons are only shown in certain menu types.
     */
    icon?: IconType | TLUiIconJsx;
    /**
     * An icon to display to the left of the menu item.
     */
    iconLeft?: IconType | TLUiIconJsx;
    /**
     * The keyboard shortcut to display on the item.
     */
    kbd?: string;
    /**
     * The label to display on the item. If it's a string, it will be translated. If it's an object, the keys will be used as the language keys and the values will be translated.
     */
    label?: TranslationKey | {
        [key: string]: TranslationKey;
    };
    /**
     * If the editor is in readonly mode and the item is not marked as readonlyok, it will not be rendered.
     */
    readonlyOk?: boolean;
    /**
     * The function to call when the item is clicked.
     */
    onSelect(source: TLUiEventSource): Promise<void> | void;
    /**
     * Whether this item should be disabled.
     */
    disabled?: boolean;
    /**
     * Prevent the menu from closing when the item is clicked
     */
    noClose?: boolean;
    /**
     * Whether to show a spinner on the item.
     */
    spinner?: boolean;
    /**
     * Whether the item is selected.
     */
    isSelected?: boolean;
    /**
     * The function to call when the item is dragged. If this is provided, the item will be draggable.
     */
    onDragStart?(source: TLUiEventSource, info: TLPointerEventInfo): void;
}
/** @public @react */
export declare function TldrawUiMenuItem<TranslationKey extends string = string, IconType extends string = string>({ disabled, spinner, readonlyOk, id, kbd, label, icon, iconLeft, onSelect, noClose, isSelected, onDragStart }: TLUiMenuItemProps<TranslationKey, IconType>): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=TldrawUiMenuItem.d.ts.map
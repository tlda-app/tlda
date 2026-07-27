import { TLUiEventSource } from '../../../context/events';
import { TLUiIconJsx } from '../TldrawUiIcon';
/** @public */
export interface TLUiMenuCheckboxItemProps<TranslationKey extends string = string, IconType extends string = string> {
    icon?: IconType | TLUiIconJsx;
    id: string;
    kbd?: string;
    title?: string;
    label?: TranslationKey | {
        [key: string]: TranslationKey;
    };
    lang?: string;
    readonlyOk?: boolean;
    onSelect(source: TLUiEventSource): Promise<void> | void;
    toggle?: boolean;
    checked?: boolean;
    disabled?: boolean;
}
/** @public @react */
export declare function TldrawUiMenuCheckboxItem<TranslationKey extends string = string, IconType extends string = string>({ id, kbd, label, lang, readonlyOk, onSelect, toggle, disabled, checked }: TLUiMenuCheckboxItemProps<TranslationKey, IconType>): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=TldrawUiMenuCheckboxItem.d.ts.map
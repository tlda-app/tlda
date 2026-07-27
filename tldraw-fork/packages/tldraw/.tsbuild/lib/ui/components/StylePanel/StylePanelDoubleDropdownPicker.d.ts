import { SharedStyle, StyleProp } from '@tldraw/editor';
import * as React from 'react';
import { StyleValuesForUi } from '../../../styles';
import { TLUiTranslationKey } from '../../hooks/useTranslation/TLUiTranslationKey';
/** @public */
export interface StylePanelDoubleDropdownPickerProps<T extends string> {
    uiTypeA: string;
    uiTypeB: string;
    label: TLUiTranslationKey | Exclude<string, TLUiTranslationKey>;
    labelA: TLUiTranslationKey | Exclude<string, TLUiTranslationKey>;
    labelB: TLUiTranslationKey | Exclude<string, TLUiTranslationKey>;
    itemsA: StyleValuesForUi<T>;
    itemsB: StyleValuesForUi<T>;
    styleA: StyleProp<T>;
    styleB: StyleProp<T>;
    valueA: SharedStyle<T>;
    valueB: SharedStyle<T>;
    onValueChange?(style: StyleProp<T>, value: T): void;
}
/** @public @react */
export declare const StylePanelDoubleDropdownPicker: <T extends string>(props: StylePanelDoubleDropdownPickerProps<T>) => React.JSX.Element;
/** @public @react */
export declare const StylePanelDoubleDropdownPickerInline: <T extends string>(props: StylePanelDoubleDropdownPickerProps<T>) => React.JSX.Element;
//# sourceMappingURL=StylePanelDoubleDropdownPicker.d.ts.map
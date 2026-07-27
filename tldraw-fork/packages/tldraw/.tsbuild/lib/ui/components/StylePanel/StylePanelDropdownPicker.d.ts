import { SharedStyle, StyleProp } from '@tldraw/editor';
import * as React from 'react';
import { StyleValuesForUi } from '../../../styles';
import { TLUiTranslationKey } from '../../hooks/useTranslation/TLUiTranslationKey';
/** @public */
export interface StylePanelDropdownPickerProps<T extends string> {
    id: string;
    label?: TLUiTranslationKey | Exclude<string, TLUiTranslationKey>;
    uiType: string;
    stylePanelType: string;
    style: StyleProp<T>;
    value: SharedStyle<T>;
    items: StyleValuesForUi<T>;
    type: 'icon' | 'tool' | 'menu';
    onValueChange?(style: StyleProp<T>, value: T): void;
    /** Override the test ID prefix. Defaults to uiType. */
    testIdType?: string;
    /** Distance to push the popover left of the trigger so it lands flush with the style panel. */
    sideOffset?: number;
}
/** @public @react */
export declare const StylePanelDropdownPicker: <T extends string>(props: StylePanelDropdownPickerProps<T>) => React.JSX.Element;
/** @public @react */
export declare const StylePanelDropdownPickerInline: <T extends string>(props: StylePanelDropdownPickerProps<T>) => React.JSX.Element;
//# sourceMappingURL=StylePanelDropdownPicker.d.ts.map
import React from 'react';
/** @public */
export interface TLUiSliderProps {
    min?: number;
    steps: number;
    value: number | null;
    label: string;
    title: string;
    onValueChange(value: number): void;
    onHistoryMark?(id: string): void;
    'data-testid'?: string;
    ariaValueModifier?: number;
}
/** @public @react */
export declare const TldrawUiSlider: React.ForwardRefExoticComponent<TLUiSliderProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=TldrawUiSlider.d.ts.map
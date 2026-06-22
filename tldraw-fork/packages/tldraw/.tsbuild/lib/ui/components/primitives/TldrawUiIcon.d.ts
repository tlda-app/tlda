import { ReactElement } from 'react';
import { TLUiIconType } from '../../icon-types';
/** @public */
export type TLUiIconJsx = ReactElement<React.HTMLAttributes<HTMLDivElement>>;
/** @public */
export interface TLUiIconProps extends React.HTMLAttributes<HTMLDivElement> {
    icon: TLUiIconType | Exclude<string, TLUiIconType> | TLUiIconJsx;
    label: string;
    small?: boolean;
    tiny?: boolean;
    color?: string;
    children?: undefined;
    invertIcon?: boolean;
    crossOrigin?: 'anonymous' | 'use-credentials';
}
/** @public @react */
export declare const TldrawUiIcon: import("react").NamedExoticComponent<TLUiIconProps>;
//# sourceMappingURL=TldrawUiIcon.d.ts.map
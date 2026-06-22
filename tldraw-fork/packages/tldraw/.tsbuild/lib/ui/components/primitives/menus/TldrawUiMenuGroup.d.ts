import { ReactNode } from 'react';
/** @public */
export interface TLUiMenuGroupProps<TranslationKey extends string = string> {
    id: string;
    /**
     * The label to display on the item. If it's a string, it will be translated. If it's an object, the keys will be used as the language keys and the values will be translated.
     */
    label?: TranslationKey | {
        [key: string]: TranslationKey;
    };
    className?: string;
    children?: ReactNode;
}
/** @public @react */
export declare function TldrawUiMenuGroup({ id, label, className, children }: TLUiMenuGroupProps): string | number | bigint | boolean | import("react/jsx-runtime").JSX.Element | Iterable<ReactNode> | Promise<string | number | bigint | boolean | Iterable<ReactNode> | import("react").ReactElement<unknown, string | import("react").JSXElementConstructor<any>> | import("react").ReactPortal | null | undefined> | null | undefined;
//# sourceMappingURL=TldrawUiMenuGroup.d.ts.map
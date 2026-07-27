import { ReactNode } from 'react';
import { LicenseManager } from './LicenseManager';
/** @internal */
export declare const LicenseContext: import("react").Context<LicenseManager>;
/** @internal */
export declare function useLicenseContext(): LicenseManager;
/** @internal */
export declare const LICENSE_TIMEOUT = 5000;
/** @internal */
export declare function LicenseProvider({ licenseKey, children }: {
    children: ReactNode;
    licenseKey?: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=LicenseProvider.d.ts.map
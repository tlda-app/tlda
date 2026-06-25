export declare const FLAGS: {
    ANNUAL_LICENSE: number;
    EVALUATION_LICENSE: number;
    INTERNAL_LICENSE: number;
    NATIVE_LICENSE: number;
    PERPETUAL_LICENSE: number;
    WITH_WATERMARK: number;
};
export declare const PROPERTIES: {
    EXPIRY_DATE: number;
    FLAGS: number;
    HOSTS: number;
    ID: number;
};
/** @internal */
export interface LicenseInfo {
    id: string;
    hosts: string[];
    flags: number;
    expiryDate: string;
}
/** @internal */
export type LicenseState = 'expired' | 'licensed-with-watermark' | 'licensed' | 'pending' | 'unlicensed-production' | 'unlicensed';
/** @internal */
export type InvalidLicenseReason = 'has-key-development-mode' | 'invalid-license-key' | 'no-key-provided';
/** @internal */
export type LicenseFromKeyResult = InvalidLicenseKeyResult | ValidLicenseKeyResult;
/** @internal */
export interface InvalidLicenseKeyResult {
    isLicenseParseable: false;
    reason: InvalidLicenseReason;
}
/** @internal */
export interface ValidLicenseKeyResult {
    isLicenseParseable: true;
    license: LicenseInfo;
    isDevelopment: boolean;
    isDomainValid: boolean;
    expiryDate: Date;
    isAnnualLicense: boolean;
    isAnnualLicenseExpired: boolean;
    isPerpetualLicense: boolean;
    isPerpetualLicenseExpired: boolean;
    isInternalLicense: boolean;
    isNativeLicense: boolean;
    isLicensedWithWatermark: boolean;
    isEvaluationLicense: boolean;
    isEvaluationLicenseExpired: boolean;
    daysSinceExpiry: number;
}
/** @internal */
export type TrackType = 'evaluation' | 'unlicensed' | 'with_watermark' | null;
/** @internal */
export declare class LicenseManager {
    private publicKey;
    isDevelopment: boolean;
    isTest: boolean;
    isCryptoAvailable: boolean;
    state: import("@tldraw/state").Atom<LicenseState, unknown>;
    verbose: boolean;
    constructor(licenseKey: string | undefined, testPublicKey?: string);
    private getIsDevelopment;
    private getTrackType;
    private maybeTrack;
    private extractLicenseKey;
    getLicenseFromKey(licenseKey?: string): Promise<LicenseFromKeyResult>;
    private isDomainValid;
    private isNativeLicense;
    private getExpirationDateWithoutGracePeriod;
    private getExpirationDateWithGracePeriod;
    private isAnnualLicenseExpired;
    private isPerpetualLicenseExpired;
    private getDaysSinceExpiry;
    private isEvaluationLicenseExpired;
    private isFlagEnabled;
    private outputNoLicenseKeyProvided;
    private outputInvalidLicenseKey;
    private outputLicenseInfoIfNeeded;
    private outputMessages;
    private outputDelimiter;
    static className: string;
}
export declare function getLicenseState(result: LicenseFromKeyResult, outputMessages: (messages: string[]) => void, isDevelopment: boolean): LicenseState;
//# sourceMappingURL=LicenseManager.d.ts.map
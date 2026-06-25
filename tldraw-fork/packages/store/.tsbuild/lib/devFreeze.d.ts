/**
 * Freeze an object when in development mode. Copied from
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze
 *
 * @example
 *
 * ```ts
 * const frozen = devFreeze({ a: 1 })
 * ```
 *
 * @param object - The object to freeze.
 * @returns The frozen object when in development mode, or else the object when in other modes.
 * @public
 */
export declare function devFreeze<T>(object: T): T;
//# sourceMappingURL=devFreeze.d.ts.map
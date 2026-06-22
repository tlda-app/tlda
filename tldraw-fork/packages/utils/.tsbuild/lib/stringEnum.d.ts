/**
 * Creates an enum-like object from string values where each key maps to itself.
 * Useful for creating string constant objects with type safety and autocompletion.
 * @param values - The string values to create the enum from.
 * @returns An object where each provided string is both the key and value.
 * @example
 * ```ts
 * const Colors = stringEnum('red', 'green', 'blue')
 * // Results in: { red: 'red', green: 'green', blue: 'blue' }
 *
 * // Type-safe usage
 * function setColor(color: keyof typeof Colors) {
 *   console.log(`Setting color to ${Colors[color]}`)
 * }
 *
 * setColor('red') // ✓ Valid
 * setColor('yellow') // ✗ TypeScript error
 * ```
 * @internal
 */
export declare function stringEnum<T extends string>(...values: T[]): {
    [K in T]: K;
};
//# sourceMappingURL=stringEnum.d.ts.map
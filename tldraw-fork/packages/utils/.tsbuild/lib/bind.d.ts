/*!
 * MIT License: https://github.com/NoHomey/bind-decorator/blob/master/License
 * Copyright (c) 2016 Ivo Stratev
 */
/**
 * Decorator that binds a method to its class instance (legacy stage-2 TypeScript decorators).
 * When applied to a class method, ensures `this` always refers to the class instance,
 * even when the method is called as a callback or event handler.
 *
 * @param target - The prototype of the class being decorated
 * @param propertyKey - The name of the method being decorated
 * @param descriptor - The property descriptor for the method being decorated
 * @returns The modified property descriptor with bound method access
 * @example
 * ```typescript
 * class MyClass {
 *   name = 'example';
 *
 *   @bind
 *   getName() {
 *     return this.name;
 *   }
 * }
 *
 * const instance = new MyClass();
 * const callback = instance.getName;
 * console.log(callback()); // 'example' (this is properly bound)
 * ```
 * @public
 */
export declare function bind<T extends (...args: any[]) => any>(target: object, propertyKey: string, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T>;
/**
 * Decorator that binds a method to its class instance (TC39 decorators standard).
 * When applied to a class method, ensures `this` always refers to the class instance,
 * even when the method is called as a callback or event handler.
 *
 * @param originalMethod - The original method being decorated
 * @param context - The decorator context containing metadata about the method
 * @example
 * ```typescript
 * class EventHandler {
 *   message = 'Hello World';
 *
 *   @bind
 *   handleClick() {
 *     console.log(this.message);
 *   }
 * }
 *
 * const handler = new EventHandler();
 * document.addEventListener('click', handler.handleClick); // 'this' is properly bound
 * ```
 * @public
 */
export declare function bind<This extends object, T extends (...args: any[]) => any>(originalMethod: T, context: ClassMethodDecoratorContext<This, T>): void;
//# sourceMappingURL=bind.d.ts.map
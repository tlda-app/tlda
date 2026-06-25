import { IdOf, UnknownRecord } from './BaseRecord';
import { StoreQueries } from './StoreQueries';
/**
 * Defines matching criteria for query values. Supports equality, inequality, and greater-than comparisons.
 *
 * @example
 * ```ts
 * // Exact match
 * const exactMatch: QueryValueMatcher<string> = { eq: 'Science Fiction' }
 *
 * // Not equal to
 * const notMatch: QueryValueMatcher<string> = { neq: 'Romance' }
 *
 * // Greater than (numeric values only)
 * const greaterThan: QueryValueMatcher<number> = { gt: 2020 }
 * ```
 *
 * @public
 */
export type QueryValueMatcher<T> = {
    eq: T;
} | {
    neq: T;
} | {
    gt: number;
};
/**
 * Query expression for filtering records by their property values. Maps record property names
 * to matching criteria.
 *
 * @example
 * ```ts
 * // Query for books published after 2020 that are in stock
 * const bookQuery: QueryExpression<Book> = {
 *   publishedYear: { gt: 2020 },
 *   inStock: { eq: true }
 * }
 *
 * // Query for books not by a specific author
 * const notByAuthor: QueryExpression<Book> = {
 *   authorId: { neq: 'author:tolkien' }
 * }
 *
 * // Query with nested properties
 * const nestedQuery: QueryExpression<Book> = {
 *   metadata: { sessionId: { eq: 'session:alpha' } }
 * }
 * ```
 *
 * @public
 */
/** @public */
export type QueryExpression<R extends object> = {
    [k in keyof R & string]?: R[k] extends string | number | boolean | null | undefined ? QueryValueMatcher<R[k]> : R[k] extends object ? QueryExpression<R[k]> : QueryValueMatcher<R[k]>;
};
export declare function objectMatchesQuery<T extends object>(query: QueryExpression<T>, object: T): boolean;
/**
 * Executes a query against the store using reactive indexes to efficiently find matching record IDs.
 * Uses the store's internal indexes for optimal performance, especially for equality matches.
 *
 * @param store - The store queries interface providing access to reactive indexes
 * @param typeName - The type name of records to query (e.g., 'book', 'author')
 * @param query - Query expression defining the matching criteria
 * @returns A Set containing the IDs of all records that match the query criteria
 *
 * @example
 * ```ts
 * // Find IDs of all books published after 2020 that are in stock
 * const bookIds = executeQuery(store, 'book', {
 *   publishedYear: { gt: 2020 },
 *   inStock: { eq: true }
 * })
 *
 * // Find IDs of books not by a specific author
 * const otherBookIds = executeQuery(store, 'book', {
 *   authorId: { neq: 'author:tolkien' }
 * })
 *
 * // Query with nested properties
 * const nestedQueryIds = executeQuery(store, 'book', {
 *   metadata: { sessionId: { eq: 'session:alpha' } }
 * })
 * ```
 *
 * @public
 */
export declare function executeQuery<R extends UnknownRecord, TypeName extends R['typeName']>(store: StoreQueries<R>, typeName: TypeName, query: QueryExpression<Extract<R, {
    typeName: TypeName;
}>>): Set<IdOf<Extract<R, {
    typeName: TypeName;
}>>>;
//# sourceMappingURL=executeQuery.d.ts.map
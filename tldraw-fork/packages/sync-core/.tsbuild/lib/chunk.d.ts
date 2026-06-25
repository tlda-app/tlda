/**
 * Splits a string into smaller chunks suitable for transmission over WebSockets.
 * This function ensures messages don't exceed size limits imposed by platforms like Cloudflare Workers (1MB max).
 * Each chunk is prefixed with a number indicating how many more chunks follow.
 *
 * @param msg - The string to split into chunks
 * @param maxSafeMessageSize - Maximum safe size for each chunk in characters. Defaults to quarter megabyte to account for UTF-8 encoding
 * @returns Array of chunked strings, each prefixed with "\{number\}_" where number indicates remaining chunks
 *
 * @example
 * ```ts
 * // Small message - returns as single chunk
 * chunk('hello world') // ['hello world']
 *
 * // Large message - splits into multiple chunks
 * chunk('very long message...', 10)
 * // ['2_very long', '1_ message', '0_...']
 * ```
 *
 * @internal
 */
export declare function chunk(msg: string, maxSafeMessageSize?: number): string[];
/**
 * Assembles chunked JSON messages back into complete objects.
 * Handles both regular JSON messages and chunked messages created by the chunk() function.
 * Maintains internal state to track partially received chunked messages.
 *
 * @example
 * ```ts
 * const assembler = new JsonChunkAssembler()
 *
 * // Handle regular JSON message
 * const result1 = assembler.handleMessage('{"hello": "world"}')
 * // Returns: { data: { hello: "world" }, stringified: '{"hello": "world"}' }
 *
 * // Handle chunked message
 * assembler.handleMessage('1_hello') // Returns: null (partial)
 * const result2 = assembler.handleMessage('0_ world')
 * // Returns: { data: "hello world", stringified: "hello world" }
 * ```
 *
 * @public
 */
export declare class JsonChunkAssembler {
    /**
     * Current assembly state - either 'idle' or tracking chunks being received
     */
    state: 'idle' | {
        chunksReceived: string[];
        totalChunks: number;
    };
    /**
     * Processes a single message, which can be either a complete JSON object or a chunk.
     * For complete JSON objects (starting with '\{'), parses immediately.
     * For chunks (prefixed with "\{number\}_"), accumulates until all chunks received.
     *
     * @param msg - The message to process, either JSON or chunk format
     * @returns Result object with data/stringified on success, error object on failure, or null for incomplete chunks
     * 	- `\{ data: object, stringified: string \}` - Successfully parsed complete message
     * 	- `\{ error: Error \}` - Parse error or invalid chunk sequence
     * 	- `null` - Chunk received but more chunks expected
     *
     * @example
     * ```ts
     * const assembler = new JsonChunkAssembler()
     *
     * // Complete JSON message
     * const result = assembler.handleMessage('{"key": "value"}')
     * if (result && 'data' in result) {
     *   console.log(result.data) // { key: "value" }
     * }
     *
     * // Chunked message sequence
     * assembler.handleMessage('2_hel') // null - more chunks expected
     * assembler.handleMessage('1_lo ') // null - more chunks expected
     * assembler.handleMessage('0_wor') // { data: "hello wor", stringified: "hello wor" }
     * ```
     */
    handleMessage(msg: string): {
        error: Error;
    } | {
        stringified: string;
        data: object;
    } | null;
}
//# sourceMappingURL=chunk.d.ts.map
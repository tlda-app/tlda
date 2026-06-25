import { StoreSchema, UnknownRecord } from '@tldraw/store';
import { InMemorySyncStorage } from '../lib/InMemorySyncStorage';
import { RoomSnapshot, TLSyncRoom } from '../lib/TLSyncRoom';
import { TestSocketPair } from './TestSocketPair';
export declare class TestServer<R extends UnknownRecord, P = unknown> {
    room: TLSyncRoom<R, undefined>;
    storage: InMemorySyncStorage<R>;
    constructor(schema: StoreSchema<R, P>, snapshot?: RoomSnapshot);
    connect(socketPair: TestSocketPair<R>): void;
    flushDebouncingMessages(): void;
}
//# sourceMappingURL=TestServer.d.ts.map
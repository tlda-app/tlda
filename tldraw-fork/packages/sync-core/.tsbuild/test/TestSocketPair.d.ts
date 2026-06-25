import { UnknownRecord } from '@tldraw/store';
import { TLSocketClientSentEvent, TLSocketServerSentEvent } from '../lib/protocol';
import { TLPersistentClientSocket, TLSocketStatusListener } from '../lib/TLSyncClient';
import { TLRoomSocket } from '../lib/TLSyncRoom';
import { TestServer } from './TestServer';
export declare class TestSocketPair<R extends UnknownRecord> {
    readonly id: string;
    readonly server: TestServer<R>;
    clientSentEventQueue: TLSocketClientSentEvent<R>[];
    serverSentEventQueue: TLSocketServerSentEvent<R>[];
    flushServerSentEvents(): void;
    flushClientSentEvents(): void;
    flushAllEvents(): Promise<void>;
    getNeedsFlushing(): boolean;
    roomSocket: TLRoomSocket<R>;
    didReceiveFromClient?: (msg: TLSocketClientSentEvent<R>) => void;
    clientDisconnected?: () => void;
    clientSocket: TLPersistentClientSocket<TLSocketClientSentEvent<R>, TLSocketServerSentEvent<R>>;
    callbacks: {
        onReceiveMessage: ((msg: TLSocketServerSentEvent<R>) => void) | null;
        onStatusChange: TLSocketStatusListener | null;
    };
    get isConnected(): boolean;
    connect(): void;
    disconnect(code?: number, reason?: string): void;
    constructor(id: string, server: TestServer<R>);
}
//# sourceMappingURL=TestSocketPair.d.ts.map
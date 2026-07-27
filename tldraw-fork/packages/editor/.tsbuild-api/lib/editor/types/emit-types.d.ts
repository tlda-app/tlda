import { HistoryEntry } from '@tldraw/store';
import { BoxModel, TLPageId, TLRecord, TLShapeId } from '@tldraw/tlschema';
import { TLEventInfo } from './event-types';
/** @public */
export interface TLEventMap {
    mount: [];
    'max-shapes': [{
        count: number;
        name: string;
        pageId: TLPageId;
    }];
    change: [HistoryEntry<TLRecord>];
    update: [];
    crash: [{
        error: unknown;
    }];
    'stop-camera-animation': [];
    'stop-following': [];
    'before-event': [TLEventInfo];
    event: [TLEventInfo];
    tick: [number];
    frame: [number];
    resize: [BoxModel];
    'select-all-text': [{
        shapeId: TLShapeId;
    }];
    'place-caret': [{
        point: {
            x: number;
            y: number;
        };
        shapeId: TLShapeId;
    }];
    'created-shapes': [TLRecord[]];
    'edited-shapes': [TLRecord[]];
    'deleted-shapes': [TLShapeId[]];
    edit: [];
    dispose: [];
}
/** @public */
export type TLEventMapHandler<T extends keyof TLEventMap> = (...args: TLEventMap[T]) => void;
//# sourceMappingURL=emit-types.d.ts.map
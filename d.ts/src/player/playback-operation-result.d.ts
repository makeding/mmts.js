import { type PlaybackOperation } from '../core/playback-operation';
export type PlaybackOperationProgressStatus = 'queued' | 'running' | 'retrying' | 'recovering';
export type PlaybackOperationTerminalStatus = 'committed' | 'no-op' | 'cancelled' | 'superseded' | 'failed';
export type PlaybackOperationStatus = PlaybackOperationProgressStatus | PlaybackOperationTerminalStatus;
export type PlaybackOperationEvent = {
    operation: PlaybackOperation;
    scopeId: string;
    transactionKey: string;
    attemptKey: string;
    timelineGeneration: number;
    transactionId: number;
    attempt: number;
    kind: PlaybackOperation['kind'];
    phase: string;
    status: PlaybackOperationStatus;
    terminal: boolean;
    requestedPacketId?: number;
    committedPacketId?: number;
    requestedTimeMilliseconds: number;
    committedTimeMilliseconds?: number;
    reason?: string;
    error?: any;
};
export type PlaybackOperationResult = PlaybackOperationEvent & {
    status: PlaybackOperationTerminalStatus;
    terminal: true;
};
export type PlaybackOperationProgressDetails = {
    reason?: string;
};
export type PlaybackOperationSettleDetails = {
    reason?: string;
    error?: any;
    committedPacketId?: number;
    committedTimeMilliseconds?: number;
};
export declare function isPlaybackOperationTerminalStatus(status: PlaybackOperationStatus): status is PlaybackOperationTerminalStatus;
export declare function isPlaybackOperationStatus(value: any): value is PlaybackOperationStatus;
export declare function isPlaybackOperationEvent(value: any): value is PlaybackOperationEvent;
export declare function createPlaybackOperationEvent(operation: PlaybackOperation, status: PlaybackOperationStatus, details?: PlaybackOperationSettleDetails): PlaybackOperationEvent;
export default class PlaybackOperationResultRegistry {
    private _pending;
    private _emit;
    constructor(emit: (event: PlaybackOperationEvent) => void);
    register(operation: PlaybackOperation, initialStatus?: PlaybackOperationProgressStatus, reason?: string | PlaybackOperationProgressDetails): Promise<PlaybackOperationResult>;
    has(operationOrKey: PlaybackOperation | string): boolean;
    promiseFor(operationOrKey: PlaybackOperation | string): Promise<PlaybackOperationResult> | null;
    /**
     * Replace an attempt-zero reservation before it enters the async pipeline.
     * Queue wait time may change the execution timestamp, but the transaction
     * key and Promise must remain stable.
     */
    replaceReservation(operation: PlaybackOperation): boolean;
    publish(operation: PlaybackOperation, status: PlaybackOperationProgressStatus, details?: string | PlaybackOperationProgressDetails): PlaybackOperationEvent | null;
    markRunning(operation: PlaybackOperation, reason?: string): void;
    canAdoptAttempt(operation: PlaybackOperation): boolean;
    adoptAttempt(operation: PlaybackOperation, reason?: string): boolean;
    settle(operation: PlaybackOperation, status: PlaybackOperationTerminalStatus, details?: PlaybackOperationSettleDetails): PlaybackOperationResult | null;
    /** Consume a result produced by a Dedicated Worker. */
    acceptExternal(event: PlaybackOperationEvent): boolean;
    destroy(reason?: string): void;
    cancelAll(reason?: string): void;
    static immediate(operation: PlaybackOperation, status: PlaybackOperationTerminalStatus, details?: PlaybackOperationSettleDetails): Promise<PlaybackOperationResult>;
    private _canAccept;
    private _makeEvent;
}

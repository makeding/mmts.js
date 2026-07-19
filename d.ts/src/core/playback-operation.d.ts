export type PlaybackOperationKind = 'startup' | 'seek' | 'audio-switch' | 'video-switch';
/**
 * Immutable identity and payload for one asynchronous playback attempt.
 *
 * transactionKey identifies the user's intent across retries.
 * attemptKey identifies one concrete execution of that intent.
 * phase is progress only and is deliberately excluded from identity checks.
 */
export type PlaybackOperation = {
    scopeId: string;
    transactionKey: string;
    attemptKey: string;
    timelineGeneration: number;
    kind: PlaybackOperationKind;
    transactionId: number;
    attempt: number;
    phase: string;
    /** Original intent time, stable across retries. */
    intentTimeMicroseconds: number;
    /** Time used by this attempt. */
    requestedTimeMicroseconds: number;
    /** Compatibility projection. Always requestedTimeMicroseconds / 1000. */
    requestedTimeMilliseconds: number;
    packetId?: number;
};
export type PlaybackOperationCreateOptions = {
    scopeId: string;
    timelineGeneration: number;
    kind: PlaybackOperationKind;
    transactionId: number;
    requestedTimeMilliseconds: number;
    packetId?: number;
    phase?: string;
};
export type PlaybackOperationRetryOptions = {
    requestedTimeMilliseconds?: number;
    phase?: string;
};
export type PlaybackOperationReservationChanges = {
    requestedTimeMilliseconds?: number;
    packetId?: number;
    phase?: string;
};
export type PlaybackSwitchIdentity = {
    scopeId: string;
    transactionKey: string;
    attemptKey: string;
    kind: 'audio-switch' | 'video-switch';
    /** Legacy alias retained in media metadata and logs. */
    id: number;
    transactionId: number;
    attempt: number;
};
export type PlaybackOperationAdvance = {
    accepted: true;
    kind: 'first-operation' | 'same-attempt' | 'next-attempt' | 'next-transaction';
} | {
    accepted: false;
    kind: 'rejected';
    reason: string;
};
export type PlaybackOperationRetryReason = 'mmts-vod-seek-lookback';
/**
 * Serializable request emitted by a playback participant when the current
 * attempt cannot continue without a new owner-authorized attempt.
 *
 * The request identifies the source attempt, but deliberately does not carry
 * or manufacture the next attempt.  Only the PlayerEngine transaction owner
 * is allowed to call createNextPlaybackAttempt().
 */
export type PlaybackOperationRetryRequest = {
    requestId: string;
    reason: PlaybackOperationRetryReason;
    sourceTransactionKey: string;
    sourceAttemptKey: string;
    sourceTimelineGeneration: number;
    sourceTransactionId: number;
    sourceAttempt: number;
    segmentIndex: number;
    requestedTimeMicroseconds: number;
    requestedTimeMilliseconds: number;
    filePosition: number;
    estimatedPosition: number;
    lookbackBytes: number;
};
export declare function createPlaybackScopeId(prefix?: string): string;
export declare function createPlaybackOperation(options: PlaybackOperationCreateOptions): PlaybackOperation;
export declare function createNextPlaybackAttempt(operation: PlaybackOperation, options?: PlaybackOperationRetryOptions): PlaybackOperation;
/** Update progress without changing attempt identity. */
export declare function withPlaybackOperationPhase(operation: PlaybackOperation, phase: string): PlaybackOperation;
/**
 * Rebind a reserved attempt-zero operation before it enters an asynchronous
 * pipeline. Used for queued track requests and pre-reserved recovery work.
 */
export declare function rebindReservedPlaybackOperation(operation: PlaybackOperation, changes: PlaybackOperationReservationChanges): PlaybackOperation;
/**
 * Whether an attempt-zero reservation may be replaced before any asynchronous
 * participant has observed it.  Only execution time and phase may change.
 */
export declare function canReplacePlaybackOperationReservation(current: PlaybackOperation, next: PlaybackOperation): boolean;
export declare function isPlaybackOperation(value: any): value is PlaybackOperation;
export declare function isPlaybackOperationRetryRequest(value: any, sourceOperation?: PlaybackOperation | null): value is PlaybackOperationRetryRequest;
export declare function clonePlaybackOperation(operation: PlaybackOperation): PlaybackOperation;
export declare function isSamePlaybackTransaction(left: PlaybackOperation, right: PlaybackOperation): boolean;
export declare function isSamePlaybackAttempt(left: PlaybackOperation, right: PlaybackOperation): boolean;
/** Phase is progress, not identity. */
export declare function isSamePlaybackOperation(left: PlaybackOperation, right: PlaybackOperation): boolean;
export declare function isSamePlaybackOperationPhase(left: PlaybackOperation, right: PlaybackOperation): boolean;
export declare function classifyPlaybackOperationAdvance(current: PlaybackOperation | null | undefined, next: PlaybackOperation): PlaybackOperationAdvance;
export declare function canAdvancePlaybackOperation(current: PlaybackOperation | null | undefined, next: PlaybackOperation): boolean;
export declare function createPlaybackSwitchIdentity(operation: PlaybackOperation): PlaybackSwitchIdentity;
export declare function isPlaybackSwitchIdentity(value: any): value is PlaybackSwitchIdentity;
export declare function doesPlaybackSwitchIdentityMatchOperation(identity: any, operation: PlaybackOperation): boolean;

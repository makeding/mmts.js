export type PlaybackOperationKind = 'startup' | 'seek' | 'audio-switch' | 'video-switch';

/**
 * Immutable identity and payload for one asynchronous playback attempt.
 *
 * transactionKey identifies the user's intent across retries.
 * attemptKey identifies one concrete execution of that intent.
 * phase is progress only and is deliberately excluded from identity checks.
 */
export type PlaybackOperation = {
    scopeId: string,
    transactionKey: string,
    attemptKey: string,
    timelineGeneration: number,
    kind: PlaybackOperationKind,
    transactionId: number,
    attempt: number,
    phase: string,
    /** Original intent time, stable across retries. */
    intentTimeMicroseconds: number,
    /** Time used by this attempt. */
    requestedTimeMicroseconds: number,
    /** Compatibility projection. Always requestedTimeMicroseconds / 1000. */
    requestedTimeMilliseconds: number,
    packetId?: number,
};

export type PlaybackOperationCreateOptions = {
    scopeId: string,
    timelineGeneration: number,
    kind: PlaybackOperationKind,
    transactionId: number,
    requestedTimeMilliseconds: number,
    packetId?: number,
    phase?: string,
};

export type PlaybackOperationRetryOptions = {
    requestedTimeMilliseconds?: number,
    phase?: string,
};

export type PlaybackOperationReservationChanges = {
    requestedTimeMilliseconds?: number,
    packetId?: number,
    phase?: string,
};

export type PlaybackSwitchIdentity = {
    scopeId: string,
    transactionKey: string,
    attemptKey: string,
    kind: 'audio-switch' | 'video-switch',
    /** Legacy alias retained in media metadata and logs. */
    id: number,
    transactionId: number,
    attempt: number,
};

export type PlaybackOperationAdvance =
    | {accepted: true, kind: 'first-operation' | 'same-attempt' | 'next-attempt' | 'next-transaction'}
    | {accepted: false, kind: 'rejected', reason: string};

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
    requestId: string,
    reason: PlaybackOperationRetryReason,
    sourceTransactionKey: string,
    sourceAttemptKey: string,
    sourceTimelineGeneration: number,
    sourceTransactionId: number,
    sourceAttempt: number,
    segmentIndex: number,
    requestedTimeMicroseconds: number,
    requestedTimeMilliseconds: number,
    filePosition: number,
    estimatedPosition: number,
    lookbackBytes: number,
};

let playbackScopeSequence = 0;

function isNonEmptyString(value: any): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: any): value is number {
    return Number.isInteger(value) && value >= 0;
}

function normalizeTime(milliseconds: number): {microseconds: number, milliseconds: number} {
    if (typeof milliseconds !== 'number' || !isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError('Invalid playback operation time');
    }
    const microseconds = Math.round(milliseconds * 1000);
    if (!Number.isSafeInteger(microseconds) || microseconds < 0) {
        throw new TypeError('Playback operation time is outside the safe integer range');
    }
    return {microseconds, milliseconds: microseconds / 1000};
}

function makeTransactionKey(scopeId: string,
                            kind: PlaybackOperationKind,
                            transactionId: number): string {
    return `${scopeId}:${kind}:${transactionId}`;
}

function makeAttemptKey(transactionKey: string, attempt: number): string {
    return `${transactionKey}:${attempt}`;
}

export function createPlaybackScopeId(prefix: string = 'player'): string {
    playbackScopeSequence++;
    const random = Math.floor(Math.random() * 0x100000000).toString(36);
    return `${prefix}-${Date.now().toString(36)}-${playbackScopeSequence.toString(36)}-${random}`;
}

export function createPlaybackOperation(options: PlaybackOperationCreateOptions): PlaybackOperation {
    if (!options || !isNonEmptyString(options.scopeId) ||
        !isNonNegativeInteger(options.timelineGeneration) ||
        !isNonNegativeInteger(options.transactionId) ||
        !['startup', 'seek', 'audio-switch', 'video-switch'].includes(options.kind) ||
        (options.packetId !== undefined && !isNonNegativeInteger(options.packetId))) {
        throw new TypeError('Invalid playback operation options');
    }
    const phase = options.phase === undefined ? 'requested' : options.phase;
    if (!isNonEmptyString(phase)) {
        throw new TypeError('Invalid playback operation phase');
    }
    const time = normalizeTime(options.requestedTimeMilliseconds);
    const transactionKey = makeTransactionKey(options.scopeId, options.kind, options.transactionId);
    return {
        scopeId: options.scopeId,
        transactionKey,
        attemptKey: makeAttemptKey(transactionKey, 0),
        timelineGeneration: options.timelineGeneration,
        kind: options.kind,
        transactionId: options.transactionId,
        attempt: 0,
        phase,
        intentTimeMicroseconds: time.microseconds,
        requestedTimeMicroseconds: time.microseconds,
        requestedTimeMilliseconds: time.milliseconds,
        packetId: options.packetId,
    };
}

export function createNextPlaybackAttempt(operation: PlaybackOperation,
                                          options: PlaybackOperationRetryOptions = {}): PlaybackOperation {
    if (!isPlaybackOperation(operation)) {
        throw new TypeError('Invalid playback operation');
    }
    const phase = options.phase === undefined ? operation.phase : options.phase;
    if (!isNonEmptyString(phase)) {
        throw new TypeError('Invalid playback operation phase');
    }
    const time = options.requestedTimeMilliseconds === undefined ? {
        microseconds: operation.requestedTimeMicroseconds,
        milliseconds: operation.requestedTimeMilliseconds,
    } : normalizeTime(options.requestedTimeMilliseconds);
    const attempt = operation.attempt + 1;
    if (!Number.isSafeInteger(attempt)) {
        throw new TypeError('Playback operation attempt overflow');
    }
    return Object.assign({}, operation, {
        attempt,
        attemptKey: makeAttemptKey(operation.transactionKey, attempt),
        phase,
        requestedTimeMicroseconds: time.microseconds,
        requestedTimeMilliseconds: time.milliseconds,
    });
}

/** Update progress without changing attempt identity. */
export function withPlaybackOperationPhase(operation: PlaybackOperation,
                                           phase: string): PlaybackOperation {
    if (!isPlaybackOperation(operation) || !isNonEmptyString(phase)) {
        throw new TypeError('Invalid playback operation phase update');
    }
    return operation.phase === phase ? clonePlaybackOperation(operation) :
        Object.assign({}, operation, {phase});
}

/**
 * Rebind a reserved attempt-zero operation before it enters an asynchronous
 * pipeline. Used for queued track requests and pre-reserved recovery work.
 */
export function rebindReservedPlaybackOperation(
    operation: PlaybackOperation,
    changes: PlaybackOperationReservationChanges
): PlaybackOperation {
    if (!isPlaybackOperation(operation) || operation.attempt !== 0 || !changes) {
        throw new TypeError('Only an attempt-zero reserved operation may be rebound');
    }
    const phase = changes.phase === undefined ? operation.phase : changes.phase;
    if (!isNonEmptyString(phase)) {
        throw new TypeError('Invalid playback operation phase');
    }
    const time = changes.requestedTimeMilliseconds === undefined ? {
        microseconds: operation.requestedTimeMicroseconds,
        milliseconds: operation.requestedTimeMilliseconds,
    } : normalizeTime(changes.requestedTimeMilliseconds);
    const packetId = changes.packetId === undefined ? operation.packetId : changes.packetId;
    if (packetId !== undefined && !isNonNegativeInteger(packetId)) {
        throw new TypeError('Invalid playback operation packet ID');
    }
    return Object.assign({}, operation, {
        phase,
        // The user intent timestamp belongs to the transaction and is stable.
        // Only the concrete execution timestamp may be rebound while queued.
        requestedTimeMicroseconds: time.microseconds,
        requestedTimeMilliseconds: time.milliseconds,
        packetId,
    });
}

/**
 * Whether an attempt-zero reservation may be replaced before any asynchronous
 * participant has observed it.  Only execution time and phase may change.
 */
export function canReplacePlaybackOperationReservation(
    current: PlaybackOperation,
    next: PlaybackOperation
): boolean {
    return isPlaybackOperation(current) && isPlaybackOperation(next) &&
        current.attempt === 0 && next.attempt === 0 &&
        isSamePlaybackAttempt(current, next) &&
        current.timelineGeneration === next.timelineGeneration &&
        current.intentTimeMicroseconds === next.intentTimeMicroseconds &&
        current.packetId === next.packetId;
}

export function isPlaybackOperation(value: any): value is PlaybackOperation {
    if (!value || value.requestedTime !== undefined ||
        !isNonEmptyString(value.scopeId) ||
        !isNonEmptyString(value.transactionKey) ||
        !isNonEmptyString(value.attemptKey) ||
        !isNonNegativeInteger(value.timelineGeneration) ||
        !isNonNegativeInteger(value.transactionId) ||
        !isNonNegativeInteger(value.attempt) ||
        !['startup', 'seek', 'audio-switch', 'video-switch'].includes(value.kind) ||
        !isNonEmptyString(value.phase) ||
        !Number.isSafeInteger(value.intentTimeMicroseconds) || value.intentTimeMicroseconds < 0 ||
        !Number.isSafeInteger(value.requestedTimeMicroseconds) || value.requestedTimeMicroseconds < 0 ||
        typeof value.requestedTimeMilliseconds !== 'number' ||
        !isFinite(value.requestedTimeMilliseconds) || value.requestedTimeMilliseconds < 0 ||
        (value.packetId !== undefined && !isNonNegativeInteger(value.packetId))) {
        return false;
    }
    const transactionKey = makeTransactionKey(value.scopeId, value.kind, value.transactionId);
    return value.transactionKey === transactionKey &&
        value.attemptKey === makeAttemptKey(transactionKey, value.attempt) &&
        value.requestedTimeMilliseconds === value.requestedTimeMicroseconds / 1000;
}

export function isPlaybackOperationRetryRequest(
    value: any,
    sourceOperation?: PlaybackOperation | null
): value is PlaybackOperationRetryRequest {
    if (!value || !isNonEmptyString(value.requestId) ||
        value.reason !== 'mmts-vod-seek-lookback' ||
        !isNonEmptyString(value.sourceTransactionKey) ||
        !isNonEmptyString(value.sourceAttemptKey) ||
        !isNonNegativeInteger(value.sourceTimelineGeneration) ||
        !isNonNegativeInteger(value.sourceTransactionId) ||
        !isNonNegativeInteger(value.sourceAttempt) ||
        !isNonNegativeInteger(value.segmentIndex) ||
        !Number.isSafeInteger(value.requestedTimeMicroseconds) ||
        value.requestedTimeMicroseconds < 0 ||
        typeof value.requestedTimeMilliseconds !== 'number' ||
        !isFinite(value.requestedTimeMilliseconds) ||
        value.requestedTimeMilliseconds < 0 ||
        value.requestedTimeMilliseconds !== value.requestedTimeMicroseconds / 1000 ||
        !Number.isSafeInteger(value.filePosition) || value.filePosition < 0 ||
        !Number.isSafeInteger(value.estimatedPosition) || value.estimatedPosition < 0 ||
        !Number.isSafeInteger(value.lookbackBytes) || value.lookbackBytes < 0) {
        return false;
    }
    if (sourceOperation !== undefined && sourceOperation !== null) {
        return isPlaybackOperation(sourceOperation) &&
            value.sourceTransactionKey === sourceOperation.transactionKey &&
            value.sourceAttemptKey === sourceOperation.attemptKey &&
            value.sourceTimelineGeneration === sourceOperation.timelineGeneration &&
            value.sourceTransactionId === sourceOperation.transactionId &&
            value.sourceAttempt === sourceOperation.attempt &&
            value.requestedTimeMicroseconds === sourceOperation.requestedTimeMicroseconds;
    }
    return true;
}

export function clonePlaybackOperation(operation: PlaybackOperation): PlaybackOperation {
    if (!isPlaybackOperation(operation)) {
        throw new TypeError('Invalid playback operation');
    }
    return Object.assign({}, operation);
}

export function isSamePlaybackTransaction(left: PlaybackOperation,
                                          right: PlaybackOperation): boolean {
    return isPlaybackOperation(left) && isPlaybackOperation(right) &&
        left.scopeId === right.scopeId &&
        left.transactionKey === right.transactionKey &&
        left.kind === right.kind &&
        left.transactionId === right.transactionId;
}

export function isSamePlaybackAttempt(left: PlaybackOperation,
                                      right: PlaybackOperation): boolean {
    return isSamePlaybackTransaction(left, right) &&
        left.attemptKey === right.attemptKey &&
        left.attempt === right.attempt;
}

/** Phase is progress, not identity. */
export function isSamePlaybackOperation(left: PlaybackOperation,
                                        right: PlaybackOperation): boolean {
    return isSamePlaybackAttempt(left, right) &&
        left.timelineGeneration === right.timelineGeneration &&
        left.intentTimeMicroseconds === right.intentTimeMicroseconds &&
        left.requestedTimeMicroseconds === right.requestedTimeMicroseconds &&
        left.packetId === right.packetId;
}

export function isSamePlaybackOperationPhase(left: PlaybackOperation,
                                             right: PlaybackOperation): boolean {
    return isSamePlaybackOperation(left, right) && left.phase === right.phase;
}

export function classifyPlaybackOperationAdvance(
    current: PlaybackOperation | null | undefined,
    next: PlaybackOperation
): PlaybackOperationAdvance {
    if (!isPlaybackOperation(next)) {
        return {accepted: false, kind: 'rejected', reason: 'invalid-next-operation'};
    }
    if (!current) {
        return next.attempt === 0 ?
            {accepted: true, kind: 'first-operation'} :
            {accepted: false, kind: 'rejected', reason: 'first-operation-must-use-attempt-zero'};
    }
    if (!isPlaybackOperation(current)) {
        return {accepted: false, kind: 'rejected', reason: 'invalid-current-operation'};
    }
    if (current.scopeId !== next.scopeId) {
        return {accepted: false, kind: 'rejected', reason: 'scope-mismatch'};
    }
    if (isSamePlaybackTransaction(current, next)) {
        if (current.timelineGeneration !== next.timelineGeneration ||
            current.intentTimeMicroseconds !== next.intentTimeMicroseconds ||
            current.packetId !== next.packetId) {
            return {accepted: false, kind: 'rejected', reason: 'transaction-payload-mutated'};
        }
        if (next.attempt === current.attempt) {
            return isSamePlaybackOperation(current, next) ?
                {accepted: true, kind: 'same-attempt'} :
                {accepted: false, kind: 'rejected', reason: 'attempt-payload-mutated'};
        }
        if (next.attempt !== current.attempt + 1) {
            return {accepted: false, kind: 'rejected', reason: 'attempt-sequence-gap'};
        }
        return {accepted: true, kind: 'next-attempt'};
    }
    if (next.timelineGeneration <= current.timelineGeneration) {
        return {accepted: false, kind: 'rejected', reason: 'stale-timeline-generation'};
    }
    if (next.transactionId <= current.transactionId) {
        return {accepted: false, kind: 'rejected', reason: 'stale-transaction-id'};
    }
    if (next.attempt !== 0) {
        return {accepted: false, kind: 'rejected', reason: 'new-transaction-must-use-attempt-zero'};
    }
    return {accepted: true, kind: 'next-transaction'};
}

export function canAdvancePlaybackOperation(current: PlaybackOperation | null | undefined,
                                            next: PlaybackOperation): boolean {
    return classifyPlaybackOperationAdvance(current, next).accepted;
}

export function createPlaybackSwitchIdentity(operation: PlaybackOperation): PlaybackSwitchIdentity {
    if (!isPlaybackOperation(operation) ||
        (operation.kind !== 'audio-switch' && operation.kind !== 'video-switch')) {
        throw new TypeError('Track switch identity requires a track switch operation');
    }
    return {
        scopeId: operation.scopeId,
        transactionKey: operation.transactionKey,
        attemptKey: operation.attemptKey,
        kind: operation.kind,
        id: operation.transactionId,
        transactionId: operation.transactionId,
        attempt: operation.attempt,
    };
}

export function isPlaybackSwitchIdentity(value: any): value is PlaybackSwitchIdentity {
    if (!value || !isNonEmptyString(value.scopeId) ||
        (value.kind !== 'audio-switch' && value.kind !== 'video-switch') ||
        !isNonEmptyString(value.transactionKey) || !isNonEmptyString(value.attemptKey) ||
        !isNonNegativeInteger(value.id) || !isNonNegativeInteger(value.transactionId) ||
        value.id !== value.transactionId || !isNonNegativeInteger(value.attempt)) {
        return false;
    }
    const transactionKey = makeTransactionKey(value.scopeId, value.kind, value.transactionId);
    return value.transactionKey === transactionKey &&
        value.attemptKey === makeAttemptKey(transactionKey, value.attempt);
}

export function doesPlaybackSwitchIdentityMatchOperation(identity: any,
                                                         operation: PlaybackOperation): boolean {
    return isPlaybackSwitchIdentity(identity) && isPlaybackOperation(operation) &&
        identity.scopeId === operation.scopeId &&
        identity.kind === operation.kind &&
        identity.transactionKey === operation.transactionKey &&
        identity.attemptKey === operation.attemptKey &&
        identity.transactionId === operation.transactionId &&
        identity.attempt === operation.attempt;
}

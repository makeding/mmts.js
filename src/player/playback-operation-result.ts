/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {
    canReplacePlaybackOperationReservation,
    classifyPlaybackOperationAdvance,
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackTransaction,
    type PlaybackOperation,
} from '../core/playback-operation';

export type PlaybackOperationProgressStatus = 'queued' | 'running' | 'retrying' | 'recovering';
export type PlaybackOperationTerminalStatus =
    'committed' | 'no-op' | 'cancelled' | 'superseded' | 'failed';
export type PlaybackOperationStatus =
    PlaybackOperationProgressStatus | PlaybackOperationTerminalStatus;

export type PlaybackOperationEvent = {
    operation: PlaybackOperation,
    scopeId: string,
    transactionKey: string,
    attemptKey: string,
    timelineGeneration: number,
    transactionId: number,
    attempt: number,
    kind: PlaybackOperation['kind'],
    phase: string,
    status: PlaybackOperationStatus,
    terminal: boolean,
    requestedPacketId?: number,
    committedPacketId?: number,
    requestedTimeMilliseconds: number,
    committedTimeMilliseconds?: number,
    reason?: string,
    error?: any,
};

export type PlaybackOperationResult = PlaybackOperationEvent & {
    status: PlaybackOperationTerminalStatus,
    terminal: true,
};

export type PlaybackOperationProgressDetails = {reason?: string};

export type PlaybackOperationSettleDetails = {
    reason?: string,
    error?: any,
    committedPacketId?: number,
    committedTimeMilliseconds?: number,
};

type PendingResult = {
    operation: PlaybackOperation,
    promise: Promise<PlaybackOperationResult>,
    resolve: (result: PlaybackOperationResult) => void,
};

export function isPlaybackOperationTerminalStatus(
    status: PlaybackOperationStatus
): status is PlaybackOperationTerminalStatus {
    return status === 'committed' || status === 'no-op' || status === 'cancelled' ||
        status === 'superseded' || status === 'failed';
}

export function isPlaybackOperationStatus(value: any): value is PlaybackOperationStatus {
    return value === 'queued' || value === 'running' || value === 'retrying' ||
        value === 'recovering' || isPlaybackOperationTerminalStatus(value);
}

function normalizeError(error: any): any {
    if (error == null || typeof error !== 'object') return error;
    if (error instanceof Error || typeof error.message === 'string') {
        return {
            name: typeof error.name === 'string' ? error.name : 'Error',
            message: String(error.message || error),
            stack: typeof error.stack === 'string' ? error.stack : undefined,
            code: error.code,
        };
    }
    try {
        return Object.assign({}, error);
    } catch (_error) {
        return String(error);
    }
}

export function isPlaybackOperationEvent(value: any): value is PlaybackOperationEvent {
    if (!value || !isPlaybackOperation(value.operation) ||
        value.scopeId !== value.operation.scopeId ||
        value.transactionKey !== value.operation.transactionKey ||
        value.attemptKey !== value.operation.attemptKey ||
        value.timelineGeneration !== value.operation.timelineGeneration ||
        value.transactionId !== value.operation.transactionId ||
        value.attempt !== value.operation.attempt ||
        value.kind !== value.operation.kind || value.phase !== value.operation.phase ||
        value.requestedPacketId !== value.operation.packetId ||
        value.requestedTimeMilliseconds !== value.operation.requestedTimeMilliseconds ||
        !['queued', 'running', 'retrying', 'recovering', 'committed', 'no-op',
            'cancelled', 'superseded', 'failed'].includes(value.status) ||
        value.terminal !== isPlaybackOperationTerminalStatus(value.status)) {
        return false;
    }
    if (value.committedPacketId !== undefined &&
        (!Number.isInteger(value.committedPacketId) || value.committedPacketId < 0)) {
        return false;
    }
    return value.committedTimeMilliseconds === undefined ||
        (typeof value.committedTimeMilliseconds === 'number' &&
            isFinite(value.committedTimeMilliseconds) && value.committedTimeMilliseconds >= 0);
}

export function createPlaybackOperationEvent(
    operation: PlaybackOperation,
    status: PlaybackOperationStatus,
    details: PlaybackOperationSettleDetails = {}
): PlaybackOperationEvent {
    if (!isPlaybackOperation(operation)) {
        throw new TypeError('Invalid playback operation');
    }
    return {
        operation: clonePlaybackOperation(operation),
        scopeId: operation.scopeId,
        transactionKey: operation.transactionKey,
        attemptKey: operation.attemptKey,
        timelineGeneration: operation.timelineGeneration,
        transactionId: operation.transactionId,
        attempt: operation.attempt,
        kind: operation.kind,
        phase: operation.phase,
        status,
        terminal: isPlaybackOperationTerminalStatus(status),
        requestedPacketId: operation.packetId,
        committedPacketId: details.committedPacketId,
        requestedTimeMilliseconds: operation.requestedTimeMilliseconds,
        committedTimeMilliseconds: details.committedTimeMilliseconds,
        reason: details.reason,
        error: normalizeError(details.error),
    };
}

export default class PlaybackOperationResultRegistry {
    private _pending: Map<string, PendingResult> = new Map();
    private _emit: (event: PlaybackOperationEvent) => void;

    public constructor(emit: (event: PlaybackOperationEvent) => void) {
        this._emit = emit;
    }

    public register(operation: PlaybackOperation,
                    initialStatus: PlaybackOperationProgressStatus = 'queued',
                    reason?: string | PlaybackOperationProgressDetails): Promise<PlaybackOperationResult> {
        if (!isPlaybackOperation(operation)) {
            throw new TypeError('Invalid playback operation');
        }
        const existing = this._pending.get(operation.transactionKey);
        if (existing) {
            if (!this._canAccept(existing.operation, operation)) {
                throw new TypeError('Playback transaction key collision or stale attempt');
            }
            existing.operation = clonePlaybackOperation(operation);
            this.publish(operation, initialStatus, reason);
            return existing.promise;
        }
        let resolver: (result: PlaybackOperationResult) => void = () => {};
        const promise = new Promise<PlaybackOperationResult>((resolve) => {
            resolver = resolve;
        });
        this._pending.set(operation.transactionKey, {
            operation: clonePlaybackOperation(operation),
            promise,
            resolve: resolver,
        });
        this.publish(operation, initialStatus, reason);
        return promise;
    }

    public has(operationOrKey: PlaybackOperation | string): boolean {
        const key = typeof operationOrKey === 'string' ?
            operationOrKey : operationOrKey.transactionKey;
        return this._pending.has(key);
    }

    public promiseFor(operationOrKey: PlaybackOperation | string): Promise<PlaybackOperationResult> | null {
        const key = typeof operationOrKey === 'string' ?
            operationOrKey : operationOrKey.transactionKey;
        return this._pending.get(key)?.promise || null;
    }

    /**
     * Replace an attempt-zero reservation before it enters the async pipeline.
     * Queue wait time may change the execution timestamp, but the transaction
     * key and Promise must remain stable.
     */
    public replaceReservation(operation: PlaybackOperation): boolean {
        if (!isPlaybackOperation(operation) || operation.attempt !== 0) return false;
        const pending = this._pending.get(operation.transactionKey);
        if (!pending ||
            !canReplacePlaybackOperationReservation(pending.operation, operation)) {
            return false;
        }
        pending.operation = clonePlaybackOperation(operation);
        return true;
    }

    public publish(operation: PlaybackOperation,
                   status: PlaybackOperationProgressStatus,
                   details?: string | PlaybackOperationProgressDetails): PlaybackOperationEvent | null {
        if (!isPlaybackOperation(operation) || isPlaybackOperationTerminalStatus(status)) return null;
        const pending = this._pending.get(operation.transactionKey);
        if (!pending || !this._canAccept(pending.operation, operation)) return null;
        pending.operation = clonePlaybackOperation(operation);
        const reason = typeof details === 'string' ? details : details && details.reason;
        const event = this._makeEvent(operation, status, {reason});
        this._emit(event);
        return event;
    }

    public markRunning(operation: PlaybackOperation, reason?: string): void {
        this.publish(operation, operation.attempt > 0 ? 'retrying' : 'running', reason);
    }

    public canAdoptAttempt(operation: PlaybackOperation): boolean {
        if (!isPlaybackOperation(operation)) return false;
        const pending = this._pending.get(operation.transactionKey);
        return !!pending && this._canAccept(pending.operation, operation);
    }

    public adoptAttempt(operation: PlaybackOperation, reason: string = 'attempt-adopted'): boolean {
        if (!this.canAdoptAttempt(operation)) {
            return false;
        }
        const pending = this._pending.get(operation.transactionKey) as PendingResult;
        pending.operation = clonePlaybackOperation(operation);
        this.publish(operation, operation.attempt > 0 ? 'retrying' : 'running', reason);
        return true;
    }

    public settle(operation: PlaybackOperation,
                  status: PlaybackOperationTerminalStatus,
                  details: PlaybackOperationSettleDetails = {}): PlaybackOperationResult | null {
        if (!isPlaybackOperation(operation) || !isPlaybackOperationTerminalStatus(status)) return null;
        const pending = this._pending.get(operation.transactionKey);
        if (!pending || !this._canAccept(pending.operation, operation)) return null;
        pending.operation = clonePlaybackOperation(operation);
        const event = this._makeEvent(operation, status, details) as PlaybackOperationResult;
        this._pending.delete(operation.transactionKey);
        pending.resolve(event);
        this._emit(event);
        return event;
    }

    /** Consume a result produced by a Dedicated Worker. */
    public acceptExternal(event: PlaybackOperationEvent): boolean {
        if (!isPlaybackOperationEvent(event)) {
            return false;
        }
        const pending = this._pending.get(event.transactionKey);
        if (!pending || !this._canAccept(pending.operation, event.operation)) {
            return false;
        }
        pending.operation = clonePlaybackOperation(event.operation);
        if (event.terminal && isPlaybackOperationTerminalStatus(event.status)) {
            this._pending.delete(event.transactionKey);
            pending.resolve(event as PlaybackOperationResult);
        }
        this._emit(event);
        return true;
    }

    public destroy(reason: string = 'player-destroyed'): void {
        this.cancelAll(reason);
        this._emit = () => {};
    }

    public cancelAll(reason: string = 'player-unloaded'): void {
        const pending = Array.from(this._pending.values());
        this._pending.clear();
        for (let i = 0; i < pending.length; i++) {
            const entry = pending[i];
            const event = this._makeEvent(entry.operation, 'cancelled', {reason}) as PlaybackOperationResult;
            entry.resolve(event);
            this._emit(event);
        }
    }

    public static immediate(operation: PlaybackOperation,
                            status: PlaybackOperationTerminalStatus,
                            details: PlaybackOperationSettleDetails = {}): Promise<PlaybackOperationResult> {
        const registry = new PlaybackOperationResultRegistry(() => {});
        const promise = registry.register(operation, 'running');
        registry.settle(operation, status, details);
        return promise;
    }

    private _canAccept(current: PlaybackOperation,
                       next: PlaybackOperation): boolean {
        if (!isSamePlaybackTransaction(current, next)) return false;
        const advance = classifyPlaybackOperationAdvance(current, next);
        return advance.accepted &&
            (advance.kind === 'same-attempt' || advance.kind === 'next-attempt');
    }

    private _makeEvent(operation: PlaybackOperation,
                       status: PlaybackOperationStatus,
                       details: PlaybackOperationSettleDetails): PlaybackOperationEvent {
        return createPlaybackOperationEvent(operation, status, details);
    }
}

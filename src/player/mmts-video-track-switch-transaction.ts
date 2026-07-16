/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackTransaction,
    rebindReservedPlaybackOperation,
    type PlaybackOperation,
} from '../core/playback-operation';

export type MMTSVideoTrackSwitchStage =
    'requested' | 'selecting' | 'waiting-init' | 'waiting-media' |
    'submitted' | 'committed' | 'aborted';

export type MMTSVideoTrackSwitchReservation = {
    operation: PlaybackOperation,
    priorCommittedPacketId: number,
    targetPacketId: number,
    recoveryDepth?: number,
    recoveryOperation?: PlaybackOperation,
};

export type MMTSVideoTrackSwitchTransaction = MMTSVideoTrackSwitchReservation & {
    stage: MMTSVideoTrackSwitchStage,
    confirmedTrackData?: any,
    pendingMediaInfo?: any,
    deadline: number,
    internalSelectionChanged: boolean,
    selectionMayHaveMutated: boolean,
    terminal: boolean,
};

export type MMTSVideoTrackSwitchRequestResult =
    {type: 'activate', transaction: MMTSVideoTrackSwitchTransaction} |
    {type: 'queued', reservation: MMTSVideoTrackSwitchReservation} |
    {type: 'same-target'};

export type MMTSVideoTrackSelectionResult = {
    transactionId: number,
    attempt: number,
    accepted: boolean,
    changed: boolean,
    requestedPacketId: number,
    selectedPacketId?: number,
    reason: string,
};

const TERMINAL_STAGES = new Set<MMTSVideoTrackSwitchStage>(['committed', 'aborted']);
const ALLOWED_TRANSITIONS: Record<string, MMTSVideoTrackSwitchStage[]> = {
    requested: ['selecting'],
    selecting: [],
    'waiting-init': ['waiting-media'],
    'waiting-media': ['submitted'],
    submitted: [],
    committed: [],
    aborted: [],
};

export default class MMTSVideoTrackSwitchCoordinator {
    private _active: MMTSVideoTrackSwitchTransaction | null = null;
    private _queued: MMTSVideoTrackSwitchReservation | null = null;
    private _timer: any = null;
    private _now: () => number;
    private _setTimer: (callback: () => void, delay: number) => any;
    private _clearTimer: (timer: any) => void;
    private _onTimeout: (transaction: MMTSVideoTrackSwitchTransaction) => void;
    private _stageTimeout: (stage: MMTSVideoTrackSwitchStage) => number;

    public constructor(options: {
        now?: () => number,
        setTimer?: (callback: () => void, delay: number) => any,
        clearTimer?: (timer: any) => void,
        onTimeout: (transaction: MMTSVideoTrackSwitchTransaction) => void,
        stageTimeout: (stage: MMTSVideoTrackSwitchStage) => number,
    }) {
        this._now = options.now || (() => Date.now());
        this._setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
        this._clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
        this._onTimeout = options.onTimeout;
        this._stageTimeout = options.stageTimeout;
    }

    public get active(): MMTSVideoTrackSwitchTransaction | null {
        return this._active ? this._snapshotTransaction(this._active) : null;
    }

    public get queued(): MMTSVideoTrackSwitchReservation | null {
        return this._queued ? this._snapshotReservation(this._queued) : null;
    }

    public request(reservation: MMTSVideoTrackSwitchReservation): MMTSVideoTrackSwitchRequestResult {
        this._validateReservation(reservation);
        if (!this._active) {
            if (reservation.targetPacketId === reservation.priorCommittedPacketId &&
                (reservation.recoveryDepth || 0) === 0) {
                return {type: 'same-target'};
            }
            return {type: 'activate', transaction: this._snapshotTransaction(this._activate(reservation))};
        }
        if (this._active.targetPacketId === reservation.targetPacketId) {
            this._queued = null;
            return {type: 'same-target'};
        }
        this._queued = this._cloneReservation(reservation);
        return {type: 'queued', reservation: this._snapshotReservation(this._queued)};
    }

    public transition(
        operation: PlaybackOperation,
        expected: MMTSVideoTrackSwitchStage | MMTSVideoTrackSwitchStage[],
        next: MMTSVideoTrackSwitchStage
    ): MMTSVideoTrackSwitchTransaction | null {
        const transaction = this._matchingActive(operation);
        const expectedStages = Array.isArray(expected) ? expected : [expected];
        if (!transaction || transaction.terminal || !expectedStages.includes(transaction.stage) ||
            TERMINAL_STAGES.has(next) || !ALLOWED_TRANSITIONS[transaction.stage].includes(next)) {
            return null;
        }
        transaction.stage = next;
        if (next === 'selecting') {
            transaction.selectionMayHaveMutated = true;
        }
        this._armDeadline(transaction);
        return this._snapshotTransaction(transaction);
    }

    public selectionResult(operation: PlaybackOperation, result: MMTSVideoTrackSelectionResult):
        {type: 'accepted' | 'rejected' | 'stale', transaction?: MMTSVideoTrackSwitchTransaction} {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.stage !== 'selecting' || !result ||
            result.transactionId !== transaction.operation.transactionId ||
            result.attempt !== transaction.operation.attempt ||
            result.requestedPacketId !== transaction.targetPacketId ||
            typeof result.reason !== 'string' || result.reason.length === 0) {
            return {type: 'stale'};
        }

        if (typeof result.changed !== 'boolean') {
            return {type: 'rejected', transaction: this._snapshotTransaction(transaction)};
        }

        const selected = result.reason === 'selected' && result.accepted === true &&
            result.changed === true && result.selectedPacketId === transaction.targetPacketId;
        const alreadySelected = result.reason === 'already-selected' && result.accepted === true &&
            result.changed === false && result.selectedPacketId === transaction.targetPacketId;
        if (!selected && !alreadySelected) {
            return {type: 'rejected', transaction: this._snapshotTransaction(transaction)};
        }

        transaction.internalSelectionChanged = transaction.internalSelectionChanged ||
            result.changed === true ||
            (alreadySelected && transaction.priorCommittedPacketId !== transaction.targetPacketId);
        transaction.stage = 'waiting-init';
        this._armDeadline(transaction);
        return {type: 'accepted', transaction: this._snapshotTransaction(transaction)};
    }

    public setConfirmedTrackData(operation: PlaybackOperation, data: any): boolean {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal ||
            !['selecting', 'waiting-init', 'waiting-media'].includes(transaction.stage)) {
            return false;
        }
        transaction.confirmedTrackData = data;
        return true;
    }

    public setPendingMediaInfo(operation: PlaybackOperation, data: any): boolean {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal) {
            return false;
        }
        transaction.pendingMediaInfo = data;
        return true;
    }

    public canAdoptAttempt(operation: PlaybackOperation): boolean {
        const transaction = this._active;
        return !!transaction && !transaction.terminal &&
            isPlaybackOperation(operation) && operation.kind === 'video-switch' &&
            isSamePlaybackTransaction(operation, transaction.operation) &&
            operation.timelineGeneration === transaction.operation.timelineGeneration &&
            operation.intentTimeMicroseconds === transaction.operation.intentTimeMicroseconds &&
            operation.packetId === transaction.targetPacketId &&
            operation.attempt === transaction.operation.attempt + 1 &&
            operation.phase === 'adaptive-retry' &&
            ['selecting', 'waiting-init', 'waiting-media'].includes(transaction.stage);
    }

    public adoptAttempt(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null {
        const transaction = this._active;
        if (!transaction || !this.canAdoptAttempt(operation)) {
            return null;
        }
        transaction.operation = clonePlaybackOperation(operation);
        transaction.stage = 'selecting';
        transaction.selectionMayHaveMutated = true;
        this._armDeadline(transaction);
        return this._snapshotTransaction(transaction);
    }

    public commit(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal || transaction.stage !== 'submitted') {
            return null;
        }
        transaction.stage = 'committed';
        transaction.terminal = true;
        this._clearDeadline();
        this._active = null;
        return this._snapshotTransaction(transaction);
    }

    public abort(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal) {
            return null;
        }
        transaction.stage = 'aborted';
        transaction.terminal = true;
        this._clearDeadline();
        this._active = null;
        return this._snapshotTransaction(transaction);
    }

    public promote(
        activePlaybackOperation: PlaybackOperation,
        recoveryDepth?: number,
        priorCommittedPacketId?: number
    ): MMTSVideoTrackSwitchTransaction | null {
        if (this._active || !this._queued) {
            return null;
        }
        const reservation = this._queued;
        this._queued = null;
        if (!isPlaybackOperation(activePlaybackOperation) ||
            reservation.operation.timelineGeneration <= activePlaybackOperation.timelineGeneration) {
            return null;
        }
        const promoted = this._cloneReservation(reservation);
        if (priorCommittedPacketId !== undefined) {
            if (!Number.isInteger(priorCommittedPacketId) || priorCommittedPacketId < 0) {
                return null;
            }
            promoted.priorCommittedPacketId = priorCommittedPacketId;
            if (promoted.recoveryOperation) {
                promoted.recoveryOperation = rebindReservedPlaybackOperation(
                    promoted.recoveryOperation,
                    {packetId: priorCommittedPacketId}
                );
            }
        }
        if (recoveryDepth !== undefined) {
            if (!Number.isInteger(recoveryDepth) || recoveryDepth < 0 || recoveryDepth > 1) {
                return null;
            }
            promoted.recoveryDepth = recoveryDepth;
        }
        promoted.operation = rebindReservedPlaybackOperation(
            promoted.operation,
            {phase: 'requested'}
        );
        if (promoted.targetPacketId === promoted.priorCommittedPacketId &&
            (promoted.recoveryDepth || 0) === 0) {
            return null;
        }
        return this._snapshotTransaction(this._activate(promoted));
    }

    public clear(): void {
        this._clearDeadline();
        this._active = null;
        this._queued = null;
    }

    private _activate(reservation: MMTSVideoTrackSwitchReservation): MMTSVideoTrackSwitchTransaction {
        const transaction: MMTSVideoTrackSwitchTransaction = Object.assign(
            this._cloneReservation(reservation),
            {
                stage: 'requested' as MMTSVideoTrackSwitchStage,
                deadline: 0,
                internalSelectionChanged: false,
                selectionMayHaveMutated: false,
                terminal: false,
            }
        );
        this._active = transaction;
        this._armDeadline(transaction);
        return transaction;
    }

    private _matchingActive(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null {
        const transaction = this._active;
        return transaction && isPlaybackOperation(operation) &&
            isSamePlaybackTransaction(operation, transaction.operation) &&
            operation.attempt === transaction.operation.attempt ? transaction : null;
    }

    private _armDeadline(transaction: MMTSVideoTrackSwitchTransaction): void {
        this._clearDeadline();
        const timeout = this._stageTimeout(transaction.stage);
        if (typeof timeout !== 'number' || !isFinite(timeout) || timeout <= 0) {
            throw new TypeError('Invalid MMTS video track switch stage timeout');
        }
        transaction.deadline = this._now() + timeout;
        const operation = clonePlaybackOperation(transaction.operation);
        this._timer = this._setTimer(() => {
            this._timer = null;
            const active = this._matchingActive(operation);
            if (!active || active.terminal) return;
            const remaining = active.deadline - this._now();
            if (remaining > 0) {
                this._timer = this._setTimer(() => this._handleTimer(operation), remaining);
            } else {
                this._onTimeout(this._snapshotTransaction(active));
            }
        }, timeout);
    }

    private _handleTimer(operation: PlaybackOperation): void {
        this._timer = null;
        const active = this._matchingActive(operation);
        if (!active || active.terminal) return;
        const remaining = active.deadline - this._now();
        if (remaining > 0) {
            this._timer = this._setTimer(() => this._handleTimer(operation), remaining);
            return;
        }
        this._onTimeout(this._snapshotTransaction(active));
    }

    private _clearDeadline(): void {
        if (this._timer != null) {
            this._clearTimer(this._timer);
            this._timer = null;
        }
    }

    private _validateReservation(reservation: MMTSVideoTrackSwitchReservation): void {
        if (!reservation || !isPlaybackOperation(reservation.operation) ||
            reservation.operation.kind !== 'video-switch' || reservation.operation.attempt !== 0 ||
            reservation.operation.packetId !== reservation.targetPacketId ||
            !Number.isInteger(reservation.targetPacketId) || reservation.targetPacketId < 0 ||
            !Number.isInteger(reservation.priorCommittedPacketId) || reservation.priorCommittedPacketId < 0 ||
            (reservation.recoveryDepth !== undefined &&
                (!Number.isInteger(reservation.recoveryDepth) ||
                    reservation.recoveryDepth < 0 || reservation.recoveryDepth > 1))) {
            throw new TypeError('Invalid MMTS video track switch reservation');
        }
        const recovery = reservation.recoveryOperation;
        if (recovery !== undefined && (!isPlaybackOperation(recovery) ||
            recovery.kind !== 'video-switch' || recovery.attempt !== 0 ||
            recovery.packetId !== reservation.priorCommittedPacketId ||
            recovery.timelineGeneration <= reservation.operation.timelineGeneration ||
            recovery.transactionId <= reservation.operation.transactionId)) {
            throw new TypeError('Invalid MMTS video track switch recovery reservation');
        }
    }

    private _cloneReservation(reservation: MMTSVideoTrackSwitchReservation): MMTSVideoTrackSwitchReservation {
        return Object.assign({}, reservation, {
            operation: clonePlaybackOperation(reservation.operation),
            recoveryOperation: reservation.recoveryOperation ?
                clonePlaybackOperation(reservation.recoveryOperation) : undefined,
        });
    }

    private _snapshotReservation(reservation: MMTSVideoTrackSwitchReservation): MMTSVideoTrackSwitchReservation {
        const snapshot = this._cloneReservation(reservation);
        snapshot.operation = Object.freeze(snapshot.operation);
        if (snapshot.recoveryOperation) {
            snapshot.recoveryOperation = Object.freeze(snapshot.recoveryOperation);
        }
        return Object.freeze(snapshot);
    }

    private _snapshotTransaction(transaction: MMTSVideoTrackSwitchTransaction): MMTSVideoTrackSwitchTransaction {
        return Object.freeze(Object.assign({}, transaction, {
            operation: Object.freeze(clonePlaybackOperation(transaction.operation)),
            recoveryOperation: transaction.recoveryOperation ?
                Object.freeze(clonePlaybackOperation(transaction.recoveryOperation)) : undefined,
            confirmedTrackData: this._snapshotData(transaction.confirmedTrackData),
            pendingMediaInfo: this._snapshotData(transaction.pendingMediaInfo),
        }));
    }

    private _snapshotData(value: any): any {
        if (!value || typeof value !== 'object') {
            return value;
        }
        return Object.freeze(Array.isArray(value) ? value.slice() : Object.assign({}, value));
    }
}

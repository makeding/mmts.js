import {
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackTransaction,
    rebindReservedPlaybackOperation,
    type PlaybackOperation,
} from '../core/playback-operation';

export type MMTSAudioTrackSwitchStrategy = 'vod-reseek' | 'vod-forward' | 'live-forward';
export type MMTSAudioTrackSwitchStage =
    'requested' | 'preparing' | 'selecting' | 'waiting-init' | 'collecting-overlap' |
    'submitted' | 'rebuilding' | 'committed' | 'aborted';

export type MMTSAudioTrackSwitchReservation = {
    operation: PlaybackOperation,
    priorCommittedPacketId: number,
    targetPacketId: number,
    strategy: MMTSAudioTrackSwitchStrategy,
    resumeIntent: boolean,
    recoveryDepth?: number,
    recoveryOperation?: PlaybackOperation,
};

export type MMTSAudioTrackSwitchTransaction = MMTSAudioTrackSwitchReservation & {
    stage: MMTSAudioTrackSwitchStage,
    confirmedTrackData?: any,
    pendingMediaInfo?: any,
    deadline: number,
    internalSelectionChanged: boolean,
    selectionMayHaveMutated: boolean,
    terminal: boolean,
};

export type MMTSAudioTrackSwitchRequestResult =
    {type: 'activate', transaction: MMTSAudioTrackSwitchTransaction} |
    {type: 'queued', reservation: MMTSAudioTrackSwitchReservation} |
    {type: 'same-target'};

export type MMTSVodAudioStartupGroupInvalidReason =
    'selection-not-confirmed' |
    'missing-segment' |
    'invalid-segment-type' |
    'missing-audio-switch' |
    'mixed-operation' |
    'mixed-attempt' |
    'invalid-audio-window' |
    'missing-video-window' |
    'video-not-random-access' |
    'video-not-sync' |
    'coordinator-transition-rejected';

export type MMTSVodAudioStartupGroupApplyResult =
    {status: 'accepted'} |
    {status: 'stale'} |
    {status: 'invalid', reason: MMTSVodAudioStartupGroupInvalidReason};

const TERMINAL_STAGES = new Set<MMTSAudioTrackSwitchStage>(['committed', 'aborted']);
const ALLOWED_TRANSITIONS: Record<string, MMTSAudioTrackSwitchStage[]> = {
    requested: ['preparing'],
    preparing: ['selecting'],
    selecting: ['waiting-init'],
    'waiting-init': ['collecting-overlap'],
    'collecting-overlap': ['submitted'],
    submitted: ['rebuilding'],
    rebuilding: [],
    committed: [],
    aborted: [],
};

export default class MMTSAudioTrackSwitchCoordinator {
    private _active: MMTSAudioTrackSwitchTransaction | null = null;
    private _queued: MMTSAudioTrackSwitchReservation | null = null;
    private _timer: any = null;
    private _now: () => number;
    private _setTimer: (callback: () => void, delay: number) => any;
    private _clearTimer: (timer: any) => void;
    private _onTimeout: (transaction: MMTSAudioTrackSwitchTransaction) => void;
    private _stageTimeout: (stage: MMTSAudioTrackSwitchStage) => number;

    public constructor(options: {
        now?: () => number,
        setTimer?: (callback: () => void, delay: number) => any,
        clearTimer?: (timer: any) => void,
        onTimeout: (transaction: MMTSAudioTrackSwitchTransaction) => void,
        stageTimeout: (stage: MMTSAudioTrackSwitchStage) => number,
    }) {
        this._now = options.now || (() => Date.now());
        this._setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
        this._clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
        this._onTimeout = options.onTimeout;
        this._stageTimeout = options.stageTimeout;
    }

    public get active(): MMTSAudioTrackSwitchTransaction | null {
        return this._active ? this._snapshotTransaction(this._active) : null;
    }

    public get queued(): MMTSAudioTrackSwitchReservation | null {
        return this._queued ? this._snapshotReservation(this._queued) : null;
    }

    public request(reservation: MMTSAudioTrackSwitchReservation): MMTSAudioTrackSwitchRequestResult {
        this._validateReservation(reservation);
        if (!this._active) {
            const isRecovery = (reservation.recoveryDepth || 0) === 1;
            if (!isRecovery) {
                this._queued = null;
            }
            if (reservation.targetPacketId === reservation.priorCommittedPacketId &&
                !isRecovery) {
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
        expected: MMTSAudioTrackSwitchStage | MMTSAudioTrackSwitchStage[],
        next: MMTSAudioTrackSwitchStage
    ): MMTSAudioTrackSwitchTransaction | null {
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

    public selectionResult(operation: PlaybackOperation, result: any):
        {type: 'accepted' | 'rejected' | 'stale', transaction?: MMTSAudioTrackSwitchTransaction} {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.stage !== 'selecting' || !result ||
            (result.transactionId !== undefined &&
                result.transactionId !== transaction.operation.transactionId) ||
            (result.attempt !== undefined && result.attempt !== transaction.operation.attempt) ||
            result.requestedPacketId !== transaction.targetPacketId) {
            return {type: 'stale'};
        }
        const selected = result.reason === 'selected' && result.accepted === true &&
            result.changed === true && result.selectedPacketId === transaction.targetPacketId;
        const alreadySelected = result.reason === 'already-selected' && result.accepted === true &&
            result.changed === false && result.selectedPacketId === transaction.targetPacketId;
        const rejected = ['unknown-track', 'unsupported-track', 'invalid-timeline'].includes(result.reason) &&
            result.accepted === false && result.changed === false && result.selectedPacketId === undefined;
        if (!selected && !alreadySelected && !rejected) {
            return {type: 'rejected', transaction: this._snapshotTransaction(transaction)};
        }
        if (rejected) {
            return {type: 'rejected', transaction: this._snapshotTransaction(transaction)};
        }
        transaction.internalSelectionChanged = transaction.internalSelectionChanged || result.changed === true ||
            (alreadySelected && transaction.priorCommittedPacketId !== transaction.targetPacketId);
        transaction.stage = 'waiting-init';
        this._armDeadline(transaction);
        return {type: 'accepted', transaction: this._snapshotTransaction(transaction)};
    }

    public canAdoptAttempt(operation: PlaybackOperation): boolean {
        const transaction = this._active;
        return !!transaction && !transaction.terminal &&
            isPlaybackOperation(operation) && operation.kind === 'audio-switch' &&
            isSamePlaybackTransaction(operation, transaction.operation) &&
            operation.timelineGeneration === transaction.operation.timelineGeneration &&
            operation.intentTimeMicroseconds === transaction.operation.intentTimeMicroseconds &&
            operation.packetId === transaction.targetPacketId &&
            operation.attempt === transaction.operation.attempt + 1 &&
            ['preparing', 'adaptive-retry'].includes(operation.phase) &&
            transaction.strategy === 'vod-reseek' &&
            ['preparing', 'selecting', 'waiting-init', 'collecting-overlap'].includes(
                transaction.stage
            );
    }

    public adoptAttempt(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null {
        const transaction = this._active;
        if (!transaction || !this.canAdoptAttempt(operation)) {
            return null;
        }
        transaction.operation = clonePlaybackOperation(operation);
        transaction.stage = operation.phase === 'preparing' ? 'preparing' : 'selecting';
        if (transaction.stage === 'selecting') {
            transaction.selectionMayHaveMutated = true;
        }
        this._armDeadline(transaction);
        return this._snapshotTransaction(transaction);
    }

    public setConfirmedTrackData(operation: PlaybackOperation, data: any): boolean {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal) return false;
        transaction.confirmedTrackData = data;
        return true;
    }

    public setPendingMediaInfo(operation: PlaybackOperation, data: any): boolean {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal) return false;
        transaction.pendingMediaInfo = data;
        return true;
    }

    public commit(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null {
        const transaction = this._matchingActive(operation);
        if (!transaction || transaction.terminal || transaction.stage !== 'rebuilding') {
            return null;
        }
        transaction.stage = 'committed';
        transaction.terminal = true;
        this._clearDeadline();
        this._active = null;
        return this._snapshotTransaction(transaction);
    }

    public abort(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null {
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
        requestedTimeMilliseconds?: number,
        recoveryDepth?: number,
        priorCommittedPacketId?: number
    ): MMTSAudioTrackSwitchTransaction | null {
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
        if (requestedTimeMilliseconds !== undefined) {
            if (!isFinite(requestedTimeMilliseconds) || requestedTimeMilliseconds < 0) {
                return null;
            }
            promoted.operation = rebindReservedPlaybackOperation(
                promoted.operation,
                {requestedTimeMilliseconds}
            );
        }
        promoted.operation = rebindReservedPlaybackOperation(
            promoted.operation,
            {phase: 'requested'}
        );
        if (recoveryDepth !== undefined) {
            if (!Number.isInteger(recoveryDepth) || recoveryDepth < 0 || recoveryDepth > 1) {
                return null;
            }
            promoted.recoveryDepth = recoveryDepth;
        }
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

    private _activate(reservation: MMTSAudioTrackSwitchReservation): MMTSAudioTrackSwitchTransaction {
        const transaction: MMTSAudioTrackSwitchTransaction = Object.assign(
            this._cloneReservation(reservation),
            {
                stage: 'requested' as MMTSAudioTrackSwitchStage,
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

    private _matchingActive(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null {
        const transaction = this._active;
        return transaction && isPlaybackOperation(operation) &&
            isSamePlaybackTransaction(operation, transaction.operation) &&
            operation.attempt === transaction.operation.attempt ? transaction : null;
    }

    private _armDeadline(transaction: MMTSAudioTrackSwitchTransaction): void {
        this._clearDeadline();
        const timeout = this._stageTimeout(transaction.stage);
        if (typeof timeout !== 'number' || !isFinite(timeout) || timeout <= 0) {
            throw new TypeError('Invalid MMTS audio track switch stage timeout');
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

    private _validateReservation(reservation: MMTSAudioTrackSwitchReservation): void {
        if (!reservation || !isPlaybackOperation(reservation.operation) ||
            reservation.operation.kind !== 'audio-switch' || reservation.operation.attempt !== 0 ||
            !Number.isInteger(reservation.targetPacketId) || reservation.targetPacketId < 0 ||
            !Number.isInteger(reservation.priorCommittedPacketId) || reservation.priorCommittedPacketId < 0 ||
            (reservation.recoveryDepth !== undefined &&
                (!Number.isInteger(reservation.recoveryDepth) ||
                    reservation.recoveryDepth < 0 || reservation.recoveryDepth > 1)) ||
            reservation.operation.packetId !== reservation.targetPacketId ||
            typeof reservation.operation.requestedTimeMilliseconds !== 'number' ||
            !isFinite(reservation.operation.requestedTimeMilliseconds) ||
            !['vod-reseek', 'vod-forward', 'live-forward'].includes(reservation.strategy)) {
            throw new TypeError('Invalid MMTS audio track switch reservation');
        }
        const recovery = reservation.recoveryOperation;
        if (recovery !== undefined && (!isPlaybackOperation(recovery) ||
            recovery.kind !== 'audio-switch' || recovery.attempt !== 0 ||
            recovery.packetId !== reservation.priorCommittedPacketId ||
            typeof recovery.requestedTimeMilliseconds !== 'number' ||
            !isFinite(recovery.requestedTimeMilliseconds) || recovery.requestedTimeMilliseconds < 0 ||
            recovery.timelineGeneration <= reservation.operation.timelineGeneration ||
            recovery.transactionId <= reservation.operation.transactionId)) {
            throw new TypeError('Invalid MMTS audio track switch recovery reservation');
        }
    }

    private _cloneReservation(reservation: MMTSAudioTrackSwitchReservation): MMTSAudioTrackSwitchReservation {
        return Object.assign({}, reservation, {
            operation: clonePlaybackOperation(reservation.operation),
            recoveryOperation: reservation.recoveryOperation ?
                clonePlaybackOperation(reservation.recoveryOperation) : undefined,
        });
    }

    private _snapshotReservation(reservation: MMTSAudioTrackSwitchReservation): MMTSAudioTrackSwitchReservation {
        const snapshot = this._cloneReservation(reservation);
        snapshot.operation = Object.freeze(snapshot.operation);
        if (snapshot.recoveryOperation) {
            snapshot.recoveryOperation = Object.freeze(snapshot.recoveryOperation);
        }
        return Object.freeze(snapshot);
    }

    private _snapshotTransaction(transaction: MMTSAudioTrackSwitchTransaction): MMTSAudioTrackSwitchTransaction {
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

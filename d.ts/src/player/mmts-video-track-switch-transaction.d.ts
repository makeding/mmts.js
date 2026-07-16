import { type PlaybackOperation } from '../core/playback-operation';
export type MMTSVideoTrackSwitchStage = 'requested' | 'selecting' | 'waiting-init' | 'waiting-media' | 'submitted' | 'committed' | 'aborted';
export type MMTSVideoTrackSwitchReservation = {
    operation: PlaybackOperation;
    priorCommittedPacketId: number;
    targetPacketId: number;
    recoveryDepth?: number;
    recoveryOperation?: PlaybackOperation;
};
export type MMTSVideoTrackSwitchTransaction = MMTSVideoTrackSwitchReservation & {
    stage: MMTSVideoTrackSwitchStage;
    confirmedTrackData?: any;
    pendingMediaInfo?: any;
    deadline: number;
    internalSelectionChanged: boolean;
    selectionMayHaveMutated: boolean;
    terminal: boolean;
};
export type MMTSVideoTrackSwitchRequestResult = {
    type: 'activate';
    transaction: MMTSVideoTrackSwitchTransaction;
} | {
    type: 'queued';
    reservation: MMTSVideoTrackSwitchReservation;
} | {
    type: 'same-target';
};
export type MMTSVideoTrackSelectionResult = {
    transactionId: number;
    attempt: number;
    accepted: boolean;
    changed: boolean;
    requestedPacketId: number;
    selectedPacketId?: number;
    reason: string;
};
export default class MMTSVideoTrackSwitchCoordinator {
    private _active;
    private _queued;
    private _timer;
    private _now;
    private _setTimer;
    private _clearTimer;
    private _onTimeout;
    private _stageTimeout;
    constructor(options: {
        now?: () => number;
        setTimer?: (callback: () => void, delay: number) => any;
        clearTimer?: (timer: any) => void;
        onTimeout: (transaction: MMTSVideoTrackSwitchTransaction) => void;
        stageTimeout: (stage: MMTSVideoTrackSwitchStage) => number;
    });
    get active(): MMTSVideoTrackSwitchTransaction | null;
    get queued(): MMTSVideoTrackSwitchReservation | null;
    request(reservation: MMTSVideoTrackSwitchReservation): MMTSVideoTrackSwitchRequestResult;
    transition(operation: PlaybackOperation, expected: MMTSVideoTrackSwitchStage | MMTSVideoTrackSwitchStage[], next: MMTSVideoTrackSwitchStage): MMTSVideoTrackSwitchTransaction | null;
    selectionResult(operation: PlaybackOperation, result: MMTSVideoTrackSelectionResult): {
        type: 'accepted' | 'rejected' | 'stale';
        transaction?: MMTSVideoTrackSwitchTransaction;
    };
    setConfirmedTrackData(operation: PlaybackOperation, data: any): boolean;
    setPendingMediaInfo(operation: PlaybackOperation, data: any): boolean;
    adoptAttempt(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null;
    commit(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null;
    abort(operation: PlaybackOperation): MMTSVideoTrackSwitchTransaction | null;
    promote(activePlaybackOperation: PlaybackOperation, recoveryDepth?: number, priorCommittedPacketId?: number): MMTSVideoTrackSwitchTransaction | null;
    clear(): void;
    private _activate;
    private _matchingActive;
    private _armDeadline;
    private _handleTimer;
    private _clearDeadline;
    private _validateReservation;
    private _cloneReservation;
    private _snapshotReservation;
    private _snapshotTransaction;
    private _snapshotData;
}

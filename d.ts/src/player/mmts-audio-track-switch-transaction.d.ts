import { type PlaybackOperation } from '../core/playback-operation';
export type MMTSAudioTrackSwitchStrategy = 'vod-reseek' | 'vod-forward' | 'live-forward';
export type MMTSAudioTrackSwitchStage = 'requested' | 'preparing' | 'selecting' | 'waiting-init' | 'collecting-overlap' | 'submitted' | 'rebuilding' | 'committed' | 'aborted';
export type MMTSAudioTrackSwitchReservation = {
    operation: PlaybackOperation;
    priorCommittedPacketId: number;
    targetPacketId: number;
    strategy: MMTSAudioTrackSwitchStrategy;
    resumeIntent: boolean;
    recoveryDepth?: number;
    recoveryOperation?: PlaybackOperation;
};
export type MMTSAudioTrackSwitchTransaction = MMTSAudioTrackSwitchReservation & {
    stage: MMTSAudioTrackSwitchStage;
    confirmedTrackData?: any;
    pendingMediaInfo?: any;
    deadline: number;
    internalSelectionChanged: boolean;
    selectionMayHaveMutated: boolean;
    terminal: boolean;
};
export type MMTSAudioTrackSwitchRequestResult = {
    type: 'activate';
    transaction: MMTSAudioTrackSwitchTransaction;
} | {
    type: 'queued';
    reservation: MMTSAudioTrackSwitchReservation;
} | {
    type: 'same-target';
};
export type MMTSVodAudioStartupGroupInvalidReason = 'selection-not-confirmed' | 'missing-segment' | 'invalid-segment-type' | 'missing-audio-switch' | 'mixed-operation' | 'mixed-attempt' | 'invalid-audio-window' | 'missing-video-window' | 'video-not-random-access' | 'video-not-sync' | 'coordinator-transition-rejected';
export type MMTSVodAudioStartupGroupApplyResult = {
    status: 'accepted';
} | {
    status: 'stale';
} | {
    status: 'invalid';
    reason: MMTSVodAudioStartupGroupInvalidReason;
};
export default class MMTSAudioTrackSwitchCoordinator {
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
        onTimeout: (transaction: MMTSAudioTrackSwitchTransaction) => void;
        stageTimeout: (stage: MMTSAudioTrackSwitchStage) => number;
    });
    get active(): MMTSAudioTrackSwitchTransaction | null;
    get queued(): MMTSAudioTrackSwitchReservation | null;
    request(reservation: MMTSAudioTrackSwitchReservation): MMTSAudioTrackSwitchRequestResult;
    transition(operation: PlaybackOperation, expected: MMTSAudioTrackSwitchStage | MMTSAudioTrackSwitchStage[], next: MMTSAudioTrackSwitchStage): MMTSAudioTrackSwitchTransaction | null;
    selectionResult(operation: PlaybackOperation, result: any): {
        type: 'accepted' | 'rejected' | 'stale';
        transaction?: MMTSAudioTrackSwitchTransaction;
    };
    canAdoptAttempt(operation: PlaybackOperation): boolean;
    adoptAttempt(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null;
    setConfirmedTrackData(operation: PlaybackOperation, data: any): boolean;
    setPendingMediaInfo(operation: PlaybackOperation, data: any): boolean;
    commit(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null;
    abort(operation: PlaybackOperation): MMTSAudioTrackSwitchTransaction | null;
    promote(activePlaybackOperation: PlaybackOperation, requestedTimeMilliseconds?: number, recoveryDepth?: number, priorCommittedPacketId?: number): MMTSAudioTrackSwitchTransaction | null;
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

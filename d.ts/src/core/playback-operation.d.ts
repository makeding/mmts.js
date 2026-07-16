export type PlaybackOperationKind = 'startup' | 'seek' | 'audio-switch' | 'video-switch';
export type PlaybackOperation = {
    timelineGeneration: number;
    kind: PlaybackOperationKind;
    transactionId: number;
    attempt: number;
    phase: string;
    requestedTimeMilliseconds?: number;
    packetId?: number;
};
export declare function isPlaybackOperation(value: any): value is PlaybackOperation;
export declare function clonePlaybackOperation(operation: PlaybackOperation): PlaybackOperation;
export declare function isSamePlaybackTransaction(left: PlaybackOperation, right: PlaybackOperation): boolean;
export declare function isSamePlaybackOperation(left: PlaybackOperation, right: PlaybackOperation): boolean;
export declare function canAdvancePlaybackOperation(current: PlaybackOperation | null | undefined, next: PlaybackOperation): boolean;

import {
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackOperation,
    PlaybackOperation,
} from './playback-operation';

export const DEFAULT_MMTS_STARTUP_GROUP_TIMEOUT = 45000;

export type MMTSStartupGroupFailurePhase = 'collecting' | 'appending';

export type MMTSStartupGroupFailure = {
    kind: 'startup-group',
    transactionId: number,
    playbackOperation: PlaybackOperation,
    mseBufferGeneration: number,
    phase: MMTSStartupGroupFailurePhase,
    reason: string,
    missing: string[],
    error?: any,
};

export function resolveMMTSStartupGroupTimeout(config: any): number {
    if (config == null ||
        !Object.prototype.hasOwnProperty.call(config, 'mmtsStartupGroupTimeout')) {
        return DEFAULT_MMTS_STARTUP_GROUP_TIMEOUT;
    }
    const timeout = config.mmtsStartupGroupTimeout;
    if (typeof timeout !== 'number' || !isFinite(timeout) || timeout <= 0) {
        throw new TypeError('mmtsStartupGroupTimeout must be a positive finite number');
    }
    return timeout;
}

export function createMMTSStartupGroupFailure(
    operation: PlaybackOperation,
    phase: MMTSStartupGroupFailurePhase,
    reason: string,
    missing: string[],
    error?: any
): MMTSStartupGroupFailure {
    if (!isPlaybackOperation(operation) ||
        (phase !== 'collecting' && phase !== 'appending') ||
        typeof reason !== 'string' || reason.length === 0 ||
        !Array.isArray(missing) || missing.length === 0 ||
        missing.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new TypeError('Invalid MMTS startup group failure');
    }
    const failure: MMTSStartupGroupFailure = {
        kind: 'startup-group',
        transactionId: operation.transactionId,
        playbackOperation: clonePlaybackOperation(operation),
        mseBufferGeneration: operation.timelineGeneration,
        phase,
        reason,
        missing: missing.slice(),
    };
    if (error !== undefined) {
        failure.error = error;
    }
    return failure;
}

export function isMMTSStartupGroupFailure(
    value: any,
    expectedOperation?: PlaybackOperation
): value is MMTSStartupGroupFailure {
    if (!value || value.kind !== 'startup-group' ||
        !isPlaybackOperation(value.playbackOperation) ||
        value.transactionId !== value.playbackOperation.transactionId ||
        value.mseBufferGeneration !== value.playbackOperation.timelineGeneration ||
        (value.phase !== 'collecting' && value.phase !== 'appending') ||
        typeof value.reason !== 'string' || value.reason.length === 0 ||
        !Array.isArray(value.missing) || value.missing.length === 0 ||
        value.missing.some((item: any) => typeof item !== 'string' || item.length === 0)) {
        return false;
    }
    return expectedOperation === undefined ||
        isSamePlaybackOperation(value.playbackOperation, expectedOperation);
}

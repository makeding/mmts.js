import { PlaybackOperation } from './playback-operation';
export declare const DEFAULT_MMTS_STARTUP_GROUP_TIMEOUT = 45000;
export type MMTSStartupGroupFailurePhase = 'collecting' | 'appending';
export type MMTSStartupGroupFailure = {
    kind: 'startup-group';
    transactionId: number;
    playbackOperation: PlaybackOperation;
    mseBufferGeneration: number;
    phase: MMTSStartupGroupFailurePhase;
    reason: string;
    missing: string[];
    error?: any;
};
export declare function resolveMMTSStartupGroupTimeout(config: any): number;
export declare function createMMTSStartupGroupFailure(operation: PlaybackOperation, phase: MMTSStartupGroupFailurePhase, reason: string, missing: string[], error?: any): MMTSStartupGroupFailure;
export declare function isMMTSStartupGroupFailure(value: any, expectedOperation?: PlaybackOperation): value is MMTSStartupGroupFailure;

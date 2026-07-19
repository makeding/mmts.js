export type MMTSTrackSwitchType = 'video' | 'audio';
export type MMTSSegmentDecodeRange = {
    start: number;
    end: number;
};
export type MMTSFirstPlayableWindow = {
    decodeStart: number;
    compositionStart: number;
    syncPoint: number;
    playableStart: number;
    playableEnd: number;
};
export declare const MMTS_TRACK_SWITCH_MAX_DECODE_GAP = 0.1;
export declare function getMMTSSegmentDecodeRange(segment: any): MMTSSegmentDecodeRange | null;
export declare function getMMTSFirstPlayableWindow(segment: any): MMTSFirstPlayableWindow | null;
export declare function isMMTSRandomAccessSafeVideoSegment(segment: any): boolean;
export declare function selectMMTSTrackSwitchSegmentPrefix(segments: any[], type: MMTSTrackSwitchType, targetTime: number, minimumDuration: number): any[];
export declare function validateMMTSTrackSwitchSegmentPrefix(segments: any[], type: MMTSTrackSwitchType, targetTime: number, minimumDuration: number): boolean;
export declare function canAppendMMTSLiveVideoContinuation(previousSegment: any, nextSegment: any): boolean;

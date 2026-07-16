export type BufferRange = {
    start: number;
    end: number;
};
export type BufferWindowInfo = {
    currentTime: number;
    ranges: BufferRange[];
    currentRangeIndex: number;
    currentRangeStart?: number;
    currentRangeEnd?: number;
    forwardDuration: number;
    nextRangeStart?: number;
    nextRangeEnd?: number;
    nextRangeGap?: number;
    atCurrentRangeEnd: boolean;
};
export type BufferWindowOptions = {
    tolerance?: number;
    mergeGap?: number;
    edgeTolerance?: number;
};
declare class BufferWindow {
    static inspect(buffered: TimeRanges, currentTime: number, options?: BufferWindowOptions): BufferWindowInfo;
    private static _readRanges;
    private static _readPositiveOption;
}
export default BufferWindow;

export type MMTSTrackSwitchType = 'video' | 'audio';

export type MMTSSegmentDecodeRange = {
    start: number,
    end: number,
};

export type MMTSFirstPlayableWindow = {
    decodeStart: number,
    compositionStart: number,
    syncPoint: number,
    playableStart: number,
    playableEnd: number,
};

export const MMTS_TRACK_SWITCH_MAX_DECODE_GAP = 0.1;

const MMTS_TRACK_SWITCH_TIMESTAMP_TOLERANCE = 0.001;
const MMTS_TRACK_SWITCH_COMPARISON_EPSILON = 0.000001;

function isFiniteNumber(value: any): value is number {
    return typeof value === 'number' && isFinite(value);
}

export function getMMTSSegmentDecodeRange(segment: any): MMTSSegmentDecodeRange | null {
    const info = segment && segment.info;
    const start = info && isFiniteNumber(info.beginDts) ? info.beginDts / 1000 : NaN;
    const end = info && isFiniteNumber(info.endDts) ? info.endDts / 1000 : NaN;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || end <= start) {
        return null;
    }
    return {start, end};
}

export function getMMTSFirstPlayableWindow(segment: any): MMTSFirstPlayableWindow | null {
    const range = getMMTSSegmentDecodeRange(segment);
    const window = segment && segment.firstPlayableWindow;
    if (!range || !window ||
        !isFiniteNumber(window.decodeStart) ||
        !isFiniteNumber(window.compositionStart) ||
        !isFiniteNumber(window.syncPoint) ||
        !isFiniteNumber(window.playableStart) ||
        !isFiniteNumber(window.playableEnd) ||
        Math.abs(window.decodeStart - range.start) > MMTS_TRACK_SWITCH_TIMESTAMP_TOLERANCE ||
        window.compositionStart > window.playableStart ||
        Math.abs(window.playableStart - window.syncPoint) > MMTS_TRACK_SWITCH_TIMESTAMP_TOLERANCE ||
        window.playableStart < 0 ||
        window.playableEnd <= window.playableStart) {
        return null;
    }
    return {
        decodeStart: window.decodeStart,
        compositionStart: window.compositionStart,
        syncPoint: window.syncPoint,
        playableStart: window.playableStart,
        playableEnd: window.playableEnd,
    };
}

export function isMMTSRandomAccessSafeVideoSegment(segment: any): boolean {
    const firstSample = segment && segment.info && segment.info.firstSample;
    return !!segment && segment.type === 'video' &&
        segment.mmtsRandomAccessSafe === true &&
        !!firstSample && firstSample.isSyncPoint === true &&
        getMMTSFirstPlayableWindow(segment) !== null;
}

function isDecodeContiguousContinuation(previous: MMTSSegmentDecodeRange,
                                        next: MMTSSegmentDecodeRange): boolean {
    const gap = next.start - previous.end;
    return gap >= -MMTS_TRACK_SWITCH_COMPARISON_EPSILON &&
        gap <= MMTS_TRACK_SWITCH_MAX_DECODE_GAP + MMTS_TRACK_SWITCH_COMPARISON_EPSILON &&
        next.end > previous.end;
}

function getVideoContinuationCoverageEnd(segment: any, range: MMTSSegmentDecodeRange): number {
    const info = segment && segment.info;
    let end = range.end;
    if (info && isFiniteNumber(info.endPts)) {
        end = Math.max(end, info.endPts / 1000);
    }
    const samples = info ? [info.firstSample, info.lastSample] : [];
    for (const sample of samples) {
        if (sample && isFiniteNumber(sample.pts) &&
            isFiniteNumber(sample.duration) && sample.duration >= 0) {
            end = Math.max(end, (sample.pts + sample.duration) / 1000);
        }
    }
    return end;
}

function selectMMTSTrackSwitchSegmentCount(segments: any[],
                                           type: MMTSTrackSwitchType,
                                           targetTime: number,
                                           minimumDuration: number): number {
    if (!Array.isArray(segments) || segments.length === 0 ||
        (type !== 'video' && type !== 'audio') ||
        !isFiniteNumber(targetTime) || targetTime < 0 ||
        !isFiniteNumber(minimumDuration) || minimumDuration < 0 ||
        !isFiniteNumber(targetTime + minimumDuration)) {
        return 0;
    }

    const first = segments[0];
    const firstRange = first && first.type === type ? getMMTSSegmentDecodeRange(first) : null;
    if (!firstRange) {
        return 0;
    }

    const hasExplicitPlayableWindow = type === 'video' &&
        first.firstPlayableWindow !== undefined && first.firstPlayableWindow !== null;
    const firstPlayableWindow = type === 'video' ? getMMTSFirstPlayableWindow(first) : null;
    if (hasExplicitPlayableWindow && !firstPlayableWindow) {
        return 0;
    }
    const usePresentationWindow = firstPlayableWindow !== null;
    const coverageStart = firstPlayableWindow ? firstPlayableWindow.playableStart : firstRange.start;
    let coverageEnd = firstPlayableWindow ? firstPlayableWindow.playableEnd : firstRange.end;
    const requiredEnd = targetTime + minimumDuration;
    if (targetTime + MMTS_TRACK_SWITCH_COMPARISON_EPSILON < coverageStart) {
        return 0;
    }
    if (requiredEnd <= coverageEnd + MMTS_TRACK_SWITCH_COMPARISON_EPSILON) {
        return 1;
    }

    let previousRange = firstRange;
    for (let i = 1; i < segments.length; i++) {
        const segment = segments[i];
        const range = segment && segment.type === type ? getMMTSSegmentDecodeRange(segment) : null;
        if (!range || !isDecodeContiguousContinuation(previousRange, range)) {
            return 0;
        }
        coverageEnd = usePresentationWindow ?
            Math.max(coverageEnd, getVideoContinuationCoverageEnd(segment, range)) :
            range.end;
        previousRange = range;
        if (requiredEnd <= coverageEnd + MMTS_TRACK_SWITCH_COMPARISON_EPSILON) {
            return i + 1;
        }
    }
    return 0;
}

export function selectMMTSTrackSwitchSegmentPrefix(segments: any[],
                                                   type: MMTSTrackSwitchType,
                                                   targetTime: number,
                                                   minimumDuration: number): any[] {
    const count = selectMMTSTrackSwitchSegmentCount(
        segments,
        type,
        targetTime,
        minimumDuration
    );
    return count > 0 ? segments.slice(0, count) : [];
}

export function validateMMTSTrackSwitchSegmentPrefix(segments: any[],
                                                     type: MMTSTrackSwitchType,
                                                     targetTime: number,
                                                     minimumDuration: number): boolean {
    const count = selectMMTSTrackSwitchSegmentCount(
        segments,
        type,
        targetTime,
        minimumDuration
    );
    return count > 0 && count === segments.length;
}

export function canAppendMMTSLiveVideoContinuation(previousSegment: any,
                                                   nextSegment: any): boolean {
    if (!previousSegment || previousSegment.type !== 'video' ||
        !nextSegment || nextSegment.type !== 'video') {
        return false;
    }
    const previousRange = getMMTSSegmentDecodeRange(previousSegment);
    const nextRange = getMMTSSegmentDecodeRange(nextSegment);
    return !!previousRange && !!nextRange &&
        isDecodeContiguousContinuation(previousRange, nextRange);
}

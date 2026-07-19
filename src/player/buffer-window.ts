/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type BufferRange = {
    start: number,
    end: number,
};

export type BufferWindowInfo = {
    currentTime: number,
    ranges: BufferRange[],
    currentRangeIndex: number,
    currentRangeStart?: number,
    currentRangeEnd?: number,
    forwardDuration: number,
    nextRangeStart?: number,
    nextRangeEnd?: number,
    nextRangeGap?: number,
    atCurrentRangeEnd: boolean,
};

export type BufferWindowOptions = {
    tolerance?: number,
    mergeGap?: number,
    edgeTolerance?: number,
};

class BufferWindow {

    public static inspect(buffered: TimeRanges,
                          currentTime: number,
                          options?: BufferWindowOptions): BufferWindowInfo {
        const tolerance = BufferWindow._readPositiveOption(options, 'tolerance', 0.05);
        const mergeGap = BufferWindow._readPositiveOption(options, 'mergeGap', 0.12);
        const edgeTolerance = BufferWindow._readPositiveOption(options, 'edgeTolerance', 0.2);
        const ranges = BufferWindow._readRanges(buffered, mergeGap);

        let currentRangeIndex = -1;
        let nextRangeIndex = -1;

        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];

            if (currentTime < range.start - tolerance) {
                nextRangeIndex = i;
                break;
            }

            if (currentTime >= range.start - tolerance && currentTime <= range.end + tolerance) {
                currentRangeIndex = i;
                if (i + 1 < ranges.length) {
                    nextRangeIndex = i + 1;
                }
                break;
            }
        }

        const currentRange = currentRangeIndex >= 0 ? ranges[currentRangeIndex] : null;
        const nextRange = nextRangeIndex >= 0 ? ranges[nextRangeIndex] : null;
        const forwardDuration = currentRange !== null ?
            Math.max(0, currentRange.end - Math.max(currentTime, currentRange.start)) :
            0;
        const atCurrentRangeEnd = currentRange !== null &&
            currentTime >= currentRange.end - edgeTolerance;

        return {
            currentTime,
            ranges,
            currentRangeIndex,
            currentRangeStart: currentRange !== null ? currentRange.start : undefined,
            currentRangeEnd: currentRange !== null ? currentRange.end : undefined,
            forwardDuration,
            nextRangeStart: nextRange !== null ? nextRange.start : undefined,
            nextRangeEnd: nextRange !== null ? nextRange.end : undefined,
            nextRangeGap: nextRange !== null ? Math.max(0, nextRange.start - currentTime) : undefined,
            atCurrentRangeEnd,
        };
    }

    private static _readRanges(buffered: TimeRanges, mergeGap: number): BufferRange[] {
        const ranges: BufferRange[] = [];
        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (!isFinite(start) || !isFinite(end) || end <= start) {
                continue;
            }

            const last = ranges.length > 0 ? ranges[ranges.length - 1] : null;
            if (last !== null && start <= last.end + mergeGap) {
                last.end = Math.max(last.end, end);
                continue;
            }
            ranges.push({start, end});
        }
        return ranges;
    }

    private static _readPositiveOption(options: BufferWindowOptions,
                                       key: keyof BufferWindowOptions,
                                       defaultValue: number): number {
        const value = options && options[key];
        return typeof value === 'number' && isFinite(value) && value >= 0 ?
            value :
            defaultValue;
    }

}

export default BufferWindow;

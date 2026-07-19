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

import {MMTAsset, MMTMpuExtendedTimestampDescriptor} from './mmt-si';

export interface MMTSTimestamp {
    decodingIndex: number;
    presentationIndex: number;
    dts: number;
    pts: number;
    rawDts: number;
    rawPts: number;
    timescale: number;
    presentationTimeLeapIndicator: number;
}

export interface MMTSMpuPresentationWindow {
    rawPtsStart: number;
    rawPtsEnd: number;
    timescale: number;
    presentationTimeLeapIndicator: number;
}

interface RawTimestamp {
    rawDts: number;
    rawPts: number;
    timescale: number;
    presentationIndex: number;
    presentationTimeLeapIndicator: number;
}

/** Strict ARIB STD-B60 MPU timestamp reconstruction. */
export default class MMTSTimestampTable {

    public getTimestampAtAccessUnit(asset: MMTAsset | undefined,
                                    mpuSequenceNumber: number,
                                    auIndex: number,
                                    firstDts?: number,
                                    presentationIndexes?: number[]): MMTSTimestamp | null {
        if (!Number.isInteger(auIndex) || auIndex < 0) {
            return null;
        }
        const timestamps = this.getTimestampsForMpu(
            asset,
            mpuSequenceNumber,
            firstDts,
            presentationIndexes
        );
        return timestamps !== null && auIndex < timestamps.length ? timestamps[auIndex] : null;
    }

    public getTimestampsForMpu(asset: MMTAsset | undefined,
                               mpuSequenceNumber: number,
                               firstDts?: number,
                               presentationIndexes?: number[]): MMTSTimestamp[] | null {
        if (asset === undefined ||
            asset.timestampDescriptors === undefined ||
            asset.extendedTimestampDescriptors === undefined) {
            return null;
        }
        const timestampDescriptor = asset.timestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        const extendedTimestampDescriptor = asset.extendedTimestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        if (timestampDescriptor === undefined || extendedTimestampDescriptor === undefined) {
            return null;
        }

        const rawTimestamps = this.buildDescriptorTimestamps(
            asset,
            timestampDescriptor.presentationTimeUs,
            extendedTimestampDescriptor,
            presentationIndexes
        );
        if (rawTimestamps === null || rawTimestamps.length === 0) {
            return null;
        }

        const dtsBase = firstDts !== undefined ? firstDts : rawTimestamps[0].rawDts;
        if (!Number.isFinite(dtsBase)) {
            return null;
        }
        return rawTimestamps.map((timestamp, decodingIndex) => ({
            decodingIndex,
            presentationIndex: timestamp.presentationIndex,
            dts: timestamp.rawDts - dtsBase,
            pts: timestamp.rawPts - dtsBase,
            rawDts: timestamp.rawDts,
            rawPts: timestamp.rawPts,
            timescale: timestamp.timescale,
            presentationTimeLeapIndicator: timestamp.presentationTimeLeapIndicator
        }));
    }

    public getDescriptorAccessUnitCount(asset: MMTAsset | undefined,
                                        mpuSequenceNumber: number): number | null {
        if (asset === undefined || asset.extendedTimestampDescriptors === undefined) {
            return null;
        }
        const descriptor = asset.extendedTimestampDescriptors.find((item) => {
            return item.mpuSequenceNumber === mpuSequenceNumber;
        });
        return descriptor === undefined ? null : descriptor.au.length;
    }

    public getMpuPresentationWindow(asset: MMTAsset | undefined,
                                    mpuSequenceNumber: number): MMTSMpuPresentationWindow | null {
        if (asset === undefined ||
            asset.timestampDescriptors === undefined ||
            asset.extendedTimestampDescriptors === undefined) {
            return null;
        }
        const timestampDescriptor = asset.timestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        const extendedTimestampDescriptor = asset.extendedTimestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        if (timestampDescriptor === undefined || extendedTimestampDescriptor === undefined) {
            return null;
        }

        const timescale = extendedTimestampDescriptor.timescale === undefined ?
            90000 : extendedTimestampDescriptor.timescale;
        const leapIndicator = extendedTimestampDescriptor.presentationTimeLeapIndicator === undefined ?
            0 : extendedTimestampDescriptor.presentationTimeLeapIndicator;
        if (!Number.isInteger(timescale) || timescale <= 0 ||
            !Number.isFinite(timestampDescriptor.presentationTimeUs) ||
            !Number.isInteger(leapIndicator) || leapIndicator < 0 || leapIndicator > 2 ||
            !Number.isInteger(extendedTimestampDescriptor.decodingTimeOffset) ||
            extendedTimestampDescriptor.decodingTimeOffset < 0 ||
            !Number.isInteger(extendedTimestampDescriptor.ptsOffsetType) ||
            extendedTimestampDescriptor.ptsOffsetType < 0 ||
            extendedTimestampDescriptor.ptsOffsetType > 2 ||
            extendedTimestampDescriptor.au.length === 0) {
            return null;
        }

        const rawPtsStart = this.microsecondsToTimescaleTicks(
            timestampDescriptor.presentationTimeUs,
            timescale
        );
        if (!Number.isSafeInteger(rawPtsStart)) {
            return null;
        }
        let duration = 0;
        for (let i = 0; i < extendedTimestampDescriptor.au.length; i++) {
            const accessUnit = extendedTimestampDescriptor.au[i];
            if (!Number.isInteger(accessUnit.dtsPtsOffset) || accessUnit.dtsPtsOffset < 0) {
                return null;
            }
            const offset = this.getPtsOffset(asset, extendedTimestampDescriptor, i, timescale);
            if (offset === null || offset <= 0 || !Number.isSafeInteger(duration + offset)) {
                return null;
            }
            duration += offset;
        }
        const rawPtsEnd = rawPtsStart + duration;
        if (!Number.isSafeInteger(rawPtsEnd)) {
            return null;
        }
        return {
            rawPtsStart,
            rawPtsEnd,
            timescale,
            presentationTimeLeapIndicator: leapIndicator
        };
    }

    private buildDescriptorTimestamps(asset: MMTAsset,
                                      presentationTimeUs: number,
                                      descriptor: MMTMpuExtendedTimestampDescriptor,
                                      presentationIndexes?: number[]): RawTimestamp[] | null {
        const timescale = descriptor.timescale === undefined ? 90000 : descriptor.timescale;
        const leapIndicator = descriptor.presentationTimeLeapIndicator === undefined ?
            0 : descriptor.presentationTimeLeapIndicator;
        if (!Number.isInteger(timescale) || timescale <= 0 ||
            !Number.isFinite(presentationTimeUs) ||
            !Number.isInteger(leapIndicator) || leapIndicator < 0 || leapIndicator > 2 ||
            !Number.isInteger(descriptor.decodingTimeOffset) || descriptor.decodingTimeOffset < 0 ||
            !Number.isInteger(descriptor.ptsOffsetType) || descriptor.ptsOffsetType < 0 || descriptor.ptsOffsetType > 2 ||
            descriptor.au.length === 0) {
            return null;
        }

        let indexes: number[];
        if (this.isValidPresentationIndexes(presentationIndexes, descriptor.au.length)) {
            indexes = presentationIndexes.slice();
        } else if (asset.mediaType === 'video') {
            // A video MPU may not use the decoding-order shortcut unless its
            // precondition has independently been proved.  This module never
            // guesses that condition: no complete map means no timestamps.
            return null;
        } else {
            indexes = descriptor.au.map((_au, index) => index);
        }

        const anchorPts = this.microsecondsToTimescaleTicks(presentationTimeUs, timescale);
        if (!Number.isSafeInteger(anchorPts)) {
            return null;
        }
        const timestamps: RawTimestamp[] = descriptor.au.map(() => ({
            rawDts: 0,
            rawPts: 0,
            timescale,
            presentationIndex: 0,
            presentationTimeLeapIndicator: leapIndicator
        }));
        let rawDts = anchorPts - descriptor.decodingTimeOffset;
        for (let decodingIndex = 0; decodingIndex < descriptor.au.length; decodingIndex++) {
            const descriptorAu = descriptor.au[decodingIndex];
            if (!Number.isInteger(descriptorAu.dtsPtsOffset) || descriptorAu.dtsPtsOffset < 0) {
                return null;
            }
            const timestamp = timestamps[decodingIndex];
            timestamp.rawDts = rawDts;
            timestamp.rawPts = rawDts + descriptorAu.dtsPtsOffset;
            timestamp.presentationIndex = indexes[decodingIndex];
            if (!Number.isSafeInteger(timestamp.rawDts) || !Number.isSafeInteger(timestamp.rawPts)) {
                return null;
            }

            if (decodingIndex + 1 < descriptor.au.length) {
                const ptsOffset = this.getPtsOffset(asset, descriptor, decodingIndex, timescale);
                if (ptsOffset === null || ptsOffset <= 0) {
                    return null;
                }
                rawDts += ptsOffset;
                if (!Number.isSafeInteger(rawDts)) {
                    return null;
                }
            }
        }

        for (let i = 1; i < timestamps.length; i++) {
            if (timestamps[i].rawDts < timestamps[i - 1].rawDts) {
                return null;
            }
        }
        return timestamps;
    }

    private microsecondsToTimescaleTicks(microseconds: number, timescale: number): number {
        // Multiplying an epoch-sized microsecond timestamp by 180000 first
        // exceeds the integer precision of a JavaScript Number and introduces
        // several ticks of jitter at every MPU boundary.  Split the whole
        // seconds before scaling so 60000/1001 video keeps its source cadence.
        const seconds = Math.floor(microseconds / 1000000);
        const remainder = microseconds - seconds * 1000000;
        return seconds * timescale + Math.round(remainder * timescale / 1000000);
    }

    private isValidPresentationIndexes(indexes: number[] | undefined, count: number): indexes is number[] {
        if (indexes === undefined || indexes.length !== count) {
            return false;
        }
        const seen: {[index: number]: boolean} = {};
        for (const index of indexes) {
            if (!Number.isInteger(index) || index < 0 || index >= count || seen[index]) {
                return false;
            }
            seen[index] = true;
        }
        return true;
    }

    private getPtsOffset(asset: MMTAsset,
                         descriptor: MMTMpuExtendedTimestampDescriptor,
                         auIndex: number,
                         timescale: number): number | null {
        let offset: number;
        switch (descriptor.ptsOffsetType) {
            case 0:
                offset = asset.mediaType === 'audio' ?
                    this.getAudioFrameDuration(asset.audioSamplingRateCode, timescale) :
                    this.getVideoFrameDuration(asset.videoFrameRate, timescale);
                break;
            case 1:
                offset = descriptor.defaultPtsOffset;
                break;
            case 2:
                offset = descriptor.au[auIndex].ptsOffset;
                break;
            default:
                return null;
        }
        return Number.isInteger(offset) && offset >= 0 ? offset : null;
    }

    private getVideoFrameDuration(videoFrameRate: number | undefined, timescale: number): number {
        switch (videoFrameRate) {
            case 1: return Math.round(timescale / 15);
            case 2: return Math.round(timescale * 1001 / 24000);
            case 3: return Math.round(timescale / 24);
            case 4: return Math.round(timescale / 25);
            case 5: return Math.round(timescale * 1001 / 30000);
            case 6: return Math.round(timescale / 30);
            case 7: return Math.round(timescale / 50);
            case 8: return Math.round(timescale * 1001 / 60000);
            case 9: return Math.round(timescale / 60);
            case 10: return Math.round(timescale / 100);
            case 11: return Math.round(timescale * 1001 / 120000);
            case 12: return Math.round(timescale / 120);
            default: return 0;
        }
    }

    private getAudioFrameDuration(samplingRateCode: number | undefined, timescale: number): number {
        let samplingRate = 0;
        switch (samplingRateCode) {
            case 0x01: samplingRate = 16000; break;
            case 0x02: samplingRate = 22050; break;
            case 0x03: samplingRate = 24000; break;
            case 0x05: samplingRate = 32000; break;
            case 0x06: samplingRate = 44100; break;
            case 0x07: samplingRate = 48000; break;
            default: return 0;
        }
        return Math.round(timescale * 1024 / samplingRate);
    }
}

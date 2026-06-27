/*
 * Copyright (C) 2022 magicxqq. All Rights Reserved.
 *
 * @author magicxqq <xqq@xqq.im>
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

import {MFUFragment} from '../demux/mpu';
import {MMTAsset} from '../demux/mmt-si';
import {MMTSTimestamp} from '../demux/mmts-program';
import {MMTSSubtitleData, MMTSSubtitleResource} from '../demux/mmts-track-data';
import decodeUTF8 from './utf8-conv.js';
import {readU16, readU32} from './mmts-demuxer-utils';

interface SubtitleMfuPayload {
    subsampleNumber: number;
    lastSubsampleNumber: number;
    dataType: number;
    payload: Uint8Array;
}

interface SubtitleMpuState {
    subtitle?: MMTSSubtitleData;
    resources: MMTSSubtitleResource[];
    received: {[subsampleNumber: number]: boolean};
    lastSubsampleNumber: number;
    dispatchedPartial: boolean;
}

interface MMTSSubtitleVideoTimeline {
    lastVideoDts: number;
    lastVideoPts: number;
    outputVideoDtsBase: number;
    outputVideoRawDtsBase: number;
    videoSampleIndex: number;
    droppedVideoSampleCount: number;
}

interface MMTSSubtitleAssemblerCallbacks {
    nextTimestamp(packetId: number, mpuSequenceNumber: number): MMTSTimestamp | null;
    getVideoTimeline(): MMTSSubtitleVideoTimeline;
    onSubtitleData?(subtitle: MMTSSubtitleData): void;
    logSubtitleData?(subtitle: MMTSSubtitleData): void;
}

export default class MMTSSubtitleAssembler {

    private callbacks_: MMTSSubtitleAssemblerCallbacks;
    private states_: {[key: string]: SubtitleMpuState} = {};

    public constructor(callbacks: MMTSSubtitleAssemblerCallbacks) {
        this.callbacks_ = callbacks;
    }

    public destroy(): void {
        this.callbacks_ = null;
        this.states_ = null;
    }

    public processMfuUnit(packetId: number,
                          asset: MMTAsset,
                          mpuSequenceNumber: number,
                          fragment: MFUFragment,
                          unit: Uint8Array): void {
        const payloadUnit = this.extractMfuPayload(unit);
        if (payloadUnit === null) {
            return;
        }

        if (payloadUnit.subsampleNumber === 0 && payloadUnit.dataType !== 0) {
            return;
        }

        const state = this.getMpuState(packetId, mpuSequenceNumber, payloadUnit.lastSubsampleNumber);

        if (payloadUnit.subsampleNumber !== 0) {
            state.resources = state.resources.filter((resource) => resource.index !== payloadUnit.subsampleNumber);
            state.resources.push({
                index: payloadUnit.subsampleNumber,
                subsampleNumber: payloadUnit.subsampleNumber,
                dataType: payloadUnit.dataType,
                data: payloadUnit.payload,
                len: payloadUnit.payload.byteLength
            });
            state.received[payloadUnit.subsampleNumber] = true;
            this.dispatchMpu(packetId, mpuSequenceNumber, state, false);
            return;
        }

        const subtitle = new MMTSSubtitleData();
        subtitle.packetId = packetId;
        subtitle.assetType = asset.assetType;
        subtitle.codec = asset.codec || 'ttml';
        subtitle.language = asset.language;
        subtitle.mpuSequenceNumber = mpuSequenceNumber;
        subtitle.sampleNumber = fragment.sampleNumber;
        subtitle.data = payloadUnit.payload;
        subtitle.len = payloadUnit.payload.byteLength;
        subtitle.text = decodeUTF8(payloadUnit.payload);
        subtitle.subtitleTimingMode = asset.subtitleTimingMode;
        subtitle.subtitleReferenceStartTime = asset.subtitleReferenceStartTimeUs !== undefined
            ? Math.floor(asset.subtitleReferenceStartTimeUs / 1000)
            : undefined;

        const timestamp = this.callbacks_.nextTimestamp(packetId, mpuSequenceNumber);
        if (timestamp !== null) {
            subtitle.rawPts = Math.floor(timestamp.rawPts * 1000 / timestamp.timescale);
            subtitle.rawDts = Math.floor(timestamp.rawDts * 1000 / timestamp.timescale);
            subtitle.pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
            subtitle.dts = Math.floor(timestamp.dts * 1000 / timestamp.timescale);
        }

        state.subtitle = subtitle;
        state.received[0] = true;
        this.dispatchMpu(packetId, mpuSequenceNumber, state, true);
    }

    public flush(): void {
        Object.keys(this.states_).forEach((key) => {
            const state = this.states_[key];
            if (state === undefined) {
                return;
            }

            const parts = key.split(':');
            this.dispatchMpu(Number(parts[0]), Number(parts[1]), state, true);
        });
    }

    private extractMfuPayload(unit: Uint8Array): SubtitleMfuPayload | null {
        if (unit.byteLength < 7) {
            return null;
        }

        let offset = 0;
        offset += 2; // subtitle_tag + subtitle_sequence_number
        const subsampleNumber = unit[offset++];
        const lastSubsampleNumber = unit[offset++];
        const flags = unit[offset++];
        const dataType = flags >> 4;
        const lengthExtFlag = ((flags >> 3) & 0x01) !== 0;
        const subsampleInfoListFlag = ((flags >> 2) & 0x01) !== 0;

        const dataSizeLength = lengthExtFlag ? 4 : 2;
        if (offset + dataSizeLength > unit.byteLength) {
            return null;
        }

        const dataSize = lengthExtFlag ? readU32(unit, offset) : readU16(unit, offset);
        offset += dataSizeLength;

        if (subsampleNumber === 0 && lastSubsampleNumber > 0 && subsampleInfoListFlag) {
            const entrySize = lengthExtFlag ? 5 : 3;
            const skipSize = lastSubsampleNumber * entrySize;
            if (offset + skipSize > unit.byteLength) {
                return null;
            }
            offset += skipSize;
        }

        if (offset + dataSize > unit.byteLength) {
            return null;
        }

        return {
            subsampleNumber,
            lastSubsampleNumber,
            dataType,
            payload: unit.subarray(offset, offset + dataSize)
        };
    }

    private getMpuState(packetId: number,
                        mpuSequenceNumber: number,
                        lastSubsampleNumber: number): SubtitleMpuState {
        const key = this.stateKey(packetId, mpuSequenceNumber);
        let state = this.states_[key];
        if (state === undefined) {
            state = {
                resources: [],
                received: {},
                lastSubsampleNumber,
                dispatchedPartial: false
            };
            this.states_[key] = state;
        } else if (lastSubsampleNumber > state.lastSubsampleNumber) {
            state.lastSubsampleNumber = lastSubsampleNumber;
        }
        this.pruneStates(packetId, mpuSequenceNumber);
        return state;
    }

    private dispatchMpu(packetId: number,
                        mpuSequenceNumber: number,
                        state: SubtitleMpuState,
                        allowPartial: boolean): void {
        if (!state.subtitle) {
            return;
        }

        const complete = this.isMpuComplete(state);
        if (!complete && (!allowPartial || state.dispatchedPartial)) {
            return;
        }
        if (!this.alignTimestampToVideoTimeline(state.subtitle)) {
            return;
        }

        const timeline = this.callbacks_.getVideoTimeline();
        if (state.subtitle.subtitleTimingMode === 0x02 &&
            state.subtitle.subtitleReferenceStartTime !== undefined &&
            timeline.outputVideoRawDtsBase < 0) {
            return;
        }

        if (timeline.lastVideoDts >= 0 && timeline.outputVideoDtsBase >= 0) {
            state.subtitle.videoMediaDts = timeline.lastVideoDts - timeline.outputVideoDtsBase;
        }
        if (timeline.lastVideoPts >= 0 && timeline.outputVideoDtsBase >= 0) {
            state.subtitle.videoMediaPts = timeline.lastVideoPts - timeline.outputVideoDtsBase;
        }
        state.subtitle.videoRawDtsBase =
            timeline.outputVideoRawDtsBase >= 0 ? timeline.outputVideoRawDtsBase : undefined;
        state.subtitle.videoDtsBase =
            timeline.outputVideoDtsBase >= 0 ? timeline.outputVideoDtsBase : undefined;
        if (state.subtitle.subtitleReferenceStartTime !== undefined && timeline.outputVideoRawDtsBase >= 0) {
            state.subtitle.subtitleReferenceStartMediaTime =
                state.subtitle.subtitleReferenceStartTime - timeline.outputVideoRawDtsBase;
        }
        state.subtitle.videoSampleIndex = timeline.videoSampleIndex;
        state.subtitle.droppedVideoSampleCount = timeline.droppedVideoSampleCount;
        state.subtitle.resources = state.resources.slice().sort((a, b) => a.index - b.index);
        state.subtitle.resourcesComplete = complete;
        if (this.callbacks_.onSubtitleData) {
            this.callbacks_.onSubtitleData(state.subtitle);
        }
        if (this.callbacks_.logSubtitleData) {
            this.callbacks_.logSubtitleData(state.subtitle);
        }
        if (complete) {
            delete this.states_[this.stateKey(packetId, mpuSequenceNumber)];
        } else {
            state.dispatchedPartial = true;
        }
    }

    private alignTimestampToVideoTimeline(subtitle: MMTSSubtitleData): boolean {
        if (subtitle.rawPts === undefined || subtitle.rawDts === undefined) {
            return true;
        }

        const timeline = this.callbacks_.getVideoTimeline();
        if (timeline.outputVideoRawDtsBase < 0) {
            return false;
        }

        subtitle.pts = subtitle.rawPts - timeline.outputVideoRawDtsBase;
        subtitle.dts = subtitle.rawDts - timeline.outputVideoRawDtsBase;
        return true;
    }

    private isMpuComplete(state: SubtitleMpuState): boolean {
        for (let i = 0; i <= state.lastSubsampleNumber; i++) {
            if (!state.received[i]) {
                return false;
            }
        }
        return true;
    }

    private pruneStates(packetId: number, currentMpuSequenceNumber: number): void {
        Object.keys(this.states_).forEach((key) => {
            const parts = key.split(':');
            if (Number(parts[0]) === packetId && Number(parts[1]) + 4 < currentMpuSequenceNumber) {
                delete this.states_[key];
            }
        });
    }

    private stateKey(packetId: number, mpuSequenceNumber: number): string {
        return `${packetId}:${mpuSequenceNumber}`;
    }
}

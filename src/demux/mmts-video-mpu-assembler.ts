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

import {H265NaluHVC1, H265NaluType} from './h265';
import {isH265VclNalu} from '../utils/mmts-demuxer-utils';

export interface MMTSVideoAccessUnit {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number | undefined;
    auIndex: number;
    filePosition: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
}

export interface MMTSVideoNaluInput {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number | undefined;
    offset: number | undefined;
    filePosition: number;
    nalu: H265NaluHVC1;
    keyframe: boolean;
    isVcl: boolean;
}

interface VideoAccessUnitState {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number | undefined;
    auIndex?: number;
    filePosition: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
    hasVcl: boolean;
}

interface VideoAccessUnitIndexState {
    mpuSequenceNumber?: number;
    nextAuIndex: number;
}

interface VideoMpuState {
    mpuSequenceNumber?: number;
    currentAccessUnit: VideoAccessUnitState | null;
    completedAccessUnits: MMTSVideoAccessUnit[];
}

export interface MMTSVideoMpuDiscontinuityResult {
    completed: MMTSVideoAccessUnit[];
    dropped: MMTSVideoAccessUnit | null;
}

export default class MMTSVideoMpuAssembler {

    private mpu_states_by_packet_id_: {[packetId: number]: VideoMpuState} = {};
    private access_unit_index_states_by_packet_id_: {[packetId: number]: VideoAccessUnitIndexState} = {};

    public destroy(): void {
        this.mpu_states_by_packet_id_ = null;
        this.access_unit_index_states_by_packet_id_ = null;
    }

    public reset(): void {
        this.mpu_states_by_packet_id_ = {};
        this.access_unit_index_states_by_packet_id_ = {};
    }

    public appendNalu(input: MMTSVideoNaluInput): MMTSVideoAccessUnit[] {
        const prepared = this.prepareMpuState(input.packetId, input.mpuSequenceNumber);
        const state = prepared.state;
        const completed = prepared.completed;

        if (state.currentAccessUnit !== null &&
            state.currentAccessUnit.sampleNumber !== input.sampleNumber) {
            this.flushCurrentAccessUnit(state);
        }

        if (input.nalu.type === H265NaluType.kSliceAUD &&
            state.currentAccessUnit !== null) {
            this.flushCurrentAccessUnit(state);
        }

        if (state.currentAccessUnit !== null &&
            state.currentAccessUnit.hasVcl &&
            this.shouldStartFallbackAccessUnit(input)) {
            this.flushCurrentAccessUnit(state);
        }

        if (state.currentAccessUnit === null) {
            state.currentAccessUnit = {
                packetId: input.packetId,
                mpuSequenceNumber: input.mpuSequenceNumber,
                sampleNumber: input.sampleNumber,
                auIndex: undefined,
                filePosition: input.filePosition,
                units: [],
                length: 0,
                keyframe: false,
                hasVcl: false
            };
        }

        if (input.isVcl && !state.currentAccessUnit.hasVcl) {
            state.currentAccessUnit.auIndex = this.allocateAccessUnitIndex(
                input.packetId,
                input.mpuSequenceNumber,
                input.sampleNumber
            );
        }

        state.currentAccessUnit.units.push(input.nalu);
        state.currentAccessUnit.filePosition = Math.min(state.currentAccessUnit.filePosition, input.filePosition);
        state.currentAccessUnit.length += input.nalu.byteLength || input.nalu.data.byteLength;
        state.currentAccessUnit.keyframe = state.currentAccessUnit.keyframe || input.keyframe;
        state.currentAccessUnit.hasVcl = state.currentAccessUnit.hasVcl || input.isVcl;

        return completed;
    }

    public appendStandaloneAccessUnit(packetId: number,
                                      mpuSequenceNumber: number,
                                      sampleNumber: number | undefined,
                                      filePosition: number,
                                      units: H265NaluHVC1[],
                                      length: number,
                                      keyframe: boolean): MMTSVideoAccessUnit[] {
        const prepared = this.prepareMpuState(packetId, mpuSequenceNumber);
        const state = prepared.state;
        if (state.currentAccessUnit !== null) {
            this.flushCurrentAccessUnit(state);
        }

        state.completedAccessUnits.push({
            packetId,
            mpuSequenceNumber,
            sampleNumber,
            auIndex: this.allocateAccessUnitIndex(packetId, mpuSequenceNumber, sampleNumber),
            filePosition,
            units,
            length,
            keyframe
        });
        return prepared.completed;
    }

    public flush(): MMTSVideoAccessUnit[] {
        const completed: MMTSVideoAccessUnit[] = [];
        for (const key of Object.keys(this.mpu_states_by_packet_id_)) {
            const state = this.mpu_states_by_packet_id_[Number(key)];
            this.flushCurrentAccessUnit(state);
            completed.push(...this.takeCompletedAccessUnits(state));
        }
        return completed.sort(this.compareAccessUnits);
    }

    public reconcileMpuDiscontinuity(packetId: number,
                                     mpuSequenceNumber: number,
                                     sampleNumber: number | undefined): MMTSVideoMpuDiscontinuityResult {
        const state = this.getMpuState(packetId);
        const accessUnit = state.currentAccessUnit;
        if (accessUnit === null) {
            return {
                completed: this.takeCompletedAccessUnits(state),
                dropped: null
            };
        }

        const sameSample = sampleNumber !== undefined &&
            accessUnit.packetId === packetId &&
            accessUnit.mpuSequenceNumber === mpuSequenceNumber &&
            accessUnit.sampleNumber === sampleNumber;

        if (!sameSample && accessUnit.hasVcl) {
            this.flushCurrentAccessUnit(state);
            return {
                completed: this.takeCompletedAccessUnits(state),
                dropped: null
            };
        }

        state.currentAccessUnit = null;
        return {
            completed: this.takeCompletedAccessUnits(state),
            dropped: this.completeAccessUnit(accessUnit)
        };
    }

    public getNextAccessUnitIndex(packetId: number, mpuSequenceNumber: number): number {
        const state = this.access_unit_index_states_by_packet_id_[packetId];
        if (state === undefined || state.mpuSequenceNumber !== mpuSequenceNumber) {
            return 0;
        }
        return state.nextAuIndex;
    }

    private getMpuState(packetId: number): VideoMpuState {
        let state = this.mpu_states_by_packet_id_[packetId];
        if (state === undefined) {
            state = {
                mpuSequenceNumber: undefined,
                currentAccessUnit: null,
                completedAccessUnits: []
            };
            this.mpu_states_by_packet_id_[packetId] = state;
        }
        return state;
    }

    private prepareMpuState(packetId: number,
                            mpuSequenceNumber: number): {state: VideoMpuState, completed: MMTSVideoAccessUnit[]} {
        const state = this.getMpuState(packetId);
        const completed: MMTSVideoAccessUnit[] = [];
        if (state.mpuSequenceNumber !== undefined && state.mpuSequenceNumber !== mpuSequenceNumber) {
            this.flushCurrentAccessUnit(state);
            completed.push(...this.takeCompletedAccessUnits(state));
            state.mpuSequenceNumber = mpuSequenceNumber;
        } else if (state.mpuSequenceNumber === undefined) {
            state.mpuSequenceNumber = mpuSequenceNumber;
        }
        return {state, completed};
    }

    private flushCurrentAccessUnit(state: VideoMpuState): void {
        const accessUnit = state.currentAccessUnit;
        state.currentAccessUnit = null;
        const completed = this.completeAccessUnit(accessUnit);
        if (completed !== null) {
            state.completedAccessUnits.push(completed);
        }
    }

    private takeCompletedAccessUnits(state: VideoMpuState): MMTSVideoAccessUnit[] {
        if (state.completedAccessUnits.length === 0) {
            return [];
        }
        const accessUnits = state.completedAccessUnits;
        state.completedAccessUnits = [];
        return accessUnits.sort(this.compareAccessUnits);
    }

    private compareAccessUnits(a: MMTSVideoAccessUnit, b: MMTSVideoAccessUnit): number {
        if (a.packetId !== b.packetId) {
            return a.packetId - b.packetId;
        }
        if (a.mpuSequenceNumber !== b.mpuSequenceNumber) {
            return a.mpuSequenceNumber - b.mpuSequenceNumber;
        }
        if (a.auIndex !== b.auIndex) {
            return a.auIndex - b.auIndex;
        }
        return a.filePosition - b.filePosition;
    }

    private completeAccessUnit(accessUnit: VideoAccessUnitState | null): MMTSVideoAccessUnit | null {
        if (accessUnit === null ||
            accessUnit.units.length === 0 ||
            !accessUnit.hasVcl ||
            accessUnit.auIndex === undefined) {
            return null;
        }

        return {
            packetId: accessUnit.packetId,
            mpuSequenceNumber: accessUnit.mpuSequenceNumber,
            sampleNumber: accessUnit.sampleNumber,
            auIndex: accessUnit.auIndex,
            filePosition: accessUnit.filePosition,
            units: accessUnit.units,
            length: accessUnit.length,
            keyframe: accessUnit.keyframe
        };
    }

    private isH265FirstSliceSegment(nalu: H265NaluHVC1): boolean {
        if (nalu === null || !isH265VclNalu(nalu.type)) {
            return false;
        }

        const byteLength = nalu.byteLength || nalu.data.byteLength;
        const unitLength = byteLength - 4;
        if (unitLength + 4 > byteLength || unitLength < 3) {
            return false;
        }

        const firstSliceByte = nalu.readUint8 ? nalu.readUint8(6) : nalu.data[6];
        return firstSliceByte !== undefined && (firstSliceByte & 0x80) !== 0;
    }

    private shouldStartFallbackAccessUnit(input: MMTSVideoNaluInput): boolean {
        if (!this.shouldUseFallbackBoundary(input.sampleNumber)) {
            return false;
        }
        return input.isVcl && this.isH265FirstSliceSegment(input.nalu);
    }

    private shouldUseFallbackBoundary(sampleNumber: number | undefined): boolean {
        return sampleNumber === undefined || sampleNumber <= 0;
    }

    private allocateAccessUnitIndex(packetId: number,
                                    mpuSequenceNumber: number,
                                    sampleNumber: number | undefined): number {
        let state = this.access_unit_index_states_by_packet_id_[packetId];
        if (state === undefined || state.mpuSequenceNumber !== mpuSequenceNumber) {
            state = {
                mpuSequenceNumber,
                nextAuIndex: 0
            };
            this.access_unit_index_states_by_packet_id_[packetId] = state;
        }

        if (sampleNumber !== undefined && sampleNumber > 0) {
            const auIndex = sampleNumber - 1;
            if (state.nextAuIndex <= auIndex) {
                state.nextAuIndex = auIndex + 1;
            }
            return auIndex;
        }

        return state.nextAuIndex++;
    }

}

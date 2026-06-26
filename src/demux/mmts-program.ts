import MMTSI, {
    MMTAsset,
    MMTConditionalAccessInfo,
    MMTMpuExtendedTimestampDescriptor,
    MMTMpuTimestampDescriptor,
    SignalingFragmentState
} from './mmt-si';
import {MMTPPacket} from './mmtp';
import MPU, {FragmentationIndicator, MFUFragment, MPUInfo} from './mpu';

interface MFUFragmentState {
    data: number[];
    lastSeq: number;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

interface MMTSStreamState {
    lastMpuSequenceNumber?: number;
    auCount: number;
    firstDts?: number;
}

interface MMTSPacketContinuityState {
    lastSeq?: number;
}

interface AssembledMFU {
    unit: Uint8Array;
    randomAccess: boolean;
}

const MAX_TIMESTAMP_DESCRIPTORS = 100;

export interface MMTSTimestamp {
    dts: number;
    pts: number;
    rawDts: number;
    rawPts: number;
    timescale: number;
}

export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: Uint8Array;
}

export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    discontinuity: boolean;
    units: MMTSCompletedMfuUnit[];
}

class MMTSProgram {

    private signaling_fragment_states_: {[packetId: number]: SignalingFragmentState} = {};
    private mfu_fragment_states_: {[packetId: number]: MFUFragmentState} = {};
    private mmtp_packet_continuity_states_: {[packetId: number]: MMTSPacketContinuityState} = {};
    private assets_by_packet_id_: {[packetId: number]: MMTAsset} = {};
    private stream_states_by_packet_id_: {[packetId: number]: MMTSStreamState} = {};
    private conditional_access_info_: MMTConditionalAccessInfo = {};

    public destroy(): void {
        this.signaling_fragment_states_ = null;
        this.mfu_fragment_states_ = null;
        this.mmtp_packet_continuity_states_ = null;
        this.assets_by_packet_id_ = null;
        this.stream_states_by_packet_id_ = null;
        this.conditional_access_info_ = null;
    }

    public parseSignalingPacket(packet: MMTPPacket): MMTAsset[] {
        let state = this.signaling_fragment_states_[packet.packetId];
        if (state === undefined) {
            state = MMTSI.createFragmentState();
            this.signaling_fragment_states_[packet.packetId] = state;
        }

        const result = MMTSI.parseSignalingPayload(
            packet.payload,
            packet.packetSequenceNumber,
            state
        );

        const assets: MMTAsset[] = [];
        const conditionalAccessUpdated = this.mergeConditionalAccessInfos(result.conditionalAccessInfos);
        for (const asset of result.assets) {
            if (asset.packetId >= 0) {
                const merged = this.mergeAsset(asset);
                this.applyConditionalAccessDefaults(merged);
                assets.push(merged);
            } else {
                assets.push(asset);
            }
        }

        if (conditionalAccessUpdated) {
            const seen: {[packetId: number]: boolean} = {};
            for (const asset of assets) {
                if (asset.packetId >= 0) {
                    seen[asset.packetId] = true;
                }
            }
            for (const key of Object.keys(this.assets_by_packet_id_)) {
                const asset = this.assets_by_packet_id_[Number(key)];
                this.applyConditionalAccessDefaults(asset);
                if (!seen[asset.packetId]) {
                    assets.push(asset);
                }
            }
        }

        return assets;
    }

    public parseMpuPacket(packet: MMTPPacket): MMTSParsedMpu | null {
        const discontinuity = this.checkMmtpPacketDiscontinuity(packet.packetId, packet.packetSequenceNumber);
        const mpu = MPU.parse(packet.payload);
        if (mpu === null) {
            return null;
        }

        const units: MMTSCompletedMfuUnit[] = [];
        for (const fragment of mpu.mfuFragments) {
            const assembled = this.assembleMfuFragment(packet, mpu.mpuSequenceNumber, fragment);
            if (assembled !== null) {
                units.push({
                    fragment,
                    mpuSequenceNumber: mpu.mpuSequenceNumber,
                    randomAccess: assembled.randomAccess,
                    unit: assembled.unit
                });
            }
        }

        return {
            asset: this.assets_by_packet_id_[packet.packetId],
            mpu,
            discontinuity,
            units
        };
    }

    public getAsset(packetId: number): MMTAsset | undefined {
        return this.assets_by_packet_id_[packetId];
    }

    public resetMpuPacketState(packetId: number): void {
        delete this.mmtp_packet_continuity_states_[packetId];
        delete this.mfu_fragment_states_[packetId];
    }

    public get streamCount(): number {
        return Object.keys(this.assets_by_packet_id_).length;
    }

    public nextTimestamp(packetId: number, mpuSequenceNumber: number): MMTSTimestamp | null {
        const asset = this.assets_by_packet_id_[packetId];
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

        const state = this.getStreamState(packetId);
        if (state.lastMpuSequenceNumber !== mpuSequenceNumber) {
            state.lastMpuSequenceNumber = mpuSequenceNumber;
            state.auCount = 0;
        }

        const auIndex = state.auCount;
        if (auIndex >= extendedTimestampDescriptor.au.length) {
            return null;
        }

        const timescale = extendedTimestampDescriptor.timescale || 90000;
        let dts = Math.round(timestampDescriptor.presentationTimeUs * timescale / 1000000) -
            extendedTimestampDescriptor.decodingTimeOffset;
        for (let i = 0; i < auIndex; i++) {
            dts += this.getPtsOffset(asset, extendedTimestampDescriptor.au[i].ptsOffset, timescale);
        }

        const pts = dts + extendedTimestampDescriptor.au[auIndex].dtsPtsOffset;
        const rawDts = dts;
        const rawPts = pts;
        if (state.firstDts === undefined) {
            state.firstDts = dts;
        }
        dts -= state.firstDts;
        const normalizedPts = pts - state.firstDts;
        state.auCount++;
        return {dts, pts: normalizedPts, rawDts, rawPts, timescale};
    }

    private getPtsOffset(asset: MMTAsset, ptsOffset: number, timescale: number): number {
        if (ptsOffset > 0 || asset.mediaType !== 'video') {
            return ptsOffset;
        }

        return this.getVideoFrameDuration(asset.videoFrameRate, timescale);
    }

    private getVideoFrameDuration(videoFrameRate: number | undefined, timescale: number): number {
        switch (videoFrameRate) {
            case 1:
                return Math.round(timescale / 15);
            case 2:
                return Math.round(timescale * 1001 / 24000);
            case 3:
                return Math.round(timescale / 24);
            case 4:
                return Math.round(timescale / 25);
            case 5:
                return Math.round(timescale * 1001 / 30000);
            case 6:
                return Math.round(timescale / 30);
            case 7:
                return Math.round(timescale / 50);
            case 8:
                return Math.round(timescale * 1001 / 60000);
            case 9:
                return Math.round(timescale / 60);
            case 10:
                return Math.round(timescale / 100);
            case 11:
                return Math.round(timescale * 1001 / 120000);
            case 12:
                return Math.round(timescale / 120);
            default:
                return 0;
        }
    }

    private getStreamState(packetId: number): MMTSStreamState {
        let state = this.stream_states_by_packet_id_[packetId];
        if (state === undefined) {
            state = {auCount: 0};
            this.stream_states_by_packet_id_[packetId] = state;
        }
        return state;
    }

    private mergeConditionalAccessInfos(infos: MMTConditionalAccessInfo[]): boolean {
        let updated = false;
        for (const info of infos) {
            updated = this.copyDefinedConditionalAccessFields(info, this.conditional_access_info_) || updated;
        }
        return updated;
    }

    private applyConditionalAccessDefaults(asset: MMTAsset): void {
        this.copyMissingConditionalAccessFields(this.conditional_access_info_, asset);
    }

    private copyDefinedConditionalAccessFields(source: MMTConditionalAccessInfo,
                                               target: MMTConditionalAccessInfo): boolean {
        let updated = false;
        const keys = [
            'accessControlCaSystemId',
            'accessControlLocationType',
            'accessControlPacketId',
            'accessControlPrivateData',
            'scramblerLayerType',
            'scrambleSystemId',
            'scramblerPrivateData',
            'messageAuthenticationLayerType',
            'messageAuthenticationSystemId',
            'messageAuthenticationPrivateData'
        ];
        for (const key of keys) {
            if (source[key] !== undefined && target[key] !== source[key]) {
                target[key] = source[key];
                updated = true;
            }
        }
        return updated;
    }

    private copyMissingConditionalAccessFields(source: MMTConditionalAccessInfo,
                                               target: MMTConditionalAccessInfo): void {
        const keys = [
            'accessControlCaSystemId',
            'accessControlLocationType',
            'accessControlPacketId',
            'accessControlPrivateData',
            'scramblerLayerType',
            'scrambleSystemId',
            'scramblerPrivateData',
            'messageAuthenticationLayerType',
            'messageAuthenticationSystemId',
            'messageAuthenticationPrivateData'
        ];
        for (const key of keys) {
            if (target[key] === undefined && source[key] !== undefined) {
                target[key] = source[key];
            }
        }
    }

    private mergeAsset(asset: MMTAsset): MMTAsset {
        const existing = this.assets_by_packet_id_[asset.packetId];
        if (existing === undefined) {
            this.mergeTimestampDescriptors(asset, undefined, undefined);
            this.assets_by_packet_id_[asset.packetId] = asset;
            return asset;
        }

        const oldTimestampDescriptors = existing.timestampDescriptors;
        const oldExtendedTimestampDescriptors = existing.extendedTimestampDescriptors;
        const state = this.stream_states_by_packet_id_[asset.packetId];

        Object.assign(existing, asset);
        this.mergeTimestampDescriptors(
            existing,
            oldTimestampDescriptors,
            oldExtendedTimestampDescriptors,
            state ? state.lastMpuSequenceNumber : undefined
        );
        return existing;
    }

    private mergeTimestampDescriptors(asset: MMTAsset,
                                      oldTimestampDescriptors?: MMTMpuTimestampDescriptor[],
                                      oldExtendedTimestampDescriptors?: MMTMpuExtendedTimestampDescriptor[],
                                      lastMpuSequenceNumber?: number): void {
        asset.timestampDescriptors = this.mergeDescriptorCache(
            oldTimestampDescriptors,
            asset.timestampDescriptors,
            lastMpuSequenceNumber
        );
        asset.timestampDescriptorCount = asset.timestampDescriptors ? asset.timestampDescriptors.length : 0;

        asset.extendedTimestampDescriptors = this.mergeDescriptorCache(
            oldExtendedTimestampDescriptors,
            asset.extendedTimestampDescriptors,
            lastMpuSequenceNumber
        );
        asset.extendedTimestampDescriptorCount = asset.extendedTimestampDescriptors ?
            asset.extendedTimestampDescriptors.length : 0;
    }

    private mergeDescriptorCache<T extends {mpuSequenceNumber: number}>(oldDescriptors: T[] | undefined,
                                                                        newDescriptors: T[] | undefined,
                                                                        lastMpuSequenceNumber?: number): T[] | undefined {
        const cache = oldDescriptors ? oldDescriptors.slice() : [];
        if (newDescriptors === undefined || newDescriptors.length === 0) {
            return cache.length > 0 ? cache : undefined;
        }

        for (const descriptor of newDescriptors) {
            if (lastMpuSequenceNumber !== undefined && descriptor.mpuSequenceNumber < lastMpuSequenceNumber) {
                continue;
            }

            const existingIndex = cache.findIndex((cached) => {
                return cached.mpuSequenceNumber === descriptor.mpuSequenceNumber;
            });
            if (existingIndex >= 0) {
                cache[existingIndex] = descriptor;
                continue;
            }

            const reusableIndex = cache.findIndex((cached) => {
                return lastMpuSequenceNumber !== undefined && cached.mpuSequenceNumber < lastMpuSequenceNumber;
            });
            if (reusableIndex >= 0) {
                cache[reusableIndex] = descriptor;
                continue;
            }

            if (cache.length >= MAX_TIMESTAMP_DESCRIPTORS) {
                cache[this.findOldestDescriptorIndex(cache)] = descriptor;
            } else {
                cache.push(descriptor);
            }
        }

        return cache.length > 0 ? cache : undefined;
    }

    private findOldestDescriptorIndex<T extends {mpuSequenceNumber: number}>(descriptors: T[]): number {
        let oldestIndex = 0;
        for (let i = 1; i < descriptors.length; i++) {
            if (descriptors[i].mpuSequenceNumber < descriptors[oldestIndex].mpuSequenceNumber) {
                oldestIndex = i;
            }
        }
        return oldestIndex;
    }

    private assembleMfuFragment(packet: MMTPPacket,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment): AssembledMFU | null {
        const packetId = packet.packetId;
        const packetSequenceNumber = packet.packetSequenceNumber;
        let state = this.mfu_fragment_states_[packetId];
        if (state === undefined) {
            state = {
                data: [],
                lastSeq: 0,
                mpuSequenceNumber: 0,
                randomAccess: false,
                state: 'init'
            };
            this.mfu_fragment_states_[packetId] = state;
        }

        if (state.state === 'init') {
            state.state = 'skip';
        } else if (((state.lastSeq + 1) >>> 0) !== packetSequenceNumber) {
            state.data = [];
            state.randomAccess = false;
            state.state = 'skip';
        }
        state.lastSeq = packetSequenceNumber;

        if (state.mpuSequenceNumber !== 0 && state.mpuSequenceNumber !== mpuSequenceNumber && state.state === 'in-fragment') {
            state.data = [];
            state.randomAccess = false;
            state.state = 'skip';
        }
        state.mpuSequenceNumber = mpuSequenceNumber;

        switch (fragment.fragmentationIndicator) {
            case FragmentationIndicator.NotFragmented:
                state.data = [];
                state.randomAccess = false;
                state.state = 'not-started';
                return {
                    unit: fragment.payload,
                    randomAccess: packet.rapFlag
                };
            case FragmentationIndicator.FirstFragment:
                if (state.state === 'in-fragment') {
                    state.data = [];
                    state.randomAccess = false;
                    state.state = 'skip';
                    return null;
                }
                state.data = Array.prototype.slice.call(fragment.payload);
                state.randomAccess = packet.rapFlag;
                state.state = 'in-fragment';
                return null;
            case FragmentationIndicator.MiddleFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                state.randomAccess = state.randomAccess || packet.rapFlag;
                this.appendToState(state, fragment.payload);
                return null;
            case FragmentationIndicator.LastFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                state.randomAccess = state.randomAccess || packet.rapFlag;
                this.appendToState(state, fragment.payload);
                const completeUnit = new Uint8Array(state.data);
                const randomAccess = state.randomAccess;
                state.data = [];
                state.randomAccess = false;
                state.state = 'not-started';
                return {
                    unit: completeUnit,
                    randomAccess
                };
            default:
                return null;
        }
    }

    private checkMmtpPacketDiscontinuity(packetId: number, packetSequenceNumber: number): boolean {
        let state = this.mmtp_packet_continuity_states_[packetId];
        if (state === undefined) {
            state = {};
            this.mmtp_packet_continuity_states_[packetId] = state;
        }

        const lastSeq = state.lastSeq;
        state.lastSeq = packetSequenceNumber;
        if (lastSeq === undefined) {
            return false;
        }

        return ((lastSeq + 1) >>> 0) !== packetSequenceNumber;
    }

    private appendToState(state: MFUFragmentState, data: Uint8Array): void {
        for (let i = 0; i < data.byteLength; i++) {
            state.data.push(data[i]);
        }
    }

}

export default MMTSProgram;

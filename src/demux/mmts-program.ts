import MMTSI, {MMTAsset, SignalingFragmentState} from './mmt-si';
import {MMTPPacket} from './mmtp';
import MPU, {FragmentationIndicator, MFUFragment, MPUInfo} from './mpu';

interface MFUFragmentState {
    data: number[];
    lastSeq: number;
    mpuSequenceNumber: number;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

interface MMTSStreamState {
    lastMpuSequenceNumber?: number;
    auCount: number;
    firstDts?: number;
}

export interface MMTSTimestamp {
    dts: number;
    pts: number;
    timescale: number;
}

export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    mpuSequenceNumber: number;
    unit: Uint8Array;
}

export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    units: MMTSCompletedMfuUnit[];
}

class MMTSProgram {

    private signaling_fragment_states_: {[packetId: number]: SignalingFragmentState} = {};
    private mfu_fragment_states_: {[packetId: number]: MFUFragmentState} = {};
    private assets_by_packet_id_: {[packetId: number]: MMTAsset} = {};
    private stream_states_by_packet_id_: {[packetId: number]: MMTSStreamState} = {};

    public destroy(): void {
        this.signaling_fragment_states_ = null;
        this.mfu_fragment_states_ = null;
        this.assets_by_packet_id_ = null;
        this.stream_states_by_packet_id_ = null;
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

        for (const asset of result.assets) {
            if (asset.packetId >= 0) {
                this.assets_by_packet_id_[asset.packetId] = asset;
            }
        }

        return result.assets;
    }

    public parseMpuPacket(packet: MMTPPacket): MMTSParsedMpu | null {
        const mpu = MPU.parse(packet.payload);
        if (mpu === null) {
            return null;
        }

        const units: MMTSCompletedMfuUnit[] = [];
        for (const fragment of mpu.mfuFragments) {
            const unit = this.assembleMfuFragment(
                packet.packetId,
                packet.packetSequenceNumber,
                mpu.mpuSequenceNumber,
                fragment
            );
            if (unit !== null) {
                units.push({
                    fragment,
                    mpuSequenceNumber: mpu.mpuSequenceNumber,
                    unit
                });
            }
        }

        return {
            asset: this.assets_by_packet_id_[packet.packetId],
            mpu,
            units
        };
    }

    public getAsset(packetId: number): MMTAsset | undefined {
        return this.assets_by_packet_id_[packetId];
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
            dts += extendedTimestampDescriptor.au[i].ptsOffset;
        }

        const pts = dts + extendedTimestampDescriptor.au[auIndex].dtsPtsOffset;
        if (state.firstDts === undefined) {
            state.firstDts = dts;
        }
        dts -= state.firstDts;
        const normalizedPts = pts - state.firstDts;
        state.auCount++;
        return {dts, pts: normalizedPts, timescale};
    }

    private getStreamState(packetId: number): MMTSStreamState {
        let state = this.stream_states_by_packet_id_[packetId];
        if (state === undefined) {
            state = {auCount: 0};
            this.stream_states_by_packet_id_[packetId] = state;
        }
        return state;
    }

    private assembleMfuFragment(packetId: number,
                                packetSequenceNumber: number,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment): Uint8Array | null {
        let state = this.mfu_fragment_states_[packetId];
        if (state === undefined) {
            state = {
                data: [],
                lastSeq: 0,
                mpuSequenceNumber: 0,
                state: 'init'
            };
            this.mfu_fragment_states_[packetId] = state;
        }

        if (state.state === 'init') {
            state.state = 'skip';
        } else if (((state.lastSeq + 1) >>> 0) !== packetSequenceNumber) {
            state.data = [];
            state.state = 'skip';
        }
        state.lastSeq = packetSequenceNumber;

        if (state.mpuSequenceNumber !== 0 && state.mpuSequenceNumber !== mpuSequenceNumber && state.state === 'in-fragment') {
            state.data = [];
            state.state = 'skip';
        }
        state.mpuSequenceNumber = mpuSequenceNumber;

        switch (fragment.fragmentationIndicator) {
            case FragmentationIndicator.NotFragmented:
                state.data = [];
                state.state = 'not-started';
                return fragment.payload;
            case FragmentationIndicator.FirstFragment:
                if (state.state === 'in-fragment') {
                    state.data = [];
                    state.state = 'skip';
                    return null;
                }
                state.data = Array.prototype.slice.call(fragment.payload);
                state.state = 'in-fragment';
                return null;
            case FragmentationIndicator.MiddleFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                this.appendToState(state, fragment.payload);
                return null;
            case FragmentationIndicator.LastFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                this.appendToState(state, fragment.payload);
                const completeUnit = new Uint8Array(state.data);
                state.data = [];
                state.state = 'not-started';
                return completeUnit;
            default:
                return null;
        }
    }

    private appendToState(state: MFUFragmentState, data: Uint8Array): void {
        for (let i = 0; i < data.byteLength; i++) {
            state.data.push(data[i]);
        }
    }

}

export default MMTSProgram;

import MMTSI, {
    MMTAsset,
    MMTConditionalAccessInfo,
    MMTMpuExtendedTimestampDescriptor,
    MMTMpuTimestampDescriptor,
    MMTParsedPackageTable,
    SignalingFragmentState
} from './mmt-si';
import {MMTPPacket} from './mmtp';
import MPU, {FragmentationIndicator, MFUFragment, MPUInfo} from './mpu';
import MMTSTimestampTable, {
    MMTSMpuPresentationWindow,
    MMTSTimestamp
} from './mmts-timestamp-table';

export {MMTSMpuPresentationWindow, MMTSTimestamp};

interface MFUFragmentState {
    chunks: Uint8Array[];
    length: number;
    firstFragment?: MFUFragment;
    firstFilePosition?: number;
    randomAccess: boolean;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

interface MMTSStreamState {
    lastMpuSequenceNumber?: number;
    firstDts?: number;
}

interface MMTSPacketContinuityState {
    lastSeq?: number;
}

interface MPTSubsetState {
    version: number;
    mode: number;
    nextSubsetIndex: number;
    tablesBySubsetIndex: {[subsetIndex: number]: MMTParsedPackageTable};
    processedSubsetIndexes: {[subsetIndex: number]: boolean};
}

export interface MMTSPacketLossInfo {
    packetSequenceGap: boolean;
    fragmentedUnitDropped: boolean;
    duplicatePacket: boolean;
    expectedSeq?: number;
    actualSeq?: number;
}

interface AssembledMFU {
    fragment: MFUFragment;
    filePosition: number;
    unit: MMTSByteSpanList;
    randomAccess: boolean;
}

export class MMTSByteSpanList implements Iterable<number> {
    public readonly spans: Uint8Array[];
    public readonly byteLength: number;

    public constructor(spans: Uint8Array[], byteLength?: number) {
        this.spans = spans.filter((span) => span.byteLength > 0);
        this.byteLength = byteLength !== undefined ? byteLength :
            this.spans.reduce((length, span) => length + span.byteLength, 0);
        const actualLength = this.spans.reduce((length, span) => length + span.byteLength, 0);
        if (actualLength !== this.byteLength) {
            throw new RangeError('MMTS byte span length mismatch');
        }
    }

    public readUint8(index: number): number | undefined {
        if (!Number.isInteger(index) || index < 0 || index >= this.byteLength) {
            return undefined;
        }
        let offset = index;
        for (const span of this.spans) {
            if (offset < span.byteLength) {
                return span[offset];
            }
            offset -= span.byteLength;
        }
        return undefined;
    }

    public readUint32BE(index: number): number | undefined {
        const a = this.readUint8(index);
        const b = this.readUint8(index + 1);
        const c = this.readUint8(index + 2);
        const d = this.readUint8(index + 3);
        if (a === undefined || b === undefined || c === undefined || d === undefined) {
            return undefined;
        }
        return ((a * 0x1000000) + (b << 16) + (c << 8) + d) >>> 0;
    }

    public copyRange(offset: number, length: number): Uint8Array {
        if (!Number.isInteger(offset) || !Number.isInteger(length) ||
            offset < 0 || length < 0 || offset + length > this.byteLength) {
            throw new RangeError('Invalid MMTS byte span range');
        }
        if (length === 0) {
            return new Uint8Array(0);
        }
        let sourceOffset = offset;
        for (const span of this.spans) {
            if (sourceOffset >= span.byteLength) {
                sourceOffset -= span.byteLength;
                continue;
            }
            if (sourceOffset + length <= span.byteLength) {
                return span.subarray(sourceOffset, sourceOffset + length);
            }
            break;
        }
        const result = new Uint8Array(length);
        this.copyTo(result, 0, offset, length);
        return result;
    }

    public copyTo(target: Uint8Array,
                  targetOffset: number = 0,
                  sourceOffset: number = 0,
                  length: number = this.byteLength - sourceOffset): void {
        if (!Number.isInteger(targetOffset) || !Number.isInteger(sourceOffset) ||
            !Number.isInteger(length) || targetOffset < 0 || sourceOffset < 0 ||
            length < 0 || sourceOffset + length > this.byteLength ||
            targetOffset + length > target.byteLength) {
            throw new RangeError('Invalid MMTS byte span copy');
        }
        let skip = sourceOffset;
        let remaining = length;
        let writeOffset = targetOffset;
        for (const span of this.spans) {
            if (remaining === 0) {
                break;
            }
            if (skip >= span.byteLength) {
                skip -= span.byteLength;
                continue;
            }
            const copyLength = Math.min(remaining, span.byteLength - skip);
            target.set(span.subarray(skip, skip + copyLength), writeOffset);
            writeOffset += copyLength;
            remaining -= copyLength;
            skip = 0;
        }
    }

    public toUint8Array(): Uint8Array {
        return this.copyRange(0, this.byteLength);
    }

    public *[Symbol.iterator](): Iterator<number> {
        for (const span of this.spans) {
            for (let i = 0; i < span.byteLength; i++) {
                yield span[i];
            }
        }
    }
}

const MAX_TIMESTAMP_DESCRIPTORS = 100;

export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    filePosition: number;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: MMTSByteSpanList;
}

export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    discontinuity: boolean;
    loss: MMTSPacketLossInfo;
    units: MMTSCompletedMfuUnit[];
}

class MMTSProgram {

    private signaling_fragment_states_: {[packetId: number]: SignalingFragmentState} = {};
    private mfu_fragment_states_: {[key: string]: MFUFragmentState} = {};
    private mmtp_packet_continuity_states_: {[packetId: number]: MMTSPacketContinuityState} = {};
    private mpt_subset_states_: {[packageId: string]: MPTSubsetState} = {};
    private presentation_indexes_by_packet_and_mpu_: {[key: string]: number[]} = {};
    private assets_by_packet_id_: {[packetId: number]: MMTAsset} = {};
    private stream_states_by_packet_id_: {[packetId: number]: MMTSStreamState} = {};
    private conditional_access_info_: MMTConditionalAccessInfo = {};
    private timestamp_table_: MMTSTimestampTable = new MMTSTimestampTable();

    public destroy(): void {
        this.signaling_fragment_states_ = null;
        this.mfu_fragment_states_ = null;
        this.mmtp_packet_continuity_states_ = null;
        this.mpt_subset_states_ = null;
        this.presentation_indexes_by_packet_and_mpu_ = null;
        this.assets_by_packet_id_ = null;
        this.stream_states_by_packet_id_ = null;
        this.conditional_access_info_ = null;
        this.timestamp_table_ = null;
    }

    public parseSignalingPacket(packet: MMTPPacket, filePosition: number = 0): MMTAsset[] {
        let state = this.signaling_fragment_states_[packet.packetId];
        if (state === undefined) {
            state = MMTSI.createFragmentState();
            this.signaling_fragment_states_[packet.packetId] = state;
        }

        const result = MMTSI.parseSignalingPayload(
            packet.payload,
            packet.packetSequenceNumber,
            state,
            filePosition
        );

        this.annotateTimestampDescriptorSources(result.assets, result.sourceFilePosition);
        for (const table of result.mptTables || []) {
            this.annotateTimestampDescriptorSources(table.assets, result.sourceFilePosition);
        }

        const acceptedMptTables = this.acceptMptTables(result.mptTables || []);
        const assets: MMTAsset[] = [];
        const conditionalAccessInfos = result.conditionalAccessInfos.slice();
        const parsedAssets = result.assets.slice();
        for (const table of acceptedMptTables) {
            conditionalAccessInfos.push(...table.conditionalAccessInfos);
            parsedAssets.push(...table.assets);
        }
        const conditionalAccessUpdated = this.mergeConditionalAccessInfos(conditionalAccessInfos);
        for (const asset of parsedAssets) {
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

    private acceptMptTables(tables: MMTParsedPackageTable[]): MMTParsedPackageTable[] {
        const accepted: MMTParsedPackageTable[] = [];
        for (const table of tables) {
            if (table.tableId === 0x20) {
                delete this.mpt_subset_states_[table.packageId];
                accepted.push(table);
                continue;
            }

            if (table.mode === 3) {
                continue;
            }
            const subsetIndex = table.tableId - 0x11;
            let state = this.mpt_subset_states_[table.packageId];
            if (state === undefined || state.version !== table.version || state.mode !== table.mode) {
                state = {
                    version: table.version,
                    mode: table.mode,
                    nextSubsetIndex: 0,
                    tablesBySubsetIndex: {},
                    processedSubsetIndexes: {}
                };
                this.mpt_subset_states_[table.packageId] = state;
            }
            state.tablesBySubsetIndex[subsetIndex] = table;

            if (state.mode === 0) {
                while (state.tablesBySubsetIndex[state.nextSubsetIndex] !== undefined) {
                    const next = state.tablesBySubsetIndex[state.nextSubsetIndex];
                    if (!state.processedSubsetIndexes[state.nextSubsetIndex]) {
                        accepted.push(next);
                        state.processedSubsetIndexes[state.nextSubsetIndex] = true;
                    }
                    state.nextSubsetIndex++;
                }
            } else if (state.mode === 1) {
                if (state.tablesBySubsetIndex[0] === undefined) {
                    continue;
                }
                for (const key of Object.keys(state.tablesBySubsetIndex)) {
                    const index = Number(key);
                    if (!state.processedSubsetIndexes[index]) {
                        accepted.push(state.tablesBySubsetIndex[index]);
                        state.processedSubsetIndexes[index] = true;
                    }
                }
            } else {
                accepted.push(table);
                state.processedSubsetIndexes[subsetIndex] = true;
            }
        }
        return accepted;
    }

    public parseMpuPacket(packet: MMTPPacket, filePosition: number = 0): MMTSParsedMpu | null {
        const loss = this.checkMmtpPacketContinuity(packet.packetId, packet.packetSequenceNumber);
        if (loss.duplicatePacket) {
            return null;
        }
        const mpu = MPU.parse(packet.payload);
        if (mpu === null) {
            return null;
        }
        if (loss.packetSequenceGap) {
            this.resetMfuFragmentStatesForPacket(packet.packetId, loss);
        }

        const units: MMTSCompletedMfuUnit[] = [];
        for (const fragment of mpu.mfuFragments) {
            const assembled = this.assembleMfuFragment(packet, mpu.mpuSequenceNumber, fragment, filePosition, loss);
            if (assembled !== null) {
                units.push({
                    fragment: assembled.fragment,
                    filePosition: assembled.filePosition,
                    mpuSequenceNumber: mpu.mpuSequenceNumber,
                    randomAccess: assembled.randomAccess,
                    unit: assembled.unit
                });
            }
        }

        return {
            asset: this.assets_by_packet_id_[packet.packetId],
            mpu,
            discontinuity: loss.packetSequenceGap,
            loss,
            units
        };
    }

    public getAsset(packetId: number): MMTAsset | undefined {
        return this.assets_by_packet_id_[packetId];
    }

    public resetMpuPacketState(packetId: number): void {
        delete this.mmtp_packet_continuity_states_[packetId];
        this.resetMfuFragmentStatesForPacket(packetId);
    }

    public resetMediaState(preserveTimestampBase: boolean = false): void {
        const streamStates = this.stream_states_by_packet_id_;
        this.signaling_fragment_states_ = {};
        this.mfu_fragment_states_ = {};
        this.mmtp_packet_continuity_states_ = {};
        this.mpt_subset_states_ = {};
        this.stream_states_by_packet_id_ = {};
        this.presentation_indexes_by_packet_and_mpu_ = {};
        for (const key of Object.keys(this.assets_by_packet_id_)) {
            const asset = this.assets_by_packet_id_[Number(key)];
            asset.timestampDescriptors = undefined;
            asset.extendedTimestampDescriptors = undefined;
            asset.timestampDescriptorCount = 0;
            asset.extendedTimestampDescriptorCount = 0;
        }
        if (preserveTimestampBase) {
            for (const key of Object.keys(streamStates)) {
                const state = streamStates[Number(key)];
                if (state.firstDts !== undefined) {
                    this.stream_states_by_packet_id_[Number(key)] = {
                        firstDts: state.firstDts
                    };
                }
            }
        }
    }

    public hasTimestampBase(packetId: number): boolean {
        const state = this.stream_states_by_packet_id_[packetId];
        return state !== undefined && state.firstDts !== undefined;
    }

    public get streamCount(): number {
        return Object.keys(this.assets_by_packet_id_).length;
    }

    public getTimestampAtAccessUnit(packetId: number,
                                    mpuSequenceNumber: number,
                                    auIndex: number): MMTSTimestamp | null {
        return this.readTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex, true);
    }

    public peekTimestampAtAccessUnit(packetId: number,
                                     mpuSequenceNumber: number,
                                     auIndex: number): MMTSTimestamp | null {
        return this.readTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex, false);
    }

    public getDescriptorAccessUnitCount(packetId: number, mpuSequenceNumber: number): number | null {
        return this.timestamp_table_.getDescriptorAccessUnitCount(
            this.assets_by_packet_id_[packetId],
            mpuSequenceNumber
        );
    }

    public getMpuPresentationWindow(packetId: number,
                                    mpuSequenceNumber: number): MMTSMpuPresentationWindow | null {
        return this.timestamp_table_.getMpuPresentationWindow(
            this.assets_by_packet_id_[packetId],
            mpuSequenceNumber
        );
    }

    public getTimestampRestartFilePosition(packetId: number,
                                           mpuSequenceNumber: number): number | null {
        const asset = this.assets_by_packet_id_[packetId];
        if (asset === undefined ||
            asset.timestampDescriptors === undefined ||
            asset.extendedTimestampDescriptors === undefined) {
            return null;
        }
        const timestamp = asset.timestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        const extended = asset.extendedTimestampDescriptors.find((descriptor) => {
            return descriptor.mpuSequenceNumber === mpuSequenceNumber;
        });
        if (timestamp === undefined || extended === undefined ||
            typeof timestamp.sourceFilePosition !== 'number' ||
            !Number.isSafeInteger(timestamp.sourceFilePosition) || timestamp.sourceFilePosition < 0 ||
            typeof extended.sourceFilePosition !== 'number' ||
            !Number.isSafeInteger(extended.sourceFilePosition) || extended.sourceFilePosition < 0) {
            return null;
        }
        return Math.min(timestamp.sourceFilePosition, extended.sourceFilePosition);
    }

    public getTimestampsForMpu(packetId: number,
                               mpuSequenceNumber: number,
                               presentationIndexes: number[]): MMTSTimestamp[] | null {
        return this.readTimestampsForMpu(packetId, mpuSequenceNumber, presentationIndexes, true);
    }

    public peekTimestampsForMpu(packetId: number,
                                mpuSequenceNumber: number,
                                presentationIndexes: number[]): MMTSTimestamp[] | null {
        return this.readTimestampsForMpu(packetId, mpuSequenceNumber, presentationIndexes, false);
    }

    public setPresentationIndexes(packetId: number, mpuSequenceNumber: number, indexes: number[]): void {
        this.presentation_indexes_by_packet_and_mpu_[this.presentationIndexKey(packetId, mpuSequenceNumber)] = indexes.slice();
    }

    public clearPresentationIndexes(packetId: number, mpuSequenceNumber: number): void {
        delete this.presentation_indexes_by_packet_and_mpu_[this.presentationIndexKey(packetId, mpuSequenceNumber)];
    }

    private readTimestampAtAccessUnit(packetId: number,
                                      mpuSequenceNumber: number,
                                      auIndex: number,
                                      establishBase: boolean): MMTSTimestamp | null {
        const asset = this.assets_by_packet_id_[packetId];
        const state = this.getStreamState(packetId);
        const timestamp = this.timestamp_table_.getTimestampAtAccessUnit(
            asset,
            mpuSequenceNumber,
            auIndex,
            state.firstDts,
            this.presentation_indexes_by_packet_and_mpu_[this.presentationIndexKey(packetId, mpuSequenceNumber)]
        );
        if (timestamp === null) {
            return null;
        }
        if (establishBase) {
            if (state.firstDts === undefined) {
                state.firstDts = timestamp.rawDts;
            }
            if (state.lastMpuSequenceNumber === undefined ||
                mpuSequenceNumber > state.lastMpuSequenceNumber) {
                state.lastMpuSequenceNumber = mpuSequenceNumber;
            }
        }
        return timestamp;
    }

    private readTimestampsForMpu(packetId: number,
                                 mpuSequenceNumber: number,
                                 presentationIndexes: number[],
                                 establishBase: boolean): MMTSTimestamp[] | null {
        const asset = this.assets_by_packet_id_[packetId];
        const state = this.getStreamState(packetId);
        const timestamps = this.timestamp_table_.getTimestampsForMpu(
            asset,
            mpuSequenceNumber,
            state.firstDts,
            presentationIndexes
        );
        if (timestamps === null || timestamps.length === 0) {
            return null;
        }
        if (establishBase) {
            if (state.firstDts === undefined) {
                state.firstDts = timestamps[0].rawDts;
            }
            if (state.lastMpuSequenceNumber === undefined ||
                mpuSequenceNumber > state.lastMpuSequenceNumber) {
                state.lastMpuSequenceNumber = mpuSequenceNumber;
            }
            this.setPresentationIndexes(packetId, mpuSequenceNumber, presentationIndexes);
        }
        return timestamps;
    }

    private getStreamState(packetId: number): MMTSStreamState {
        let state = this.stream_states_by_packet_id_[packetId];
        if (state === undefined) {
            state = {};
            this.stream_states_by_packet_id_[packetId] = state;
        }
        return state;
    }

    private presentationIndexKey(packetId: number, mpuSequenceNumber: number): string {
        return `${packetId}:${mpuSequenceNumber}`;
    }

    private mergeConditionalAccessInfos(infos: MMTConditionalAccessInfo[]): boolean {
        let updated = false;
        for (const info of infos) {
            updated = this.copyDefinedConditionalAccessFields(info, this.conditional_access_info_) || updated;
        }
        return updated;
    }

    private annotateTimestampDescriptorSources(assets: MMTAsset[], filePosition?: number): void {
        if (typeof filePosition !== 'number' || !Number.isSafeInteger(filePosition) || filePosition < 0) {
            return;
        }
        for (const asset of assets) {
            for (const descriptor of asset.timestampDescriptors || []) {
                descriptor.sourceFilePosition = filePosition;
            }
            for (const descriptor of asset.extendedTimestampDescriptors || []) {
                descriptor.sourceFilePosition = filePosition;
            }
        }
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
                                fragment: MFUFragment,
                                filePosition: number,
                                loss: MMTSPacketLossInfo): AssembledMFU | null {
        const packetId = packet.packetId;
        const stateKey = this.getMfuFragmentStateKey(packetId, mpuSequenceNumber, fragment);
        let state = this.mfu_fragment_states_[stateKey];
        if (state === undefined) {
            state = {
                chunks: [],
                length: 0,
                firstFragment: undefined,
                firstFilePosition: undefined,
                randomAccess: false,
                state: 'init'
            };
            this.mfu_fragment_states_[stateKey] = state;
        }

        if (state.state === 'init') {
            state.state = 'skip';
        }

        switch (fragment.fragmentationIndicator) {
            case FragmentationIndicator.NotFragmented:
                if (state.state === 'in-fragment') {
                    loss.fragmentedUnitDropped = true;
                }
                this.resetMfuFragmentState(state);
                delete this.mfu_fragment_states_[stateKey];
                return {
                    fragment,
                    filePosition,
                    unit: new MMTSByteSpanList([fragment.payload]),
                    randomAccess: packet.rapFlag
                };
            case FragmentationIndicator.FirstFragment:
                if (state.state === 'in-fragment') {
                    loss.fragmentedUnitDropped = true;
                    this.resetMfuFragmentState(state);
                }
                state.chunks = [fragment.payload];
                state.length = fragment.payload.byteLength;
                state.firstFragment = fragment;
                state.firstFilePosition = filePosition;
                state.randomAccess = packet.rapFlag;
                state.state = 'in-fragment';
                return null;
            case FragmentationIndicator.MiddleFragment:
                if (state.state !== 'in-fragment') {
                    loss.fragmentedUnitDropped = true;
                    this.resetMfuFragmentState(state);
                    state.state = 'skip';
                    return null;
                }
                state.randomAccess = state.randomAccess || packet.rapFlag;
                this.appendToState(state, fragment.payload);
                return null;
            case FragmentationIndicator.LastFragment:
                if (state.state !== 'in-fragment') {
                    loss.fragmentedUnitDropped = true;
                    this.resetMfuFragmentState(state);
                    state.state = 'skip';
                    return null;
                }
                state.randomAccess = state.randomAccess || packet.rapFlag;
                this.appendToState(state, fragment.payload);
                const completeUnit = new MMTSByteSpanList(state.chunks, state.length);
                const firstFragment = state.firstFragment;
                const completeFragment: MFUFragment = {
                    ...fragment,
                    // Completed MFUs may span multiple source buffers. The full
                    // payload lives in completeUnit; keep only the first view in
                    // the fragment metadata so the hot path stays scatter/gather.
                    payload: completeUnit.spans[0],
                    sampleNumber: firstFragment && firstFragment.sampleNumber !== undefined ?
                        firstFragment.sampleNumber : fragment.sampleNumber,
                    offset: firstFragment && firstFragment.offset !== undefined ?
                        firstFragment.offset : fragment.offset,
                    nalUnitLength: firstFragment && firstFragment.nalUnitLength !== undefined ?
                        firstFragment.nalUnitLength : fragment.nalUnitLength
                };
                const randomAccess = state.randomAccess;
                const firstFilePosition = state.firstFilePosition !== undefined ? state.firstFilePosition : filePosition;
                this.resetMfuFragmentState(state);
                state.state = 'not-started';
                delete this.mfu_fragment_states_[stateKey];
                return {
                    fragment: completeFragment,
                    filePosition: firstFilePosition,
                    unit: completeUnit,
                    randomAccess
                };
            default:
                return null;
        }
    }

    private getMfuFragmentStateKey(packetId: number,
                                   mpuSequenceNumber: number,
                                   fragment: MFUFragment): string {
        return [
            packetId,
            mpuSequenceNumber,
            fragment.sampleNumber !== undefined ? fragment.sampleNumber : 'n',
            fragment.offset !== undefined ? fragment.offset : 'n'
        ].join(':');
    }

    private resetMfuFragmentStatesForPacket(packetId: number, loss?: MMTSPacketLossInfo): void {
        const prefix = `${packetId}:`;
        for (const key of Object.keys(this.mfu_fragment_states_)) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            const state = this.mfu_fragment_states_[key];
            if (loss !== undefined && state.state === 'in-fragment') {
                loss.fragmentedUnitDropped = true;
            }
            delete this.mfu_fragment_states_[key];
        }
    }

    private checkMmtpPacketContinuity(packetId: number, packetSequenceNumber: number): MMTSPacketLossInfo {
        let state = this.mmtp_packet_continuity_states_[packetId];
        if (state === undefined) {
            state = {};
            this.mmtp_packet_continuity_states_[packetId] = state;
        }

        const lastSeq = state.lastSeq;
        const loss: MMTSPacketLossInfo = {
            packetSequenceGap: false,
            fragmentedUnitDropped: false,
            duplicatePacket: false
        };
        if (lastSeq === undefined) {
            state.lastSeq = packetSequenceNumber;
            return loss;
        }

        if (lastSeq === packetSequenceNumber) {
            loss.duplicatePacket = true;
            return loss;
        }

        state.lastSeq = packetSequenceNumber;
        const expectedSeq = (lastSeq + 1) >>> 0;
        if (expectedSeq !== packetSequenceNumber) {
            loss.packetSequenceGap = true;
            loss.expectedSeq = expectedSeq;
            loss.actualSeq = packetSequenceNumber;
        }

        return loss;
    }

    private appendToState(state: MFUFragmentState, data: Uint8Array): void {
        state.chunks.push(data);
        state.length += data.byteLength;
    }

    private resetMfuFragmentState(state: MFUFragmentState): void {
        state.chunks = [];
        state.length = 0;
        state.firstFragment = undefined;
        state.firstFilePosition = undefined;
        state.randomAccess = false;
    }

}

export default MMTSProgram;

export const enum MMTTableId {
    MmtPackageTable = 0x20,
    PackageListTable = 0x80,
    MhEit = 0x8b
}

export const enum MMTMessageId {
    Pa = 0x0000,
    M2Section = 0x8000
}

export interface MMTAsset {
    packetId: number;
    assetType: string;
    mediaType: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
    codec?: string;
    language?: string;
    componentTag?: number;
    audioComponentType?: number;
    audioComponentTag?: number;
    audioStreamType?: number;
    audioSimulcastGroupTag?: number;
    audioMainComponent?: boolean;
    audioQualityIndicator?: number;
    audioSamplingRateCode?: number;
    dataComponentId?: number;
    dataComponentInfo?: Uint8Array;
    timestampDescriptorCount?: number;
    extendedTimestampDescriptorCount?: number;
    timestampDescriptors?: MMTMpuTimestampDescriptor[];
    extendedTimestampDescriptors?: MMTMpuExtendedTimestampDescriptor[];
}

export interface MMTMpuTimestampDescriptor {
    mpuSequenceNumber: number;
    presentationTimeUs: number;
}

export interface MMTMpuExtendedTimestampDescriptor {
    mpuSequenceNumber: number;
    timescale?: number;
    decodingTimeOffset: number;
    au: MMTMpuTimestampOffset[];
}

export interface MMTMpuTimestampOffset {
    dtsPtsOffset: number;
    ptsOffset: number;
}

export interface MMTSIResult {
    assets: MMTAsset[];
    messages: number[];
    tables: number[];
}

export interface SignalingFragmentState {
    data: number[];
    lastSeq: number;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

const NOT_FRAGMENTED = 0;
const FIRST_FRAGMENT = 1;
const MIDDLE_FRAGMENT = 2;
const LAST_FRAGMENT = 3;

const MPU_TIMESTAMP_DESCRIPTOR = 0x0001;
const VIDEO_COMPONENT_DESCRIPTOR = 0x8010;
const MH_STREAM_IDENTIFICATION_DESCRIPTOR = 0x8011;
const MH_AUDIO_COMPONENT_DESCRIPTOR = 0x8014;
const MH_DATA_COMPONENT_DESCRIPTOR = 0x8020;
const MPU_EXTENDED_TIMESTAMP_DESCRIPTOR = 0x8026;

export default class MMTSI {

    public static parseSignalingPayload(payload: Uint8Array,
                                        packetSequenceNumber: number,
                                        fragmentState: SignalingFragmentState): MMTSIResult {
        const result: MMTSIResult = {assets: [], messages: [], tables: []};
        const reader = new ByteReader(payload);
        if (!reader.canRead(2)) {
            return result;
        }

        const flags = reader.readU8();
        const fragmentationIndicator = flags >> 6;
        const lengthExtensionFlag = ((flags >> 1) & 0x01) !== 0;
        const aggregationFlag = (flags & 0x01) !== 0;
        reader.skip(1); // fragment_counter

        MMTSI.checkFragmentState(fragmentState, packetSequenceNumber);

        if (!aggregationFlag) {
            const completed = MMTSI.assembleFragment(
                fragmentState,
                fragmentationIndicator,
                reader.remainingBytes()
            );
            if (completed !== null) {
                MMTSI.parseSignalingMessage(completed, result);
            }
            return result;
        }

        if (fragmentationIndicator !== NOT_FRAGMENTED) {
            return result;
        }

        while (reader.bytesLeft() > 0) {
            if (!reader.canRead(lengthExtensionFlag ? 4 : 2)) {
                break;
            }
            const length = lengthExtensionFlag ? reader.readU32() : reader.readU16();
            if (!reader.canRead(length)) {
                break;
            }
            MMTSI.parseSignalingMessage(reader.readBytes(length), result);
        }

        return result;
    }

    public static createFragmentState(): SignalingFragmentState {
        return {
            data: [],
            lastSeq: 0,
            state: 'init'
        };
    }

    private static checkFragmentState(state: SignalingFragmentState,
                                      packetSequenceNumber: number): void {
        if (state.state === 'init') {
            state.state = 'skip';
        } else if (((state.lastSeq + 1) >>> 0) !== packetSequenceNumber) {
            state.data = [];
            state.state = 'skip';
        }
        state.lastSeq = packetSequenceNumber;
    }

    private static assembleFragment(state: SignalingFragmentState,
                                    fragmentationIndicator: number,
                                    data: Uint8Array): Uint8Array | null {
        switch (fragmentationIndicator) {
            case NOT_FRAGMENTED:
                if (state.state === 'in-fragment') {
                    state.data = [];
                }
                state.state = 'not-started';
                return data;
            case FIRST_FRAGMENT:
                if (state.state === 'in-fragment') {
                    state.data = [];
                    state.state = 'skip';
                    return null;
                }
                state.data = Array.prototype.slice.call(data);
                state.state = 'in-fragment';
                return null;
            case MIDDLE_FRAGMENT:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                MMTSI.append(state.data, data);
                return null;
            case LAST_FRAGMENT:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                MMTSI.append(state.data, data);
                const completed = new Uint8Array(state.data);
                state.data = [];
                state.state = 'not-started';
                return completed;
            default:
                return null;
        }
    }

    private static append(target: number[], data: Uint8Array): void {
        for (let i = 0; i < data.byteLength; i++) {
            target.push(data[i]);
        }
    }

    private static parseSignalingMessage(data: Uint8Array, result: MMTSIResult): void {
        const reader = new ByteReader(data);
        if (!reader.canRead(4)) {
            return;
        }

        const messageId = reader.peekU16();
        result.messages.push(messageId);

        switch (messageId) {
            case MMTMessageId.Pa:
                MMTSI.parsePaMessage(reader, result);
                break;
            case MMTMessageId.M2Section:
                MMTSI.parseM2SectionMessage(reader, result);
                break;
        }
    }

    private static parsePaMessage(reader: ByteReader, result: MMTSIResult): void {
        if (!reader.canRead(7) || reader.readU16() !== MMTMessageId.Pa) {
            return;
        }
        reader.skip(1); // version
        const length = reader.readU32();
        if (!reader.canRead(length)) {
            return;
        }

        const payload = new ByteReader(reader.readBytes(length));
        if (!payload.canRead(1)) {
            return;
        }

        const tableCount = payload.readU8();
        for (let i = 0; i < tableCount; i++) {
            if (!payload.canRead(4)) {
                return;
            }
            payload.skip(4);
        }

        while (payload.bytesLeft() > 0) {
            if (!MMTSI.parseTable(payload, result)) {
                break;
            }
        }
    }

    private static parseM2SectionMessage(reader: ByteReader, result: MMTSIResult): void {
        if (!reader.canRead(5) || reader.readU16() !== MMTMessageId.M2Section) {
            return;
        }
        reader.skip(1); // version
        const length = reader.readU16();
        if (!reader.canRead(length)) {
            return;
        }
        MMTSI.parseTable(new ByteReader(reader.readBytes(length)), result);
    }

    private static parseTable(reader: ByteReader, result: MMTSIResult): boolean {
        if (!reader.canRead(1)) {
            return false;
        }

        const tableId = reader.peekU8();
        result.tables.push(tableId);

        switch (tableId) {
            case MMTTableId.MmtPackageTable:
                return MMTSI.parseMpt(reader, result);
            default:
                reader.skip(reader.bytesLeft());
                return true;
        }
    }

    private static parseMpt(reader: ByteReader, result: MMTSIResult): boolean {
        if (!reader.canRead(4) || reader.readU8() !== MMTTableId.MmtPackageTable) {
            return false;
        }
        reader.skip(1); // version
        const length = reader.readU16();
        if (!reader.canRead(length)) {
            return false;
        }

        const payload = new ByteReader(reader.readBytes(length));
        if (!payload.canRead(2)) {
            return false;
        }

        payload.skip(1); // MPT_mode and reserved bits
        const packageIdLength = payload.readU8();
        if (!payload.canRead(packageIdLength + 2)) {
            return false;
        }
        payload.skip(packageIdLength);

        const descriptorsLength = payload.readU16();
        if (!payload.canRead(descriptorsLength + 1)) {
            return false;
        }
        payload.skip(descriptorsLength);

        const assetCount = payload.readU8();
        for (let i = 0; i < assetCount; i++) {
            const asset = MMTSI.parseMptAsset(payload);
            if (asset !== null) {
                result.assets.push(asset);
            } else {
                return false;
            }
        }

        return true;
    }

    private static parseMptAsset(reader: ByteReader): MMTAsset | null {
        if (!reader.canRead(6)) {
            return null;
        }

        reader.skip(5); // identifier_type + asset_id_scheme
        const assetIdLength = reader.readU8();
        if (!reader.canRead(assetIdLength + 6)) {
            return null;
        }
        reader.skip(assetIdLength);

        const assetType = reader.readFourCC();
        reader.skip(1); // asset_clock_relation_flag and reserved bits

        const locationCount = reader.readU8();
        let packetId = -1;
        for (let i = 0; i < locationCount; i++) {
            const location = MMTSI.parseLocation(reader);
            if (location === null) {
                return null;
            }
            if (location.packetId !== undefined) {
                packetId = location.packetId;
            }
        }

        if (!reader.canRead(2)) {
            return null;
        }
        const descriptorsLength = reader.readU16();
        if (!reader.canRead(descriptorsLength)) {
            return null;
        }

        const asset = MMTSI.assetFromType(assetType, packetId);
        const descriptors = new ByteReader(reader.readBytes(descriptorsLength));
        MMTSI.parseAssetDescriptors(asset, descriptors);

        return asset;
    }

    private static parseLocation(reader: ByteReader): {packetId?: number} | null {
        if (!reader.canRead(1)) {
            return null;
        }

        const locationType = reader.readU8();
        switch (locationType) {
            case 0x00:
                if (!reader.canRead(2)) {
                    return null;
                }
                return {packetId: reader.readU16()};
            case 0x01:
                if (!reader.canRead(12)) {
                    return null;
                }
                reader.skip(10);
                return {packetId: reader.readU16()};
            case 0x02:
                if (!reader.canRead(36)) {
                    return null;
                }
                reader.skip(34);
                return {packetId: reader.readU16()};
            case 0x03:
                if (!reader.canRead(6)) {
                    return null;
                }
                reader.skip(6);
                return {};
            case 0x04:
                if (!reader.canRead(36)) {
                    return null;
                }
                reader.skip(36);
                return {};
            case 0x05:
                if (!reader.canRead(1)) {
                    return null;
                }
                const urlLength = reader.readU8();
                if (!reader.canRead(urlLength)) {
                    return null;
                }
                reader.skip(urlLength);
                return {};
            default:
                return null;
        }
    }

    private static assetFromType(assetType: string, packetId: number): MMTAsset {
        switch (assetType) {
            case 'hev1':
                return {packetId, assetType, mediaType: 'video', codec: 'hevc'};
            case 'mp4a':
                return {packetId, assetType, mediaType: 'audio'};
            case 'stpp':
                return {packetId, assetType, mediaType: 'subtitle', codec: 'ttml'};
            case 'aapp':
            case 'asgd':
            case 'aagd':
                return {packetId, assetType, mediaType: 'data'};
            default:
                return {packetId, assetType, mediaType: 'unknown'};
        }
    }

    private static parseAssetDescriptors(asset: MMTAsset, reader: ByteReader): void {
        while (reader.bytesLeft() >= 3) {
            const start = reader.offset;
            const tag = reader.peekU16();

            switch (tag) {
                case MPU_TIMESTAMP_DESCRIPTOR:
                    MMTSI.parseMpuTimestampDescriptor(asset, reader);
                    break;
                case VIDEO_COMPONENT_DESCRIPTOR:
                    MMTSI.parseVideoComponentDescriptor(asset, reader);
                    break;
                case MH_STREAM_IDENTIFICATION_DESCRIPTOR:
                    MMTSI.parseStreamIdentificationDescriptor(asset, reader);
                    break;
                case MH_AUDIO_COMPONENT_DESCRIPTOR:
                    MMTSI.parseAudioComponentDescriptor(asset, reader);
                    break;
                case MH_DATA_COMPONENT_DESCRIPTOR:
                    MMTSI.parseDataComponentDescriptor(asset, reader);
                    break;
                case MPU_EXTENDED_TIMESTAMP_DESCRIPTOR:
                    MMTSI.parseMpuExtendedTimestampDescriptor(asset, reader);
                    break;
                default:
                    if (!MMTSI.skipDescriptor(reader)) {
                        return;
                    }
                    break;
            }

            if (reader.offset <= start) {
                return;
            }
        }
    }

    private static parseMpuTimestampDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MPU_TIMESTAMP_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        const timestamps: MMTMpuTimestampDescriptor[] = [];

        while (descriptor.bytesLeft() >= 12) {
            timestamps.push({
                mpuSequenceNumber: descriptor.readU32(),
                presentationTimeUs: MMTSI.readNtpTimestampUs(descriptor)
            });
        }

        asset.timestampDescriptorCount = timestamps.length;
        asset.timestampDescriptors = timestamps;
    }

    private static parseMpuExtendedTimestampDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MPU_EXTENDED_TIMESTAMP_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }

        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(1)) {
            return;
        }

        const flags = descriptor.readU8();
        const ptsOffsetType = (flags >> 1) & 0x03;
        const timescaleFlag = (flags & 0x01) !== 0;
        let timescale: number | undefined;
        let defaultPtsOffset = 0;

        if (timescaleFlag) {
            if (!descriptor.canRead(4)) {
                return;
            }
            timescale = descriptor.readU32();
        }

        if (ptsOffsetType === 1) {
            if (!descriptor.canRead(2)) {
                return;
            }
            defaultPtsOffset = descriptor.readU16();
        } else if (ptsOffsetType === 0) {
            return;
        }

        const extended: MMTMpuExtendedTimestampDescriptor[] = [];
        while (descriptor.bytesLeft() > 0) {
            if (!descriptor.canRead(8)) {
                return;
            }

            const mpuSequenceNumber = descriptor.readU32();
            descriptor.skip(1); // leap_indicator + reserved
            const decodingTimeOffset = descriptor.readU16();
            const auCount = descriptor.readU8();
            const au: MMTMpuTimestampOffset[] = [];

            for (let i = 0; i < auCount; i++) {
                if (!descriptor.canRead(2)) {
                    return;
                }
                const dtsPtsOffset = descriptor.readU16();
                let ptsOffset = defaultPtsOffset;

                if (ptsOffsetType === 2) {
                    if (!descriptor.canRead(2)) {
                        return;
                    }
                    ptsOffset = descriptor.readU16();
                }

                au.push({dtsPtsOffset, ptsOffset});
            }

            extended.push({
                mpuSequenceNumber,
                timescale,
                decodingTimeOffset,
                au
            });
        }

        asset.extendedTimestampDescriptorCount = extended.length;
        asset.extendedTimestampDescriptors = extended;
    }

    private static parseVideoComponentDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, VIDEO_COMPONENT_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (descriptor.canRead(7)) {
            descriptor.skip(5);
            asset.language = descriptor.readAscii(3);
        }
    }

    private static parseAudioComponentDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_AUDIO_COMPONENT_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(10)) {
            return;
        }

        const streamContent = descriptor.readU8() & 0x0f;
        asset.audioComponentType = descriptor.readU8();
        asset.audioComponentTag = descriptor.readU16();
        asset.componentTag = asset.audioComponentTag;
        const streamType = descriptor.readU8();
        asset.audioStreamType = streamType;
        asset.audioSimulcastGroupTag = descriptor.readU8();
        const flags = descriptor.readU8();
        const multiLingual = (flags >> 7) !== 0;
        asset.audioMainComponent = ((flags >> 6) & 0x01) !== 0;
        asset.audioQualityIndicator = (flags >> 4) & 0x03;
        asset.audioSamplingRateCode = (flags >> 1) & 0x07;
        asset.language = descriptor.readAscii(3);
        if (multiLingual && descriptor.canRead(3)) {
            descriptor.skip(3);
        }

        if (streamContent === 0x03) {
            if (streamType === 0x11) {
                asset.codec = 'aac-latm';
            } else if (streamType === 0x1c) {
                asset.codec = 'aac';
            }
        } else if (streamContent === 0x04) {
            asset.codec = 'mp4als';
        }
    }

    private static parseStreamIdentificationDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_STREAM_IDENTIFICATION_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (descriptor.canRead(2)) {
            asset.componentTag = descriptor.readU16();
        }
    }

    private static parseDataComponentDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_DATA_COMPONENT_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(2)) {
            return;
        }
        const dataComponentId = descriptor.readU16();
        asset.dataComponentId = dataComponentId;
        asset.dataComponentInfo = descriptor.remainingBytes();
        if (dataComponentId === 0x0020 || dataComponentId === 0x0008) {
            asset.codec = 'ttml';
        }
    }

    private static readShortDescriptorHeader(reader: ByteReader, expectedTag: number): number {
        if (!reader.canRead(3) || reader.readU16() !== expectedTag) {
            return -1;
        }
        return reader.readU8();
    }

    private static skipDescriptor(reader: ByteReader): boolean {
        if (!reader.canRead(3)) {
            return false;
        }

        const tag = reader.readU16();
        let lengthBytes = 1;
        if (tag >= 0x4000 && tag <= 0x6fff) {
            lengthBytes = 2;
        } else if (tag >= 0x7000 && tag <= 0x7fff) {
            lengthBytes = 4;
        } else if (tag >= 0xf000) {
            lengthBytes = 2;
        }

        if (!reader.canRead(lengthBytes)) {
            return false;
        }

        let length = 0;
        if (lengthBytes === 1) {
            length = reader.readU8();
        } else if (lengthBytes === 2) {
            length = reader.readU16();
        } else {
            length = reader.readU32();
        }

        if (!reader.canRead(length)) {
            return false;
        }
        reader.skip(length);
        return true;
    }

    private static readNtpTimestampUs(reader: ByteReader): number {
        const seconds = reader.readU32();
        const fraction = reader.readU32();
        return (seconds - 2208988800) * 1000000 + Math.round(fraction * 1000000 / 0x100000000);
    }

}

class ByteReader {

    public offset: number = 0;
    private data: Uint8Array;

    public constructor(data: Uint8Array) {
        this.data = data;
    }

    public bytesLeft(): number {
        return this.data.byteLength - this.offset;
    }

    public canRead(size: number): boolean {
        return size >= 0 && this.offset + size <= this.data.byteLength;
    }

    public peekU8(): number {
        return this.data[this.offset];
    }

    public peekU16(): number {
        return (this.data[this.offset] << 8) | this.data[this.offset + 1];
    }

    public readU8(): number {
        return this.data[this.offset++];
    }

    public readU16(): number {
        const value = this.peekU16();
        this.offset += 2;
        return value;
    }

    public readU32(): number {
        const value = ((this.data[this.offset] << 24) >>> 0) +
            (this.data[this.offset + 1] << 16) +
            (this.data[this.offset + 2] << 8) +
            this.data[this.offset + 3];
        this.offset += 4;
        return value;
    }

    public readFourCC(): string {
        return this.readAscii(4);
    }

    public readAscii(length: number): string {
        let value = '';
        for (let i = 0; i < length && this.canRead(1); i++) {
            value += String.fromCharCode(this.readU8());
        }
        return value;
    }

    public readBytes(length: number): Uint8Array {
        const value = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    public remainingBytes(): Uint8Array {
        return this.data.subarray(this.offset);
    }

    public skip(length: number): void {
        this.offset = Math.min(this.data.byteLength, this.offset + Math.max(0, length));
    }

}

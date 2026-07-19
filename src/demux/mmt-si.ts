export const enum MMTTableId {
    MmtPackageTable = 0x20,
    MhCat = 0x86,
    PackageListTable = 0x80,
    MhEit = 0x8b
}

export const enum MMTMessageId {
    Pa = 0x0000,
    M2Section = 0x8000,
    Ca = 0x8001
}

export interface MMTConditionalAccessInfo {
    accessControlCaSystemId?: number;
    accessControlLocationType?: number;
    accessControlPacketId?: number;
    accessControlPrivateData?: Uint8Array;
    scramblerLayerType?: number;
    scrambleSystemId?: number;
    scramblerPrivateData?: Uint8Array;
    messageAuthenticationLayerType?: number;
    messageAuthenticationSystemId?: number;
    messageAuthenticationPrivateData?: Uint8Array;
}

export interface MMTAsset {
    packetId: number;
    assetType: string;
    mediaType: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
    codec?: string;
    language?: string;
    componentTag?: number;
    assetGroupId?: number;
    assetSelectionLevel?: number;
    accessControlCaSystemId?: number;
    accessControlLocationType?: number;
    accessControlPacketId?: number;
    accessControlPrivateData?: Uint8Array;
    scramblerLayerType?: number;
    scrambleSystemId?: number;
    scramblerPrivateData?: Uint8Array;
    messageAuthenticationLayerType?: number;
    messageAuthenticationSystemId?: number;
    messageAuthenticationPrivateData?: Uint8Array;
    videoResolution?: number;
    videoAspectRatio?: number;
    videoScanFlag?: boolean;
    videoFrameRate?: number;
    videoTransferCharacteristics?: number;
    hierarchyType?: number;
    hierarchyLayerIndex?: number;
    hierarchyEmbeddedLayerIndex?: number;
    hierarchyChannel?: number;
    hierarchyTemporalScalability?: boolean;
    hierarchySpatialScalability?: boolean;
    hierarchyQualityScalability?: boolean;
    audioComponentType?: number;
    audioComponentTag?: number;
    audioStreamType?: number;
    audioSimulcastGroupTag?: number;
    audioMainComponent?: boolean;
    audioQualityIndicator?: number;
    audioSamplingRateCode?: number;
    mpeg4AudioProfileLevel?: number;
    audioSpecificConfig?: Uint8Array;
    hevcProfileSpace?: number;
    hevcTierFlag?: boolean;
    hevcProfileIdc?: number;
    hevcProfileCompatibility?: number;
    hevcLevelIdc?: number;
    hevcHdrWcgIdc?: number;
    dataComponentId?: number;
    dataComponentInfo?: Uint8Array;
    subtitleTag?: number;
    subtitleInfoVersion?: number;
    subtitleStartMpuSequenceNumber?: number;
    subtitleType?: number;
    subtitleFormat?: number;
    subtitleOperationMode?: number;
    subtitleTimingMode?: number;
    subtitleDisplayMode?: number;
    subtitleResolution?: number;
    subtitleCompressionType?: number;
    subtitleReferenceStartTimeUs?: number;
    timestampDescriptorCount?: number;
    extendedTimestampDescriptorCount?: number;
    timestampDescriptors?: MMTMpuTimestampDescriptor[];
    extendedTimestampDescriptors?: MMTMpuExtendedTimestampDescriptor[];
}

export interface MMTMpuTimestampDescriptor {
    mpuSequenceNumber: number;
    presentationTimeUs: number;
    sourceFilePosition?: number;
}

export interface MMTMpuExtendedTimestampDescriptor {
    mpuSequenceNumber: number;
    sourceFilePosition?: number;
    timescale?: number;
    ptsOffsetType: number;
    defaultPtsOffset: number;
    decodingTimeOffset: number;
    presentationTimeLeapIndicator: number;
    au: MMTMpuTimestampOffset[];
}

export interface MMTParsedPackageTable {
    tableId: number;
    version: number;
    mode: number;
    packageId: string;
    assets: MMTAsset[];
    conditionalAccessInfos: MMTConditionalAccessInfo[];
}

export interface MMTMpuTimestampOffset {
    dtsPtsOffset: number;
    ptsOffset: number;
}

export interface MMTSIResult {
    assets: MMTAsset[];
    conditionalAccessInfos: MMTConditionalAccessInfo[];
    messages: number[];
    tables: number[];
    mptTables: MMTParsedPackageTable[];
    sourceFilePosition?: number;
}

export interface SignalingFragmentState {
    data: number[];
    firstFilePosition?: number;
    lastSeq: number;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

const NOT_FRAGMENTED = 0;
const FIRST_FRAGMENT = 1;
const MIDDLE_FRAGMENT = 2;
const LAST_FRAGMENT = 3;

const MPU_TIMESTAMP_DESCRIPTOR = 0x0001;
const ASSET_GROUP_DESCRIPTOR = 0x8000;
const ACCESS_CONTROL_DESCRIPTOR = 0x8004;
const SCRAMBLER_DESCRIPTOR = 0x8005;
const MESSAGE_AUTHENTICATION_METHOD_DESCRIPTOR = 0x8006;
const VIDEO_COMPONENT_DESCRIPTOR = 0x8010;
const MH_STREAM_IDENTIFICATION_DESCRIPTOR = 0x8011;
const MH_AUDIO_COMPONENT_DESCRIPTOR = 0x8014;
const MH_MPEG4_AUDIO_DESCRIPTOR = 0x8008;
const MH_MPEG4_AUDIO_EXTENSION_DESCRIPTOR = 0x8009;
const MH_HEVC_DESCRIPTOR = 0x800a;
const MH_DATA_COMPONENT_DESCRIPTOR = 0x8020;
const MPU_EXTENDED_TIMESTAMP_DESCRIPTOR = 0x8026;
const MH_HIERARCHY_DESCRIPTOR = 0x8037;

export default class MMTSI {

    public static parseSignalingPayload(payload: Uint8Array,
                                        packetSequenceNumber: number,
                                        fragmentState: SignalingFragmentState,
                                        filePosition: number = 0): MMTSIResult {
        const result: MMTSIResult = {assets: [], conditionalAccessInfos: [], messages: [], tables: [], mptTables: []};
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
                reader.remainingBytes(),
                filePosition
            );
            if (completed !== null) {
                result.sourceFilePosition = completed.filePosition;
                MMTSI.parseSignalingMessage(completed.data, result);
            }
            return result;
        }

        if (fragmentationIndicator !== NOT_FRAGMENTED) {
            return result;
        }

        result.sourceFilePosition = filePosition;

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
            firstFilePosition: undefined,
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
            state.firstFilePosition = undefined;
            state.state = 'skip';
        }
        state.lastSeq = packetSequenceNumber;
    }

    private static assembleFragment(state: SignalingFragmentState,
                                    fragmentationIndicator: number,
                                    data: Uint8Array,
                                    filePosition: number): {data: Uint8Array; filePosition: number} | null {
        switch (fragmentationIndicator) {
            case NOT_FRAGMENTED:
                if (state.state === 'in-fragment') {
                    state.data = [];
                }
                state.firstFilePosition = undefined;
                state.state = 'not-started';
                return {data, filePosition};
            case FIRST_FRAGMENT:
                if (state.state === 'in-fragment') {
                    state.data = [];
                    state.firstFilePosition = undefined;
                    state.state = 'skip';
                    return null;
                }
                state.data = Array.prototype.slice.call(data);
                state.firstFilePosition = filePosition;
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
                const completedFilePosition = state.firstFilePosition !== undefined ?
                    state.firstFilePosition : filePosition;
                state.data = [];
                state.firstFilePosition = undefined;
                state.state = 'not-started';
                return {data: completed, filePosition: completedFilePosition};
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
            case MMTMessageId.Ca:
                MMTSI.parseCaMessage(reader, result);
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

    private static parseCaMessage(reader: ByteReader, result: MMTSIResult): void {
        if (!reader.canRead(5) || reader.readU16() !== MMTMessageId.Ca) {
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
            case 0x11:
            case 0x12:
            case 0x13:
            case 0x14:
            case 0x15:
            case 0x16:
            case 0x17:
            case 0x18:
            case 0x19:
            case 0x1a:
            case 0x1b:
            case 0x1c:
            case 0x1d:
            case 0x1e:
            case 0x1f:
                return MMTSI.parseMpt(reader, result);
            case MMTTableId.MhCat:
                return MMTSI.parseCat(reader, result);
            default:
                reader.skip(reader.bytesLeft());
                return true;
        }
    }

    private static parseMpt(reader: ByteReader, result: MMTSIResult): boolean {
        if (!reader.canRead(4)) {
            return false;
        }
        const tableId = reader.readU8();
        if (tableId !== MMTTableId.MmtPackageTable && (tableId < 0x11 || tableId > 0x1f)) {
            return false;
        }
        const version = reader.readU8();
        const length = reader.readU16();
        if (!reader.canRead(length)) {
            return false;
        }

        const payload = new ByteReader(reader.readBytes(length));
        if (!payload.canRead(2)) {
            return false;
        }

        const mode = payload.readU8() >> 6;
        const packageIdLength = payload.readU8();
        if (!payload.canRead(packageIdLength + 2)) {
            return false;
        }
        const packageId = MMTSI.bytesToKey(payload.readBytes(packageIdLength));

        const descriptorsLength = payload.readU16();
        if (!payload.canRead(descriptorsLength + 1)) {
            return false;
        }
        const conditionalAccessInfos: MMTConditionalAccessInfo[] = [];
        if (descriptorsLength > 0) {
            const info: MMTConditionalAccessInfo = {};
            MMTSI.parseConditionalAccessDescriptors(info, new ByteReader(payload.readBytes(descriptorsLength)));
            if (MMTSI.hasConditionalAccessInfo(info)) {
                conditionalAccessInfos.push(info);
            }
        }

        const assetCount = payload.readU8();
        const assets: MMTAsset[] = [];
        for (let i = 0; i < assetCount; i++) {
            const asset = MMTSI.parseMptAsset(payload);
            if (asset !== null) {
                assets.push(asset);
            } else {
                return false;
            }
        }

        result.mptTables.push({tableId, version, mode, packageId, assets, conditionalAccessInfos});

        return true;
    }

    private static parseCat(reader: ByteReader, result: MMTSIResult): boolean {
        if (!reader.canRead(4) || reader.readU8() !== MMTTableId.MhCat) {
            return false;
        }
        reader.skip(1); // version
        const length = reader.readU16();
        if (!reader.canRead(length)) {
            return false;
        }

        const info: MMTConditionalAccessInfo = {};
        const descriptors = new ByteReader(reader.readBytes(length));
        MMTSI.parseConditionalAccessDescriptors(info, descriptors);
        if (MMTSI.hasConditionalAccessInfo(info)) {
            result.conditionalAccessInfos.push(info);
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

    private static parseLocation(reader: ByteReader): {locationType: number, packetId?: number} | null {
        if (!reader.canRead(1)) {
            return null;
        }

        const locationType = reader.readU8();
        switch (locationType) {
            case 0x00:
                if (!reader.canRead(2)) {
                    return null;
                }
                return {locationType, packetId: reader.readU16()};
            case 0x01:
                if (!reader.canRead(12)) {
                    return null;
                }
                reader.skip(10);
                return {locationType, packetId: reader.readU16()};
            case 0x02:
                if (!reader.canRead(36)) {
                    return null;
                }
                reader.skip(34);
                return {locationType, packetId: reader.readU16()};
            case 0x03:
                if (!reader.canRead(6)) {
                    return null;
                }
                reader.skip(6);
                return {locationType};
            case 0x04:
                if (!reader.canRead(36)) {
                    return null;
                }
                reader.skip(36);
                return {locationType};
            case 0x05:
                if (!reader.canRead(1)) {
                    return null;
                }
                const urlLength = reader.readU8();
                if (!reader.canRead(urlLength)) {
                    return null;
                }
                reader.skip(urlLength);
                return {locationType};
            default:
                return null;
        }
    }

    private static assetFromType(assetType: string, packetId: number): MMTAsset {
        switch (assetType) {
            case 'hvc1':
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
                case ASSET_GROUP_DESCRIPTOR:
                    MMTSI.parseAssetGroupDescriptor(asset, reader);
                    break;
                case ACCESS_CONTROL_DESCRIPTOR:
                case SCRAMBLER_DESCRIPTOR:
                case MESSAGE_AUTHENTICATION_METHOD_DESCRIPTOR:
                    MMTSI.parseConditionalAccessDescriptor(asset, reader, tag);
                    break;
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
                case MH_MPEG4_AUDIO_DESCRIPTOR:
                    MMTSI.parseMpeg4AudioDescriptor(asset, reader);
                    break;
                case MH_MPEG4_AUDIO_EXTENSION_DESCRIPTOR:
                    MMTSI.parseMpeg4AudioExtensionDescriptor(asset, reader);
                    break;
                case MH_HEVC_DESCRIPTOR:
                    MMTSI.parseHevcDescriptor(asset, reader);
                    break;
                case MH_DATA_COMPONENT_DESCRIPTOR:
                    MMTSI.parseDataComponentDescriptor(asset, reader);
                    break;
                case MPU_EXTENDED_TIMESTAMP_DESCRIPTOR:
                    MMTSI.parseMpuExtendedTimestampDescriptor(asset, reader);
                    break;
                case MH_HIERARCHY_DESCRIPTOR:
                    MMTSI.parseHierarchyDescriptor(asset, reader);
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

    private static parseConditionalAccessDescriptors(info: MMTConditionalAccessInfo, reader: ByteReader): void {
        while (reader.bytesLeft() >= 3) {
            const start = reader.offset;
            const tag = reader.peekU16();

            switch (tag) {
                case ACCESS_CONTROL_DESCRIPTOR:
                case SCRAMBLER_DESCRIPTOR:
                case MESSAGE_AUTHENTICATION_METHOD_DESCRIPTOR:
                    MMTSI.parseConditionalAccessDescriptor(info, reader, tag);
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

    private static parseConditionalAccessDescriptor(info: MMTConditionalAccessInfo,
                                                    reader: ByteReader,
                                                    tag: number): void {
        switch (tag) {
            case ACCESS_CONTROL_DESCRIPTOR:
                MMTSI.parseAccessControlDescriptor(info, reader);
                break;
            case SCRAMBLER_DESCRIPTOR:
                MMTSI.parseScramblerDescriptor(info, reader);
                break;
            case MESSAGE_AUTHENTICATION_METHOD_DESCRIPTOR:
                MMTSI.parseMessageAuthenticationMethodDescriptor(info, reader);
                break;
            default:
                MMTSI.skipDescriptor(reader);
                break;
        }
    }

    private static parseAssetGroupDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, ASSET_GROUP_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(2)) {
            return;
        }

        asset.assetGroupId = descriptor.readU8();
        asset.assetSelectionLevel = descriptor.readU8();
    }

    private static parseAccessControlDescriptor(info: MMTConditionalAccessInfo, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, ACCESS_CONTROL_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(3)) {
            return;
        }

        info.accessControlCaSystemId = descriptor.readU16();
        const location = MMTSI.parseLocation(descriptor);
        if (location === null) {
            return;
        }
        info.accessControlLocationType = location.locationType;
        info.accessControlPacketId = location.packetId;
        info.accessControlPrivateData = descriptor.remainingBytes();
    }

    private static parseScramblerDescriptor(info: MMTConditionalAccessInfo, reader: ByteReader): void {
        const values = MMTSI.parseLayerSystemDescriptor(reader, SCRAMBLER_DESCRIPTOR);
        if (values === null) {
            return;
        }

        info.scramblerLayerType = values.layerType;
        info.scrambleSystemId = values.systemId;
        info.scramblerPrivateData = values.privateData;
    }

    private static parseMessageAuthenticationMethodDescriptor(info: MMTConditionalAccessInfo, reader: ByteReader): void {
        const values = MMTSI.parseLayerSystemDescriptor(reader, MESSAGE_AUTHENTICATION_METHOD_DESCRIPTOR);
        if (values === null) {
            return;
        }

        info.messageAuthenticationLayerType = values.layerType;
        info.messageAuthenticationSystemId = values.systemId;
        info.messageAuthenticationPrivateData = values.privateData;
    }

    private static hasConditionalAccessInfo(info: MMTConditionalAccessInfo): boolean {
        return info.accessControlCaSystemId !== undefined ||
            info.scrambleSystemId !== undefined ||
            info.messageAuthenticationSystemId !== undefined;
    }

    private static parseLayerSystemDescriptor(reader: ByteReader,
                                              expectedTag: number): {layerType: number, systemId: number, privateData: Uint8Array} | null {
        const length = MMTSI.readShortDescriptorHeader(reader, expectedTag);
        if (length < 0 || !reader.canRead(length)) {
            return null;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(2)) {
            return null;
        }

        const layerType = (descriptor.readU8() >> 6) & 0x03;
        return {
            layerType,
            systemId: descriptor.readU8(),
            privateData: descriptor.remainingBytes()
        };
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
        }

        const extended: MMTMpuExtendedTimestampDescriptor[] = [];
        while (descriptor.bytesLeft() > 0) {
            if (!descriptor.canRead(8)) {
                return;
            }

            const mpuSequenceNumber = descriptor.readU32();
            const leapIndicator = descriptor.readU8() >> 6;
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
                ptsOffsetType,
                defaultPtsOffset,
                decodingTimeOffset,
                presentationTimeLeapIndicator: leapIndicator,
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
        if (descriptor.canRead(8)) {
            let byte = descriptor.readU8();
            asset.videoResolution = (byte >> 4) & 0x0f;
            asset.videoAspectRatio = byte & 0x0f;
            byte = descriptor.readU8();
            asset.videoScanFlag = (byte & 0x80) !== 0;
            asset.videoFrameRate = byte & 0x1f;
            asset.componentTag = descriptor.readU16();
            byte = descriptor.readU8();
            asset.videoTransferCharacteristics = (byte >> 4) & 0x0f;
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

    private static parseMpeg4AudioDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_MPEG4_AUDIO_DESCRIPTOR);
        if (length < 1 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        asset.mpeg4AudioProfileLevel = descriptor.readU8();
    }

    private static parseMpeg4AudioExtensionDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_MPEG4_AUDIO_EXTENSION_DESCRIPTOR);
        if (length < 1 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        const flags = descriptor.readU8();
        const ascFlag = (flags & 0x80) !== 0;
        const profileCount = flags & 0x0f;
        if (!descriptor.canRead(profileCount)) {
            return;
        }
        descriptor.skip(profileCount);
        if (!ascFlag || !descriptor.canRead(1)) {
            return;
        }
        const ascSize = descriptor.readU8();
        if (!descriptor.canRead(ascSize)) {
            return;
        }
        asset.audioSpecificConfig = descriptor.readBytes(ascSize);
    }

    private static parseHevcDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_HEVC_DESCRIPTOR);
        if (length < 13 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        const profile = descriptor.readU8();
        asset.hevcProfileSpace = profile >> 6;
        asset.hevcTierFlag = ((profile >> 5) & 0x01) !== 0;
        asset.hevcProfileIdc = profile & 0x1f;
        asset.hevcProfileCompatibility = descriptor.readU32();
        descriptor.skip(6); // constraint flags and copied_44bits
        asset.hevcLevelIdc = descriptor.readU8();
        const flags = descriptor.readU8();
        asset.hevcHdrWcgIdc = flags & 0x03;
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
            MMTSI.parseAdditionalAribSubtitleInfo(asset, asset.dataComponentInfo);
        }
    }

    private static parseAdditionalAribSubtitleInfo(asset: MMTAsset, data: Uint8Array): void {
        if (!data || data.byteLength < 8) {
            return;
        }

        const reader = new ByteReader(data);
        asset.subtitleTag = reader.readU8();

        let byte = reader.readU8();
        asset.subtitleInfoVersion = (byte >> 4) & 0x0f;
        const hasStartMpuSequenceNumber = ((byte >> 3) & 0x01) !== 0;

        asset.language = reader.readAscii(3);

        byte = reader.readU8();
        asset.subtitleType = (byte >> 6) & 0x03;
        asset.subtitleFormat = (byte >> 2) & 0x0f;
        asset.subtitleOperationMode = byte & 0x03;

        byte = reader.readU8();
        asset.subtitleTimingMode = (byte >> 4) & 0x0f;
        asset.subtitleDisplayMode = byte & 0x0f;

        byte = reader.readU8();
        asset.subtitleResolution = (byte >> 4) & 0x0f;
        asset.subtitleCompressionType = byte & 0x0f;

        if (hasStartMpuSequenceNumber) {
            if (!reader.canRead(4)) {
                return;
            }
            asset.subtitleStartMpuSequenceNumber = reader.readU32();
        }

        if (asset.subtitleTimingMode === 0x02 && reader.canRead(8)) {
            asset.subtitleReferenceStartTimeUs = MMTSI.readNtpTimestampUs(reader);
        }
    }

    private static parseHierarchyDescriptor(asset: MMTAsset, reader: ByteReader): void {
        const length = MMTSI.readShortDescriptorHeader(reader, MH_HIERARCHY_DESCRIPTOR);
        if (length < 0 || !reader.canRead(length)) {
            return;
        }
        const descriptor = new ByteReader(reader.readBytes(length));
        if (!descriptor.canRead(4)) {
            return;
        }

        let byte = descriptor.readU8();
        asset.hierarchyTemporalScalability = ((byte >> 6) & 0x01) === 0;
        asset.hierarchySpatialScalability = ((byte >> 5) & 0x01) === 0;
        asset.hierarchyQualityScalability = ((byte >> 4) & 0x01) === 0;
        asset.hierarchyType = byte & 0x0f;

        byte = descriptor.readU8();
        asset.hierarchyLayerIndex = byte & 0x3f;

        byte = descriptor.readU8();
        asset.hierarchyEmbeddedLayerIndex = byte & 0x3f;

        byte = descriptor.readU8();
        asset.hierarchyChannel = byte & 0x3f;
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
        // NTP seconds wrapped in 2036. Broadcast timestamps before the wrap
        // have the high bit set; current-era timestamps after it do not.
        const eraAdjustedSeconds = seconds < 0x80000000 ? seconds + 0x100000000 : seconds;
        return (eraAdjustedSeconds - 2208988800) * 1000000 + Math.round(fraction * 1000000 / 0x100000000);
    }

    private static bytesToKey(data: Uint8Array): string {
        let key = '';
        for (let i = 0; i < data.byteLength; i++) {
            key += data[i].toString(16).padStart(2, '0');
        }
        return key;
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

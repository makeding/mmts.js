export declare const enum MMTTableId {
    MmtPackageTable = 32,
    MhCat = 134,
    PackageListTable = 128,
    MhEit = 139
}
export declare const enum MMTMessageId {
    Pa = 0,
    M2Section = 32768,
    Ca = 32769
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
    hevcProgressiveSourceFlag?: boolean;
    hevcInterlacedSourceFlag?: boolean;
    hevcNonPackedConstraintFlag?: boolean;
    hevcFrameOnlyConstraintFlag?: boolean;
    hevcLevelIdc?: number;
    hevcTemporalLayerSubsetFlag?: boolean;
    hevcStillPresentFlag?: boolean;
    hevc24HourPicturePresentFlag?: boolean;
    hevcTemporalIdMin?: number;
    hevcTemporalIdMax?: number;
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
export default class MMTSI {
    static parseSignalingPayload(payload: Uint8Array, packetSequenceNumber: number, fragmentState: SignalingFragmentState, filePosition?: number): MMTSIResult;
    static createFragmentState(): SignalingFragmentState;
    private static checkFragmentState;
    private static assembleFragment;
    private static append;
    private static parseSignalingMessage;
    private static parsePaMessage;
    private static parseM2SectionMessage;
    private static parseCaMessage;
    private static parseTable;
    private static parseMpt;
    private static parseCat;
    private static parseMptAsset;
    private static parseLocation;
    private static assetFromType;
    private static parseAssetDescriptors;
    private static parseConditionalAccessDescriptors;
    private static parseConditionalAccessDescriptor;
    private static parseAssetGroupDescriptor;
    private static parseAccessControlDescriptor;
    private static parseScramblerDescriptor;
    private static parseMessageAuthenticationMethodDescriptor;
    private static hasConditionalAccessInfo;
    private static parseLayerSystemDescriptor;
    private static parseMpuTimestampDescriptor;
    private static parseMpuExtendedTimestampDescriptor;
    private static parseVideoComponentDescriptor;
    private static parseAudioComponentDescriptor;
    private static parseMpeg4AudioDescriptor;
    private static parseMpeg4AudioExtensionDescriptor;
    private static parseHevcDescriptor;
    private static parseStreamIdentificationDescriptor;
    private static parseDataComponentDescriptor;
    private static parseAdditionalAribSubtitleInfo;
    private static parseHierarchyDescriptor;
    private static readShortDescriptorHeader;
    private static skipDescriptor;
    private static readNtpTimestampUs;
    private static bytesToKey;
}

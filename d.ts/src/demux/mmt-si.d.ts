export declare const enum MMTTableId {
    MmtPackageTable = 32,
    PackageListTable = 128,
    MhEit = 139
}
export declare const enum MMTMessageId {
    Pa = 0,
    M2Section = 32768
}
export interface MMTAsset {
    packetId: number;
    assetType: string;
    mediaType: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
    codec?: string;
    language?: string;
    componentTag?: number;
    videoResolution?: number;
    videoAspectRatio?: number;
    videoScanFlag?: boolean;
    videoFrameRate?: number;
    videoTransferCharacteristics?: number;
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
export default class MMTSI {
    static parseSignalingPayload(payload: Uint8Array, packetSequenceNumber: number, fragmentState: SignalingFragmentState): MMTSIResult;
    static createFragmentState(): SignalingFragmentState;
    private static checkFragmentState;
    private static assembleFragment;
    private static append;
    private static parseSignalingMessage;
    private static parsePaMessage;
    private static parseM2SectionMessage;
    private static parseTable;
    private static parseMpt;
    private static parseMptAsset;
    private static parseLocation;
    private static assetFromType;
    private static parseAssetDescriptors;
    private static parseMpuTimestampDescriptor;
    private static parseMpuExtendedTimestampDescriptor;
    private static parseVideoComponentDescriptor;
    private static parseAudioComponentDescriptor;
    private static parseStreamIdentificationDescriptor;
    private static parseDataComponentDescriptor;
    private static readShortDescriptorHeader;
    private static skipDescriptor;
    private static readNtpTimestampUs;
}

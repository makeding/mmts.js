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
    timestampDescriptorCount?: number;
    extendedTimestampDescriptorCount?: number;
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
    private static parseDataComponentDescriptor;
    private static readShortDescriptorHeader;
    private static skipDescriptor;
}

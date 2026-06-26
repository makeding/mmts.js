export interface MMTSAudioTrackInfo {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    componentType?: number;
    componentTag?: number;
    streamType?: number;
    simulcastGroupTag?: number;
    mainComponent?: boolean;
    qualityIndicator?: number;
    samplingRateCode?: number;
    channelConfig?: number;
    channelCount?: number;
    channelLayout?: string;
    audioSampleRate?: number;
    selected: boolean;
}
export interface MMTSVideoTrackInfo {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    componentTag?: number;
    assetGroupId?: number;
    assetSelectionLevel?: number;
    resolution?: number;
    resolutionLabel?: string;
    frameRateCode?: number;
    hierarchyType?: number;
    hierarchyLayerIndex?: number;
    hierarchyEmbeddedLayerIndex?: number;
    hierarchyChannel?: number;
    hierarchyTemporalScalability?: boolean;
    hierarchySpatialScalability?: boolean;
    hierarchyQualityScalability?: boolean;
    role?: 'primary' | 'secondary';
    active: boolean;
    selected: boolean;
}
export interface MMTSSubtitleTrackInfo {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    componentTag?: number;
    dataComponentId?: number;
    dataComponentInfo?: Uint8Array;
}
export declare class MMTSAudioTrackList {
    tracks: MMTSAudioTrackInfo[];
    selectedPacketId?: number;
}
export declare class MMTSVideoTrackList {
    tracks: MMTSVideoTrackInfo[];
    selectedPacketId?: number;
    fallback: boolean;
    fallbackReason?: string;
    selectedRole?: 'primary' | 'secondary';
    hasPrimary: boolean;
    primaryActive: boolean;
    hasSecondary: boolean;
    secondaryActive: boolean;
}
export declare class MMTSSubtitleTrackList {
    tracks: MMTSSubtitleTrackInfo[];
}
export declare class MMTSSubtitleData {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    mpuSequenceNumber: number;
    sampleNumber?: number;
    pts?: number;
    dts?: number;
    rawPts?: number;
    rawDts?: number;
    text?: string;
    data: Uint8Array;
    len: number;
}

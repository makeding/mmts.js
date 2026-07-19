export interface MMTSAudioTrackInfo {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    componentType?: number;
    componentTag?: number;
    assetGroupId?: number;
    assetSelectionLevel?: number;
    accessControlCaSystemId?: number;
    accessControlLocationType?: number;
    accessControlPacketId?: number;
    scramblerLayerType?: number;
    scrambleSystemId?: number;
    messageAuthenticationLayerType?: number;
    messageAuthenticationSystemId?: number;
    streamType?: number;
    simulcastGroupTag?: number;
    mainComponent?: boolean;
    qualityIndicator?: number;
    samplingRateCode?: number;
    channelConfig?: number;
    channelCount?: number;
    channelLayout?: string;
    audioSampleRate?: number;
    supported?: boolean;
    unsupportedReason?: 'als' | 'channel-layout' | 'aac-channel-config';
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
    accessControlCaSystemId?: number;
    accessControlLocationType?: number;
    accessControlPacketId?: number;
    scramblerLayerType?: number;
    scrambleSystemId?: number;
    messageAuthenticationLayerType?: number;
    messageAuthenticationSystemId?: number;
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
    assetGroupId?: number;
    assetSelectionLevel?: number;
    accessControlCaSystemId?: number;
    accessControlLocationType?: number;
    accessControlPacketId?: number;
    scramblerLayerType?: number;
    scrambleSystemId?: number;
    messageAuthenticationLayerType?: number;
    messageAuthenticationSystemId?: number;
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
    subtitleReferenceStartTime?: number;
    supported?: boolean;
    unsupportedReason?: 'compression';
}

export class MMTSAudioTrackList {
    tracks: MMTSAudioTrackInfo[];
    selectedPacketId?: number;
}

export class MMTSVideoTrackList {
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

export class MMTSSubtitleTrackList {
    tracks: MMTSSubtitleTrackInfo[];
}

export class MMTSSubtitleData {
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
    subtitleTimingMode?: number;
    subtitleReferenceStartTime?: number;
    subtitleReferenceStartMediaTime?: number;
    videoMediaDts?: number;
    videoMediaPts?: number;
    videoRawDtsBase?: number;
    videoDtsBase?: number;
    videoSampleIndex?: number;
    droppedVideoSampleCount?: number;
    text?: string;
    data: Uint8Array;
    resources?: MMTSSubtitleResource[];
    resourcesComplete?: boolean;
    len: number;
}

export interface MMTSSubtitleResource {
    index: number;
    subsampleNumber: number;
    dataType: number;
    data: Uint8Array;
    len: number;
}

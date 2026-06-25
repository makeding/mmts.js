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

export interface MMTSSubtitleTrackInfo {
    packetId: number;
    assetType: string;
    codec?: string;
    language?: string;
    componentTag?: number;
    dataComponentId?: number;
    dataComponentInfo?: Uint8Array;
}

export class MMTSAudioTrackList {
    tracks: MMTSAudioTrackInfo[];
    selectedPacketId?: number;
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
    text?: string;
    data: Uint8Array;
    len: number;
}

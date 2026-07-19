import { MFUFragment } from '../demux/mpu';
import { MMTAsset } from '../demux/mmt-si';
import { MMTSTimestamp } from '../demux/mmts-program';
import { MMTSSubtitleData } from '../demux/mmts-track-data';
interface MMTSSubtitleVideoTimeline {
    lastVideoDts: number;
    lastVideoPts: number;
    outputVideoDtsBase: number;
    outputVideoRawDtsBase: number;
    videoSampleIndex: number;
    droppedVideoSampleCount: number;
}
interface MMTSSubtitleAssemblerCallbacks {
    getTimestampAtAccessUnit(packetId: number, mpuSequenceNumber: number, auIndex: number): MMTSTimestamp | null;
    getVideoTimeline(): MMTSSubtitleVideoTimeline;
    onSubtitleData?(subtitle: MMTSSubtitleData): void;
    logSubtitleData?(subtitle: MMTSSubtitleData): void;
}
export default class MMTSSubtitleAssembler {
    private callbacks_;
    private states_;
    constructor(callbacks: MMTSSubtitleAssemblerCallbacks);
    destroy(): void;
    reset(): void;
    processMfuUnit(packetId: number, asset: MMTAsset, mpuSequenceNumber: number, fragment: MFUFragment, unit: Uint8Array): void;
    flush(): void;
    private extractMfuPayload;
    private getMpuState;
    private dispatchMpu;
    private alignTimestampToVideoTimeline;
    private isMpuComplete;
    private pruneStates;
    private stateKey;
}
export {};

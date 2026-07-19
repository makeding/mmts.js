interface MMTSAudioTimelineAlignment {
    rawPts: number;
    offset: number;
    mappedPts: number;
}
interface MMTSAudioTimelineMapping {
    pts: number;
    alignment?: MMTSAudioTimelineAlignment;
}
export default class MMTSAudioTimeline {
    private timestamp_offsets_by_packet_id_;
    private pending_seeds_by_packet_id_;
    destroy(): void;
    clearPacket(packetId: number): void;
    clearPendingSeed(packetId: number): void;
    seed(packetId: number, timelinePts: number): void;
    setMapping(packetId: number, rawPts: number, mappedPts: number): void;
    hasMapping(packetId: number): boolean;
    mapTimestamp(packetId: number, pts: number, refSampleDuration: number): MMTSAudioTimelineMapping;
}
export {};

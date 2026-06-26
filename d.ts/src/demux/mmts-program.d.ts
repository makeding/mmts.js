import { MMTAsset } from './mmt-si';
import { MMTPPacket } from './mmtp';
import { MFUFragment, MPUInfo } from './mpu';
export interface MMTSTimestamp {
    dts: number;
    pts: number;
    rawDts: number;
    rawPts: number;
    timescale: number;
}
export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: Uint8Array;
}
export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    discontinuity: boolean;
    units: MMTSCompletedMfuUnit[];
}
declare class MMTSProgram {
    private signaling_fragment_states_;
    private mfu_fragment_states_;
    private mmtp_packet_continuity_states_;
    private assets_by_packet_id_;
    private stream_states_by_packet_id_;
    destroy(): void;
    parseSignalingPacket(packet: MMTPPacket): MMTAsset[];
    parseMpuPacket(packet: MMTPPacket): MMTSParsedMpu | null;
    getAsset(packetId: number): MMTAsset | undefined;
    resetMpuPacketState(packetId: number): void;
    get streamCount(): number;
    nextTimestamp(packetId: number, mpuSequenceNumber: number): MMTSTimestamp | null;
    private getPtsOffset;
    private getVideoFrameDuration;
    private getStreamState;
    private mergeAsset;
    private mergeTimestampDescriptors;
    private mergeDescriptorCache;
    private findOldestDescriptorIndex;
    private assembleMfuFragment;
    private checkMmtpPacketDiscontinuity;
    private appendToState;
}
export default MMTSProgram;

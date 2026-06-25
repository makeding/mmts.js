import { MMTAsset } from './mmt-si';
import { MMTPPacket } from './mmtp';
import { MFUFragment, MPUInfo } from './mpu';
export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    unit: Uint8Array;
}
export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    units: MMTSCompletedMfuUnit[];
}
declare class MMTSProgram {
    private signaling_fragment_states_;
    private mfu_fragment_states_;
    private assets_by_packet_id_;
    destroy(): void;
    parseSignalingPacket(packet: MMTPPacket): MMTAsset[];
    parseMpuPacket(packet: MMTPPacket): MMTSParsedMpu | null;
    getAsset(packetId: number): MMTAsset | undefined;
    get streamCount(): number;
    private assembleMfuFragment;
    private appendToState;
}
export default MMTSProgram;

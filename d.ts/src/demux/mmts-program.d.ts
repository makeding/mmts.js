import { MMTAsset } from './mmt-si';
import { MMTPPacket } from './mmtp';
import { MFUFragment, MPUInfo } from './mpu';
import { MMTSMpuPresentationWindow, MMTSTimestamp } from './mmts-timestamp-table';
export { MMTSMpuPresentationWindow, MMTSTimestamp };
export interface MMTSPacketLossInfo {
    packetSequenceGap: boolean;
    fragmentedUnitDropped: boolean;
    duplicatePacket: boolean;
    expectedSeq?: number;
    actualSeq?: number;
}
export interface MMTSCompletedMfuUnit {
    fragment: MFUFragment;
    filePosition: number;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: Uint8Array;
}
export interface MMTSParsedMpu {
    asset: MMTAsset | undefined;
    mpu: MPUInfo;
    discontinuity: boolean;
    loss: MMTSPacketLossInfo;
    units: MMTSCompletedMfuUnit[];
}
declare class MMTSProgram {
    private signaling_fragment_states_;
    private mfu_fragment_states_;
    private mmtp_packet_continuity_states_;
    private mpt_subset_states_;
    private presentation_indexes_by_packet_and_mpu_;
    private assets_by_packet_id_;
    private stream_states_by_packet_id_;
    private conditional_access_info_;
    private timestamp_table_;
    destroy(): void;
    parseSignalingPacket(packet: MMTPPacket, filePosition?: number): MMTAsset[];
    private acceptMptTables;
    parseMpuPacket(packet: MMTPPacket, filePosition?: number): MMTSParsedMpu | null;
    getAsset(packetId: number): MMTAsset | undefined;
    resetMpuPacketState(packetId: number): void;
    resetMediaState(preserveTimestampBase?: boolean): void;
    hasTimestampBase(packetId: number): boolean;
    get streamCount(): number;
    getTimestampAtAccessUnit(packetId: number, mpuSequenceNumber: number, auIndex: number): MMTSTimestamp | null;
    peekTimestampAtAccessUnit(packetId: number, mpuSequenceNumber: number, auIndex: number): MMTSTimestamp | null;
    getDescriptorAccessUnitCount(packetId: number, mpuSequenceNumber: number): number | null;
    getTimestampTimescale(packetId: number, mpuSequenceNumber: number): number | null;
    getMpuPresentationWindow(packetId: number, mpuSequenceNumber: number): MMTSMpuPresentationWindow | null;
    getTimestampRestartFilePosition(packetId: number, mpuSequenceNumber: number): number | null;
    getTimestampsForMpu(packetId: number, mpuSequenceNumber: number, presentationIndexes: number[]): MMTSTimestamp[] | null;
    peekTimestampsForMpu(packetId: number, mpuSequenceNumber: number, presentationIndexes: number[]): MMTSTimestamp[] | null;
    setPresentationIndexes(packetId: number, mpuSequenceNumber: number, indexes: number[]): void;
    clearPresentationIndexes(packetId: number, mpuSequenceNumber: number): void;
    private readTimestampAtAccessUnit;
    private readTimestampsForMpu;
    private getStreamState;
    private presentationIndexKey;
    private mergeConditionalAccessInfos;
    private annotateTimestampDescriptorSources;
    private applyConditionalAccessDefaults;
    private copyDefinedConditionalAccessFields;
    private copyMissingConditionalAccessFields;
    private mergeAsset;
    private mergeTimestampDescriptors;
    private mergeDescriptorCache;
    private findOldestDescriptorIndex;
    private assembleMfuFragment;
    private getMfuFragmentStateKey;
    private resetMfuFragmentStatesForPacket;
    private checkMmtpPacketContinuity;
    private appendToState;
    private flattenMfuFragmentState;
    private resetMfuFragmentState;
}
export default MMTSProgram;

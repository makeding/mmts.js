import { H265NaluHVC1 } from './h265';
export interface MMTSVideoAccessUnit {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number | undefined;
    auIndex: number;
    filePosition: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
}
export interface MMTSVideoNaluInput {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number | undefined;
    offset: number | undefined;
    filePosition: number;
    nalu: H265NaluHVC1;
    keyframe: boolean;
    isVcl: boolean;
}
export interface MMTSVideoMpuDiscontinuityResult {
    completed: MMTSVideoAccessUnit[];
    dropped: MMTSVideoAccessUnit | null;
}
export default class MMTSVideoMpuAssembler {
    private mpu_states_by_packet_id_;
    private access_unit_index_states_by_packet_id_;
    destroy(): void;
    reset(): void;
    appendNalu(input: MMTSVideoNaluInput): MMTSVideoAccessUnit[];
    appendStandaloneAccessUnit(packetId: number, mpuSequenceNumber: number, sampleNumber: number | undefined, filePosition: number, units: H265NaluHVC1[], length: number, keyframe: boolean): MMTSVideoAccessUnit[];
    flush(): MMTSVideoAccessUnit[];
    reconcileMpuDiscontinuity(packetId: number, mpuSequenceNumber: number, sampleNumber: number | undefined): MMTSVideoMpuDiscontinuityResult;
    getNextAccessUnitIndex(packetId: number, mpuSequenceNumber: number): number;
    private getMpuState;
    private prepareMpuState;
    private flushCurrentAccessUnit;
    private takeCompletedAccessUnits;
    private compareAccessUnits;
    private completeAccessUnit;
    private isH265FirstSliceSegment;
    private shouldStartFallbackAccessUnit;
    private shouldUseFallbackBoundary;
    private allocateAccessUnitIndex;
}

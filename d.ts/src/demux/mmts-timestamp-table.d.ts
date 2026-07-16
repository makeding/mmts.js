import { MMTAsset } from './mmt-si';
export interface MMTSTimestamp {
    decodingIndex: number;
    presentationIndex: number;
    dts: number;
    pts: number;
    rawDts: number;
    rawPts: number;
    timescale: number;
    presentationTimeLeapIndicator: number;
}
export interface MMTSMpuPresentationWindow {
    rawPtsStart: number;
    rawPtsEnd: number;
    timescale: number;
    presentationTimeLeapIndicator: number;
}
/** Strict ARIB STD-B60 MPU timestamp reconstruction. */
export default class MMTSTimestampTable {
    getTimestampAtAccessUnit(asset: MMTAsset | undefined, mpuSequenceNumber: number, auIndex: number, firstDts?: number, presentationIndexes?: number[]): MMTSTimestamp | null;
    getTimestampsForMpu(asset: MMTAsset | undefined, mpuSequenceNumber: number, firstDts?: number, presentationIndexes?: number[]): MMTSTimestamp[] | null;
    getDescriptorAccessUnitCount(asset: MMTAsset | undefined, mpuSequenceNumber: number): number | null;
    getMpuPresentationWindow(asset: MMTAsset | undefined, mpuSequenceNumber: number): MMTSMpuPresentationWindow | null;
    private buildDescriptorTimestamps;
    private isValidPresentationIndexes;
    private getPtsOffset;
    private getVideoFrameDuration;
    private getAudioFrameDuration;
}

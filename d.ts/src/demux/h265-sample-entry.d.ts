import { H265NaluHVC1 } from './h265';
export type H265SampleEntryType = 'hvc1' | 'hev1';
export interface H265NormalizedAccessUnit {
    units: H265NaluHVC1[];
    length: number;
}
export declare function normalizeH265AccessUnitForSampleEntry(sampleEntryType: H265SampleEntryType, units: H265NaluHVC1[], length: number): H265NormalizedAccessUnit;

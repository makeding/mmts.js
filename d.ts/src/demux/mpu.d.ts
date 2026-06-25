export declare const enum MPUFragmentType {
    MpuMetadata = 0,
    MovieFragmentMetadata = 1,
    Mfu = 2
}
export declare const enum FragmentationIndicator {
    NotFragmented = 0,
    FirstFragment = 1,
    MiddleFragment = 2,
    LastFragment = 3
}
export interface MFUInfo {
    timed: boolean;
    payloadOffset: number;
    payloadLength: number;
    movieFragmentSequenceNumber?: number;
    sampleNumber?: number;
    offset?: number;
    priority?: number;
    dependencyCounter?: number;
    nalUnitLength?: number;
}
export interface MFUFragment {
    timed: boolean;
    fragmentationIndicator: FragmentationIndicator;
    payload: Uint8Array;
    sampleNumber?: number;
    offset?: number;
    nalUnitLength?: number;
}
export interface MPUInfo {
    fragmentType: MPUFragmentType;
    timed: boolean;
    fragmentationIndicator: FragmentationIndicator;
    aggregationFlag: boolean;
    fragmentCounter: number;
    mpuSequenceNumber: number;
    payloadOffset: number;
    payloadLength: number;
    mfu?: MFUInfo;
    mfuFragments: MFUFragment[];
}
export default class MPU {
    static parse(payload: Uint8Array): MPUInfo | null;
    static readLengthPrefixedUnitLength(data: Uint8Array): number | undefined;
    private static parseMfuFragments;
    private static parseMfu;
    private static readU16;
    private static readU32;
}

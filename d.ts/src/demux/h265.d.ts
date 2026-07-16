export declare enum H265NaluType {
    kSliceTRAIL_N = 0,
    kSliceTRAIL_R = 1,
    kSliceTSA_N = 2,
    kSliceTSA_R = 3,
    kSliceSTSA_N = 4,
    kSliceSTSA_R = 5,
    kSliceRADL_N = 6,
    kSliceRADL_R = 7,
    kSliceRASL_N = 8,
    kSliceRASL_R = 9,
    kSliceRSV_VCL_N10 = 10,
    kSliceRSV_VCL_R11 = 11,
    kSliceRSV_VCL_N12 = 12,
    kSliceRSV_VCL_R13 = 13,
    kSliceRSV_VCL_N14 = 14,
    kSliceRSV_VCL_R15 = 15,
    kSliceBLA_W_LP = 16,
    kSliceBLA_W_RADL = 17,
    kSliceBLA_N_LP = 18,
    kSliceIDR_W_RADL = 19,
    kSliceIDR_N_LP = 20,
    kSliceCRA_NUT = 21,
    kSliceRSV_IRAP_VCL22 = 22,
    kSliceRSV_IRAP_VCL23 = 23,
    kSliceVPS = 32,
    kSliceSPS = 33,
    kSlicePPS = 34,
    kSliceAUD = 35,
    kSliceEOS = 36,
    kSliceEOB = 37,
    kSliceFD = 38,
    kSliceSEI = 39,
    kSliceSEISuffix = 40
}
export declare class H265NaluPayload {
    type: H265NaluType;
    data: Uint8Array;
}
export declare class H265NaluHVC1 {
    type: H265NaluType;
    data: Uint8Array;
    constructor(nalu: H265NaluPayload);
}
export declare class H265AnnexBParser {
    private readonly TAG;
    private data_;
    private current_startcode_offset_;
    private eof_flag_;
    constructor(data: Uint8Array);
    private findNextStartCodeOffset;
    readNextNaluPayload(): H265NaluPayload | null;
}
export type HEVCDecoderConfigurationRecordType = {
    configurationVersion: 1;
} & VPSHEVCDecoderConfigurationRecordType & SPSHEVCDecoderConfigurationRecordType & PPSHEVCDecoderConfigurationRecordType;
export type VPSHEVCDecoderConfigurationRecordType = {
    num_temporal_layers: number;
    temporal_id_nested: boolean;
};
export type SPSHEVCDecoderConfigurationRecordType = {
    general_profile_space: number;
    general_tier_flag: number;
    general_level_idc: number;
    general_profile_idc: number;
    general_profile_compatibility_flags_1: number;
    general_profile_compatibility_flags_2: number;
    general_profile_compatibility_flags_3: number;
    general_profile_compatibility_flags_4: number;
    general_constraint_indicator_flags_1: number;
    general_constraint_indicator_flags_2: number;
    general_constraint_indicator_flags_3: number;
    general_constraint_indicator_flags_4: number;
    general_constraint_indicator_flags_5: number;
    general_constraint_indicator_flags_6: number;
    constant_frame_rate: number;
    min_spatial_segmentation_idc: number;
    chroma_format_idc: number;
    bit_depth_luma_minus8: number;
    bit_depth_chroma_minus8: number;
};
export type PPSHEVCDecoderConfigurationRecordType = {
    parallelismType: number;
};
export declare class HEVCDecoderConfigurationRecord {
    private data;
    constructor(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array, detail: HEVCDecoderConfigurationRecordType, arrayCompleteness?: boolean);
    getData(): Uint8Array<ArrayBufferLike>;
}

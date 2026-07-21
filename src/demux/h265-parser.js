/*
 * Copyright (C) 2022 もにょてっく. All Rights Reserved.
 *
 * @author もにょ〜ん <monyone.teihen@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ExpGolomb from './exp-golomb.js';

class H265NaluParser {

    static parseNaluHeader(uint8array) {
        if (!(uint8array instanceof Uint8Array) || uint8array.byteLength < 2) {
            return null;
        }
        const forbiddenZeroBit = (uint8array[0] >>> 7) & 0x01;
        const nalUnitType = (uint8array[0] >>> 1) & 0x3f;
        const nuhLayerId = ((uint8array[0] & 0x01) << 5) | (uint8array[1] >>> 3);
        const temporalIdPlus1 = uint8array[1] & 0x07;
        if (forbiddenZeroBit !== 0 || temporalIdPlus1 === 0) {
            return null;
        }
        return {
            forbidden_zero_bit: forbiddenZeroBit,
            nal_unit_type: nalUnitType,
            nuh_layer_id: nuhLayerId,
            nuh_temporal_id_plus1: temporalIdPlus1,
            temporal_id: temporalIdPlus1 - 1
        };
    }

    static _ceilLog2(value) {
        if (!Number.isFinite(value) || value <= 1) {
            return 0;
        }
        return Math.ceil(Math.log(value) / Math.LN2);
    }

    static _isIrapNaluType(naluType) {
        return naluType >= 16 && naluType <= 23;
    }

    static _isIdrNaluType(naluType) {
        return naluType === 19 || naluType === 20;
    }

    static _getCodecString(profileSpace, profileIdc, profileCompatibilityFlags, tierFlag, levelIdc, constraintIndicatorFlags) {
        const profileSpacePrefix = ['', 'A', 'B', 'C'][profileSpace];
        let profileCompatibility = 0;

        for (let byteIndex = 0; byteIndex < profileCompatibilityFlags.length; byteIndex++) {
            let byte = profileCompatibilityFlags[byteIndex];
            let reversedByte = 0;
            // SPS writes compatibility flag 0 first (as the MSB), while the codec string represents it as bit 0.
            for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
                reversedByte |= ((byte >> (7 - bitIndex)) & 1) << bitIndex;
            }
            profileCompatibility = (profileCompatibility | (reversedByte << (byteIndex * 8))) >>> 0;
        }

        let codec = `hvc1.${profileSpacePrefix}${profileIdc}.${profileCompatibility.toString(16).toUpperCase()}.${tierFlag ? 'H' : 'L'}${levelIdc}`;
        let lastConstraintByte = constraintIndicatorFlags.length - 1;
        while (lastConstraintByte >= 0 && constraintIndicatorFlags[lastConstraintByte] === 0) {
            lastConstraintByte--;
        }
        for (let i = 0; i <= lastConstraintByte; i++) {
            codec += `.${constraintIndicatorFlags[i].toString(16).padStart(2, '0').toUpperCase()}`;
        }

        return codec;
    }

    static _ebsp2rbsp(uint8array) {
        let src = uint8array;
        let src_length = src.byteLength;
        let dst = new Uint8Array(src_length);
        let dst_idx = 0;

        for (let i = 0; i < src_length; i++) {
            if (i >= 2) {
                // Unescape: Skip 0x03 after 00 00
                if (src[i] === 0x03 && src[i - 1] === 0x00 && src[i - 2] === 0x00) {
                    continue;
                }
            }
            dst[dst_idx] = src[i];
            dst_idx++;
        }

        return new Uint8Array(dst.buffer, 0, dst_idx);
    }

    static _rbsp2ebsp(uint8array) {
        if (!(uint8array instanceof Uint8Array) || uint8array.byteLength < 2) {
            throw new Error('Invalid HEVC RBSP');
        }

        // The two-byte NAL unit header is not part of RBSP escaping. Preserve it verbatim and only
        // insert emulation-prevention bytes into the payload that follows it.
        const output = [uint8array[0], uint8array[1]];
        let consecutiveZeroBytes = 0;
        for (let index = 2; index < uint8array.byteLength; index++) {
            const value = uint8array[index];
            if (consecutiveZeroBytes >= 2 && value <= 0x03) {
                output.push(0x03);
                consecutiveZeroBytes = 0;
            }
            output.push(value);
            consecutiveZeroBytes = value === 0x00 ? consecutiveZeroBytes + 1 : 0;
        }
        return Uint8Array.from(output);
    }

    static _writeBits(uint8array, bitOffset, bitLength, value) {
        if (!Number.isInteger(bitOffset) || !Number.isInteger(bitLength) || bitOffset < 0 || bitLength <= 0 ||
            bitLength > 32 || bitOffset + bitLength > uint8array.byteLength * 8) {
            throw new Error('Invalid HEVC RBSP bit range');
        }
        for (let index = 0; index < bitLength; index++) {
            const absoluteBitOffset = bitOffset + index;
            const byteOffset = absoluteBitOffset >>> 3;
            const bitInByte = 7 - (absoluteBitOffset & 0x07);
            const bit = (value >>> (bitLength - index - 1)) & 0x01;
            uint8array[byteOffset] = (uint8array[byteOffset] & ~(1 << bitInByte)) | (bit << bitInByte);
        }
    }

    static rewriteSPSColorimetry(uint8array, colourPrimaries, transferCharacteristics) {
        if (![colourPrimaries, transferCharacteristics].every((value) => {
            return Number.isInteger(value) && value >= 0 && value <= 0xff;
        })) {
            throw new Error('Invalid HEVC colour description value');
        }

        const details = H265NaluParser.parseSPS(uint8array);
        if (!Number.isInteger(details.colour_primaries_bit_offset) ||
            !Number.isInteger(details.transfer_characteristics_bit_offset)) {
            // Adding a missing VUI colour_description would shift all following syntax elements. The prototype
            // intentionally handles only broadcast SPS units that already carry the three fixed-width CICP bytes.
            return null;
        }

        const rbsp = H265NaluParser._ebsp2rbsp(uint8array).slice();
        H265NaluParser._writeBits(rbsp, details.colour_primaries_bit_offset, 8, colourPrimaries);
        H265NaluParser._writeBits(rbsp, details.transfer_characteristics_bit_offset, 8, transferCharacteristics);
        const rewritten = H265NaluParser._rbsp2ebsp(rbsp);
        const rewrittenDetails = H265NaluParser.parseSPS(rewritten);
        if (rewrittenDetails.colour_primaries !== colourPrimaries ||
            rewrittenDetails.transfer_characteristics !== transferCharacteristics ||
            rewrittenDetails.matrix_coeffs !== details.matrix_coeffs) {
            throw new Error('HEVC SPS colour description rewrite verification failed');
        }
        return rewritten;
    }

    static parseVPS(uint8array) {
        const header = H265NaluParser.parseNaluHeader(uint8array);
        if (header === null || header.nal_unit_type !== 32 || header.nuh_layer_id !== 0 || header.temporal_id !== 0) {
            throw new Error('Invalid HEVC VPS NAL unit');
        }
        let rbsp = H265NaluParser._ebsp2rbsp(uint8array);
        let gb = new ExpGolomb(rbsp);

        /* remove NALu Header */
        gb.readByte();
        gb.readByte();

        // VPS
        let video_parameter_set_id = gb.readBits(4);
        gb.readBits(2);
        let max_layers_minus1 = gb.readBits(6);
        let max_sub_layers_minus1 = gb.readBits(3);
        let temporal_id_nesting_flag = gb.readBool();
        if (video_parameter_set_id < 0 || video_parameter_set_id > 15 ||
            max_layers_minus1 !== 0 || max_sub_layers_minus1 > 6) {
            throw new Error('Unsupported HEVC VPS parameters');
        }
        // and more ...

        return {
            video_parameter_set_id,
            max_layers_minus1,
            max_sub_layers_minus1,
            num_temporal_layers: max_sub_layers_minus1 + 1,
            temporal_id_nested: temporal_id_nesting_flag,
            nalu_header: header
        }
    }

    static parseSPS(uint8array) {
        const header = H265NaluParser.parseNaluHeader(uint8array);
        if (header === null || header.nal_unit_type !== 33 || header.nuh_layer_id !== 0 || header.temporal_id !== 0) {
            throw new Error('Invalid HEVC SPS NAL unit');
        }
        let rbsp = H265NaluParser._ebsp2rbsp(uint8array);
        let gb = new ExpGolomb(rbsp);

        /* remove NALu Header */
        gb.readByte();
        gb.readByte();

        let left_offset = 0, right_offset = 0, top_offset = 0, bottom_offset = 0;

        // SPS
        let video_paramter_set_id = gb.readBits(4);
        let max_sub_layers_minus1 = gb.readBits(3);
        let temporal_id_nesting_flag = gb.readBool();
        if (video_paramter_set_id > 15 || max_sub_layers_minus1 > 6) {
            throw new Error('Unsupported HEVC SPS temporal-layer configuration');
        }

        // profile_tier_level begin
        let general_profile_space = gb.readBits(2);
        let general_tier_flag = gb.readBool();
        let general_profile_idc = gb.readBits(5);
        let general_profile_compatibility_flags_1 = gb.readByte();
        let general_profile_compatibility_flags_2 = gb.readByte();
        let general_profile_compatibility_flags_3 = gb.readByte();
        let general_profile_compatibility_flags_4 = gb.readByte();
        let general_constraint_indicator_flags_1 = gb.readByte();
        let general_constraint_indicator_flags_2 = gb.readByte();
        let general_constraint_indicator_flags_3 = gb.readByte();
        let general_constraint_indicator_flags_4 = gb.readByte();
        let general_constraint_indicator_flags_5 = gb.readByte();
        let general_constraint_indicator_flags_6 = gb.readByte();
        let general_level_idc = gb.readByte();
        let sub_layer_profile_present_flag = [];
        let sub_layer_level_present_flag = [];
        for (let i = 0; i < max_sub_layers_minus1; i++) {
            sub_layer_profile_present_flag.push(gb.readBool());
            sub_layer_level_present_flag.push(gb.readBool());
        }
        if (max_sub_layers_minus1 > 0) {
            for (let i = max_sub_layers_minus1; i < 8; i++) { gb.readBits(2); }
        }
        for (let i = 0; i < max_sub_layers_minus1; i++) {
            if (sub_layer_profile_present_flag[i]) {
                gb.readByte(); // sub_layer_profile_space, sub_layer_tier_flag, sub_layer_profile_idc
                gb.readByte(); gb.readByte(); gb.readByte(); gb.readByte(); // sub_layer_profile_compatibility_flag
                gb.readByte(); gb.readByte(); gb.readByte(); gb.readByte(); gb.readByte(); gb.readByte();
            }
            if (sub_layer_level_present_flag[i]) {
                gb.readByte();
            }
        }
        // profile_tier_level end

        let seq_parameter_set_id = gb.readUEG();
        if (seq_parameter_set_id > 15) {
            throw new Error('HEVC SPS id exceeds the normative range');
        }
        let chroma_format_idc = gb.readUEG();
        if (chroma_format_idc > 3) {
            throw new Error('Invalid HEVC chroma_format_idc');
        }
        let separate_colour_plane_flag = false;
        if (chroma_format_idc == 3) {
            separate_colour_plane_flag = gb.readBool();
        }
        let pic_width_in_luma_samples = gb.readUEG();
        let pic_height_in_luma_samples = gb.readUEG();
        let conformance_window_flag = gb.readBool();
        if (conformance_window_flag) {
            left_offset += gb.readUEG();
            right_offset += gb.readUEG();
            top_offset += gb.readUEG();
            bottom_offset += gb.readUEG();
        }
        let bit_depth_luma_minus8 = gb.readUEG();
        let bit_depth_chroma_minus8 = gb.readUEG();
        let log2_max_pic_order_cnt_lsb_minus4 = gb.readUEG();
        if (log2_max_pic_order_cnt_lsb_minus4 > 12) {
            throw new Error('Invalid HEVC POC LSB bit width');
        }
        let sub_layer_ordering_info_present_flag = gb.readBool();
        let sps_max_dec_pic_buffering_minus1 = new Array(max_sub_layers_minus1 + 1);
        let sps_max_num_reorder_pics = new Array(max_sub_layers_minus1 + 1);
        let sps_max_latency_increase_plus1 = new Array(max_sub_layers_minus1 + 1);
        for (let i = sub_layer_ordering_info_present_flag ? 0 : max_sub_layers_minus1; i <= max_sub_layers_minus1; i++) {
            sps_max_dec_pic_buffering_minus1[i] = gb.readUEG();
            sps_max_num_reorder_pics[i] = gb.readUEG();
            sps_max_latency_increase_plus1[i] = gb.readUEG();
            if (sps_max_num_reorder_pics[i] > sps_max_dec_pic_buffering_minus1[i]) {
                throw new Error('Invalid HEVC sub-layer ordering constraints');
            }
        }
        if (!sub_layer_ordering_info_present_flag) {
            for (let i = 0; i < max_sub_layers_minus1; i++) {
                sps_max_dec_pic_buffering_minus1[i] = sps_max_dec_pic_buffering_minus1[max_sub_layers_minus1];
                sps_max_num_reorder_pics[i] = sps_max_num_reorder_pics[max_sub_layers_minus1];
                sps_max_latency_increase_plus1[i] = sps_max_latency_increase_plus1[max_sub_layers_minus1];
            }
        }
        let log2_min_luma_coding_block_size_minus3 = gb.readUEG();
        let log2_diff_max_min_luma_coding_block_size = gb.readUEG();
        const ctbLog2SizeY = log2_min_luma_coding_block_size_minus3 + 3 +
            log2_diff_max_min_luma_coding_block_size;
        if (ctbLog2SizeY < 4 || ctbLog2SizeY > 6 ||
            pic_width_in_luma_samples <= 0 || pic_height_in_luma_samples <= 0) {
            throw new Error('Invalid HEVC coding tree block geometry');
        }
        const ctbSizeY = Math.pow(2, ctbLog2SizeY);
        const picWidthInCtbsY = Math.ceil(pic_width_in_luma_samples / ctbSizeY);
        const picHeightInCtbsY = Math.ceil(pic_height_in_luma_samples / ctbSizeY);
        const picSizeInCtbsY = picWidthInCtbsY * picHeightInCtbsY;
        const sliceSegmentAddressBits = H265NaluParser._ceilLog2(picSizeInCtbsY);
        let log2_min_transform_block_size_minus2 = gb.readUEG();
        let log2_diff_max_min_transform_block_size = gb.readUEG();
        let max_transform_hierarchy_depth_inter = gb.readUEG();
        let max_transform_hierarchy_depth_intra = gb.readUEG();
        let scaling_list_enabled_flag = gb.readBool();
        if (scaling_list_enabled_flag) {
            let sps_scaling_list_data_present_flag = gb.readBool();
            if (sps_scaling_list_data_present_flag) {
                for (let sizeId = 0; sizeId < 4; sizeId++) {
                    for(let matrixId = 0; matrixId < ((sizeId === 3) ? 2 : 6); matrixId++){
                        let scaling_list_pred_mode_flag = gb.readBool();
                        if (!scaling_list_pred_mode_flag) {
                            gb.readUEG(); // scaling_list_pred_matrix_id_delta
                        } else {
                            let coefNum = Math.min(64, (1 << (4 + (sizeId << 1))));
                            if (sizeId > 1) { gb.readSEG() }
                            for (let i = 0; i < coefNum; i++) { gb.readSEG(); }
                        }
                    }
                }
            }
        }
        let amp_enabled_flag = gb.readBool();
        let sample_adaptive_offset_enabled_flag = gb.readBool();
        let pcm_enabled_flag = gb.readBool();
        if (pcm_enabled_flag) {
            gb.readByte();
            gb.readUEG();
            gb.readUEG();
            gb.readBool();
        }
        let num_short_term_ref_pic_sets = gb.readUEG();
        let num_delta_pocs = 0;
        for (let i = 0; i < num_short_term_ref_pic_sets; i++) {
            let inter_ref_pic_set_prediction_flag = false;
            if (i !== 0) { inter_ref_pic_set_prediction_flag = gb.readBool(); }
            if (inter_ref_pic_set_prediction_flag) {
                if (i === num_short_term_ref_pic_sets) { gb.readUEG(); }
                gb.readBool();
                gb.readUEG();
                let next_num_delta_pocs = 0;
                for (let j = 0; j <= num_delta_pocs; j++) {
                    let used_by_curr_pic_flag = gb.readBool();
                    let use_delta_flag = false;
                    if (!used_by_curr_pic_flag) {
                        use_delta_flag = gb.readBool();
                    }
                    if (used_by_curr_pic_flag || use_delta_flag) {
                        next_num_delta_pocs++;
                    }
                }
                num_delta_pocs = next_num_delta_pocs;
            } else {
                let num_negative_pics = gb.readUEG();
                let num_positive_pics = gb.readUEG();
                num_delta_pocs = num_negative_pics + num_positive_pics;
                for (let j = 0; j < num_negative_pics; j++) {
                    gb.readUEG();
                    gb.readBool();
                }
                for (let j = 0; j < num_positive_pics; j++) {
                    gb.readUEG();
                    gb.readBool();
                }
            }
        }
        let long_term_ref_pics_present_flag = gb.readBool();
        if (long_term_ref_pics_present_flag) {
            let num_long_term_ref_pics_sps = gb.readUEG();
            for (let i = 0; i < num_long_term_ref_pics_sps; i++) {
                for (let j = 0; j < (log2_max_pic_order_cnt_lsb_minus4 + 4); j++) { gb.readBits(1); }
                gb.readBits(1);
            }
        }
        //*
        let default_display_window_flag = false; // for calc offset
        let min_spatial_segmentation_idc = 0; // for hvcC
        let sar_width = 1, sar_height = 1;
        let fps_fixed = false, fps_den = 1, fps_num = 1;
        //*/
        let sps_temporal_mvp_enabled_flag = gb.readBool();
        let strong_intra_smoothing_enabled_flag = gb.readBool();
        let vui_parameters_present_flag = gb.readBool();
        let video_full_range_flag = false;
        let colour_primaries = 2;
        let transfer_characteristics = 2;
        let matrix_coeffs = 2;
        let colour_primaries_bit_offset = null;
        let transfer_characteristics_bit_offset = null;
        let matrix_coeffs_bit_offset = null;
        if (vui_parameters_present_flag) {
            let aspect_ratio_info_present_flag = gb.readBool();
            if (aspect_ratio_info_present_flag) {
                let aspect_ratio_idc = gb.readByte();

                let sar_w_table = [1, 12, 10, 16, 40, 24, 20, 32, 80, 18, 15, 64, 160, 4, 3, 2];
                let sar_h_table = [1, 11, 11, 11, 33, 11, 11, 11, 33, 11, 11, 33,  99, 3, 2, 1];

                if (aspect_ratio_idc > 0 && aspect_ratio_idc <= 16) {
                    sar_width = sar_w_table[aspect_ratio_idc - 1];
                    sar_height = sar_h_table[aspect_ratio_idc - 1];
                } else if (aspect_ratio_idc === 255) {
                    sar_width = gb.readBits(16);
                    sar_height = gb.readBits(16);
                }
            }
            let overscan_info_present_flag = gb.readBool();
            if (overscan_info_present_flag) {
                gb.readBool();
            }
            let video_signal_type_present_flag = gb.readBool();
            if (video_signal_type_present_flag) {
                gb.readBits(3);
                video_full_range_flag = gb.readBool();
                let colour_description_present_flag = gb.readBool();
                if (colour_description_present_flag) {
                    colour_primaries_bit_offset = gb.getBitPosition();
                    colour_primaries = gb.readByte();
                    transfer_characteristics_bit_offset = gb.getBitPosition();
                    transfer_characteristics = gb.readByte();
                    matrix_coeffs_bit_offset = gb.getBitPosition();
                    matrix_coeffs = gb.readByte();
                }
            }
            let chroma_loc_info_present_flag = gb.readBool();
            if (chroma_loc_info_present_flag) {
                gb.readUEG();
                gb.readUEG();
            }
            let neutral_chroma_indication_flag = gb.readBool();
            let field_seq_flag = gb.readBool();
            let frame_field_info_present_flag = gb.readBool();
            default_display_window_flag = gb.readBool();
            if (default_display_window_flag) {
                gb.readUEG();
                gb.readUEG();
                gb.readUEG();
                gb.readUEG();
            }
            let vui_timing_info_present_flag = gb.readBool();
            if (vui_timing_info_present_flag) {
                fps_den = gb.readBits(32);
                fps_num = gb.readBits(32);
                let vui_poc_proportional_to_timing_flag = gb.readBool();
                if (vui_poc_proportional_to_timing_flag) {
                    gb.readUEG();
                }
                let vui_hrd_parameters_present_flag = gb.readBool();
                if (vui_hrd_parameters_present_flag) {
                    let commonInfPresentFlag = 1;
                    let nal_hrd_parameters_present_flag = false;
                    let vcl_hrd_parameters_present_flag = false;
                    let sub_pic_hrd_params_present_flag = false;
                    if (commonInfPresentFlag) {
                        nal_hrd_parameters_present_flag = gb.readBool();
                        vcl_hrd_parameters_present_flag = gb.readBool();
                        if( nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag ){
                            sub_pic_hrd_params_present_flag = gb.readBool();
                            if (sub_pic_hrd_params_present_flag) {
                                gb.readByte();
                                gb.readBits(5);
                                gb.readBool();
                                gb.readBits(5);
                            }
                            let bit_rate_scale = gb.readBits(4);
                            let cpb_size_scale = gb.readBits(4);
                            if (sub_pic_hrd_params_present_flag) {
                                gb.readBits(4);
                            }
                            gb.readBits(5);
                            gb.readBits(5);
                            gb.readBits(5);
                        }
                    }
                    for (let i = 0; i <= max_sub_layers_minus1; i++) {
                        let fixed_pic_rate_general_flag = gb.readBool();
                        fps_fixed = fixed_pic_rate_general_flag;
                        let fixed_pic_rate_within_cvs_flag = true;
                        let cpbCnt = 1;
                        if (!fixed_pic_rate_general_flag) {
                            fixed_pic_rate_within_cvs_flag = gb.readBool();
                        }
                        let low_delay_hrd_flag = false;
                        if (fixed_pic_rate_within_cvs_flag) {
                            gb.readUEG();
                        } else {
                            low_delay_hrd_flag = gb.readBool();
                        }
                        if (!low_delay_hrd_flag) {
                            cpbCnt = gb.readUEG() + 1;
                        }
                        if (nal_hrd_parameters_present_flag) {
                            for (let j = 0; j < cpbCnt; j++) {
                                gb.readUEG(); gb.readUEG();
                                if (sub_pic_hrd_params_present_flag) {
                                    gb.readUEG(); gb.readUEG();
                                }
                            }
                            gb.readBool()
                        }
                        if (vcl_hrd_parameters_present_flag) {
                            for (let j = 0; j < cpbCnt; j++) {
                                gb.readUEG(); gb.readUEG();
                                if (sub_pic_hrd_params_present_flag) {
                                    gb.readUEG(); gb.readUEG();
                                }
                            }
                            gb.readBool()
                        }
                    }
                }
            }
            let bitstream_restriction_flag = gb.readBool();
            if (bitstream_restriction_flag) {
                let tiles_fixed_structure_flag = gb.readBool()
                let motion_vectors_over_pic_boundaries_flag = gb.readBool()
                let restricted_ref_pic_lists_flag = gb.readBool();
                min_spatial_segmentation_idc = gb.readUEG();
                let max_bytes_per_pic_denom = gb.readUEG();
                let max_bits_per_min_cu_denom = gb.readUEG();
                let log2_max_mv_length_horizontal = gb.readUEG();
                let log2_max_mv_length_vertical = gb.readUEG();
            }
        }
        let sps_extension_flag = gb.readBool(); // ignore...

        // for meta data
        let codec_mimetype = H265NaluParser._getCodecString(
            general_profile_space,
            general_profile_idc,
            [
                general_profile_compatibility_flags_1,
                general_profile_compatibility_flags_2,
                general_profile_compatibility_flags_3,
                general_profile_compatibility_flags_4
            ],
            general_tier_flag,
            general_level_idc,
            [
                general_constraint_indicator_flags_1,
                general_constraint_indicator_flags_2,
                general_constraint_indicator_flags_3,
                general_constraint_indicator_flags_4,
                general_constraint_indicator_flags_5,
                general_constraint_indicator_flags_6
            ]
        );

        let sub_wc = (chroma_format_idc === 1 || chroma_format_idc === 2) ? 2 : 1;
        let sub_hc = (chroma_format_idc === 1) ? 2 : 1;
        let codec_width = pic_width_in_luma_samples - (left_offset + right_offset) * sub_wc;
        let codec_height = pic_height_in_luma_samples - (top_offset + bottom_offset) * sub_hc;
        let sar_scale = 1;
        if (sar_width !== 1 && sar_height !== 1) {
            sar_scale = sar_width / sar_height;
        }

        gb.destroy();
        gb = null;

        return {
            codec_mimetype,
            video_parameter_set_id: video_paramter_set_id,
            seq_parameter_set_id,
            max_sub_layers_minus1,
            num_temporal_layers: max_sub_layers_minus1 + 1,
            temporal_id_nested: temporal_id_nesting_flag,
            separate_colour_plane_flag,
            log2_max_pic_order_cnt_lsb: log2_max_pic_order_cnt_lsb_minus4 + 4,
            pic_width_in_luma_samples,
            pic_height_in_luma_samples,
            ctb_log2_size_y: ctbLog2SizeY,
            pic_width_in_ctbs_y: picWidthInCtbsY,
            pic_height_in_ctbs_y: picHeightInCtbsY,
            pic_size_in_ctbs_y: picSizeInCtbsY,
            slice_segment_address_bits: sliceSegmentAddressBits,
            sps_max_dec_pic_buffering_minus1,
            sps_max_num_reorder_pics,
            sps_max_latency_increase_plus1,
            profile_string: H265NaluParser.getProfileString(general_profile_idc),
            level_string: H265NaluParser.getLevelString(general_level_idc),
            profile_idc: general_profile_idc,
            bit_depth: bit_depth_luma_minus8 + 8,
            ref_frames: 1, // FIXME!!!
            chroma_format: chroma_format_idc,
            chroma_format_string: H265NaluParser.getChromaFormatString(chroma_format_idc),

            general_level_idc,
            general_profile_space,
            general_tier_flag,
            general_profile_idc,
            general_profile_compatibility_flags_1,
            general_profile_compatibility_flags_2,
            general_profile_compatibility_flags_3,
            general_profile_compatibility_flags_4,
            general_constraint_indicator_flags_1,
            general_constraint_indicator_flags_2,
            general_constraint_indicator_flags_3,
            general_constraint_indicator_flags_4,
            general_constraint_indicator_flags_5,
            general_constraint_indicator_flags_6,
            min_spatial_segmentation_idc,
            constant_frame_rate: 0 /* FIXME!! fps_fixed ? 1 : 0? */,
            chroma_format_idc,
            bit_depth_luma_minus8,
            bit_depth_chroma_minus8,

            video_full_range_flag,
            colour_primaries,
            transfer_characteristics,
            matrix_coeffs,
            colour_primaries_bit_offset,
            transfer_characteristics_bit_offset,
            matrix_coeffs_bit_offset,

            frame_rate: {
                fixed: fps_fixed,
                fps: fps_num / fps_den,
                fps_den: fps_den,
                fps_num: fps_num,
            },

            sar_ratio: {
                width: sar_width,
                height: sar_height
            },

            codec_size: {
                width: codec_width,
                height: codec_height
            },

            present_size: {
                width: codec_width * sar_scale,
                height: codec_height
            },
            nalu_header: header
        };
    }

    static parsePPS(uint8array) {
        const header = H265NaluParser.parseNaluHeader(uint8array);
        if (header === null || header.nal_unit_type !== 34 || header.nuh_layer_id !== 0) {
            const details = header === null ? 'invalid header' :
                `type=${header.nal_unit_type}, layer=${header.nuh_layer_id}, temporal_id=${header.temporal_id}`;
            throw new Error(`Invalid HEVC PPS NAL unit (${details})`);
        }
        let rbsp = H265NaluParser._ebsp2rbsp(uint8array);
        let gb = new ExpGolomb(rbsp);

        /* remove NALu Header */
        gb.readByte();
        gb.readByte();

        let pic_parameter_set_id = gb.readUEG();
        let seq_parameter_set_id = gb.readUEG();
        if (pic_parameter_set_id > 63 || seq_parameter_set_id > 15) {
            throw new Error('HEVC PPS/SPS id exceeds the normative range');
        }
        let dependent_slice_segments_enabled_flag = gb.readBool();
        let output_flag_present_flag = gb.readBool();
        let num_extra_slice_header_bits = gb.readBits(3);
        let sign_data_hiding_enabled_flag = gb.readBool();
        let cabac_init_present_flag = gb.readBool();
        let num_ref_idx_l0_default_active_minus1 = gb.readUEG();
        let num_ref_idx_l1_default_active_minus1 = gb.readUEG();
        let init_qp_minus26 = gb.readSEG();
        let constrained_intra_pred_flag = gb.readBool();
        let transform_skip_enabled_flag = gb.readBool();
        let cu_qp_delta_enabled_flag = gb.readBool();
        if (cu_qp_delta_enabled_flag) {
            let diff_cu_qp_delta_depth = gb.readUEG();
        }
        let cb_qp_offset = gb.readSEG();
        let cr_qp_offset = gb.readSEG();
        let pps_slice_chroma_qp_offsets_present_flag = gb.readBool();
        let weighted_pred_flag = gb.readBool();
        let weighted_bipred_flag = gb.readBool();
        let transquant_bypass_enabled_flag = gb.readBool();
        let tiles_enabled_flag = gb.readBool();
        let entropy_coding_sync_enabled_flag = gb.readBool();
        // and more ...

        // needs hvcC
        let parallelismType = 1; // slice-based parallel decoding
        if (entropy_coding_sync_enabled_flag && tiles_enabled_flag) {
            parallelismType = 0; // mixed-type parallel decoding
        } else if (entropy_coding_sync_enabled_flag) {
            parallelismType = 3; // wavefront-based parallel decoding
        } else if (tiles_enabled_flag) {
            parallelismType = 2; // tile-based parallel decoding
        }

        return {
            pic_parameter_set_id,
            seq_parameter_set_id,
            dependent_slice_segments_enabled_flag,
            output_flag_present_flag,
            num_extra_slice_header_bits,
            parallelismType,
            nalu_header: header
        }
    }

    static parseSliceHeader(uint8array, ppsDetails, spsDetails) {
        if (!ppsDetails || !spsDetails || uint8array.byteLength < 3) {
            return null;
        }
        try {
            const header = H265NaluParser.parseNaluHeader(uint8array);
            if (header === null || header.nal_unit_type > 31 || header.nuh_layer_id !== 0) {
                return null;
            }
            if (!Number.isInteger(spsDetails.max_sub_layers_minus1) ||
                header.temporal_id > spsDetails.max_sub_layers_minus1) {
                return null;
            }
            if (H265NaluParser._isIrapNaluType(header.nal_unit_type) && header.temporal_id !== 0) {
                return null;
            }

            const rbsp = H265NaluParser._ebsp2rbsp(uint8array);
            const gb = new ExpGolomb(rbsp);
            gb.readByte();
            gb.readByte();
            const firstSliceSegmentInPicFlag = gb.readBool();
            let noOutputOfPriorPicsFlag = false;
            if (H265NaluParser._isIrapNaluType(header.nal_unit_type)) {
                noOutputOfPriorPicsFlag = gb.readBool();
            }
            const slicePicParameterSetId = gb.readUEG();
            if (slicePicParameterSetId !== ppsDetails.pic_parameter_set_id) {
                return null;
            }

            let dependentSliceSegmentFlag = false;
            let sliceSegmentAddress = 0;
            if (!firstSliceSegmentInPicFlag) {
                if (ppsDetails.dependent_slice_segments_enabled_flag) {
                    dependentSliceSegmentFlag = gb.readBool();
                }
                const addressBits = spsDetails.slice_segment_address_bits || 0;
                if (addressBits > 0) {
                    sliceSegmentAddress = gb.readBits(addressBits);
                }
                if (!Number.isInteger(sliceSegmentAddress) ||
                    sliceSegmentAddress <= 0 ||
                    sliceSegmentAddress >= spsDetails.pic_size_in_ctbs_y) {
                    return null;
                }
            }

            const result = {
                nalu_header: header,
                first_slice_segment_in_pic_flag: firstSliceSegmentInPicFlag,
                no_output_of_prior_pics_flag: noOutputOfPriorPicsFlag,
                slice_pic_parameter_set_id: slicePicParameterSetId,
                dependent_slice_segment_flag: dependentSliceSegmentFlag,
                slice_segment_address: sliceSegmentAddress,
                slice_type: undefined,
                pic_output_flag: true,
                slice_pic_order_cnt_lsb: undefined
            };
            if (dependentSliceSegmentFlag) {
                return result;
            }

            const extraHeaderBits = ppsDetails.num_extra_slice_header_bits || 0;
            if (extraHeaderBits > 0) {
                gb.readBits(extraHeaderBits);
            }
            const sliceType = gb.readUEG();
            if (sliceType > 2) {
                return null;
            }
            result.slice_type = sliceType;
            if (ppsDetails.output_flag_present_flag) {
                result.pic_output_flag = gb.readBool();
            }
            if (spsDetails.separate_colour_plane_flag) {
                gb.readBits(2);
            }
            if (H265NaluParser._isIdrNaluType(header.nal_unit_type)) {
                result.slice_pic_order_cnt_lsb = 0;
            } else {
                const pocBits = spsDetails.log2_max_pic_order_cnt_lsb;
                if (!Number.isInteger(pocBits) || pocBits < 4 || pocBits > 16) {
                    return null;
                }
                result.slice_pic_order_cnt_lsb = gb.readBits(pocBits);
            }
            return result;
        } catch (error) {
            return null;
        }
    }

    static parseSliceHeaderPrefix(uint8array) {
        try {
            const header = H265NaluParser.parseNaluHeader(uint8array);
            if (header === null || header.nal_unit_type > 31 || header.nuh_layer_id !== 0) {
                return null;
            }
            const rbsp = H265NaluParser._ebsp2rbsp(uint8array);
            const gb = new ExpGolomb(rbsp);
            gb.readByte();
            gb.readByte();
            const firstSliceSegmentInPicFlag = gb.readBool();
            let noOutputOfPriorPicsFlag = false;
            if (H265NaluParser._isIrapNaluType(header.nal_unit_type)) {
                noOutputOfPriorPicsFlag = gb.readBool();
            }
            const slicePicParameterSetId = gb.readUEG();
            if (slicePicParameterSetId > 63) {
                return null;
            }
            return {
                nalu_header: header,
                first_slice_segment_in_pic_flag: firstSliceSegmentInPicFlag,
                no_output_of_prior_pics_flag: noOutputOfPriorPicsFlag,
                slice_pic_parameter_set_id: slicePicParameterSetId
            };
        } catch (error) {
            return null;
        }
    }

    static parseSlicePictureOrderCount(uint8array, details) {
        const parsed = H265NaluParser.parseSliceHeader(uint8array, details, details);
        if (parsed === null || !parsed.first_slice_segment_in_pic_flag) {
            return null;
        }
        return parsed.slice_pic_order_cnt_lsb;
    }

    static getChromaFormatString(chroma_idc) {
        switch (chroma_idc) {
            case 0: return '4:0:0';
            case 1: return '4:2:0';
            case 2: return '4:2:2';
            case 3: return '4:4:4';
            default: return 'Unknown';
        }
    }

    static getProfileString(profile_idc) {
        switch (profile_idc) {
            case 1: return 'Main';
            case 2: return 'Main10';
            case 3: return 'MainSP';
            case 4: return 'Rext';
            case 9: return 'SCC';
            default: return 'Unknown';
        }
    }

    static getLevelString(level_idc) {
        return (level_idc / 30).toFixed(1);
    }
}

export default H265NaluParser;

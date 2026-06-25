import BaseDemuxer from './base-demuxer';
import TLV from './tlv';
import CompressedIP from './compressed-ip';
import MMTP, {MMTPEncryptionFlag, MMTPPayloadType} from './mmtp';
import {MMTAsset} from './mmt-si';
import MPU, {FragmentationIndicator, MFUFragment, MPUFragmentType} from './mpu';
import MMTSProgram from './mmts-program';
import {AACLOASParser, LOASAACFrame} from './aac';
import {MPEG4AudioObjectTypes, MPEG4SamplingFrequencyIndex} from './mpeg4-audio';
import {H265NaluHVC1, H265NaluPayload, H265NaluType, HEVCDecoderConfigurationRecord} from './h265';
import H265Parser from './h265-parser';
import MediaInfo from '../core/media-info';
import Log from '../utils/logger.js';

interface VideoAccessUnitState {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
    hasVcl: boolean;
}

interface PendingMFUUnit {
    fragment: MFUFragment;
    mpuSequenceNumber: number;
    unit: Uint8Array;
}

interface VideoTimestamp {
    dts: number;
    pts: number;
    source: 'descriptor' | 'fallback' | 'corrected';
}

type AACAudioMetadata = {
    codec: 'aac',
    audio_object_type: MPEG4AudioObjectTypes;
    sampling_freq_index: MPEG4SamplingFrequencyIndex;
    sampling_frequency: number;
    channel_config: number;
};

type AudioData = {
    codec: 'aac';
    data: LOASAACFrame;
};

class MMTSDemuxer extends BaseDemuxer {

    private readonly TAG: string = 'MMTSDemuxer';

    private config_: any;
    private stash_: Uint8Array = null;
    private parsed_packet_count_: number = 0;
    private parsed_mmtp_count_: number = 0;
    private last_summary_tlv_count_: number = 0;
    private tlv_packet_type_counts_: {[packetType: number]: number} = {};
    private mmtp_packet_id_counts_: {[packetId: number]: number} = {};
    private program_: MMTSProgram = new MMTSProgram();
    private pending_mfu_units_by_packet_id_: {[packetId: number]: PendingMFUUnit[]} = {};
    private logged_asset_keys_: {[key: string]: boolean} = {};
    private logged_mpu_header_count_: number = 0;
    private logged_mfu_unit_count_: number = 0;
    private logged_video_nalu_count_: number = 0;
    private logged_video_sample_count_: number = 0;
    private logged_video_segment_count_: number = 0;
    private logged_video_irap_count_: number = 0;
    private logged_video_timestamp_fallback_count_: number = 0;
    private logged_video_timestamp_correction_count_: number = 0;
    private logged_audio_sample_count_: number = 0;
    private logged_audio_segment_count_: number = 0;
    private dropped_video_sample_count_: number = 0;
    private last_video_dts_: number = -1;
    private last_video_pts_: number = -1;
    private last_video_duration_: number = 17;
    private output_video_dts_base_: number = -1;
    private primary_video_packet_id_: number = -1;
    private primary_audio_packet_id_: number = -1;
    private media_info_ = new MediaInfo();
    private audio_metadata_: AACAudioMetadata = {
        codec: 'aac',
        audio_object_type: undefined,
        sampling_freq_index: undefined,
        sampling_frequency: undefined,
        channel_config: undefined
    };
    private video_metadata_ = {
        vps: undefined,
        sps: undefined,
        pps: undefined,
        details: undefined
    };
    private audio_track_ = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};
    private video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    private audio_init_segment_dispatched_: boolean = false;
    private video_init_segment_dispatched_: boolean = false;
    private audio_last_sample_pts_: number | undefined;
    private aac_last_incomplete_data_: Uint8Array = null;
    private loas_previous_frame_: LOASAACFrame | null = null;
    private video_sample_index_: number = 0;
    private video_started_: boolean = false;
    private current_video_access_unit_: VideoAccessUnitState = null;
    private pre_init_video_units_: PendingMFUUnit[] = [];

    public constructor(probeData: any, config: any) {
        super();
        this.config_ = config;

        Log.v(this.TAG, `TLV sync_offset = ${probeData.syncOffset}, probe_packets = ${probeData.packetCount || 0}`);
    }

    public destroy(): void {
        this.config_ = null;
        this.stash_ = null;
        this.tlv_packet_type_counts_ = null;
        this.mmtp_packet_id_counts_ = null;
        this.program_ && this.program_.destroy();
        this.program_ = null;
        this.pending_mfu_units_by_packet_id_ = null;
        this.logged_asset_keys_ = null;
        this.media_info_ = null;
        this.audio_metadata_ = null;
        this.video_metadata_ = null;
        this.audio_track_ = null;
        this.video_track_ = null;
        this.aac_last_incomplete_data_ = null;
        this.loas_previous_frame_ = null;
        this.current_video_access_unit_ = null;
        this.pre_init_video_units_ = null;
        super.destroy();
    }

    public static probe(buffer: ArrayBuffer) {
        return TLV.probe(buffer);
    }

    public bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    public parseChunks(chunk: ArrayBuffer, byteStart: number): number {
        let input = new Uint8Array(chunk);

        if (this.stash_ !== null && this.stash_.byteLength > 0) {
            const merged = new Uint8Array(this.stash_.byteLength + input.byteLength);
            merged.set(this.stash_, 0);
            merged.set(input, this.stash_.byteLength);
            input = merged;
            this.stash_ = null;
        }

        const result = TLV.parse(input);
        this.parsed_packet_count_ += result.packets.length;

        for (const packet of result.packets) {
            this.tlv_packet_type_counts_[packet.packetType] = (this.tlv_packet_type_counts_[packet.packetType] || 0) + 1;

            if (packet.packetType !== 0x03) {
                continue;
            }

            const compressedIP = CompressedIP.parse(packet.payload);
            if (compressedIP === null) {
                continue;
            }

            const mmtp = MMTP.parse(packet.payload.subarray(compressedIP.payloadOffset));
            if (mmtp === null) {
                continue;
            }

            this.parsed_mmtp_count_++;
            this.mmtp_packet_id_counts_[mmtp.packetId] = (this.mmtp_packet_id_counts_[mmtp.packetId] || 0) + 1;

            if (this.parsed_mmtp_count_ <= 10) {
                Log.v(
                    this.TAG,
                    `MMTP packet_id=${this.formatHex(mmtp.packetId, 4)}, ` +
                    `payload=${this.payloadTypeName(mmtp.payloadType)}, ` +
                    `seq=${mmtp.packetSequenceNumber}, ` +
                    `rap=${mmtp.rapFlag ? 1 : 0}, ` +
                    `scrambling=${this.scramblingName(mmtp.extensionHeaderScrambling && mmtp.extensionHeaderScrambling.encryptionFlag)}`
                );
            }

            if (mmtp.payloadType === MMTPPayloadType.ControlMessage) {
                this.parseSignalingMessages(mmtp);
            } else if (mmtp.payloadType === MMTPPayloadType.Mpu) {
                this.parseMpu(mmtp);
            }
        }

        this.logSummary(result.packets.length);

        if (result.needMoreData && result.consumed < input.byteLength) {
            this.stash_ = input.subarray(result.consumed);
        }

        return chunk.byteLength;
    }

    private parseSignalingMessages(mmtp): void {
        const assets = this.program_.parseSignalingPacket(mmtp);
        for (const asset of assets) {
            if (asset.packetId < 0) {
                continue;
            }

            this.maybeSelectPrimaryVideoAsset(asset);
            this.maybeSelectPrimaryAudioAsset(asset);
            const key = `${asset.packetId}:${asset.assetType}:${asset.codec || ''}:${asset.language || ''}`;

            if (!this.logged_asset_keys_[key]) {
                this.logged_asset_keys_[key] = true;
                Log.v(
                    this.TAG,
                    `MPT asset packet_id=${this.formatHex(asset.packetId, 4)}, ` +
                    `asset_type=${asset.assetType}, media=${asset.mediaType}, ` +
                    `codec=${asset.codec || 'unknown'}, lang=${asset.language || 'und'}`
                );
            }

            this.replayPendingMfuUnits(asset);
        }
    }

    private parseMpu(mmtp): void {
        const result = this.program_.parseMpuPacket(mmtp);
        if (result === null) {
            return;
        }

        const asset = result.asset;
        const mpu = result.mpu;
        if (asset !== undefined && this.logged_mpu_header_count_ < 16) {
            this.logged_mpu_header_count_++;
            Log.v(
                this.TAG,
                `MPU packet_id=${this.formatHex(mmtp.packetId, 4)}, ` +
                `asset=${asset.assetType}, mpu_seq=${mpu.mpuSequenceNumber}, ` +
                `fragment=${this.fragmentTypeName(mpu.fragmentType)}, ` +
                `timed=${mpu.timed ? 1 : 0}, fi=${this.fragmentationName(mpu.fragmentationIndicator)}, ` +
                `agg=${mpu.aggregationFlag ? 1 : 0}, fragments=${mpu.mfuFragments.length}`
            );
        }

        for (const completed of result.units) {
            this.logCompleteMfuUnit(mmtp.packetId, asset, mpu.mpuSequenceNumber, completed.fragment, completed.unit);
            this.processCompleteMfuUnit(mmtp.packetId, asset, completed.mpuSequenceNumber, completed.fragment, completed.unit);
        }
    }

    private logCompleteMfuUnit(packetId: number,
                               asset: MMTAsset | undefined,
                               mpuSequenceNumber: number,
                               fragment: MFUFragment,
                               unit: Uint8Array): void {
        if (this.logged_mfu_unit_count_ >= 32) {
            return;
        }

        this.logged_mfu_unit_count_++;
        const unitLength = MPU.readLengthPrefixedUnitLength(unit);
        const lengthStatus = asset && asset.assetType === 'hev1' && unitLength !== undefined
            ? (unitLength === unit.byteLength - 4 ? 'ok' : 'bad')
            : '-';

        Log.v(
            this.TAG,
            `MFU unit packet_id=${this.formatHex(packetId, 4)}, ` +
            `asset=${asset ? asset.assetType : 'unknown'}, mpu_seq=${mpuSequenceNumber}, ` +
            `timed=${fragment.timed ? 1 : 0}, size=${unit.byteLength}, ` +
            `length_prefix=${unitLength !== undefined ? unitLength : '-'}, length_check=${lengthStatus}`
        );
    }

    private processCompleteMfuUnit(packetId: number,
                                   asset: MMTAsset | undefined,
                                   mpuSequenceNumber: number,
                                   fragment: MFUFragment,
                                   unit: Uint8Array): void {
        if (asset === undefined) {
            this.cachePendingMfuUnit(packetId, mpuSequenceNumber, fragment, unit);
            return;
        }

        if (asset.assetType === 'mp4a' || asset.codec === 'aac-latm') {
            this.processAudioMfuUnit(packetId, asset, mpuSequenceNumber, unit);
            return;
        }

        if (asset.assetType !== 'hev1') {
            return;
        }

        this.maybeSelectPrimaryVideoAsset(asset);

        if (asset.packetId !== this.primary_video_packet_id_) {
            return;
        }

        const unitLength = MPU.readLengthPrefixedUnitLength(unit);
        if (unitLength === undefined || unitLength !== unit.byteLength - 4) {
            return;
        }

        const naluData = unit.subarray(4);
        if (naluData.byteLength < 2) {
            return;
        }

        const naluType = (naluData[0] >> 1) & 0x3f;
        const naluPayload = new H265NaluPayload();
        naluPayload.type = naluType;
        naluPayload.data = naluData;
        const hvc1 = new H265NaluHVC1(naluPayload);

        if (this.logged_video_nalu_count_ < 32) {
            this.logged_video_nalu_count_++;
            Log.v(
                this.TAG,
                `HEVC NAL packet_id=${this.formatHex(packetId, 4)}, type=${naluType}, ` +
                `sample=${fragment.sampleNumber !== undefined ? fragment.sampleNumber : '-'}, ` +
                `size=${naluData.byteLength}, init=${this.video_init_segment_dispatched_ ? 1 : 0}`
            );
        }

        if (naluType === H265NaluType.kSliceVPS) {
            if (!this.video_init_segment_dispatched_) {
                this.video_metadata_.vps = hvc1;
                this.video_metadata_.details = {
                    ...this.video_metadata_.details,
                    ...H265Parser.parseVPS(naluData)
                };
            }
            return;
        }

        if (naluType === H265NaluType.kSliceSPS) {
            if (!this.video_init_segment_dispatched_) {
                this.video_metadata_.sps = hvc1;
                this.video_metadata_.details = {
                    ...this.video_metadata_.details,
                    ...H265Parser.parseSPS(naluData)
                };
            }
            return;
        }

        if (naluType === H265NaluType.kSlicePPS) {
            if (!this.video_init_segment_dispatched_) {
                this.video_metadata_.pps = hvc1;
                this.video_metadata_.details = {
                    ...this.video_metadata_.details,
                    ...H265Parser.parsePPS(naluData)
                };

                if (this.video_metadata_.vps && this.video_metadata_.sps && this.video_metadata_.pps) {
                    this.dispatchVideoInitSegment();
                }
            }
            return;
        }

        if (!this.video_init_segment_dispatched_) {
            this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, unit);
            return;
        }

        if (!this.video_init_segment_dispatched_ || !this.isH265VclNalu(naluType)) {
            if (this.video_init_segment_dispatched_ && fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(packetId, mpuSequenceNumber, fragment.sampleNumber, hvc1, false, false);
            }
            return;
        }

        const keyframe = this.isH265IrapNalu(naluType);
        if (keyframe) {
            this.logged_video_irap_count_++;
            if (this.logged_video_irap_count_ <= 8 || this.logged_video_irap_count_ % 100 === 0) {
                Log.v(
                    this.TAG,
                    `Found MMTS HEVC IRAP #${this.logged_video_irap_count_}, ` +
                    `packet_id=${this.formatHex(packetId, 4)}, ` +
                    `type=${naluType}, sample=${fragment.sampleNumber !== undefined ? fragment.sampleNumber : '-'}`
                );
            }
        }

        if (fragment.sampleNumber === undefined) {
            this.appendStandaloneVideoSample(packetId, mpuSequenceNumber, [hvc1], hvc1.data.byteLength, keyframe);
            return;
        }

        this.appendH265NaluToAccessUnit(packetId, mpuSequenceNumber, fragment.sampleNumber, hvc1, keyframe, true);
    }

    private appendH265NaluToAccessUnit(packetId: number,
                                       mpuSequenceNumber: number,
                                       sampleNumber: number,
                                       nalu: H265NaluHVC1,
                                       keyframe: boolean,
                                       isVcl: boolean): void {
        if (nalu.type === H265NaluType.kSliceAUD &&
            this.current_video_access_unit_ !== null &&
            this.current_video_access_unit_.hasVcl) {
            this.flushCurrentVideoAccessUnit();
        }

        if (this.current_video_access_unit_ !== null && this.current_video_access_unit_.sampleNumber !== sampleNumber) {
            this.flushCurrentVideoAccessUnit();
        }

        if (this.current_video_access_unit_ === null) {
            this.current_video_access_unit_ = {
                packetId,
                mpuSequenceNumber,
                sampleNumber,
                units: [],
                length: 0,
                keyframe: false,
                hasVcl: false
            };
        }

        this.current_video_access_unit_.units.push(nalu);
        this.current_video_access_unit_.length += nalu.data.byteLength;
        this.current_video_access_unit_.keyframe = this.current_video_access_unit_.keyframe || keyframe;
        this.current_video_access_unit_.hasVcl = this.current_video_access_unit_.hasVcl || isVcl;
    }

    private processAudioMfuUnit(packetId: number,
                                asset: MMTAsset,
                                mpuSequenceNumber: number,
                                unit: Uint8Array): void {
        this.maybeSelectPrimaryAudioAsset(asset);
        if (asset.packetId !== this.primary_audio_packet_id_) {
            return;
        }

        const loas = this.wrapLatmPayloadWithLoasHeader(unit);
        if (!this.video_init_segment_dispatched_) {
            this.parseMMTSLOASAACPayload(loas, undefined, false);
            return;
        }

        const timestamp = this.program_.nextTimestamp(packetId, mpuSequenceNumber);
        if (timestamp === null) {
            return;
        }

        const pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
        this.parseMMTSLOASAACPayload(loas, pts, true);

        if (this.audio_track_.samples.length >= 16) {
            this.dispatchAudioMediaSegment();
        }
    }

    private wrapLatmPayloadWithLoasHeader(payload: Uint8Array): Uint8Array {
        const loas = new Uint8Array(payload.byteLength + 3);
        loas[0] = 0x56;
        loas[1] = 0xe0 | ((payload.byteLength >> 8) & 0x1f);
        loas[2] = payload.byteLength & 0xff;
        loas.set(payload, 3);
        return loas;
    }

    private parseMMTSLOASAACPayload(data: Uint8Array, pts: number | undefined, appendSamples: boolean): void {
        if (this.aac_last_incomplete_data_) {
            const buf = new Uint8Array(data.byteLength + this.aac_last_incomplete_data_.byteLength);
            buf.set(this.aac_last_incomplete_data_, 0);
            buf.set(data, this.aac_last_incomplete_data_.byteLength);
            data = buf;
        }

        let basePts = pts;
        if (appendSamples && this.audio_metadata_.codec === 'aac') {
            if (pts === undefined && this.audio_last_sample_pts_ !== undefined) {
                basePts = this.audio_last_sample_pts_ + 1024 / this.audio_metadata_.sampling_frequency * 1000;
            } else if (pts === undefined) {
                Log.w(this.TAG, 'MMTS AAC: Unknown pts');
                return;
            }
        }

        const parser = new AACLOASParser(data);
        let aacFrame: LOASAACFrame = null;
        let samplePts = basePts;
        let lastSamplePts: number | undefined;

        while ((aacFrame = parser.readNextAACFrame(this.loas_previous_frame_ || undefined)) !== null) {
            this.loas_previous_frame_ = aacFrame;
            const refSampleDuration = 1024 / aacFrame.sampling_frequency * 1000;
            const audioSample = {
                codec: 'aac',
                data: aacFrame
            } as const;

            if (!this.audio_init_segment_dispatched_) {
                this.audio_metadata_ = {
                    codec: 'aac',
                    audio_object_type: aacFrame.audio_object_type,
                    sampling_freq_index: aacFrame.sampling_freq_index,
                    sampling_frequency: aacFrame.sampling_frequency,
                    channel_config: aacFrame.channel_config
                };
                this.dispatchAudioInitSegment(audioSample);
            } else if (this.detectAudioMetadataChange(audioSample)) {
                this.dispatchAudioMediaSegment();
                this.dispatchAudioInitSegment(audioSample);
            }

            if (!appendSamples) {
                continue;
            }

            lastSamplePts = samplePts;
            const samplePtsInt = Math.floor(samplePts);
            this.audio_track_.samples.push({
                unit: aacFrame.data,
                length: aacFrame.data.byteLength,
                pts: samplePtsInt,
                dts: samplePtsInt
            });
            this.audio_track_.length += aacFrame.data.byteLength;

            if (this.logged_audio_sample_count_ < 16) {
                this.logged_audio_sample_count_++;
                Log.v(
                    this.TAG,
                    `Audio sample #${this.logged_audio_sample_count_}, ` +
                    `packet_id=${this.formatHex(this.primary_audio_packet_id_, 4)}, ` +
                    `length=${aacFrame.data.byteLength}, pts=${samplePtsInt}`
                );
            }

            samplePts += refSampleDuration;
        }

        if (parser.hasIncompleteData()) {
            this.aac_last_incomplete_data_ = parser.getIncompleteData();
        } else {
            this.aac_last_incomplete_data_ = null;
        }

        if (lastSamplePts !== undefined) {
            this.audio_last_sample_pts_ = lastSamplePts;
        }
    }

    private flushCurrentVideoAccessUnit(): void {
        const accessUnit = this.current_video_access_unit_;
        this.current_video_access_unit_ = null;

        if (accessUnit === null || accessUnit.units.length === 0) {
            return;
        }

        this.appendStandaloneVideoSample(
            accessUnit.packetId,
            accessUnit.mpuSequenceNumber,
            accessUnit.units,
            accessUnit.length,
            accessUnit.keyframe
        );
    }

    private appendStandaloneVideoSample(packetId: number,
                                        mpuSequenceNumber: number,
                                        units: H265NaluHVC1[],
                                        length: number,
                                        keyframe: boolean): void {
        if (!this.video_started_) {
            if (!keyframe) {
                this.dropped_video_sample_count_++;
                if (this.dropped_video_sample_count_ <= 8 || this.dropped_video_sample_count_ % 100 === 0) {
                    Log.v(
                        this.TAG,
                        `Drop MMTS video sample before first keyframe, ` +
                        `dropped=${this.dropped_video_sample_count_}, units=${units.length}, length=${length}`
                    );
                }
                return;
            }
            this.video_started_ = true;
            this.program_.resetTimestamp(packetId, mpuSequenceNumber);
            if (this.output_video_dts_base_ < 0) {
                this.output_video_dts_base_ = 0;
            }
            Log.v(this.TAG, `Start MMTS video at keyframe, units=${units.length}, length=${length}`);
        }

        const videoTimestamp = this.consumeVideoTimestamp(packetId, mpuSequenceNumber);
        if (this.output_video_dts_base_ === 0 && this.video_sample_index_ === 0) {
            this.output_video_dts_base_ = videoTimestamp.dts;
        }

        let dts = videoTimestamp.dts - this.output_video_dts_base_;
        let pts = videoTimestamp.pts - this.output_video_dts_base_;
        if (pts < dts) {
            pts = dts;
        }
        this.video_sample_index_++;

        this.video_track_.samples.push({
            units,
            length,
            isKeyframe: keyframe,
            dts,
            pts,
            cts: pts - dts,
            file_position: 0
        });
        this.video_track_.length += length;

        if (this.logged_video_sample_count_ < 16) {
            this.logged_video_sample_count_++;
            Log.v(
                this.TAG,
                `Video sample #${this.video_sample_index_}, units=${units.length}, ` +
                `length=${length}, keyframe=${keyframe ? 1 : 0}, ` +
                `dts=${dts}, pts=${pts}, ts=${videoTimestamp.source}`
            );
        }

        if (this.video_track_.samples.length >= 8) {
            this.dispatchVideoMediaSegment();
        }
    }

    private consumeVideoTimestamp(packetId: number, mpuSequenceNumber: number): VideoTimestamp {
        const timestamp = this.program_.nextTimestamp(packetId, mpuSequenceNumber);
        let source: 'descriptor' | 'fallback' | 'corrected' = 'descriptor';
        let pts: number;
        let dts: number;

        if (timestamp !== null) {
            pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
            dts = Math.floor(timestamp.dts * 1000 / timestamp.timescale);

            if (this.last_video_dts_ >= 0) {
                const duration = dts - this.last_video_dts_;
                if (duration > 0 && duration < 1000) {
                    this.last_video_duration_ = duration;
                }
            }
        } else {
            source = 'fallback';
            if (this.last_video_dts_ >= 0) {
                dts = this.last_video_dts_ + this.last_video_duration_;
                pts = this.last_video_pts_ + this.last_video_duration_;
            } else {
                dts = 0;
                pts = 0;
            }

            if (this.logged_video_timestamp_fallback_count_ < 8) {
                this.logged_video_timestamp_fallback_count_++;
                Log.v(
                    this.TAG,
                    `Fallback MMTS video timestamp #${this.logged_video_timestamp_fallback_count_}, ` +
                    `packet_id=0x${packetId.toString(16)}, mpu_seq=${mpuSequenceNumber}, dts=${dts}, pts=${pts}`
                );
            }
        }

        if (pts < dts) {
            source = 'corrected';
            pts = dts;
        }

        if (this.last_video_dts_ >= 0) {
            const duration = dts - this.last_video_dts_;
            if (duration <= 0 || duration > 1000) {
                source = 'corrected';
                dts = this.last_video_dts_ + this.last_video_duration_;
                if (pts < dts || pts - dts > 1000) {
                    pts = dts;
                }
            }
        }

        if (source === 'corrected' && this.logged_video_timestamp_correction_count_ < 8) {
            this.logged_video_timestamp_correction_count_++;
            Log.v(
                this.TAG,
                `Correct MMTS video timestamp #${this.logged_video_timestamp_correction_count_}, ` +
                `packet_id=0x${packetId.toString(16)}, mpu_seq=${mpuSequenceNumber}, dts=${dts}, pts=${pts}`
            );
        }

        this.last_video_dts_ = dts;
        this.last_video_pts_ = pts;
        return {dts, pts, source};
    }

    private isH265VclNalu(naluType: number): boolean {
        return naluType >= 0 && naluType <= 31;
    }

    private isH265IrapNalu(naluType: number): boolean {
        return naluType >= 16 && naluType <= 23;
    }

    private maybeSelectPrimaryAudioAsset(asset: MMTAsset): void {
        if (asset.assetType !== 'mp4a' && asset.codec !== 'aac-latm') {
            return;
        }

        if (this.primary_audio_packet_id_ >= 0) {
            return;
        }

        this.primary_audio_packet_id_ = asset.packetId;
        Log.v(this.TAG, `Select primary MMTS audio packet_id=${this.formatHex(asset.packetId, 4)}`);
    }

    private maybeSelectPrimaryVideoAsset(asset: MMTAsset): void {
        if (asset.assetType !== 'hev1' || this.video_started_) {
            return;
        }

        if (this.primary_video_packet_id_ >= 0) {
            return;
        }

        const score = this.scorePendingVideoAsset(asset.packetId);
        this.primary_video_packet_id_ = asset.packetId;
        Log.v(
            this.TAG,
            `Select primary MMTS video packet_id=${this.formatHex(asset.packetId, 4)}, ` +
            `score=${score}`
        );
    }

    private scorePendingVideoAsset(packetId: number): number {
        const pending = this.pending_mfu_units_by_packet_id_[packetId];
        if (pending === undefined || pending.length === 0) {
            return 0;
        }

        let score = 0;
        for (const pendingUnit of pending) {
            const naluType = this.readH265NaluType(pendingUnit.unit);
            switch (naluType) {
                case H265NaluType.kSliceVPS:
                    score += 100;
                    break;
                case H265NaluType.kSliceSPS:
                    score += 80;
                    break;
                case H265NaluType.kSlicePPS:
                    score += 40;
                    break;
                case H265NaluType.kSliceAUD:
                case H265NaluType.kSliceSEI:
                case H265NaluType.kSliceSEISuffix:
                    score += 1;
                    break;
                default:
                    if (this.isH265IrapNalu(naluType)) {
                        score += 1000;
                    } else if (this.isH265VclNalu(naluType)) {
                        score += 2;
                    }
                    break;
            }
        }
        return score;
    }

    private resetVideoBootstrapState(): void {
        this.video_metadata_ = {
            vps: undefined,
            sps: undefined,
            pps: undefined,
            details: undefined
        };
        this.video_track_ = {type: 'video', id: 1, sequenceNumber: this.video_track_.sequenceNumber, samples: [], length: 0};
        this.video_init_segment_dispatched_ = false;
        this.video_sample_index_ = 0;
        this.video_started_ = false;
        this.current_video_access_unit_ = null;
        this.pre_init_video_units_ = [];
    }

    private detectAudioMetadataChange(sample: AudioData): boolean {
        if (sample.codec !== this.audio_metadata_.codec) {
            Log.v(
                this.TAG,
                `Audio: Audio Codecs changed from ${this.audio_metadata_.codec} to ${sample.codec}`
            );
            return true;
        }

        const frame = sample.data;
        if (frame.audio_object_type !== this.audio_metadata_.audio_object_type) {
            Log.v(
                this.TAG,
                `AAC: AudioObjectType changed from ${this.audio_metadata_.audio_object_type} to ${frame.audio_object_type}`
            );
            return true;
        }

        if (frame.sampling_freq_index !== this.audio_metadata_.sampling_freq_index) {
            Log.v(
                this.TAG,
                `AAC: SamplingFrequencyIndex changed from ${this.audio_metadata_.sampling_freq_index} to ${frame.sampling_freq_index}`
            );
            return true;
        }

        if (frame.channel_config !== this.audio_metadata_.channel_config) {
            Log.v(
                this.TAG,
                `AAC: Channel configuration changed from ${this.audio_metadata_.channel_config} to ${frame.channel_config}`
            );
            return true;
        }

        return false;
    }

    private readH265NaluType(unit: Uint8Array): number {
        const unitLength = MPU.readLengthPrefixedUnitLength(unit);
        if (unitLength === undefined || unitLength !== unit.byteLength - 4 || unit.byteLength < 6) {
            return -1;
        }
        return (unit[4] >> 1) & 0x3f;
    }

    private cachePendingMfuUnit(packetId: number,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment,
                                unit: Uint8Array): void {
        const unitLength = MPU.readLengthPrefixedUnitLength(unit);
        if (unitLength === undefined || unitLength !== unit.byteLength - 4 || unit.byteLength < 6) {
            return;
        }

        const naluType = (unit[4] >> 1) & 0x3f;
        if (!this.isH265VclNalu(naluType) &&
            naluType !== H265NaluType.kSliceVPS &&
            naluType !== H265NaluType.kSliceSPS &&
            naluType !== H265NaluType.kSlicePPS &&
            naluType !== H265NaluType.kSliceAUD &&
            naluType !== H265NaluType.kSliceSEI &&
            naluType !== H265NaluType.kSliceSEISuffix) {
            return;
        }

        let pending = this.pending_mfu_units_by_packet_id_[packetId];
        if (pending === undefined) {
            pending = [];
            this.pending_mfu_units_by_packet_id_[packetId] = pending;
        }

        if (pending.length >= 128) {
            pending.shift();
        }

        const unitCopy = new Uint8Array(unit.byteLength);
        unitCopy.set(unit);
        pending.push({
            fragment: {
                timed: fragment.timed,
                fragmentationIndicator: fragment.fragmentationIndicator,
                payload: unitCopy,
                sampleNumber: fragment.sampleNumber,
                offset: fragment.offset,
                nalUnitLength: fragment.nalUnitLength
            },
            mpuSequenceNumber,
            unit: unitCopy
        });
    }

    private replayPendingMfuUnits(asset: MMTAsset): void {
        const pending = this.pending_mfu_units_by_packet_id_[asset.packetId];
        if (pending === undefined || pending.length === 0) {
            return;
        }

        delete this.pending_mfu_units_by_packet_id_[asset.packetId];
        Log.v(
            this.TAG,
            `Replay ${pending.length} pending MFU units for packet_id=${this.formatHex(asset.packetId, 4)}, ` +
            `asset=${asset.assetType}`
        );

        for (const pendingUnit of pending) {
            this.processCompleteMfuUnit(
                asset.packetId,
                asset,
                pendingUnit.mpuSequenceNumber,
                pendingUnit.fragment,
                pendingUnit.unit
            );
        }
    }

    private cachePreInitVideoUnit(mpuSequenceNumber: number, fragment: MFUFragment, unit: Uint8Array): void {
        if (this.pre_init_video_units_.length >= 256) {
            this.pre_init_video_units_.shift();
        }

        const unitCopy = new Uint8Array(unit.byteLength);
        unitCopy.set(unit);
        this.pre_init_video_units_.push({
            fragment: {
                timed: fragment.timed,
                fragmentationIndicator: fragment.fragmentationIndicator,
                payload: unitCopy,
                sampleNumber: fragment.sampleNumber,
                offset: fragment.offset,
                nalUnitLength: fragment.nalUnitLength
            },
            mpuSequenceNumber,
            unit: unitCopy
        });
    }

    private replayPreInitVideoUnits(): void {
        if (this.pre_init_video_units_.length === 0 || this.primary_video_packet_id_ < 0) {
            return;
        }

        const pending = this.pre_init_video_units_;
        this.pre_init_video_units_ = [];
        const asset = this.program_.getAsset(this.primary_video_packet_id_);
        if (asset === undefined) {
            return;
        }

        Log.v(this.TAG, `Replay ${pending.length} pre-init MMTS video NAL units`);
        for (const pendingUnit of pending) {
            this.processCompleteMfuUnit(
                asset.packetId,
                asset,
                pendingUnit.mpuSequenceNumber,
                pendingUnit.fragment,
                pendingUnit.unit
            );
        }
        this.flushCurrentVideoAccessUnit();
    }

    private dispatchAudioInitSegment(sample: AudioData): void {
        const frame = sample.data;
        const meta: any = {};
        const audioObjectType = frame.audio_object_type;
        const samplingFrequencyIndex = frame.sampling_freq_index;
        const channelConfig = frame.channel_config;

        meta.type = 'audio';
        meta.id = this.audio_track_.id;
        meta.timescale = 1000;
        meta.duration = 0;
        meta.audioSampleRate = frame.sampling_frequency;
        meta.channelCount = channelConfig;
        meta.codec = `mp4a.40.${audioObjectType}`;
        meta.originalCodec = meta.codec;
        meta.config = [
            (audioObjectType << 3) | ((samplingFrequencyIndex & 0x0f) >>> 1),
            ((samplingFrequencyIndex & 0x0f) << 7) | ((channelConfig & 0x0f) << 3)
        ];
        meta.refSampleDuration = 1024 / meta.audioSampleRate * meta.timescale;

        if (!this.audio_init_segment_dispatched_) {
            Log.v(this.TAG, `Generated first MMTS AAC AudioSpecificConfig for mimeType: ${meta.codec}`);
        }

        this.onTrackMetadata && this.onTrackMetadata('audio', meta);
        this.audio_init_segment_dispatched_ = true;

        const mi = this.media_info_;
        mi.hasAudio = true;
        mi.audioCodec = meta.originalCodec;
        mi.audioSampleRate = meta.audioSampleRate;
        mi.audioChannelCount = meta.channelCount;

        if (mi.hasVideo && mi.videoCodec) {
            mi.mimeType = `video/mp4; codecs="${mi.videoCodec},${mi.audioCodec}"`;
        } else {
            mi.mimeType = `video/mp4; codecs="${mi.audioCodec}"`;
        }

        if (mi.isComplete()) {
            this.onMediaInfo && this.onMediaInfo(mi);
        }
    }

    private dispatchAudioMediaSegment(): void {
        if (!this.audio_init_segment_dispatched_ || this.audio_track_.length === 0) {
            return;
        }

        if (this.logged_audio_segment_count_ < 16) {
            this.logged_audio_segment_count_++;
            Log.v(
                this.TAG,
                `Dispatch MMTS audio segment #${this.logged_audio_segment_count_}, ` +
                `samples=${this.audio_track_.samples.length}, length=${this.audio_track_.length}`
            );
        }

        this.onDataAvailable && this.onDataAvailable(this.audio_track_, null);
        this.audio_track_ = {
            type: 'audio',
            id: 2,
            sequenceNumber: this.audio_track_.sequenceNumber,
            samples: [],
            length: 0
        };
    }

    private dispatchVideoInitSegment(): void {
        const details = this.video_metadata_.details;
        const meta: any = {};

        meta.type = 'video';
        meta.id = this.video_track_.id;
        meta.timescale = 1000;
        meta.duration = 0;
        meta.codecWidth = details.codec_size.width;
        meta.codecHeight = details.codec_size.height;
        meta.presentWidth = details.present_size.width;
        meta.presentHeight = details.present_size.height;
        meta.profile = details.profile_string;
        meta.level = details.level_string;
        meta.bitDepth = details.bit_depth;
        meta.chromaFormat = details.chroma_format;
        meta.sarRatio = details.sar_ratio;
        meta.frameRate = details.frame_rate || {fps_num: 60, fps_den: 1, fps: 60};
        meta.refSampleDuration = 1000 * (meta.frameRate.fps_den / meta.frameRate.fps_num);
        meta.codec = details.codec_mimetype;

        const vps = this.video_metadata_.vps.data.subarray(4);
        const sps = this.video_metadata_.sps.data.subarray(4);
        const pps = this.video_metadata_.pps.data.subarray(4);
        meta.hvcc = new HEVCDecoderConfigurationRecord(vps, sps, pps, details).getData();

        Log.v(this.TAG, `Generated first MMTS HEVCDecoderConfigurationRecord for mimeType: ${meta.codec}`);
        this.onTrackMetadata && this.onTrackMetadata('video', meta);
        this.video_init_segment_dispatched_ = true;
        this.replayPreInitVideoUnits();

        const mi = this.media_info_;
        mi.hasVideo = true;
        mi.hasAudio = this.primary_audio_packet_id_ >= 0;
        mi.width = meta.codecWidth;
        mi.height = meta.codecHeight;
        mi.fps = meta.frameRate.fps;
        mi.profile = meta.profile;
        mi.level = meta.level;
        mi.refFrames = details.ref_frames;
        mi.chromaFormat = details.chroma_format_string;
        mi.sarNum = meta.sarRatio.width;
        mi.sarDen = meta.sarRatio.height;
        mi.videoCodec = meta.codec;
        mi.mimeType = `video/mp4; codecs="${mi.videoCodec}"`;

        if (mi.isComplete()) {
            this.onMediaInfo && this.onMediaInfo(mi);
        }
    }

    private dispatchVideoMediaSegment(): void {
        if (!this.video_init_segment_dispatched_ || this.video_track_.length === 0) {
            return;
        }

        if (this.logged_video_segment_count_ < 16) {
            this.logged_video_segment_count_++;
            Log.v(
                this.TAG,
                `Dispatch MMTS video segment #${this.logged_video_segment_count_}, ` +
                `samples=${this.video_track_.samples.length}, length=${this.video_track_.length}`
            );
        }

        this.onDataAvailable && this.onDataAvailable(null, this.video_track_);
        this.video_track_ = {
            type: 'video',
            id: 1,
            sequenceNumber: this.video_track_.sequenceNumber,
            samples: [],
            length: 0
        };
    }

    private logSummary(parsedPacketCount: number): void {
        if (parsedPacketCount === 0) {
            return;
        }

        if (this.parsed_packet_count_ < 5000 || this.parsed_packet_count_ - this.last_summary_tlv_count_ >= 10000) {
            this.last_summary_tlv_count_ = this.parsed_packet_count_;
            Log.v(
                this.TAG,
                `Parsed TLV total=${this.parsed_packet_count_}, total_mmtp=${this.parsed_mmtp_count_}, streams=${this.program_.streamCount}`
            );
        }
    }

    private formatHex(value: number, width: number): string {
        return '0x' + value.toString(16).padStart(width, '0');
    }

    private payloadTypeName(payloadType: MMTPPayloadType): string {
        switch (payloadType) {
            case MMTPPayloadType.Mpu:
                return 'mpu';
            case MMTPPayloadType.ControlMessage:
                return 'control';
            default:
                return `unknown(${payloadType})`;
        }
    }

    private scramblingName(encryptionFlag: MMTPEncryptionFlag | undefined): string {
        switch (encryptionFlag) {
            case MMTPEncryptionFlag.Unscrambled:
                return 'unscrambled';
            case MMTPEncryptionFlag.Reserved:
                return 'reserved';
            case MMTPEncryptionFlag.Even:
                return 'even';
            case MMTPEncryptionFlag.Odd:
                return 'odd';
            default:
                return 'none';
        }
    }

    private fragmentTypeName(fragmentType: MPUFragmentType): string {
        switch (fragmentType) {
            case MPUFragmentType.MpuMetadata:
                return 'mpu_metadata';
            case MPUFragmentType.MovieFragmentMetadata:
                return 'movie_fragment_metadata';
            case MPUFragmentType.Mfu:
                return 'mfu';
            default:
                return `unknown(${fragmentType})`;
        }
    }

    private fragmentationName(indicator: FragmentationIndicator): string {
        switch (indicator) {
            case FragmentationIndicator.NotFragmented:
                return 'none';
            case FragmentationIndicator.FirstFragment:
                return 'first';
            case FragmentationIndicator.MiddleFragment:
                return 'middle';
            case FragmentationIndicator.LastFragment:
                return 'last';
            default:
                return `unknown(${indicator})`;
        }
    }

}

export default MMTSDemuxer;

import BaseDemuxer from './base-demuxer';
import TLV from './tlv';
import CompressedIP from './compressed-ip';
import MMTP, {MMTPEncryptionFlag, MMTPPayloadType} from './mmtp';
import {MMTAsset} from './mmt-si';
import MPU, {MFUFragment} from './mpu';
import MMTSProgram from './mmts-program';
import {AACLOASParser, LOASAACFrame} from './aac';
import {MPEG4AudioObjectTypes, MPEG4SamplingFrequencyIndex} from './mpeg4-audio';
import {H265NaluHVC1, H265NaluPayload, H265NaluType, HEVCDecoderConfigurationRecord} from './h265';
import H265Parser from './h265-parser';
import MediaInfo from '../core/media-info';
import Log from '../utils/logger.js';
import decodeUTF8 from '../utils/utf8-conv.js';
import {
    MMTSAudioTrackInfo,
    MMTSAudioTrackList,
    MMTSSubtitleData,
    MMTSSubtitleTrackInfo,
    MMTSSubtitleTrackList,
    MMTSVideoTrackInfo,
    MMTSVideoTrackList
} from './mmts-track-data';

interface VideoAccessUnitState {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
    randomAccess: boolean;
    hasVcl: boolean;
}

interface PendingMFUUnit {
    fragment: MFUFragment;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: Uint8Array;
}

interface VideoTimestamp {
    dts: number;
    pts: number;
    source: 'descriptor' | 'fallback' | 'corrected';
}

interface AudioParseState {
    metadata: AACAudioMetadata;
    lastIncompleteData: Uint8Array | null;
    previousFrame: LOASAACFrame | null;
    lastSamplePts?: number;
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
    private parsed_mmtp_count_: number = 0;
    private mmtp_packet_counts_by_packet_id_: {[packetId: number]: number} = {};
    private mmtp_mpu_counts_by_packet_id_: {[packetId: number]: number} = {};
    private next_forced_video_wait_log_count_: number = 512;
    private program_: MMTSProgram = new MMTSProgram();
    private pending_mfu_units_by_packet_id_: {[packetId: number]: PendingMFUUnit[]} = {};
    private logged_asset_keys_: {[key: string]: boolean} = {};
    private logged_video_timestamp_fallback_count_: number = 0;
    private logged_video_timestamp_correction_count_: number = 0;
    private logged_audio_timestamp_fallback_count_: number = 0;
    private logged_unsupported_audio_packet_ids_: {[packetId: number]: boolean} = {};
    private audio_track_infos_by_packet_id_: {[packetId: number]: MMTSAudioTrackInfo} = {};
    private video_track_infos_by_packet_id_: {[packetId: number]: MMTSVideoTrackInfo} = {};
    private subtitle_track_infos_by_packet_id_: {[packetId: number]: MMTSSubtitleTrackInfo} = {};
    private audio_parse_states_by_packet_id_: {[packetId: number]: AudioParseState} = {};
    private audio_tracks_signature_: string = '';
    private video_tracks_signature_: string = '';
    private subtitle_tracks_signature_: string = '';
    private dropped_video_sample_count_: number = 0;
    private logged_video_nalu_count_: number = 0;
    private logged_dropped_video_sample_count_: number = 0;
    private logged_video_discontinuity_count_: number = 0;
    private logged_video_sample_count_: number = 0;
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
    private video_waiting_random_access_: boolean = false;
    private dropped_video_timestamp_keys_: {[key: string]: boolean} = {};
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
        this.program_ && this.program_.destroy();
        this.program_ = null;
        this.pending_mfu_units_by_packet_id_ = null;
        this.logged_asset_keys_ = null;
        this.logged_unsupported_audio_packet_ids_ = null;
        this.audio_track_infos_by_packet_id_ = null;
        this.video_track_infos_by_packet_id_ = null;
        this.subtitle_track_infos_by_packet_id_ = null;
        this.audio_parse_states_by_packet_id_ = null;
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

        for (const packet of result.packets) {
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
            this.countMmtpPacket(mmtp);

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

            this.logForcedVideoWaitIfNeeded();
        }

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

            this.maybeSelectPrimaryVideoAsset(asset, false);
            this.maybeSelectPrimaryAudioAsset(asset);
            this.updateTrackInfo(asset);
            const key = `${asset.packetId}:${asset.assetType}:${asset.codec || ''}:${asset.language || ''}`;

            if (!this.logged_asset_keys_[key]) {
                this.logged_asset_keys_[key] = true;
                Log.v(
                    this.TAG,
                    `MPT asset packet_id=${this.formatHex(asset.packetId, 4)}, ` +
                    `asset_type=${asset.assetType}, media=${asset.mediaType}, ` +
                    `codec=${asset.codec || 'unknown'}, lang=${asset.language || 'und'}` +
                    (asset.mediaType === 'video' ? `, resolution=${this.videoResolutionLabel(asset)}` : '')
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
        if (result.discontinuity) {
            this.handleMpuDiscontinuity(mmtp.packetId, asset, mpu.mpuSequenceNumber);
        }
        for (const completed of result.units) {
            this.processCompleteMfuUnit(
                mmtp.packetId,
                asset,
                completed.mpuSequenceNumber,
                completed.fragment,
                completed.randomAccess,
                completed.unit
            );
        }
    }

    private processCompleteMfuUnit(packetId: number,
                                   asset: MMTAsset | undefined,
                                   mpuSequenceNumber: number,
                                   fragment: MFUFragment,
                                   randomAccess: boolean,
                                   unit: Uint8Array): void {
        if (asset === undefined) {
            this.cachePendingMfuUnit(packetId, mpuSequenceNumber, fragment, randomAccess, unit);
            return;
        }

        if (asset.assetType === 'mp4a' || asset.codec === 'aac-latm') {
            this.processAudioMfuUnit(packetId, asset, mpuSequenceNumber, unit);
            return;
        }

        if (asset.assetType === 'stpp' || (asset.mediaType === 'subtitle' && asset.codec === 'ttml')) {
            this.processSubtitleMfuUnit(packetId, asset, mpuSequenceNumber, fragment, unit);
            return;
        }

        if (asset.assetType !== 'hev1') {
            return;
        }

        this.maybeSelectPrimaryVideoAsset(asset, true);

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
        this.logVideoNalu(packetId, mpuSequenceNumber, fragment, naluType, randomAccess, unit.byteLength);
        const naluPayload = new H265NaluPayload();
        naluPayload.type = naluType;
        naluPayload.data = naluData;
        const hvc1 = new H265NaluHVC1(naluPayload);

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
            this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, randomAccess, unit);
            return;
        }

        if (!this.video_init_segment_dispatched_ || !this.isH265VclNalu(naluType)) {
            if (this.video_init_segment_dispatched_ &&
                !this.video_waiting_random_access_ &&
                fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(
                    packetId,
                    mpuSequenceNumber,
                    fragment.sampleNumber,
                    hvc1,
                    false,
                    randomAccess,
                    false
                );
            }
            return;
        }

        const keyframe = this.isH265IrapNalu(naluType) || randomAccess;
        if (this.video_waiting_random_access_) {
            if (!keyframe) {
                this.dropVideoTimestampOnce(packetId, mpuSequenceNumber, fragment.sampleNumber);
                this.dropped_video_sample_count_++;
                this.logDroppedVideoSample(packetId, mpuSequenceNumber, [hvc1], 'waiting-random-access');
                return;
            }
            this.video_waiting_random_access_ = false;
            this.dropped_video_timestamp_keys_ = {};
            Log.v(
                this.TAG,
                `Resume MMTS video after random access packet_id=${this.formatHex(packetId, 4)}, ` +
                `mpu_seq=${mpuSequenceNumber}, type=${naluType}`
            );
        }

        if (fragment.sampleNumber === undefined) {
            this.appendStandaloneVideoSample(packetId, mpuSequenceNumber, [hvc1], hvc1.data.byteLength, keyframe);
            return;
        }

        this.appendH265NaluToAccessUnit(
            packetId,
            mpuSequenceNumber,
            fragment.sampleNumber,
            hvc1,
            keyframe,
            randomAccess,
            true
        );
    }

    private appendH265NaluToAccessUnit(packetId: number,
                                       mpuSequenceNumber: number,
                                       sampleNumber: number,
                                       nalu: H265NaluHVC1,
                                       keyframe: boolean,
                                       randomAccess: boolean,
                                       isVcl: boolean): void {
        if (nalu.type === H265NaluType.kSliceAUD &&
            this.current_video_access_unit_ !== null) {
            if (this.current_video_access_unit_.hasVcl) {
                this.flushCurrentVideoAccessUnit();
            } else {
                this.current_video_access_unit_.units = [];
                this.current_video_access_unit_.length = 0;
                this.current_video_access_unit_.keyframe = false;
                this.current_video_access_unit_.randomAccess = false;
                this.current_video_access_unit_.hasVcl = false;
            }
        }

        if (this.current_video_access_unit_ !== null &&
            (this.current_video_access_unit_.packetId !== packetId ||
             this.current_video_access_unit_.mpuSequenceNumber !== mpuSequenceNumber ||
             this.current_video_access_unit_.sampleNumber !== sampleNumber)) {
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
                randomAccess: false,
                hasVcl: false
            };
        }

        this.current_video_access_unit_.units.push(nalu);
        this.current_video_access_unit_.length += nalu.data.byteLength;
        this.current_video_access_unit_.keyframe = this.current_video_access_unit_.keyframe || keyframe;
        this.current_video_access_unit_.randomAccess = this.current_video_access_unit_.randomAccess || randomAccess;
        this.current_video_access_unit_.hasVcl = this.current_video_access_unit_.hasVcl || isVcl;
    }

    private processAudioMfuUnit(packetId: number,
                                asset: MMTAsset,
                                mpuSequenceNumber: number,
                                unit: Uint8Array): void {
        this.maybeSelectPrimaryAudioAsset(asset);
        const state = this.getAudioParseState(packetId);
        const loas = this.wrapLatmPayloadWithLoasHeader(unit);
        const appendSamples = asset.packetId === this.primary_audio_packet_id_;
        if (!appendSamples) {
            this.parseMMTSLOASAACPayload(packetId, loas, undefined, false, state);
            return;
        }

        if (!this.video_init_segment_dispatched_) {
            this.parseMMTSLOASAACPayload(packetId, loas, undefined, false, state);
            return;
        }

        this.parseMMTSLOASAACPayload(packetId, loas, this.consumeAudioTimestamp(packetId, mpuSequenceNumber), true, state);

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

    private parseMMTSLOASAACPayload(packetId: number,
                                    data: Uint8Array,
                                    pts: number | undefined,
                                    appendSamples: boolean,
                                    state: AudioParseState): void {
        if (state.lastIncompleteData) {
            const buf = new Uint8Array(data.byteLength + state.lastIncompleteData.byteLength);
            buf.set(state.lastIncompleteData, 0);
            buf.set(data, state.lastIncompleteData.byteLength);
            data = buf;
        }

        const parser = new AACLOASParser(data);
        let aacFrame: LOASAACFrame = null;
        let samplePts = pts;
        let lastSamplePts: number | undefined;

        while ((aacFrame = parser.readNextAACFrame(state.previousFrame || undefined)) !== null) {
            state.previousFrame = aacFrame;
            const refSampleDuration = 1024 / aacFrame.sampling_frequency * 1000;
            const audioSample = {
                codec: 'aac',
                data: aacFrame
            } as const;

            state.metadata = {
                codec: 'aac',
                audio_object_type: aacFrame.audio_object_type,
                sampling_freq_index: aacFrame.sampling_freq_index,
                sampling_frequency: aacFrame.sampling_frequency,
                channel_config: aacFrame.channel_config
            };
            this.updateAudioTrackInfoFromFrame(packetId, aacFrame);
            const appendCurrentFrame = appendSamples &&
                packetId === this.primary_audio_packet_id_ &&
                this.isSupportedAACChannelConfig(aacFrame.channel_config);

            if (appendCurrentFrame && !this.audio_init_segment_dispatched_) {
                this.audio_metadata_ = state.metadata;
                this.dispatchAudioInitSegment(audioSample);
            } else if (appendCurrentFrame && this.detectAudioMetadataChange(audioSample)) {
                this.audio_metadata_ = state.metadata;
                this.dispatchAudioMediaSegment();
                this.dispatchAudioInitSegment(audioSample);
            }

            if (!appendCurrentFrame) {
                continue;
            }

            if (samplePts === undefined) {
                samplePts = state.lastSamplePts !== undefined
                    ? state.lastSamplePts + refSampleDuration
                    : 0;
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

            samplePts += refSampleDuration;
        }

        if (parser.hasIncompleteData()) {
            state.lastIncompleteData = parser.getIncompleteData();
        } else {
            state.lastIncompleteData = null;
        }

        if (lastSamplePts !== undefined) {
            state.lastSamplePts = lastSamplePts;
            this.audio_last_sample_pts_ = lastSamplePts;
        }
    }

    private processSubtitleMfuUnit(packetId: number,
                                   asset: MMTAsset,
                                   mpuSequenceNumber: number,
                                   fragment: MFUFragment,
                                   unit: Uint8Array): void {
        const payload = this.extractSubtitlePayload(unit);
        if (payload === null) {
            return;
        }

        const subtitle = new MMTSSubtitleData();
        subtitle.packetId = packetId;
        subtitle.assetType = asset.assetType;
        subtitle.codec = asset.codec || 'ttml';
        subtitle.language = asset.language;
        subtitle.mpuSequenceNumber = mpuSequenceNumber;
        subtitle.sampleNumber = fragment.sampleNumber;
        subtitle.data = payload;
        subtitle.len = payload.byteLength;
        subtitle.text = decodeUTF8(payload);

        const timestamp = this.program_.nextTimestamp(packetId, mpuSequenceNumber);
        if (timestamp !== null) {
            subtitle.rawPts = Math.floor(timestamp.rawPts * 1000 / timestamp.timescale);
            subtitle.rawDts = Math.floor(timestamp.rawDts * 1000 / timestamp.timescale);
            subtitle.pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
            subtitle.dts = Math.floor(timestamp.dts * 1000 / timestamp.timescale);
        }

        if (this.onMMTSSubtitleData) {
            this.onMMTSSubtitleData(subtitle);
        }

        this.logSubtitleData(subtitle);
    }

    private extractSubtitlePayload(unit: Uint8Array): Uint8Array | null {
        if (unit.byteLength < 7) {
            return null;
        }

        let offset = 0;
        offset += 2; // subtitle_tag + subtitle_sequence_number
        const subsampleNumber = unit[offset++];
        const lastSubsampleNumber = unit[offset++];
        const flags = unit[offset++];
        const dataType = flags >> 4;
        const lengthExtFlag = ((flags >> 3) & 0x01) !== 0;
        const subsampleInfoListFlag = ((flags >> 2) & 0x01) !== 0;

        if (dataType !== 0) {
            return null;
        }

        const dataSizeLength = lengthExtFlag ? 4 : 2;
        if (offset + dataSizeLength > unit.byteLength) {
            return null;
        }

        const dataSize = lengthExtFlag
            ? this.readU32(unit, offset)
            : this.readU16(unit, offset);
        offset += dataSizeLength;

        if (subsampleNumber === 0 && lastSubsampleNumber > 0 && subsampleInfoListFlag) {
            const entrySize = lengthExtFlag ? 8 : 6;
            const skipSize = lastSubsampleNumber * entrySize;
            if (offset + skipSize > unit.byteLength) {
                return null;
            }
            offset += skipSize;
        }

        if (offset + dataSize > unit.byteLength) {
            return null;
        }

        return unit.subarray(offset, offset + dataSize);
    }

    private flushCurrentVideoAccessUnit(): void {
        const accessUnit = this.current_video_access_unit_;
        this.current_video_access_unit_ = null;

        if (accessUnit === null || accessUnit.units.length === 0) {
            return;
        }

        if (!accessUnit.hasVcl) {
            return;
        }

        this.appendStandaloneVideoSample(
            accessUnit.packetId,
            accessUnit.mpuSequenceNumber,
            accessUnit.units,
            accessUnit.length,
            accessUnit.keyframe || accessUnit.randomAccess
        );
    }

    private appendStandaloneVideoSample(packetId: number,
                                        mpuSequenceNumber: number,
                                        units: H265NaluHVC1[],
                                        length: number,
                                        keyframe: boolean): void {
        if (keyframe) {
            const result = this.prependVideoParameterSets(units, length);
            units = result.units;
            length = result.length;
        }

        if (!this.video_started_) {
            if (!keyframe) {
                this.dropVideoTimestamp(packetId, mpuSequenceNumber);
                this.dropped_video_sample_count_++;
                this.logDroppedVideoSample(packetId, mpuSequenceNumber, units);
                return;
            }
            this.video_started_ = true;
        }

        const videoTimestamp = this.consumeVideoTimestamp(packetId, mpuSequenceNumber);
        if (this.output_video_dts_base_ < 0 && this.video_sample_index_ === 0) {
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
        this.logVideoSample(packetId, mpuSequenceNumber, units, keyframe, dts, pts);

        if (this.video_sample_index_ === 1 || this.video_track_.samples.length >= 8) {
            this.dispatchVideoMediaSegment();
        }
    }

    private logVideoNalu(packetId: number,
                         mpuSequenceNumber: number,
                         fragment: MFUFragment,
                         naluType: number,
                         randomAccess: boolean,
                         unitLength: number): void {
        if (!this.video_init_segment_dispatched_ || this.logged_video_nalu_count_ >= 24) {
            return;
        }

        this.logged_video_nalu_count_++;
        Log.v(
            this.TAG,
            `MMTS video nalu #${this.logged_video_nalu_count_}, ` +
            `packet_id=${this.formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `sample=${fragment.sampleNumber !== undefined ? fragment.sampleNumber : 'n/a'}, ` +
            `offset=${fragment.offset !== undefined ? fragment.offset : 'n/a'}, ` +
            `frag=${fragment.fragmentationIndicator}, rap=${randomAccess ? 1 : 0}, type=${naluType}, len=${unitLength}`
        );
    }

    private logDroppedVideoSample(packetId: number,
                                  mpuSequenceNumber: number,
                                  units: H265NaluHVC1[],
                                  reason: string = 'non-keyframe'): void {
        if (this.logged_dropped_video_sample_count_ >= 12) {
            return;
        }

        this.logged_dropped_video_sample_count_++;
        Log.v(
            this.TAG,
            `Drop MMTS video sample before keyframe #${this.logged_dropped_video_sample_count_}, ` +
            `packet_id=${this.formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `reason=${reason}, nal_types=${this.formatH265NaluTypes(units)}`
        );
    }

    private prependVideoParameterSets(units: H265NaluHVC1[], length: number): {units: H265NaluHVC1[], length: number} {
        const parameterSets = [
            this.video_metadata_.vps,
            this.video_metadata_.sps,
            this.video_metadata_.pps
        ].filter((unit) => unit !== undefined) as H265NaluHVC1[];

        if (parameterSets.length === 0 || this.hasVideoParameterSets(units)) {
            return {units, length};
        }

        const nextUnits = parameterSets.concat(units);
        const nextLength = length + parameterSets.reduce((sum, unit) => sum + unit.data.byteLength, 0);
        return {units: nextUnits, length: nextLength};
    }

    private hasVideoParameterSets(units: H265NaluHVC1[]): boolean {
        return units.some((unit) => {
            return unit.type === H265NaluType.kSliceVPS ||
                unit.type === H265NaluType.kSliceSPS ||
                unit.type === H265NaluType.kSlicePPS;
        });
    }

    private logVideoSample(packetId: number,
                           mpuSequenceNumber: number,
                           units: H265NaluHVC1[],
                           keyframe: boolean,
                           dts: number,
                           pts: number): void {
        if (this.logged_video_sample_count_ >= 12) {
            return;
        }

        this.logged_video_sample_count_++;
        Log.v(
            this.TAG,
            `MMTS video sample #${this.logged_video_sample_count_}, ` +
            `packet_id=${this.formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `keyframe=${keyframe ? 1 : 0}, dts=${dts}, pts=${pts}, ` +
            `nal_types=${this.formatH265NaluTypes(units)}`
        );
    }

    private dropVideoTimestamp(packetId: number, mpuSequenceNumber: number): void {
        // Keep the per-MPU AU index aligned while waiting for the first keyframe.
        // Do not touch last_video_dts_/pts here; dropped samples must not define
        // the emitted media timeline.
        this.program_.nextTimestamp(packetId, mpuSequenceNumber);
    }

    private dropVideoTimestampOnce(packetId: number,
                                   mpuSequenceNumber: number,
                                   sampleNumber: number | undefined): void {
        const key = `${packetId}:${mpuSequenceNumber}:${sampleNumber !== undefined ? sampleNumber : 'standalone'}`;
        if (this.dropped_video_timestamp_keys_[key]) {
            return;
        }

        this.dropped_video_timestamp_keys_[key] = true;
        this.dropVideoTimestamp(packetId, mpuSequenceNumber);
    }

    private handleMpuDiscontinuity(packetId: number, asset: MMTAsset | undefined, mpuSequenceNumber: number): void {
        if (asset === undefined ||
            asset.assetType !== 'hev1' ||
            packetId !== this.primary_video_packet_id_) {
            return;
        }

        this.current_video_access_unit_ = null;
        this.video_waiting_random_access_ = true;
        this.dropped_video_timestamp_keys_ = {};

        if (this.logged_video_discontinuity_count_ >= 8) {
            return;
        }

        this.logged_video_discontinuity_count_++;
        Log.v(
            this.TAG,
            `MMTS video packet discontinuity #${this.logged_video_discontinuity_count_}, ` +
            `packet_id=${this.formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}; wait random access`
        );
    }

    private consumeVideoTimestamp(packetId: number, mpuSequenceNumber: number): VideoTimestamp {
        const timestamp = this.program_.nextTimestamp(packetId, mpuSequenceNumber);
        let source: 'descriptor' | 'fallback' | 'corrected' = 'descriptor';
        let pts: number;
        let dts: number;
        let originalPts: number;
        let originalDts: number;
        let originalSource: 'descriptor' | 'fallback' = 'descriptor';

        if (timestamp !== null) {
            pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
            dts = Math.floor(timestamp.dts * 1000 / timestamp.timescale);
            originalPts = pts;
            originalDts = dts;

            if (this.last_video_dts_ >= 0) {
                const duration = dts - this.last_video_dts_;
                if (duration > 0 && duration < 100) {
                    this.last_video_duration_ = duration;
                }
            }
        } else {
            source = 'fallback';
            originalSource = 'fallback';
            if (this.last_video_dts_ >= 0) {
                dts = this.last_video_dts_ + this.last_video_duration_;
                pts = this.last_video_pts_ + this.last_video_duration_;
            } else {
                dts = 0;
                pts = 0;
            }
            originalPts = pts;
            originalDts = dts;

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
                `packet_id=0x${packetId.toString(16)}, mpu_seq=${mpuSequenceNumber}, ` +
                `source=${originalSource}, raw_dts=${originalDts}, raw_pts=${originalPts}, ` +
                `last_dts=${this.last_video_dts_}, fixed_dts=${dts}, fixed_pts=${pts}`
            );
        }

        this.last_video_dts_ = dts;
        this.last_video_pts_ = pts;
        return {dts, pts, source};
    }

    private consumeAudioTimestamp(packetId: number, mpuSequenceNumber: number): number | undefined {
        const timestamp = this.program_.nextTimestamp(packetId, mpuSequenceNumber);
        if (timestamp !== null) {
            return Math.floor(timestamp.pts * 1000 / timestamp.timescale);
        }

        if (this.logged_audio_timestamp_fallback_count_ < 4) {
            this.logged_audio_timestamp_fallback_count_++;
            Log.v(
                this.TAG,
                `Fallback MMTS AAC timestamp #${this.logged_audio_timestamp_fallback_count_}, ` +
                `packet_id=${this.formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}`
            );
        }
        return undefined;
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

        const info = this.audio_track_infos_by_packet_id_[asset.packetId];
        if (info === undefined) {
            return;
        }

        if (!this.isMMTSAudioTrackSelectable(info)) {
            this.logUnsupportedMMTSAudioTrack(asset.packetId, info);
            return;
        }

        if (!this.hasKnownMMTSAudioSupport(info)) {
            return;
        }

        this.primary_audio_packet_id_ = asset.packetId;
        Log.v(this.TAG, `Select primary MMTS audio packet_id=${this.formatHex(asset.packetId, 4)}`);
        this.dispatchAudioTracksIfChanged();
    }

    public selectAudioTrack(packetId: number): boolean {
        const info = this.audio_track_infos_by_packet_id_[packetId];
        if (info === undefined) {
            return false;
        }

        if (this.primary_audio_packet_id_ === packetId) {
            return true;
        }

        this.dispatchAudioMediaSegment(true);
        this.primary_audio_packet_id_ = packetId;
        this.audio_init_segment_dispatched_ = false;
        this.audio_last_sample_pts_ = undefined;
        this.audio_track_ = {
            type: 'audio',
            id: 2,
            sequenceNumber: this.audio_track_.sequenceNumber,
            samples: [],
            length: 0
        };
        Log.v(this.TAG, `Select MMTS audio packet_id=${this.formatHex(packetId, 4)}`);
        this.dispatchAudioTracksIfChanged(true);
        return true;
    }

    public selectVideoTrack(packetId: number): boolean {
        const info = this.video_track_infos_by_packet_id_[packetId];
        const asset = this.program_.getAsset(packetId);
        if (info === undefined && (asset === undefined || asset.assetType !== 'hev1')) {
            return false;
        }

        if (this.primary_video_packet_id_ === packetId) {
            return true;
        }

        this.flushCurrentVideoAccessUnit();
        this.dispatchVideoMediaSegment();
        this.primary_video_packet_id_ = packetId;
        if (this.config_) {
            this.config_.mmtsVideoPacketId = packetId;
        }
        this.program_.resetMpuPacketState(packetId);
        this.resetVideoBootstrapState(true);
        Log.v(this.TAG, `Select MMTS video packet_id=${this.formatHex(packetId, 4)}`);
        this.dispatchVideoTracksIfChanged(true);
        return true;
    }

    public selectPrimaryAudioTrack(): void {
        const primary = this.findPreferredAudioTrack(false);
        if (primary !== undefined) {
            this.selectAudioTrack(primary.packetId);
        }
    }

    public selectSecondaryAudioTrack(): void {
        const tracks = this.getSortedAudioTrackInfos();
        if (tracks.length === 0) {
            return;
        }

        const selectableTracks = tracks.filter((track) => this.isMMTSAudioTrackSelectable(track));
        if (selectableTracks.length === 0) {
            return;
        }

        const currentIndex = selectableTracks.findIndex((track) => track.packetId === this.primary_audio_packet_id_);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % selectableTracks.length : 0;
        this.selectAudioTrack(selectableTracks[nextIndex].packetId);
    }

    private maybeSelectPrimaryVideoAsset(asset: MMTAsset, hasCurrentUnit: boolean): void {
        if (asset.assetType !== 'hev1' || this.video_started_) {
            return;
        }

        const forcedPacketId = this.getForcedMMTSVideoPacketId();
        if (forcedPacketId !== undefined && asset.packetId !== forcedPacketId) {
            return;
        }

        const score = this.scorePendingVideoAsset(asset.packetId);
        const hasActivity = hasCurrentUnit || score > 0;
        if (forcedPacketId === undefined && !hasActivity) {
            return;
        }

        if (this.primary_video_packet_id_ >= 0) {
            if (this.video_init_segment_dispatched_) {
                return;
            }
            if (this.scoreVideoAsset(asset) <= this.scoreVideoAsset(this.program_.getAsset(this.primary_video_packet_id_))) {
                return;
            }
            this.resetVideoBootstrapState();
        }

        this.primary_video_packet_id_ = asset.packetId;
        Log.v(
            this.TAG,
            `Select primary MMTS video packet_id=${this.formatHex(asset.packetId, 4)}, ` +
            `score=${score}, resolution=${this.videoResolutionLabel(asset)}` +
            `${forcedPacketId !== undefined ? ', forced=1' : ''}` +
            `${!hasActivity ? ', inactive=1' : ''}`
        );
        if (forcedPacketId !== undefined && !hasActivity) {
            this.logForcedVideoWait(true);
        }
        this.dispatchVideoTracksIfChanged(true);
    }

    private countMmtpPacket(mmtp): void {
        this.mmtp_packet_counts_by_packet_id_[mmtp.packetId] =
            (this.mmtp_packet_counts_by_packet_id_[mmtp.packetId] || 0) + 1;
        if (mmtp.payloadType === MMTPPayloadType.Mpu) {
            this.mmtp_mpu_counts_by_packet_id_[mmtp.packetId] =
                (this.mmtp_mpu_counts_by_packet_id_[mmtp.packetId] || 0) + 1;
            if (this.video_track_infos_by_packet_id_[mmtp.packetId] !== undefined) {
                this.video_track_infos_by_packet_id_[mmtp.packetId].active = true;
                this.dispatchVideoTracksIfChanged();
            }
        }
    }

    private logForcedVideoWaitIfNeeded(): void {
        const forcedPacketId = this.getForcedMMTSVideoPacketId();
        if (forcedPacketId === undefined ||
            this.primary_video_packet_id_ !== forcedPacketId ||
            this.video_init_segment_dispatched_) {
            return;
        }

        const forcedMpuCount = this.mmtp_mpu_counts_by_packet_id_[forcedPacketId] || 0;
        if (forcedMpuCount > 0) {
            return;
        }

        if (this.parsed_mmtp_count_ < this.next_forced_video_wait_log_count_) {
            return;
        }

        this.next_forced_video_wait_log_count_ += 4096;
        this.logForcedVideoWait(false);
    }

    private logForcedVideoWait(immediate: boolean): void {
        const forcedPacketId = this.getForcedMMTSVideoPacketId();
        if (forcedPacketId === undefined) {
            return;
        }

        Log.v(
            this.TAG,
            `Waiting for forced MMTS video packet_id=${this.formatHex(forcedPacketId, 4)}, ` +
            `seen_mpu=${this.mmtp_mpu_counts_by_packet_id_[forcedPacketId] || 0}, ` +
            `parsed_packets=${this.parsed_mmtp_count_}, ` +
            `seen_packet_ids=${this.formatPacketCounts(this.mmtp_mpu_counts_by_packet_id_)}` +
            `${immediate ? ', reason=inactive-selected' : ''}`
        );
    }

    private getForcedMMTSVideoPacketId(): number | undefined {
        if (!this.config_) {
            return undefined;
        }

        const value = this.config_.mmtsVideoPacketId;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            return value;
        }

        return undefined;
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

    private scoreVideoAsset(asset: MMTAsset | undefined): number {
        if (asset === undefined) {
            return -1;
        }

        return (asset.videoResolution !== undefined ? asset.videoResolution * 10000 : 0) +
            this.scorePendingVideoAsset(asset.packetId);
    }

    private videoResolutionLabel(asset: MMTAsset): string {
        switch (asset.videoResolution) {
            case 0x01:
                return '180p';
            case 0x02:
                return '240p';
            case 0x03:
                return '480p';
            case 0x04:
                return '720p';
            case 0x05:
                return '1080p';
            case 0x06:
                return '2160p';
            case 0x07:
                return '4320p';
            default:
                return asset.videoResolution !== undefined ? `code=${asset.videoResolution}` : 'unknown';
        }
    }

    private resetVideoBootstrapState(preserveTimeline: boolean = false): void {
        const videoSampleIndex = this.video_sample_index_;
        const lastVideoDts = this.last_video_dts_;
        const lastVideoPts = this.last_video_pts_;
        const lastVideoDuration = this.last_video_duration_;
        const outputVideoDtsBase = this.output_video_dts_base_;

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
        this.last_video_dts_ = -1;
        this.last_video_pts_ = -1;
        this.last_video_duration_ = 17;
        this.output_video_dts_base_ = -1;
        this.logged_video_nalu_count_ = 0;
        this.logged_dropped_video_sample_count_ = 0;
        this.logged_video_discontinuity_count_ = 0;
        this.logged_video_sample_count_ = 0;
        this.current_video_access_unit_ = null;
        this.video_waiting_random_access_ = false;
        this.dropped_video_timestamp_keys_ = {};
        this.pre_init_video_units_ = [];

        if (preserveTimeline) {
            this.video_sample_index_ = videoSampleIndex;
            this.last_video_dts_ = lastVideoDts;
            this.last_video_pts_ = lastVideoPts;
            this.last_video_duration_ = lastVideoDuration;
            this.output_video_dts_base_ = outputVideoDtsBase;
        }
    }

    private updateTrackInfo(asset: MMTAsset): void {
        if (asset.assetType === 'hev1' || asset.mediaType === 'video') {
            this.video_track_infos_by_packet_id_[asset.packetId] = {
                ...this.video_track_infos_by_packet_id_[asset.packetId],
                packetId: asset.packetId,
                assetType: asset.assetType,
                codec: asset.codec || 'hevc',
                language: asset.language,
                componentTag: asset.componentTag,
                resolution: asset.videoResolution,
                resolutionLabel: this.videoResolutionLabel(asset),
                frameRateCode: asset.videoFrameRate,
                active: (this.mmtp_mpu_counts_by_packet_id_[asset.packetId] || 0) > 0 ||
                    this.scorePendingVideoAsset(asset.packetId) > 0,
                selected: asset.packetId === this.primary_video_packet_id_
            };
            this.dispatchVideoTracksIfChanged();
            return;
        }

        if (asset.assetType === 'mp4a' || asset.codec === 'aac-latm') {
            this.audio_track_infos_by_packet_id_[asset.packetId] = {
                ...this.audio_track_infos_by_packet_id_[asset.packetId],
                packetId: asset.packetId,
                assetType: asset.assetType,
                codec: asset.codec || 'aac-latm',
                language: asset.language,
                componentType: asset.audioComponentType,
                componentTag: asset.componentTag !== undefined ? asset.componentTag : asset.audioComponentTag,
                streamType: asset.audioStreamType,
                simulcastGroupTag: asset.audioSimulcastGroupTag,
                mainComponent: asset.audioMainComponent,
                qualityIndicator: asset.audioQualityIndicator,
                samplingRateCode: asset.audioSamplingRateCode,
                audioSampleRate: this.audioSampleRateFromCode(asset.audioSamplingRateCode),
                channelLayout: this.audioLayoutFromComponentType(asset.audioComponentType),
                channelCount: this.audioChannelCountFromComponentType(asset.audioComponentType),
                selected: asset.packetId === this.primary_audio_packet_id_
            };
            this.dispatchAudioTracksIfChanged();
            return;
        }

        if (asset.assetType === 'stpp' || (asset.mediaType === 'subtitle' && asset.codec === 'ttml')) {
            this.subtitle_track_infos_by_packet_id_[asset.packetId] = {
                packetId: asset.packetId,
                assetType: asset.assetType,
                codec: asset.codec || 'ttml',
                language: asset.language,
                componentTag: asset.componentTag,
                dataComponentId: asset.dataComponentId,
                dataComponentInfo: asset.dataComponentInfo
            };
            this.dispatchSubtitleTracksIfChanged();
        }
    }

    private updateAudioTrackInfoFromFrame(packetId: number, frame: LOASAACFrame): void {
        const prev = this.audio_track_infos_by_packet_id_[packetId];
        this.audio_track_infos_by_packet_id_[packetId] = {
            ...prev,
            packetId,
            assetType: prev ? prev.assetType : 'mp4a',
            codec: prev && prev.codec ? prev.codec : 'aac-latm',
            channelConfig: frame.channel_config,
            channelCount: this.audioChannelCountFromAacConfig(frame.channel_config) ||
                (prev && prev.channelCount) ||
                this.audioChannelCountFromComponentType(prev && prev.componentType),
            channelLayout: this.audioLayoutFromAacConfig(frame.channel_config) ||
                (prev && prev.channelLayout) ||
                this.audioLayoutFromComponentType(prev && prev.componentType),
            audioSampleRate: frame.sampling_frequency,
            selected: packetId === this.primary_audio_packet_id_
        };
        this.maybePromotePrimaryAudioTrack(packetId);
        this.dispatchAudioTracksIfChanged();
    }

    private maybePromotePrimaryAudioTrack(packetId: number): void {
        const info = this.audio_track_infos_by_packet_id_[packetId];
        if (!this.isMMTSAudioTrackSelectable(info)) {
            if (this.primary_audio_packet_id_ === packetId && !this.audio_init_segment_dispatched_) {
                this.primary_audio_packet_id_ = -1;
                this.dispatchAudioTracksIfChanged(true);
            }
            this.logUnsupportedMMTSAudioTrack(packetId, info);
            return;
        }

        if (!this.hasKnownMMTSAudioSupport(info)) {
            return;
        }

        if (this.audio_init_segment_dispatched_) {
            return;
        }

        const primary = this.findPreferredAudioTrack(true);
        if (primary === undefined || primary.packetId === this.primary_audio_packet_id_) {
            return;
        }

        this.primary_audio_packet_id_ = primary.packetId;
        Log.v(this.TAG, `Select primary MMTS audio packet_id=${this.formatHex(primary.packetId, 4)}`);
        this.dispatchAudioTracksIfChanged(true);
    }

    private findPreferredAudioTrack(requireKnownSupport: boolean): MMTSAudioTrackInfo | undefined {
        const tracks = this.getSortedAudioTrackInfos().filter((track) => {
            return this.isMMTSAudioTrackSelectable(track) &&
                (!requireKnownSupport || this.hasKnownMMTSAudioSupport(track));
        });
        if (tracks.length === 0) {
            return undefined;
        }

        return tracks.reduce((best, track) => {
            return this.scoreAudioTrack(track) > this.scoreAudioTrack(best) ? track : best;
        }, tracks[0]);
    }

    private scoreAudioTrack(track: MMTSAudioTrackInfo): number {
        const channelCount = track.channelCount || 0;
        const knownSupport = this.hasKnownMMTSAudioSupport(track) ? 10000 : 0;
        const main = track.mainComponent ? 100 : 0;
        const quality = track.qualityIndicator !== undefined ? track.qualityIndicator : 0;
        return knownSupport + channelCount * 1000 + main + quality;
    }

    private hasKnownMMTSAudioSupport(info: MMTSAudioTrackInfo | undefined): boolean {
        return info !== undefined &&
            info.channelConfig !== undefined &&
            this.isSupportedAACChannelConfig(info.channelConfig);
    }

    private isMMTSAudioTrackSelectable(info: MMTSAudioTrackInfo | undefined): boolean {
        if (info === undefined) {
            return false;
        }

        if (info.channelConfig !== undefined) {
            return this.isSupportedAACChannelConfig(info.channelConfig);
        }

        if (info.channelCount !== undefined && info.channelCount > 8) {
            return false;
        }

        return info.channelLayout !== '10.2ch' && info.channelLayout !== '22.2ch';
    }

    private isSupportedAACChannelConfig(channelConfig: number): boolean {
        return channelConfig >= 1 && channelConfig <= 7;
    }

    private logUnsupportedMMTSAudioTrack(packetId: number, info: MMTSAudioTrackInfo | undefined): void {
        if (this.logged_unsupported_audio_packet_ids_[packetId]) {
            return;
        }
        this.logged_unsupported_audio_packet_ids_[packetId] = true;

        const parts: string[] = [`packet_id=${this.formatHex(packetId, 4)}`];
        if (info && info.channelConfig !== undefined) {
            parts.push(`channel_config=${info.channelConfig}`);
        }
        if (info && info.channelLayout) {
            parts.push(`layout=${info.channelLayout}`);
        }
        if (info && info.channelCount !== undefined) {
            parts.push(`channels=${info.channelCount}`);
        }
        Log.w(this.TAG, `Skip unsupported MMTS audio track (${parts.join(', ')})`);
    }

    private getAudioParseState(packetId: number): AudioParseState {
        let state = this.audio_parse_states_by_packet_id_[packetId];
        if (state === undefined) {
            state = {
                metadata: {
                    codec: 'aac',
                    audio_object_type: undefined,
                    sampling_freq_index: undefined,
                    sampling_frequency: undefined,
                    channel_config: undefined
                },
                lastIncompleteData: null,
                previousFrame: null
            };
            this.audio_parse_states_by_packet_id_[packetId] = state;
        }
        return state;
    }

    private dispatchAudioTracksIfChanged(force: boolean = false): void {
        const tracks = this.getSortedAudioTrackInfos().map((track) => {
            return {
                ...track,
                selected: track.packetId === this.primary_audio_packet_id_
            };
        });
        const signature = JSON.stringify(tracks);
        if (!force && signature === this.audio_tracks_signature_) {
            return;
        }
        this.audio_tracks_signature_ = signature;

        const list = new MMTSAudioTrackList();
        list.tracks = tracks;
        list.selectedPacketId = this.primary_audio_packet_id_ >= 0 ? this.primary_audio_packet_id_ : undefined;
        if (this.onMMTSAudioTracks) {
            this.onMMTSAudioTracks(list);
        }
    }

    private dispatchVideoTracksIfChanged(force: boolean = false): void {
        const tracks = this.getSortedVideoTrackInfos().map((track) => {
            return {
                ...track,
                active: track.active || (this.mmtp_mpu_counts_by_packet_id_[track.packetId] || 0) > 0,
                selected: track.packetId === this.primary_video_packet_id_
            };
        });
        const fallback = this.isMMTSVideoFallback(tracks);
        const fallbackReason = fallback ? 'higher-inactive' : undefined;
        const selectedRole = this.getMMTSSelectedVideoRole(tracks, fallback);
        const primaryTrack = this.findMMTSPrimaryVideoTrack(tracks);
        const secondaryTrack = this.findMMTSSecondaryVideoTrack(tracks, primaryTrack);
        tracks.forEach((track) => {
            if (primaryTrack !== undefined && track.packetId === primaryTrack.packetId) {
                track.role = 'primary';
            } else if (secondaryTrack !== undefined && track.packetId === secondaryTrack.packetId) {
                track.role = 'secondary';
            }
        });
        const selectedPacketId = this.primary_video_packet_id_ >= 0 ? this.primary_video_packet_id_ : undefined;
        const hasPrimary = primaryTrack !== undefined;
        const primaryActive = primaryTrack !== undefined && primaryTrack.active === true;
        const hasSecondary = secondaryTrack !== undefined;
        const secondaryActive = secondaryTrack !== undefined && secondaryTrack.active === true;
        const signature = JSON.stringify({
            tracks,
            selectedPacketId,
            fallback,
            fallbackReason,
            selectedRole,
            hasPrimary,
            primaryActive,
            hasSecondary,
            secondaryActive
        });
        if (!force && signature === this.video_tracks_signature_) {
            return;
        }
        this.video_tracks_signature_ = signature;

        const list = new MMTSVideoTrackList();
        list.tracks = tracks;
        list.selectedPacketId = selectedPacketId;
        list.fallback = fallback;
        list.fallbackReason = fallbackReason;
        list.selectedRole = selectedRole;
        list.hasPrimary = hasPrimary;
        list.primaryActive = primaryActive;
        list.hasSecondary = hasSecondary;
        list.secondaryActive = secondaryActive;
        if (this.onMMTSVideoTracks) {
            this.onMMTSVideoTracks(list);
        }
    }

    private dispatchSubtitleTracksIfChanged(force: boolean = false): void {
        const tracks = this.getSortedSubtitleTrackInfos();
        const signature = JSON.stringify(tracks);
        if (!force && signature === this.subtitle_tracks_signature_) {
            return;
        }
        this.subtitle_tracks_signature_ = signature;

        const list = new MMTSSubtitleTrackList();
        list.tracks = tracks;
        if (this.onMMTSSubtitleTracks) {
            this.onMMTSSubtitleTracks(list);
        }
        Log.v(this.TAG, `MMTS subtitle tracks: ${JSON.stringify(tracks.map((track) => {
            return {
                packetId: this.formatHex(track.packetId, 4),
                assetType: track.assetType,
                codec: track.codec || 'unknown',
                language: track.language || 'und',
                componentTag: track.componentTag !== undefined ? this.formatHex(track.componentTag, 4) : undefined,
                dataComponentId: track.dataComponentId !== undefined ? this.formatHex(track.dataComponentId, 4) : undefined,
                dataComponentInfo: track.dataComponentInfo ? this.toHex(track.dataComponentInfo) : undefined
            };
        }))}`);
    }

    private isMMTSVideoFallback(tracks: MMTSVideoTrackInfo[]): boolean {
        const selected = tracks.find((track) => track.packetId === this.primary_video_packet_id_);
        if (selected === undefined || selected.active !== true) {
            return false;
        }

        const selectedResolution = selected.resolution || 0;
        return tracks.some((track) => {
            return (track.resolution || 0) > selectedResolution && track.active !== true;
        });
    }

    private getMMTSSelectedVideoRole(tracks: MMTSVideoTrackInfo[], fallback: boolean): 'primary' | 'secondary' | undefined {
        if (this.primary_video_packet_id_ < 0) {
            return undefined;
        }
        if (fallback) {
            return 'secondary';
        }

        const selected = tracks.find((track) => track.packetId === this.primary_video_packet_id_);
        if (selected === undefined) {
            return undefined;
        }

        const primaryTrack = this.findMMTSPrimaryVideoTrack(tracks);
        if (primaryTrack === undefined || selected.resolution === undefined) {
            return undefined;
        }

        return selected.resolution >= (primaryTrack.resolution || 0) ? 'primary' : 'secondary';
    }

    private findMMTSPrimaryVideoTrack(tracks: MMTSVideoTrackInfo[]): MMTSVideoTrackInfo | undefined {
        const tracksWithResolution = tracks.filter((track) => (track.resolution || 0) > 0);
        if (tracksWithResolution.length === 0) {
            return undefined;
        }

        return tracksWithResolution.reduce((best, track) => {
            return (track.resolution || 0) > (best.resolution || 0) ? track : best;
        }, tracksWithResolution[0]);
    }

    private findMMTSSecondaryVideoTrack(tracks: MMTSVideoTrackInfo[], primaryTrack: MMTSVideoTrackInfo | undefined): MMTSVideoTrackInfo | undefined {
        if (primaryTrack === undefined || primaryTrack.resolution === undefined) {
            return undefined;
        }

        const secondaryTracks = tracks.filter((track) => {
            return (track.resolution || 0) > 0 && (track.resolution || 0) < primaryTrack.resolution!;
        });
        if (secondaryTracks.length === 0) {
            return undefined;
        }

        return secondaryTracks.reduce((best, track) => {
            return (track.resolution || 0) > (best.resolution || 0) ? track : best;
        }, secondaryTracks[0]);
    }

    private getSortedAudioTrackInfos(): MMTSAudioTrackInfo[] {
        return Object.keys(this.audio_track_infos_by_packet_id_)
            .map((key) => this.audio_track_infos_by_packet_id_[Number(key)])
            .sort((a, b) => a.packetId - b.packetId);
    }

    private getSortedVideoTrackInfos(): MMTSVideoTrackInfo[] {
        return Object.keys(this.video_track_infos_by_packet_id_)
            .map((key) => this.video_track_infos_by_packet_id_[Number(key)])
            .sort((a, b) => {
                const resolutionDiff = (b.resolution || 0) - (a.resolution || 0);
                return resolutionDiff !== 0 ? resolutionDiff : a.packetId - b.packetId;
            });
    }

    private getSortedSubtitleTrackInfos(): MMTSSubtitleTrackInfo[] {
        return Object.keys(this.subtitle_track_infos_by_packet_id_)
            .map((key) => this.subtitle_track_infos_by_packet_id_[Number(key)])
            .sort((a, b) => a.packetId - b.packetId);
    }

    private audioSampleRateFromCode(code: number | undefined): number | undefined {
        switch (code) {
            case 0x01:
                return 16000;
            case 0x02:
                return 22050;
            case 0x03:
                return 24000;
            case 0x05:
                return 32000;
            case 0x06:
                return 44100;
            case 0x07:
                return 48000;
            default:
                return undefined;
        }
    }

    private audioLayoutFromComponentType(componentType: number | undefined): string | undefined {
        if (componentType === undefined) {
            return undefined;
        }
        switch (componentType & 0x1f) {
            case 0x01:
                return 'mono';
            case 0x02:
                return 'dual-mono';
            case 0x03:
                return 'stereo';
            case 0x04:
                return '2/1';
            case 0x05:
                return '3ch';
            case 0x06:
                return '2/2';
            case 0x07:
                return '4ch';
            case 0x08:
                return '5ch';
            case 0x09:
                return '5.1ch';
            case 0x0a:
                return '3/3.1';
            case 0x0b:
                return '6.1ch';
            case 0x0c:
            case 0x0d:
            case 0x0e:
            case 0x0f:
                return '7.1ch';
            case 0x10:
                return '10.2ch';
            case 0x11:
                return '22.2ch';
            default:
                return undefined;
        }
    }

    private audioChannelCountFromComponentType(componentType: number | undefined): number | undefined {
        if (componentType === undefined) {
            return undefined;
        }
        switch (componentType & 0x1f) {
            case 0x01:
                return 1;
            case 0x02:
            case 0x03:
                return 2;
            case 0x04:
            case 0x05:
                return 3;
            case 0x06:
            case 0x07:
                return 4;
            case 0x08:
                return 5;
            case 0x09:
                return 6;
            case 0x0a:
            case 0x0b:
                return 7;
            case 0x0c:
            case 0x0d:
            case 0x0e:
            case 0x0f:
                return 8;
            case 0x10:
                return 12;
            case 0x11:
                return 24;
            default:
                return undefined;
        }
    }

    private audioLayoutFromAacConfig(channelConfig: number): string | undefined {
        switch (channelConfig) {
            case 1:
                return 'mono';
            case 2:
                return 'stereo';
            case 3:
                return '3ch';
            case 4:
                return '4ch';
            case 5:
                return '5ch';
            case 6:
                return '5.1ch';
            case 7:
                return '7.1ch';
            default:
                return undefined;
        }
    }

    private audioChannelCountFromAacConfig(channelConfig: number): number | undefined {
        if (channelConfig >= 1 && channelConfig <= 7) {
            return channelConfig === 7 ? 8 : channelConfig;
        }
        return undefined;
    }

    private logSubtitleData(subtitle: MMTSSubtitleData): void {
        Log.v(
            this.TAG,
            `MMTS subtitle packet_id=${this.formatHex(subtitle.packetId, 4)}, ` +
            `asset=${subtitle.assetType}, codec=${subtitle.codec || 'unknown'}, ` +
            `lang=${subtitle.language || 'und'}, mpu_seq=${subtitle.mpuSequenceNumber}, ` +
            `sample=${subtitle.sampleNumber !== undefined ? subtitle.sampleNumber : 'n/a'}, ` +
            `pts=${subtitle.pts !== undefined ? subtitle.pts : 'n/a'}, ` +
            `dts=${subtitle.dts !== undefined ? subtitle.dts : 'n/a'}, ` +
            `raw_pts=${subtitle.rawPts !== undefined ? subtitle.rawPts : 'n/a'}, ` +
            `raw_dts=${subtitle.rawDts !== undefined ? subtitle.rawDts : 'n/a'}, ` +
            `len=${subtitle.len}`
        );
        // Log.v(this.TAG, `MMTS subtitle TTML:\n${subtitle.text || ''}`);
    }

    private toHex(data: Uint8Array): string {
        const hex: string[] = [];
        for (let i = 0; i < data.byteLength; i++) {
            hex.push(data[i].toString(16).padStart(2, '0'));
        }
        return hex.join('');
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
                                randomAccess: boolean,
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
            randomAccess,
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
                pendingUnit.randomAccess,
                pendingUnit.unit
            );
        }
    }

    private cachePreInitVideoUnit(mpuSequenceNumber: number,
                                  fragment: MFUFragment,
                                  randomAccess: boolean,
                                  unit: Uint8Array): void {
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
            randomAccess,
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

        // Log.v(this.TAG, `Replay ${pending.length} pre-init MMTS video NAL units`);
        for (const pendingUnit of pending) {
            this.processCompleteMfuUnit(
                asset.packetId,
                asset,
                pendingUnit.mpuSequenceNumber,
                pendingUnit.fragment,
                pendingUnit.randomAccess,
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

    private dispatchAudioMediaSegment(force: boolean = false): void {
        if (!this.audio_init_segment_dispatched_ || (!force && this.audio_track_.length === 0)) {
            return;
        }

        if (this.audio_track_.length > 0 || force) {
            this.onDataAvailable && this.onDataAvailable(this.audio_track_, null, force);
        }
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

        this.onDataAvailable && this.onDataAvailable(null, this.video_track_);
        this.video_track_ = {
            type: 'video',
            id: 1,
            sequenceNumber: this.video_track_.sequenceNumber,
            samples: [],
            length: 0
        };
    }

    private formatHex(value: number, width: number): string {
        return '0x' + value.toString(16).padStart(width, '0');
    }

    private formatH265NaluTypes(units: H265NaluHVC1[]): string {
        return units.map((unit) => unit.type).join(',');
    }

    private formatPacketCounts(counts: {[packetId: number]: number}): string {
        const entries = Object.keys(counts).map((key) => {
            const packetId = Number(key);
            return {packetId, count: counts[packetId]};
        });
        entries.sort((a, b) => b.count - a.count);
        return entries.slice(0, 12).map((entry) => {
            return `${this.formatHex(entry.packetId, 4)}:${entry.count}`;
        }).join(',');
    }

    private readU16(data: Uint8Array, offset: number): number {
        return (data[offset] << 8) | data[offset + 1];
    }

    private readU32(data: Uint8Array, offset: number): number {
        return ((data[offset] << 24) >>> 0) +
            (data[offset + 1] << 16) +
            (data[offset + 2] << 8) +
            data[offset + 3];
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

}

export default MMTSDemuxer;

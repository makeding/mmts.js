import BaseDemuxer from './base-demuxer';
import TLV from './tlv';
import CompressedIP from './compressed-ip';
import IP from './ip';
import MMTP, {MMTPPayloadType} from './mmtp';
import {MMTAsset} from './mmt-si';
import MPU, {FragmentationIndicator, MFUFragment, MPUInfo} from './mpu';
import MMTSProgram, {MMTSPacketLossInfo, MMTSTimestamp} from './mmts-program';
import {AACLOASParser, AudioSpecificConfig, LOASAACFrame} from './aac';
import {MPEG4AudioObjectTypes, MPEG4SamplingFrequencyIndex} from './mpeg4-audio';
import {H265NaluHVC1, H265NaluPayload, H265NaluType, HEVCDecoderConfigurationRecord} from './h265';
import H265Parser from './h265-parser';
import HEVCPocRecovery, {
    HEVCPictureOrderInput,
    HEVCPreparedMpu,
    HEVCRecoveredPicture
} from './hevc-poc';
import {normalizeH265AccessUnitForSampleEntry} from './h265-sample-entry';
import MMTSVideoMpuAssembler, {MMTSVideoAccessUnit} from './mmts-video-mpu-assembler';
import MediaInfo from '../core/media-info';
import Log from '../utils/logger.js';
import MMTSAudioTimeline from '../utils/mmts-audio-timeline';
import MMTSSubtitleAssembler from '../utils/mmts-subtitle-assembler';
import {
    isPlaybackSwitchIdentity,
    type PlaybackSwitchIdentity,
} from '../core/playback-operation';
import {
    createMMTSAudioTrackInfo,
    createMMTSSubtitleTrackInfo,
    createMMTSVideoTrackInfo,
    findMMTSPrimaryVideoTrack,
    findMMTSSecondaryVideoTrack,
    findPreferredAudioTrack,
    findPreferredDeclaredAudioTrack,
    formatAssetConditionalAccessInfo,
    formatH265NaluTypes,
    formatHex,
    formatMmtpScramblingInfo,
    formatMsTimestamp,
    formatPacketCounts,
    getSortedAudioTrackInfos,
    getSortedSubtitleTrackInfos,
    getSortedVideoTrackInfos,
    getMMTSSelectedVideoRole,
    hasKnownMMTSAudioSupport,
    isH265IrapNalu,
    isH265VclNalu,
    isMMTSAudioTrackSelectable,
    isMMTSVideoFallback,
    isSupportedAACChannelConfig,
    payloadTypeName,
    readH265NaluType,
    scramblingName,
    toHex,
    updateMMTSAudioTrackInfoFromFrame,
    videoResolutionLabel
} from '../utils/mmts-demuxer-utils';
import {
    MMTSAudioTrackInfo,
    MMTSAudioTrackList,
    MMTSSubtitleData,
    MMTSSubtitleTrackInfo,
    MMTSSubtitleTrackList,
    MMTSVideoTrackInfo,
    MMTSVideoTrackList
} from './mmts-track-data';

interface PendingMFUUnit {
    fragment: MFUFragment;
    filePosition: number;
    mpuSequenceNumber: number;
    randomAccess: boolean;
    unit: Uint8Array;
}

interface VideoTimestamp {
    dts: number;
    pts: number;
    rawDts?: number;
    rawPts?: number;
    rawDtsTicks?: number;
    rawPtsTicks?: number;
    timescale?: number;
    decodingIndex?: number;
    presentationIndex?: number;
    source: 'descriptor';
}

interface MappedVideoDescriptorTimestamp {
    dts: number;
    pts: number;
    rawDts: number;
    rawPts: number;
    rawDtsTicks: number;
    rawPtsTicks: number;
    timescale: number;
}

interface MMTSTimedVideoAccessUnit extends MMTSVideoAccessUnit {
    descriptorTimestamp: MMTSTimestamp | null;
    mseRandomAccessSafe?: boolean;
    isLeading?: boolean;
    outputAllowed?: boolean;
    dropReason?: string;
}

interface HEVCParameterSetEntry {
    id: number;
    generation: number;
    nalu: H265NaluHVC1;
    details: any;
}

interface HEVCParameterSetChain {
    vps: HEVCParameterSetEntry;
    sps: HEVCParameterSetEntry;
    pps: HEVCParameterSetEntry;
    signature: string;
}

interface ParsedHEVCVideoAccessUnit {
    input: HEVCPictureOrderInput;
    chain: HEVCParameterSetChain;
    endOfSequence: boolean;
}

interface MMTSSampleSourceInfo {
    packetId: number;
    mpuSequenceNumber: number;
    sampleNumber?: number;
    auIndex?: number;
    filePosition: number;
    restartFilePosition?: number;
    rawDts?: number;
    rawPts?: number;
    rawDtsTicks?: number;
    rawPtsTicks?: number;
    timescale?: number;
    decodingIndex?: number;
    presentationIndex?: number;
    dts: number;
    pts: number;
    discontinuity?: MMTSVideoDiscontinuityInfo;
}

interface MMTSVideoDiscontinuityInfo {
    packetId: number;
    mpuSequenceNumber: number;
    reason: 'packet-sequence-gap';
    expectedSeq?: number;
    actualSeq?: number;
}

interface DroppedVideoTimestamp {
    timestamp: MMTSTimestamp | null;
    consumed: boolean;
}

interface AudioParseState {
    metadata: AACAudioMetadata;
    lastIncompleteData: Uint8Array | null;
    previousFrame: LOASAACFrame | null;
    lastTimestampPts?: number;
    lastSamplePts?: number;
    timestampMpuSequenceNumber?: number;
    nextAccessUnitIndex: number;
    switchReplayEndPts?: number;
}

interface CachedAudioSample {
    unit: Uint8Array;
    length: number;
    rawPts?: number;
    pts: number;
    dts: number;
}

interface MMTSAudioTrackSwitchContext {
    scopeId?: string;
    transactionKey?: string;
    attemptKey?: string;
    kind?: 'audio-switch';
    id: number;
    transactionId: number;
    attempt: number;
    packetId: number;
    requestedStart: number;
    requestedStartMicroseconds: number;
}

export type MMTSAudioTrackSelectionReason =
    'selected' | 'already-selected' | 'unknown-track' | 'unsupported-track' | 'invalid-timeline';

export interface MMTSAudioTrackSelectionResult {
    accepted: boolean,
    changed: boolean,
    requestedPacketId: number,
    selectedPacketId?: number,
    reason: MMTSAudioTrackSelectionReason,
    transactionId?: number,
    attempt?: number,
    scopeId?: string,
    transactionKey?: string,
    attemptKey?: string,
    kind?: 'audio-switch',
}

interface MMTSVideoTrackSwitchContext {
    scopeId?: string;
    transactionKey?: string;
    attemptKey?: string;
    kind?: 'video-switch';
    id: number;
    transactionId: number;
    attempt: number;
    packetId: number;
}

export type MMTSVideoTrackSelectionReason =
    'selected' | 'already-selected' | 'unknown-track' | 'invalid-identity';

export interface MMTSVideoTrackSelectionResult {
    accepted: boolean,
    changed: boolean,
    requestedPacketId: number,
    selectedPacketId?: number,
    reason: MMTSVideoTrackSelectionReason,
    transactionId?: number,
    attempt?: number,
    scopeId?: string,
    transactionKey?: string,
    attemptKey?: string,
    kind?: 'video-switch',
}

interface CachedAudioTrack {
    metadata?: AACAudioMetadata;
    refSampleDuration?: number;
    samples: CachedAudioSample[];
    length: number;
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
    private stash_byte_start_: number = 0;
    private parsed_mmtp_count_: number = 0;
    private mmtp_packet_counts_by_packet_id_: {[packetId: number]: number} = {};
    private mmtp_mpu_counts_by_packet_id_: {[packetId: number]: number} = {};
    private next_forced_video_wait_log_count_: number = 512;
    private program_: MMTSProgram = new MMTSProgram();
    private pending_mfu_units_by_packet_id_: {[packetId: number]: PendingMFUUnit[]} = {};
    private logged_asset_keys_: {[key: string]: boolean} = {};
    private logged_missing_video_timestamp_count_: number = 0;
    private logged_missing_audio_timestamp_count_: number = 0;
    private logged_audio_timestamp_mapping_count_: number = 0;
    private logged_audio_timestamp_alignment_count_: number = 0;
    private logged_unsupported_audio_packet_ids_: {[packetId: number]: boolean} = {};
    private logged_unsupported_subtitle_packet_ids_: {[packetId: number]: boolean} = {};
    private audio_track_infos_by_packet_id_: {[packetId: number]: MMTSAudioTrackInfo} = {};
    private video_track_infos_by_packet_id_: {[packetId: number]: MMTSVideoTrackInfo} = {};
    private subtitle_track_infos_by_packet_id_: {[packetId: number]: MMTSSubtitleTrackInfo} = {};
    private subtitle_assembler_: MMTSSubtitleAssembler;
    private audio_parse_states_by_packet_id_: {[packetId: number]: AudioParseState} = {};
    private audio_switch_cache_by_packet_id_: {[packetId: number]: CachedAudioTrack} = {};
    private audio_timeline_: MMTSAudioTimeline = new MMTSAudioTimeline();
    private pending_audio_track_switch_: MMTSAudioTrackSwitchContext | null = null;
    private next_audio_track_switch_id_: number = 0;
    private pending_video_track_switch_: MMTSVideoTrackSwitchContext | null = null;
    private next_video_track_switch_id_: number = 0;
    private audio_tracks_signature_: string = '';
    private video_tracks_signature_: string = '';
    private subtitle_tracks_signature_: string = '';
    private dropped_video_sample_count_: number = 0;
    private logged_video_nalu_count_: number = 0;
    private logged_dropped_video_sample_count_: number = 0;
    private logged_video_discontinuity_count_: number = 0;
    private logged_video_sample_count_: number = 0;
    private logged_audio_timestamp_gap_clamp_count_: number = 0;
    private logged_audio_discontinuity_count_: number = 0;
    private logged_subtitle_data_count_: number = 0;
    private logged_video_recovery_gap_count_: number = 0;
    private logged_video_reference_recovery_count_: number = 0;
    private logged_stale_video_timestamp_count_: number = 0;
    private logged_stale_audio_timestamp_count_: number = 0;
    private last_video_dts_: number = -1;
    private last_video_pts_: number = -1;
    private last_video_duration_: number = 17;
    private last_video_source_info_: MMTSSampleSourceInfo | null = null;
    private output_video_dts_base_: number = -1;
    private output_video_raw_dts_base_: number = -1;
    private output_video_raw_dts_base_ticks_: number = -1;
    private video_timestamp_timescale_: number = 0;
    private primary_video_packet_id_: number = -1;
    private primary_audio_packet_id_: number = -1;
    private manually_selected_audio_packet_id_: number = -1;
    private media_info_ = new MediaInfo();
    private filesize_: number = 0;
    private duration_overridden_: boolean = false;
    private keyframes_index_ = {times: [], filepositions: [], randomAccessFilepositions: []};
    private last_media_info_duration_: number = 0;
    private pending_seek_media_time_: number | undefined = undefined;
    private seek_preserved_video_timestamp_base_: boolean = false;
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
    private audio_track_: any = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};
    private video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    private audio_init_segment_dispatched_: boolean = false;
    private audio_init_segment_pending_: boolean = false;
    private video_init_segment_dispatched_: boolean = false;
    private video_sample_entry_type_: 'hvc1' | 'hev1' = 'hvc1';
    private video_parameter_sets_in_band_: boolean = false;
    private audio_last_sample_pts_: number | undefined;
    private aac_last_incomplete_data_: Uint8Array = null;
    private loas_previous_frame_: LOASAACFrame | null = null;
    private video_sample_index_: number = 0;
    private video_started_: boolean = false;
    private video_waiting_random_access_: boolean = false;
    private video_recovery_gap_pending_: boolean = false;
    private seed_audio_after_video_bootstrap_: boolean = false;
    private audio_switch_video_bootstrap_pending_: boolean = false;
    private video_random_access_safe_pending_: boolean = true;
    private dropped_video_timestamp_keys_: {[key: string]: boolean} = {};
    private video_mpu_assembler_: MMTSVideoMpuAssembler = new MMTSVideoMpuAssembler();
    private pending_video_discontinuity_: MMTSVideoDiscontinuityInfo | null = null;
    private pre_init_video_units_: PendingMFUUnit[] = [];
    private pending_video_access_units_: MMTSVideoAccessUnit[] = [];
    private pending_video_mpu_sequence_number_: number | undefined;
    private video_parameter_sets_: {
        vps: {[id: number]: HEVCParameterSetEntry};
        sps: {[id: number]: HEVCParameterSetEntry};
        pps: {[id: number]: HEVCParameterSetEntry};
    } = {vps: {}, sps: {}, pps: {}};
    private video_parameter_set_versions_: {
        vps: {[id: number]: HEVCParameterSetEntry[]};
        sps: {[id: number]: HEVCParameterSetEntry[]};
        pps: {[id: number]: HEVCParameterSetEntry[]};
    } = {vps: {}, sps: {}, pps: {}};
    private video_parameter_set_chains_by_nalu_: WeakMap<H265NaluHVC1, HEVCParameterSetChain> = new WeakMap();
    private next_video_parameter_set_generation_: number = 1;
    private active_video_parameter_set_signature_: string | undefined;
    private hevc_poc_recovery_: HEVCPocRecovery = new HEVCPocRecovery();
    private rejected_video_mpus_: {[key: string]: boolean} = {};
    private nominal_video_mpu_access_unit_count_: number = 0;
    private video_reference_recovery_pending_: boolean = false;
    private video_reference_recovery_parameter_set_generation_limit_: number = 0;
    private video_reference_recovery_watch_remaining_: number = 0;
    private video_reference_recovery_watch_delay_: number = 0;

    public constructor(probeData: any, config: any) {
        super();
        this.config_ = config;
        this.subtitle_assembler_ = new MMTSSubtitleAssembler({
            getTimestampAtAccessUnit: (packetId, mpuSequenceNumber, auIndex) => {
                return this.program_.getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex);
            },
            getVideoTimeline: () => ({
                lastVideoDts: this.last_video_dts_,
                lastVideoPts: this.last_video_pts_,
                outputVideoDtsBase: this.output_video_dts_base_,
                outputVideoRawDtsBase: this.output_video_raw_dts_base_,
                videoSampleIndex: this.video_sample_index_,
                droppedVideoSampleCount: this.dropped_video_sample_count_
            }),
            onSubtitleData: (subtitle) => this.onMMTSSubtitleData && this.onMMTSSubtitleData(subtitle),
            logSubtitleData: (subtitle) => this.logSubtitleData(subtitle)
        });

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
        this.logged_unsupported_subtitle_packet_ids_ = null;
        this.audio_track_infos_by_packet_id_ = null;
        this.video_track_infos_by_packet_id_ = null;
        this.subtitle_track_infos_by_packet_id_ = null;
        this.subtitle_assembler_ && this.subtitle_assembler_.destroy();
        this.subtitle_assembler_ = null;
        this.audio_parse_states_by_packet_id_ = null;
        this.audio_switch_cache_by_packet_id_ = null;
        this.audio_timeline_ && this.audio_timeline_.destroy();
        this.audio_timeline_ = null;
        this.pending_audio_track_switch_ = null;
        this.pending_video_track_switch_ = null;
        this.media_info_ = null;
        this.audio_metadata_ = null;
        this.video_metadata_ = null;
        this.audio_track_ = null;
        this.video_track_ = null;
        this.aac_last_incomplete_data_ = null;
        this.loas_previous_frame_ = null;
        this.video_mpu_assembler_ && this.video_mpu_assembler_.destroy();
        this.video_mpu_assembler_ = null;
        this.pre_init_video_units_ = null;
        this.pending_video_access_units_ = null;
        this.pending_video_mpu_sequence_number_ = undefined;
        this.video_parameter_sets_ = null;
        this.video_parameter_set_versions_ = null;
        this.video_parameter_set_chains_by_nalu_ = null;
        this.hevc_poc_recovery_ = null;
        this.rejected_video_mpus_ = null;
        super.destroy();
    }

    public static probe(buffer: ArrayBuffer) {
        return TLV.probe(buffer);
    }

    public set filesize(value: number) {
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            this.filesize_ = value;
        }
    }

    public set overridedDuration(value: number) {
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            this.duration_overridden_ = true;
            this.media_info_.duration = value;
            this.last_media_info_duration_ = value;
        }
    }

    public resetMediaInfo(): void {
        const old = this.media_info_;
        this.media_info_ = new MediaInfo();
        this.media_info_.hasKeyframesIndex = old ? old.hasKeyframesIndex : null;
        this.media_info_.keyframesIndex = this.keyframes_index_;
        if (this.duration_overridden_) {
            this.media_info_.duration = this.last_media_info_duration_;
        }
        this.applyPlaybackModeMediaInfo(this.media_info_);
    }

    public seek(milliseconds?: number): void {
        const preserveTimestampBase = !this.config_.isLive;
        const outputVideoDtsBase = this.output_video_dts_base_;
        const outputVideoRawDtsBase = this.output_video_raw_dts_base_;
        const outputVideoRawDtsBaseTicks = this.output_video_raw_dts_base_ticks_;
        const videoTimestampTimescale = this.video_timestamp_timescale_;
        const preserveVideoBase = preserveTimestampBase &&
            this.primary_video_packet_id_ >= 0 &&
            this.program_.hasTimestampBase(this.primary_video_packet_id_) &&
            outputVideoDtsBase >= 0;

        this.pending_seek_media_time_ = preserveTimestampBase &&
            typeof milliseconds === 'number' &&
            isFinite(milliseconds) &&
            milliseconds >= 0 ? milliseconds : undefined;
        this.seek_preserved_video_timestamp_base_ = preserveVideoBase;
        this.stash_ = null;
        this.stash_byte_start_ = 0;
        this.program_.resetMediaState(preserveTimestampBase);
        this.pending_mfu_units_by_packet_id_ = {};
        this.audio_parse_states_by_packet_id_ = {};
        this.audio_switch_cache_by_packet_id_ = {};
        this.video_mpu_assembler_.reset();
        this.subtitle_assembler_.reset();
        this.audio_timeline_ && this.audio_timeline_.destroy();
        this.audio_timeline_ = new MMTSAudioTimeline();
        this.pending_audio_track_switch_ = null;
        this.pending_video_track_switch_ = null;
        this.resetAudioTrack();
        this.resetVideoBootstrapState();
        if (preserveVideoBase) {
            this.output_video_dts_base_ = outputVideoDtsBase;
            this.output_video_raw_dts_base_ = outputVideoRawDtsBase;
            this.output_video_raw_dts_base_ticks_ = outputVideoRawDtsBaseTicks;
            this.video_timestamp_timescale_ = videoTimestampTimescale;
        }
        this.audio_init_segment_dispatched_ = false;
        this.audio_init_segment_pending_ = true;
        this.audio_last_sample_pts_ = undefined;
    }

    public resetVideoForDecoderBootstrap(): boolean {
        if (this.primary_video_packet_id_ < 0 || !this.video_init_segment_dispatched_) {
            return false;
        }

        this.video_track_ = {
            type: 'video',
            id: 1,
            sequenceNumber: this.video_track_.sequenceNumber,
            samples: [],
            length: 0
        };
        this.video_mpu_assembler_.reset();
        if (this.pending_video_access_units_.length > 0) {
            this.rejectVideoMpu(this.pending_video_access_units_, 'decoder-bootstrap-reset');
            this.pending_video_access_units_ = [];
            this.pending_video_mpu_sequence_number_ = undefined;
        }
        this.video_waiting_random_access_ = true;
        this.hevc_poc_recovery_.reset(true);
        this.audio_switch_video_bootstrap_pending_ = true;
        this.video_recovery_gap_pending_ = false;
        this.video_random_access_safe_pending_ = true;
        this.dropped_video_timestamp_keys_ = {};
        this.pending_video_discontinuity_ = null;
        return true;
    }

    public bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    public parseChunks(chunk: ArrayBuffer, byteStart: number): number {
        let input = new Uint8Array(chunk);
        let inputByteStart = byteStart;

        if (this.stash_ !== null && this.stash_.byteLength > 0) {
            const merged = new Uint8Array(this.stash_.byteLength + input.byteLength);
            merged.set(this.stash_, 0);
            merged.set(input, this.stash_.byteLength);
            input = merged;
            inputByteStart = this.stash_byte_start_;
            this.stash_ = null;
            this.stash_byte_start_ = 0;
        }

        const result = TLV.parse(input);

        for (const packet of result.packets) {
            const packetFilePosition = inputByteStart + packet.startOffset;
            let mmtpData: Uint8Array | null = null;
            if (packet.packetType === 0x03) {
                const compressedIP = CompressedIP.parse(packet.payload);
                if (compressedIP !== null) {
                    mmtpData = packet.payload.subarray(compressedIP.payloadOffset);
                }
            } else if (packet.packetType === 0x01 || packet.packetType === 0x02) {
                const udp = IP.parseUdpPayload(packet.payload, packet.packetType === 0x01 ? 4 : 6);
                if (udp !== null) {
                    mmtpData = packet.payload.subarray(
                        udp.payloadOffset,
                        udp.payloadOffset + udp.payloadLength
                    );
                }
            }
            if (mmtpData === null) {
                continue;
            }

            const mmtp = MMTP.parse(mmtpData);
            if (mmtp === null) {
                continue;
            }

            this.parsed_mmtp_count_++;
            this.countMmtpPacket(mmtp);

            if (this.parsed_mmtp_count_ <= 10) {
                Log.v(
                    this.TAG,
                    `MMTP packet_id=${formatHex(mmtp.packetId, 4)}, ` +
                    `payload=${payloadTypeName(mmtp.payloadType)}, ` +
                    `seq=${mmtp.packetSequenceNumber}, ` +
                    `rap=${mmtp.rapFlag ? 1 : 0}, ` +
                    `scrambling=${scramblingName(mmtp.extensionHeaderScrambling && mmtp.extensionHeaderScrambling.encryptionFlag)}` +
                    formatMmtpScramblingInfo(mmtp.extensionHeaderScrambling)
                );
            }

            if (mmtp.payloadType === MMTPPayloadType.ControlMessage) {
                this.parseSignalingMessages(mmtp, packetFilePosition);
            } else if (mmtp.payloadType === MMTPPayloadType.Mpu) {
                this.parseMpu(mmtp, packetFilePosition);
            }

            this.logForcedVideoWaitIfNeeded();
        }

        if (result.needMoreData && result.consumed < input.byteLength) {
            this.stash_ = input.subarray(result.consumed);
            this.stash_byte_start_ = inputByteStart + result.consumed;
        }

        return chunk.byteLength;
    }

    private parseSignalingMessages(mmtp, filePosition: number): void {
        const assets = this.program_.parseSignalingPacket(mmtp, filePosition);
        for (const asset of assets) {
            if (asset.packetId < 0) {
                continue;
            }

            this.maybeSelectPrimaryVideoAsset(asset, false);
            this.maybeSelectPrimaryAudioAsset(asset);
            this.updateTrackInfo(asset);
            const key = `${asset.packetId}:${asset.assetType}:${asset.codec || ''}:${asset.language || ''}:` +
                `${asset.assetGroupId !== undefined ? asset.assetGroupId : ''}:` +
                `${asset.assetSelectionLevel !== undefined ? asset.assetSelectionLevel : ''}:` +
                `${asset.accessControlCaSystemId !== undefined ? asset.accessControlCaSystemId : ''}:` +
                `${asset.accessControlPacketId !== undefined ? asset.accessControlPacketId : ''}:` +
                `${asset.scrambleSystemId !== undefined ? asset.scrambleSystemId : ''}:` +
                `${asset.messageAuthenticationSystemId !== undefined ? asset.messageAuthenticationSystemId : ''}`;

            if (!this.logged_asset_keys_[key]) {
                this.logged_asset_keys_[key] = true;
                Log.v(
                    this.TAG,
                    `MPT asset packet_id=${formatHex(asset.packetId, 4)}, ` +
                    `asset_type=${asset.assetType}, media=${asset.mediaType}, ` +
                    `codec=${asset.codec || 'unknown'}, lang=${asset.language || 'und'}` +
                    (asset.assetGroupId !== undefined ? `, asset_group=${asset.assetGroupId}` : '') +
                    (asset.assetSelectionLevel !== undefined ? `, selection_level=${asset.assetSelectionLevel}` : '') +
                    formatAssetConditionalAccessInfo(asset) +
                    (asset.mediaType === 'video' ? `, resolution=${videoResolutionLabel(asset)}` : '')
                );
            }

            this.replayPendingMfuUnits(asset);
        }
    }

    private parseMpu(mmtp, filePosition: number): void {
        const result = this.program_.parseMpuPacket(mmtp, filePosition);
        if (result === null) {
            return;
        }

        const asset = result.asset;
        const mpu = result.mpu;
        if (asset !== undefined &&
            asset.mediaType === 'video' &&
            mpu.fragmentType === 0x00) { // MPU metadata
            this.processVideoMpuMetadata(asset, mmtp.payload.subarray(
                mpu.payloadOffset,
                mpu.payloadOffset + mpu.payloadLength
            ));
        }
        if (result.loss.packetSequenceGap) {
            this.handleMpuDiscontinuity(mmtp.packetId, asset, mpu, result.loss, true);
            this.handleAudioMpuDiscontinuity(mmtp.packetId, asset, mpu);
        }
        for (const completed of result.units) {
            this.processCompleteMfuUnit(
                mmtp.packetId,
                asset,
                completed.mpuSequenceNumber,
                completed.fragment,
                completed.filePosition,
                completed.randomAccess,
                completed.unit
            );
        }
    }

    private processCompleteMfuUnit(packetId: number,
                                   asset: MMTAsset | undefined,
                                   mpuSequenceNumber: number,
                                   fragment: MFUFragment,
                                   filePosition: number,
                                   randomAccess: boolean,
                                   unit: Uint8Array): void {
        if (asset === undefined) {
            this.cachePendingMfuUnit(packetId, mpuSequenceNumber, fragment, filePosition, randomAccess, unit);
            return;
        }

        if (asset.assetType === 'mp4a' || asset.codec === 'aac-latm' || asset.codec === 'aac') {
            if (asset.codec === 'mp4als') {
                this.logUnsupportedMMTSAudioTrack(packetId, this.audio_track_infos_by_packet_id_[packetId]);
                return;
            }
            this.processAudioMfuUnit(packetId, asset, mpuSequenceNumber, fragment, unit);
            return;
        }

        if (asset.assetType === 'stpp' || (asset.mediaType === 'subtitle' && asset.codec === 'ttml')) {
            if (asset.subtitleCompressionType !== undefined && asset.subtitleCompressionType !== 0) {
                this.logUnsupportedMMTSSubtitleTrack(packetId, asset);
                return;
            }
            this.subtitle_assembler_.processMfuUnit(packetId, asset, mpuSequenceNumber, fragment, unit);
            return;
        }

        if (asset.mediaType !== 'video') {
            return;
        }

        this.maybeSelectPrimaryVideoAsset(asset, true);

        if (asset.packetId !== this.primary_video_packet_id_) {
            return;
        }
        this.configureVideoSampleEntry(asset);

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
        // The MFU is already encoded as a four-byte-length-prefixed HEVC NAL.
        // Keep the assembled storage as the sample shadow instead of copying the
        // complete 4K payload into another HVC1 buffer before remuxing.
        const hvc1 = H265NaluHVC1.fromLengthPrefixedData(unit, naluType);

        if (naluType === H265NaluType.kSliceVPS) {
            this.parseAndUpdateVideoParameterSet('vps', hvc1, naluData);
            if (!this.video_init_segment_dispatched_) {
                this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, filePosition, randomAccess, unit);
            } else if (fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(
                    packetId, mpuSequenceNumber, fragment.sampleNumber, fragment.offset,
                    filePosition, hvc1, false, false
                );
            }
            return;
        }

        if (naluType === H265NaluType.kSliceSPS) {
            this.parseAndUpdateVideoParameterSet('sps', hvc1, naluData);
            if (!this.video_init_segment_dispatched_) {
                this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, filePosition, randomAccess, unit);
            } else if (fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(
                    packetId, mpuSequenceNumber, fragment.sampleNumber, fragment.offset,
                    filePosition, hvc1, false, false
                );
            }
            return;
        }

        if (naluType === H265NaluType.kSlicePPS) {
            this.parseAndUpdateVideoParameterSet('pps', hvc1, naluData);
            if (!this.video_init_segment_dispatched_) {
                this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, filePosition, randomAccess, unit);
            } else if (fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(
                    packetId, mpuSequenceNumber, fragment.sampleNumber, fragment.offset,
                    filePosition, hvc1, false, false
                );
            }
            return;
        }

        if (!this.video_init_segment_dispatched_) {
            this.cachePreInitVideoUnit(mpuSequenceNumber, fragment, filePosition, randomAccess, unit);
            const timescale = this.program_.getTimestampTimescale(packetId, mpuSequenceNumber);
            if (timescale !== null) {
                this.video_timestamp_timescale_ = timescale;
            }
            this.tryActivateLatestCompleteParameterSet();
            return;
        }

        if (!this.video_init_segment_dispatched_ || !isH265VclNalu(naluType)) {
            if (this.video_init_segment_dispatched_ &&
                fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(
                    packetId,
                    mpuSequenceNumber,
                    fragment.sampleNumber,
                    fragment.offset,
                    filePosition,
                    hvc1,
                    false,
                    false
                );
            }
            return;
        }

        const keyframe = isH265IrapNalu(naluType);
        this.bindVideoNaluParameterSetChain(hvc1, naluData);

        if (fragment.sampleNumber === undefined) {
            const completed = this.video_mpu_assembler_.appendStandaloneAccessUnit(
                packetId,
                mpuSequenceNumber,
                undefined,
                filePosition,
                [hvc1],
                hvc1.data.byteLength,
                keyframe
            );
            for (const accessUnit of completed) {
                this.appendVideoAccessUnit(accessUnit);
            }
            return;
        }

        this.appendH265NaluToAccessUnit(
            packetId,
            mpuSequenceNumber,
            fragment.sampleNumber,
            fragment.offset,
            filePosition,
            hvc1,
            keyframe,
            true
        );
    }

    private processVideoMpuMetadata(asset: MMTAsset, metadata: Uint8Array): void {
        if (asset.assetType !== 'hvc1') {
            return;
        }
        this.video_sample_entry_type_ = 'hvc1';
        this.video_parameter_sets_in_band_ = false;
        this.maybeSelectPrimaryVideoAsset(asset, false);
        if (asset.packetId !== this.primary_video_packet_id_) {
            return;
        }
        const hvcC = this.findHvcCBox(metadata);
        if (hvcC === null || hvcC.byteLength < 23 || hvcC[0] !== 1) {
            return;
        }

        let offset = 22;
        const arrayCount = hvcC[offset++];
        for (let i = 0; i < arrayCount; i++) {
            if (offset + 3 > hvcC.byteLength) {
                return;
            }
            const naluType = hvcC[offset++] & 0x3f;
            const naluCount = (hvcC[offset] << 8) | hvcC[offset + 1];
            offset += 2;
            for (let j = 0; j < naluCount; j++) {
                if (offset + 2 > hvcC.byteLength) {
                    return;
                }
                const naluLength = (hvcC[offset] << 8) | hvcC[offset + 1];
                offset += 2;
                if (offset + naluLength > hvcC.byteLength || naluLength < 2) {
                    return;
                }
                const naluData = hvcC.subarray(offset, offset + naluLength);
                offset += naluLength;
                const payload = new H265NaluPayload();
                payload.type = naluType;
                payload.data = naluData;
                const nalu = new H265NaluHVC1(payload);
                if (naluType === H265NaluType.kSliceVPS) {
                    this.parseAndUpdateVideoParameterSet('vps', nalu, naluData);
                } else if (naluType === H265NaluType.kSliceSPS) {
                    this.parseAndUpdateVideoParameterSet('sps', nalu, naluData);
                } else if (naluType === H265NaluType.kSlicePPS) {
                    this.parseAndUpdateVideoParameterSet('pps', nalu, naluData);
                }
            }
        }
        this.tryActivateLatestCompleteParameterSet();
    }

    private configureVideoSampleEntry(asset: MMTAsset): void {
        this.video_parameter_sets_in_band_ = asset.assetType === 'hev1';
        this.video_sample_entry_type_ = this.video_parameter_sets_in_band_ &&
            this.config_.mmtsForceHvc1SampleEntry !== true ? 'hev1' : 'hvc1';
    }

    private findHvcCBox(data: Uint8Array): Uint8Array | null {
        for (let offset = 4; offset + 4 <= data.byteLength; offset++) {
            if (data[offset] !== 0x68 || data[offset + 1] !== 0x76 ||
                data[offset + 2] !== 0x63 || data[offset + 3] !== 0x43) {
                continue;
            }
            const sizeOffset = offset - 4;
            const size = ((data[sizeOffset] << 24) >>> 0) +
                (data[sizeOffset + 1] << 16) + (data[sizeOffset + 2] << 8) + data[sizeOffset + 3];
            if (size < 8 || sizeOffset + size > data.byteLength) {
                continue;
            }
            return data.subarray(offset + 4, sizeOffset + size);
        }
        return null;
    }

    private parseAndUpdateVideoParameterSet(kind: 'vps' | 'sps' | 'pps',
                                                 nalu: H265NaluHVC1,
                                                 naluData: Uint8Array): void {
        try {
            let details: any;
            if (kind === 'vps') {
                details = H265Parser.parseVPS(naluData);
            } else if (kind === 'sps') {
                // Chromium / VideoToolbox may prefer the HEVC SPS VUI over the MP4 colr box. For the explicit
                // SDR-tag prototype, rewrite the two fixed-width CICP bytes in both hvcC and in-band hev1 SPS
                // units before they reach the decoder. matrix_coeffs remains untouched at BT.2020-NCL.
                if (this.config_.mmtsForceSDRColorimetry === true) {
                    const rewritten = (H265Parser as any).rewriteSPSColorimetry(naluData, 1, 1);
                    if (rewritten !== null) {
                        const payload = new H265NaluPayload();
                        payload.type = H265NaluType.kSliceSPS;
                        payload.data = rewritten;
                        nalu.data = new H265NaluHVC1(payload).data;
                        naluData = rewritten;
                    } else {
                        Log.w(this.TAG, 'Cannot force SDR colorimetry: HEVC SPS has no VUI colour description.');
                    }
                }
                details = H265Parser.parseSPS(naluData);
            } else {
                details = H265Parser.parsePPS(naluData);
            }
            this.updateVideoParameterSet(kind, nalu, details);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            Log.w(this.TAG, `Reject malformed HEVC ${kind.toUpperCase()} parameter set: ${reason}`);
        }
    }

    private updateVideoParameterSet(kind: 'vps' | 'sps' | 'pps',
                                    nalu: H265NaluHVC1,
                                    details: any): void {
        if (details === undefined || details === null) {
            return;
        }
        const id = kind === 'vps' ? details.video_parameter_set_id :
            (kind === 'sps' ? details.seq_parameter_set_id : details.pic_parameter_set_id);
        const maxId = kind === 'pps' ? 63 : 15;
        if (!Number.isInteger(id) || id < 0 || id > maxId) {
            return;
        }
        const cache = this.video_parameter_sets_[kind];
        const versionsById = this.video_parameter_set_versions_[kind];
        const versions = versionsById[id] || (versionsById[id] = []);
        let entry = versions.find((candidate) => {
            return this.equalUint8Arrays(candidate.nalu.data, nalu.data);
        });
        if (entry === undefined) {
            entry = {
                id,
                generation: this.next_video_parameter_set_generation_++,
                nalu,
                details
            };
            versions.push(entry);
        } else {
            entry.details = details;
        }
        cache[id] = entry;
    }

    private equalUint8Arrays(a: Uint8Array, b: Uint8Array): boolean {
        if (a === b) {
            return true;
        }
        if (a === undefined || b === undefined || a.byteLength !== b.byteLength) {
            return false;
        }
        for (let i = 0; i < a.byteLength; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    private tryActivateLatestCompleteParameterSet(): void {
        let selected: HEVCParameterSetChain | null = null;
        for (const key of Object.keys(this.video_parameter_sets_.pps)) {
            const chain = this.resolveVideoParameterSetChain(Number(key));
            if (chain === null) {
                continue;
            }
            if (selected === null || chain.pps.generation > selected.pps.generation) {
                selected = chain;
            }
        }
        if (selected !== null) {
            this.activateVideoParameterSetChain(selected);
        }
    }

    private resolveVideoParameterSetChain(ppsId: number): HEVCParameterSetChain | null {
        const pps = this.video_parameter_sets_.pps[ppsId];
        if (pps === undefined || pps.details === undefined) {
            return null;
        }
        const spsId = pps.details.seq_parameter_set_id;
        const sps = this.video_parameter_sets_.sps[spsId];
        if (sps === undefined || sps.details === undefined ||
            sps.details.seq_parameter_set_id !== spsId) {
            return null;
        }
        const vpsId = sps.details.video_parameter_set_id;
        const vps = this.video_parameter_sets_.vps[vpsId];
        if (vps === undefined || vps.details === undefined ||
            vps.details.video_parameter_set_id !== vpsId) {
            return null;
        }
        if (sps.details.max_sub_layers_minus1 > vps.details.max_sub_layers_minus1) {
            return null;
        }
        return {
            vps,
            sps,
            pps,
            signature: `v${vps.id}.${vps.generation}:s${sps.id}.${sps.generation}:p${pps.id}.${pps.generation}`
        };
    }

    private bindVideoNaluParameterSetChain(nalu: H265NaluHVC1, naluData: Uint8Array): void {
        const prefix = (H265Parser as any).parseSliceHeaderPrefix(naluData);
        if (prefix === null || prefix === undefined) {
            return;
        }
        const chain = this.resolveVideoParameterSetChain(prefix.slice_pic_parameter_set_id);
        if (chain !== null) {
            this.video_parameter_set_chains_by_nalu_.set(nalu, chain);
        }
    }

    private activateVideoParameterSetChain(chain: HEVCParameterSetChain): void {
        const signatureChanged = this.active_video_parameter_set_signature_ !== chain.signature;
        if (!signatureChanged && this.video_metadata_.details !== undefined) {
            if (!this.video_init_segment_dispatched_) {
                this.dispatchVideoInitSegment();
            }
            return;
        }
        const details = {
            ...chain.vps.details,
            ...chain.sps.details,
            ...chain.pps.details
        };
        if (this.video_init_segment_dispatched_ &&
            this.video_sample_entry_type_ === 'hev1' &&
            !this.hasCriticalVideoMetadataChange(details)) {
            this.video_metadata_ = {
                vps: chain.vps.nalu,
                sps: chain.sps.nalu,
                pps: chain.pps.nalu,
                details
            };
            this.active_video_parameter_set_signature_ = chain.signature;
            return;
        }
        if (this.video_init_segment_dispatched_ && signatureChanged) {
            this.dispatchVideoMediaSegment(true);
        }
        this.video_metadata_ = {
            vps: chain.vps.nalu,
            sps: chain.sps.nalu,
            pps: chain.pps.nalu,
            details
        };
        this.active_video_parameter_set_signature_ = chain.signature;
        if (!this.video_init_segment_dispatched_ || signatureChanged) {
            this.dispatchVideoInitSegment();
        }
    }

    private hasCriticalVideoMetadataChange(details: any): boolean {
        const current = this.video_metadata_.details;
        if (current === undefined) {
            return false;
        }
        return details.codec_mimetype !== current.codec_mimetype ||
            details.codec_size.width !== current.codec_size.width ||
            details.codec_size.height !== current.codec_size.height ||
            details.present_size.width !== current.present_size.width ||
            details.present_size.height !== current.present_size.height;
    }

    private appendH265NaluToAccessUnit(packetId: number,
                                       mpuSequenceNumber: number,
                                       sampleNumber: number,
                                       offset: number | undefined,
                                       filePosition: number,
                                       nalu: H265NaluHVC1,
                                       keyframe: boolean,
                                       isVcl: boolean): void {
        const completed = this.video_mpu_assembler_.appendNalu({
                packetId,
                mpuSequenceNumber,
                sampleNumber,
                offset,
                filePosition,
                nalu,
                keyframe,
                isVcl
            });
        for (const accessUnit of completed) {
            this.appendVideoAccessUnit(accessUnit);
        }
    }

    private processAudioMfuUnit(packetId: number,
                                asset: MMTAsset,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment,
                                unit: Uint8Array): void {
        this.maybeSelectPrimaryAudioAsset(asset);
        const declaredTrack = this.audio_track_infos_by_packet_id_[packetId];
        if (declaredTrack !== undefined && declaredTrack.supported === false) {
            // Do not repeatedly parse and copy a declared 22.2ch/ALS stream
            // that the current MSE output path cannot select.  The component
            // descriptor already provides the layout shown to the player.
            this.logUnsupportedMMTSAudioTrack(packetId, declaredTrack);
            return;
        }
        const state = this.getAudioParseState(packetId);
        const loas = asset.audioStreamType === 0x1c ?
            this.wrapRawAacPayloadWithLoasHeader(unit, asset.audioSpecificConfig) :
            this.wrapLatmPayloadWithLoasHeader(unit);
        if (loas === null) {
            this.logUnsupportedMMTSAudioTrack(packetId, this.audio_track_infos_by_packet_id_[packetId]);
            return;
        }
        const appendSamples = asset.packetId === this.primary_audio_packet_id_;
        if (!appendSamples) {
            const pts = this.consumeAudioTimestamp(packetId, mpuSequenceNumber, fragment.sampleNumber, state);
            this.recordAudioTimestampCursor(state, pts);
            this.parseMMTSLOASAACPayload(packetId, loas, pts, false, state);
            return;
        }

        if (!this.video_init_segment_dispatched_) {
            const pts = this.consumeAudioTimestamp(packetId, mpuSequenceNumber, fragment.sampleNumber, state);
            this.recordAudioTimestampCursor(state, pts);
            this.parseMMTSLOASAACPayload(packetId, loas, pts, false, state);
            return;
        }

        if (this.shouldHoldAudioUntilVideoRandomAccess()) {
            const pts = this.consumeAudioTimestamp(packetId, mpuSequenceNumber, fragment.sampleNumber, state);
            this.recordAudioTimestampCursor(state, pts);
            this.parseMMTSLOASAACPayload(packetId, loas, pts, false, state);
            return;
        }

        const pts = this.consumeAudioTimestamp(packetId, mpuSequenceNumber, fragment.sampleNumber, state);
        this.recordAudioTimestampCursor(state, pts);
        this.parseMMTSLOASAACPayload(packetId, loas, pts, true, state);

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

    private wrapRawAacPayloadWithLoasHeader(payload: Uint8Array,
                                             audioSpecificConfig: Uint8Array | undefined): Uint8Array | null {
        if (audioSpecificConfig === undefined || audioSpecificConfig.byteLength < 2) {
            return null;
        }
        const audioObjectType = audioSpecificConfig[0] >> 3;
        const samplingFrequencyIndex = ((audioSpecificConfig[0] & 0x07) << 1) |
            (audioSpecificConfig[1] >> 7);
        const channelConfig = (audioSpecificConfig[1] >> 3) & 0x0f;
        if (audioObjectType === 0 || audioObjectType >= 31 || samplingFrequencyIndex >= 13 || channelConfig === 0) {
            return null;
        }

        const bits: number[] = [];
        const writeBits = (value: number, count: number): void => {
            for (let i = count - 1; i >= 0; i--) {
                bits.push((value >> i) & 0x01);
            }
        };
        writeBits(0, 1); // useSameStreamMux
        writeBits(0, 1); // audioMuxVersion
        writeBits(1, 1); // allStreamsSameTimeFraming
        writeBits(0, 6); // numSubFrames
        writeBits(0, 4); // numProgram
        writeBits(0, 3); // numLayer
        writeBits(audioObjectType, 5);
        writeBits(samplingFrequencyIndex, 4);
        writeBits(channelConfig, 4);
        writeBits(0, 3); // GASpecificConfig: frameLengthFlag, dependsOnCoreCoder, extensionFlag
        writeBits(0, 3); // frameLengthType
        writeBits(0, 8); // latmBufferFullness
        writeBits(0, 1); // otherDataPresent
        writeBits(0, 1); // crcCheckPresent
        for (let remaining = payload.byteLength; remaining >= 0; remaining -= 0xff) {
            const lengthByte = Math.min(remaining, 0xff);
            writeBits(lengthByte, 8);
            if (lengthByte !== 0xff) {
                break;
            }
        }
        for (let i = 0; i < payload.byteLength; i++) {
            writeBits(payload[i], 8);
        }

        const audioMuxLengthBytes = Math.ceil(bits.length / 8);
        if (audioMuxLengthBytes > 0x1fff) {
            return null;
        }
        const loas = new Uint8Array(audioMuxLengthBytes + 3);
        loas[0] = 0x56;
        loas[1] = 0xe0 | ((audioMuxLengthBytes >> 8) & 0x1f);
        loas[2] = audioMuxLengthBytes & 0xff;
        for (let i = 0; i < bits.length; i++) {
            loas[3 + (i >> 3)] |= bits[i] << (7 - (i & 0x07));
        }
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
        let rawSamplePts = pts;
        const hasMfuTimestamp = pts !== undefined;
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
                isSupportedAACChannelConfig(aacFrame.channel_config);
            const canDispatchPrimaryAudioInit = !appendSamples &&
                packetId === this.primary_audio_packet_id_ &&
                isSupportedAACChannelConfig(aacFrame.channel_config);
            const cacheCurrentFrame = !appendSamples &&
                packetId !== this.primary_audio_packet_id_ &&
                isSupportedAACChannelConfig(aacFrame.channel_config) &&
                this.getAudioSwitchCacheDuration() > 0;

            if (appendSamples && packetId === this.primary_audio_packet_id_ && !appendCurrentFrame) {
                this.logUnsupportedMMTSAudioTrack(packetId, this.audio_track_infos_by_packet_id_[packetId]);
                this.audio_init_segment_pending_ = false;
                if (rawSamplePts !== undefined) {
                    rawSamplePts += refSampleDuration;
                }
                continue;
            }

            if (appendCurrentFrame && !this.audio_init_segment_dispatched_) {
                this.audio_metadata_ = state.metadata;
                this.dispatchAudioInitSegment(audioSample);
            } else if (appendCurrentFrame) {
                const metadataChanged = this.detectAudioMetadataChange(audioSample);
                if (metadataChanged || this.audio_init_segment_pending_) {
                    this.audio_metadata_ = state.metadata;
                    if (metadataChanged) {
                        this.dispatchAudioMediaSegment();
                    }
                    this.dispatchAudioInitSegment(audioSample);
                }
            } else if (canDispatchPrimaryAudioInit &&
                (!this.audio_init_segment_dispatched_ || this.audio_init_segment_pending_)) {
                this.audio_metadata_ = state.metadata;
                this.dispatchAudioInitSegment(audioSample);
            }

            if (!appendCurrentFrame && !cacheCurrentFrame) {
                if (rawSamplePts !== undefined) {
                    rawSamplePts += refSampleDuration;
                }
                continue;
            }

            let samplePts = rawSamplePts;
            const sampleRawPts = rawSamplePts;
            if (samplePts !== undefined) {
                if (samplePts < 0 &&
                    this.output_video_raw_dts_base_ >= 0 &&
                    !this.audio_timeline_.hasMapping(packetId)) {
                    const seed = state.lastSamplePts !== undefined ?
                        state.lastSamplePts :
                        this.getAudioFallbackTimelineSeed() ?? 0;
                    this.audio_timeline_.seed(packetId, seed);
                }
                samplePts = this.alignAudioTimestampToTimeline(packetId, samplePts, refSampleDuration);
                if (appendCurrentFrame) {
                    samplePts = this.clampAudioTimestampGap(packetId, samplePts, refSampleDuration, state);
                }
            }

            if (samplePts === undefined) {
                if (appendCurrentFrame && !hasMfuTimestamp) {
                    continue;
                }
                if (state.lastSamplePts !== undefined) {
                    samplePts = state.lastSamplePts + refSampleDuration;
                } else {
                    const fallbackTimelineSeed = this.getAudioFallbackTimelineSeed();
                    if (fallbackTimelineSeed === undefined) {
                        if (rawSamplePts !== undefined) {
                            rawSamplePts += refSampleDuration;
                        }
                        continue;
                    }
                    samplePts = fallbackTimelineSeed;
                }
            }

            if (appendCurrentFrame &&
                this.isStaleBackwardAudioTimestamp(packetId, samplePts, refSampleDuration, state)) {
                this.logStaleBackwardAudioTimestamp(packetId, samplePts, state);
                if (rawSamplePts !== undefined) {
                    rawSamplePts += refSampleDuration;
                }
                continue;
            }

            if (appendCurrentFrame && state.switchReplayEndPts !== undefined) {
                if (samplePts <= state.switchReplayEndPts) {
                    if (rawSamplePts !== undefined) {
                        rawSamplePts += refSampleDuration;
                    }
                    continue;
                }
                state.switchReplayEndPts = undefined;
            }

            const samplePtsInt = Math.floor(samplePts);
            const sample = {
                unit: aacFrame.data,
                length: aacFrame.data.byteLength,
                rawPts: sampleRawPts !== undefined ? Math.floor(sampleRawPts) : undefined,
                pts: samplePtsInt,
                dts: samplePtsInt
            };
            let sampleAccepted = true;
            if (appendCurrentFrame) {
                this.audio_track_.samples.push(sample);
                this.audio_track_.length += aacFrame.data.byteLength;
            } else if (cacheCurrentFrame) {
                sampleAccepted = this.cacheAudioSwitchSample(
                    packetId,
                    sample,
                    refSampleDuration,
                    state.metadata
                );
            }
            if (sampleAccepted) {
                lastSamplePts = samplePts;
            }

            if (rawSamplePts !== undefined) {
                rawSamplePts += refSampleDuration;
            }
        }

        if (parser.hasIncompleteData()) {
            state.lastIncompleteData = parser.getIncompleteData();
        } else {
            state.lastIncompleteData = null;
        }

        if (lastSamplePts !== undefined) {
            state.lastSamplePts = lastSamplePts;
            if (packetId === this.primary_audio_packet_id_) {
                this.audio_last_sample_pts_ = lastSamplePts;
            }
        }
    }

    private shouldHoldAudioUntilVideoRandomAccess(): boolean {
        return this.primary_video_packet_id_ >= 0 &&
            (!this.video_started_ ||
            (this.video_waiting_random_access_ && !this.audio_switch_video_bootstrap_pending_));
    }

    private flushCurrentVideoAccessUnit(): void {
        const accessUnits = this.video_mpu_assembler_.flush();
        for (const accessUnit of accessUnits) {
            this.appendVideoAccessUnit(accessUnit);
        }
        this.flushPendingVideoAccessUnits();
    }

    private appendVideoAccessUnit(accessUnit: MMTSVideoAccessUnit): void {
        if (this.pending_video_mpu_sequence_number_ !== undefined &&
            this.pending_video_mpu_sequence_number_ !== accessUnit.mpuSequenceNumber) {
            this.flushPendingVideoAccessUnits();
        }
        this.pending_video_mpu_sequence_number_ = accessUnit.mpuSequenceNumber;
        this.pending_video_access_units_.push(accessUnit);
    }

    private flushPendingVideoAccessUnits(): void {
        if (this.pending_video_access_units_.length === 0) {
            return;
        }
        const accessUnits = this.pending_video_access_units_.slice().sort((a, b) => a.auIndex - b.auIndex);
        this.pending_video_access_units_ = [];
        this.pending_video_mpu_sequence_number_ = undefined;

        const packetId = accessUnits[0].packetId;
        const mpuSequenceNumber = accessUnits[0].mpuSequenceNumber;
        if (this.rejected_video_mpus_[this.videoMpuKey(packetId, mpuSequenceNumber)]) {
            this.rejectVideoMpu(accessUnits, 'packet-loss-or-incomplete-mfu');
            return;
        }
        const descriptorAuCount = this.program_.getDescriptorAccessUnitCount(packetId, mpuSequenceNumber);
        if (descriptorAuCount === null || descriptorAuCount !== accessUnits.length) {
            this.rejectVideoMpu(accessUnits, 'descriptor-au-count-mismatch');
            return;
        }
        for (let i = 0; i < accessUnits.length; i++) {
            const accessUnit = accessUnits[i];
            if (accessUnit.packetId !== packetId ||
                accessUnit.mpuSequenceNumber !== mpuSequenceNumber ||
                accessUnit.auIndex !== i) {
                this.rejectVideoMpu(accessUnits, 'non-contiguous-au-index');
                return;
            }
        }

        const parsedAccessUnits: ParsedHEVCVideoAccessUnit[] = [];
        for (const accessUnit of accessUnits) {
            const parsed = this.parseHEVCVideoAccessUnit(accessUnit);
            if (parsed === null) {
                this.rejectVideoMpu(accessUnits, 'incomplete-or-invalid-hevc-au');
                return;
            }
            parsedAccessUnits.push(parsed);
        }
        // ARIB STD-B60 6.2 permits an MPU to contain any number of access
        // units. The per-MPU num_of_au descriptor and continuity checks above
        // establish completeness; a count below an earlier GOP is not damage.
        const parameterSetGeneration = parsedAccessUnits.reduce((generation, parsed) => {
            return Math.max(generation, parsed.chain.vps.generation,
                parsed.chain.sps.generation, parsed.chain.pps.generation);
        }, 0);
        const quarantineParameterSetChange =
            this.shouldQuarantineRecoveryParameterSetChange(parameterSetGeneration);
        const referenceRecovery = this.prepareVideoReferenceRecovery(
            accessUnits.length,
            parsedAccessUnits[0].input.nalUnitType,
            parameterSetGeneration,
            quarantineParameterSetChange
        );
        const endOfSequenceAfterMpu = parsedAccessUnits.some((parsed) => parsed.endOfSequence);
        const prepared = this.hevc_poc_recovery_.prepareMpu(
            parsedAccessUnits.map((parsed) => parsed.input),
            endOfSequenceAfterMpu
        );
        if (prepared === null) {
            this.rejectVideoMpu(accessUnits, 'unverifiable-hevc-picture-order');
            return;
        }

        const timestamps = this.program_.peekTimestampsForMpu(
            packetId,
            mpuSequenceNumber,
            prepared.presentationIndexes
        );
        if (timestamps === null || !this.validateVideoMpuTimestamps(timestamps)) {
            this.rejectVideoMpu(accessUnits, 'b60-timestamp-invariant-failed');
            return;
        }
        const committedTimestamps = this.program_.getTimestampsForMpu(
            packetId,
            mpuSequenceNumber,
            prepared.presentationIndexes
        );
        if (committedTimestamps === null || committedTimestamps.length !== accessUnits.length ||
            !this.hevc_poc_recovery_.commit(prepared)) {
            this.rejectVideoMpu(accessUnits, 'timestamp-or-poc-commit-failed');
            return;
        }
        this.video_timestamp_timescale_ = committedTimestamps[0].timescale;
        if (!this.video_init_segment_dispatched_ && this.video_metadata_.details !== undefined) {
            this.dispatchVideoInitSegment();
        }

        this.program_.setPresentationIndexes(packetId, mpuSequenceNumber, prepared.presentationIndexes);
        delete this.rejected_video_mpus_[this.videoMpuKey(packetId, mpuSequenceNumber)];
        if (referenceRecovery && this.logged_video_reference_recovery_count_ < 8) {
            this.logged_video_reference_recovery_count_++;
            Log.w(
                this.TAG,
                `Recover MMTS HEVC decoder references, ` +
                `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
                `au_count=${accessUnits.length}, nominal=${this.nominal_video_mpu_access_unit_count_}; ` +
                `drop leading RASL pictures`
            );
        }
        if (referenceRecovery) {
            // Flush everything preceding the recovery boundary, then make its
            // CRA the first sample after a real SourceBuffer parser reset.
            // Merely marking it as sync does not clear VideoToolbox's DPB.
            this.dispatchVideoMediaSegment(true);
            this.onVideoDiscontinuity && this.onVideoDiscontinuity();
            this.dispatchVideoInitSegment(true);
        }
        for (let i = 0; i < accessUnits.length; i++) {
            const chain = parsedAccessUnits[i].chain;
            if (this.active_video_parameter_set_signature_ !== chain.signature) {
                this.activateVideoParameterSetChain(chain);
            }
            const recoveredPicture = prepared.pictures[i];
            const dropQuarantinedPicture =
                this.shouldDropQuarantinedVideoMpuPicture(quarantineParameterSetChange);
            const timedAccessUnit: MMTSTimedVideoAccessUnit = {
                ...accessUnits[i],
                keyframe: isH265IrapNalu(recoveredPicture.nalUnitType),
                descriptorTimestamp: committedTimestamps[i],
                mseRandomAccessSafe: isH265IrapNalu(recoveredPicture.nalUnitType) &&
                    recoveredPicture.noRaslOutput,
                isLeading: recoveredPicture.nalUnitType === H265NaluType.kSliceRASL_N ||
                    recoveredPicture.nalUnitType === H265NaluType.kSliceRASL_R,
                outputAllowed: recoveredPicture.outputAllowed && !dropQuarantinedPicture,
                dropReason: dropQuarantinedPicture ?
                    'hevc-recovery-parameter-set-quarantine' : undefined
            };
            this.appendTimedVideoAccessUnit(timedAccessUnit);
        }
    }

    private prepareVideoReferenceRecovery(accessUnitCount: number,
                                          firstNalUnitType: number,
                                          parameterSetGeneration: number = 0,
                                          quarantineParameterSetChange: boolean = false): boolean {
        const previousNominal = this.nominal_video_mpu_access_unit_count_;
        const startsWithRandomAccess = isH265IrapNalu(firstNalUnitType);
        const recoverReferences = startsWithRandomAccess &&
            this.video_reference_recovery_pending_;

        if (quarantineParameterSetChange) {
            this.video_reference_recovery_pending_ = true;
            this.video_reference_recovery_watch_remaining_ = 0;
            this.video_reference_recovery_watch_delay_ = 0;
        }

        if (recoverReferences) {
            // A parameter-set splice or packet loss may invalidate pictures
            // referenced by the following CRA. Recover only at that boundary.
            this.hevc_poc_recovery_.reset(true);
            this.video_reference_recovery_parameter_set_generation_limit_ = Math.max(
                this.video_reference_recovery_parameter_set_generation_limit_,
                parameterSetGeneration
            );
            this.video_reference_recovery_watch_remaining_ = 16;
            this.video_reference_recovery_watch_delay_ = 3;
            this.video_reference_recovery_pending_ = false;
        }

        this.nominal_video_mpu_access_unit_count_ = Math.max(previousNominal, accessUnitCount);
        return recoverReferences;
    }

    private shouldQuarantineRecoveryParameterSetChange(parameterSetGeneration: number): boolean {
        if (this.video_reference_recovery_pending_ ||
            this.video_reference_recovery_watch_remaining_ <= 0) {
            return false;
        }
        this.video_reference_recovery_watch_remaining_--;
        if (this.video_reference_recovery_watch_delay_ > 0) {
            this.video_reference_recovery_watch_delay_--;
            return false;
        }
        return parameterSetGeneration >
            this.video_reference_recovery_parameter_set_generation_limit_;
    }

    private shouldDropQuarantinedVideoMpuPicture(quarantineParameterSetChange: boolean): boolean {
        return quarantineParameterSetChange;
    }

    private parseHEVCVideoAccessUnit(accessUnit: MMTSVideoAccessUnit): ParsedHEVCVideoAccessUnit | null {
        const vclUnits = accessUnit.units.filter((unit) => isH265VclNalu(unit.type));
        if (vclUnits.length === 0) {
            return null;
        }
        let firstSliceCount = 0;
        let firstHeader: any = null;
        let firstChain: HEVCParameterSetChain | null = null;
        let lastSliceAddress = -1;
        const seenSliceAddresses: {[address: number]: boolean} = {};

        for (let i = 0; i < vclUnits.length; i++) {
            const unit = vclUnits[i];
            if (unit.data.byteLength < 7) {
                return null;
            }
            const nalu = unit.data.subarray(4);
            const prefix = (H265Parser as any).parseSliceHeaderPrefix(nalu);
            if (prefix === null || prefix === undefined) {
                return null;
            }
            const naluType = prefix.nalu_header.nal_unit_type;
            if ((naluType >= H265NaluType.kSliceRSV_VCL_N10 &&
                 naluType <= H265NaluType.kSliceRSV_VCL_R15) ||
                naluType === H265NaluType.kSliceRSV_IRAP_VCL22 ||
                naluType === H265NaluType.kSliceRSV_IRAP_VCL23) {
                return null;
            }
            const chain = this.video_parameter_set_chains_by_nalu_.get(unit);
            if (chain === undefined || chain.pps.id !== prefix.slice_pic_parameter_set_id) {
                return null;
            }
            const parsed = (H265Parser as any).parseSliceHeader(nalu, chain.pps.details, chain.sps.details);
            if (parsed === null || parsed === undefined) {
                return null;
            }
            if (parsed.first_slice_segment_in_pic_flag) {
                firstSliceCount++;
                if (i !== 0 || parsed.slice_segment_address !== 0 || parsed.dependent_slice_segment_flag) {
                    return null;
                }
                firstHeader = parsed;
                firstChain = chain;
            } else if (firstHeader === null || firstChain === null) {
                return null;
            }
            if (firstChain !== null &&
                (chain.signature !== firstChain.signature ||
                 parsed.nalu_header.nal_unit_type !== firstHeader.nalu_header.nal_unit_type ||
                 parsed.nalu_header.temporal_id !== firstHeader.nalu_header.temporal_id)) {
                return null;
            }
            const address = parsed.slice_segment_address;
            if (seenSliceAddresses[address] || address <= lastSliceAddress) {
                return null;
            }
            seenSliceAddresses[address] = true;
            lastSliceAddress = address;
            if (!parsed.dependent_slice_segment_flag && firstHeader !== null && parsed !== firstHeader) {
                if (parsed.slice_type !== firstHeader.slice_type ||
                    parsed.pic_output_flag !== firstHeader.pic_output_flag ||
                    parsed.slice_pic_order_cnt_lsb !== firstHeader.slice_pic_order_cnt_lsb) {
                    return null;
                }
            }
        }
        if (firstSliceCount !== 1 || firstHeader === null || firstChain === null ||
            !Number.isInteger(firstHeader.slice_pic_order_cnt_lsb)) {
            return null;
        }

        const header = firstHeader.nalu_header;
        const endOfSequence = accessUnit.units.some((unit) => {
            return unit.type === H265NaluType.kSliceEOS || unit.type === H265NaluType.kSliceEOB;
        });
        return {
            input: {
                auIndex: accessUnit.auIndex,
                nalUnitType: header.nal_unit_type,
                temporalId: header.temporal_id,
                pocLsb: firstHeader.slice_pic_order_cnt_lsb,
                log2MaxPicOrderCntLsb: firstChain.sps.details.log2_max_pic_order_cnt_lsb,
                parameterSetSignature: `v${firstChain.vps.id}.${firstChain.vps.generation}:` +
                    `s${firstChain.sps.id}.${firstChain.sps.generation}`
            },
            chain: firstChain,
            endOfSequence
        };
    }

    private validateVideoMpuTimestamps(timestamps: MMTSTimestamp[]): boolean {
        if (timestamps.length === 0) {
            return false;
        }
        let previousDts: number | undefined;
        for (const timestamp of timestamps) {
            const mappedTimestamp = this.mapVideoDescriptorTimestamp(timestamp);
            if (mappedTimestamp === null) {
                return false;
            }
            const {dts, pts} = mappedTimestamp;
            if (!Number.isFinite(dts) || !Number.isFinite(pts) || pts < dts ||
                (previousDts !== undefined && dts <= previousDts)) {
                return false;
            }
            previousDts = dts;
        }
        if (this.last_video_dts_ >= 0 && this.pending_seek_media_time_ === undefined) {
            const firstTimestamp = this.mapVideoDescriptorTimestamp(timestamps[0]);
            if (firstTimestamp === null || firstTimestamp.dts <= this.last_video_dts_) {
                return false;
            }
        }
        return true;
    }

    private mapVideoDescriptorTimestamp(timestamp: MMTSTimestamp): MappedVideoDescriptorTimestamp | null {
        if (timestamp === null || !Number.isFinite(timestamp.timescale) || timestamp.timescale <= 0) {
            return null;
        }

        const rawDts = Math.floor(timestamp.rawDts * 1000 / timestamp.timescale);
        const rawPts = Math.floor(timestamp.rawPts * 1000 / timestamp.timescale);
        let dts = Math.floor(timestamp.dts * 1000 / timestamp.timescale);
        let pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
        if (this.output_video_raw_dts_base_ >= 0) {
            dts = rawDts - this.output_video_raw_dts_base_;
            pts = rawPts - this.output_video_raw_dts_base_;
        }

        if (!Number.isFinite(dts) || !Number.isFinite(pts) ||
            !Number.isFinite(rawDts) || !Number.isFinite(rawPts)) {
            return null;
        }
        return {
            dts,
            pts,
            rawDts,
            rawPts,
            rawDtsTicks: timestamp.rawDts,
            rawPtsTicks: timestamp.rawPts,
            timescale: timestamp.timescale
        };
    }

    private rejectVideoMpu(accessUnits: MMTSVideoAccessUnit[], reason: string): void {
        if (accessUnits.length === 0) {
            return;
        }
        const packetId = accessUnits[0].packetId;
        const mpuSequenceNumber = accessUnits[0].mpuSequenceNumber;
        this.program_.clearPresentationIndexes(packetId, mpuSequenceNumber);
        this.rejected_video_mpus_[this.videoMpuKey(packetId, mpuSequenceNumber)] = true;
        this.hevc_poc_recovery_.rejectMpu();
        this.video_waiting_random_access_ = true;
        this.video_recovery_gap_pending_ = false;
        this.video_random_access_safe_pending_ = true;
        this.dropped_video_timestamp_keys_ = {};
        this.dropped_video_sample_count_ += accessUnits.length;
        if (this.logged_dropped_video_sample_count_ < 16) {
            this.logged_dropped_video_sample_count_++;
            Log.w(
                this.TAG,
                `Reject complete MMTS video MPU #${this.logged_dropped_video_sample_count_}, ` +
                `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
                `au_count=${accessUnits.length}, reason=${reason}; wait verified random access`
            );
        }
    }

    private videoMpuKey(packetId: number, mpuSequenceNumber: number): string {
        return `${packetId}:${mpuSequenceNumber}`;
    }

    private takePendingVideoRecoveryGap(videoTimestamp: VideoTimestamp,
                                        outputDts: number,
                                        previousVideoDts: number,
                                        previousVideoDuration: number): any | null {
        if (!this.video_recovery_gap_pending_) {
            return null;
        }

        this.video_recovery_gap_pending_ = false;
        if (previousVideoDts < 0 || previousVideoDuration <= 0 || this.output_video_dts_base_ < 0) {
            return null;
        }

        const expectedDts = previousVideoDts + previousVideoDuration;
        const gapDuration = videoTimestamp.dts - expectedDts;
        const threshold = Math.max(this.getVideoRefSampleDuration() * 2, 35);
        if (gapDuration < threshold) {
            return null;
        }
        if (this.config_.mmtsClampVideoTimestampGap && this.isRepairableVideoTimestampGap(gapDuration)) {
            return null;
        }

        const recoveryGap = {
            expectedDts: Math.max(
                0,
                expectedDts - this.output_video_dts_base_
            ),
            recoveryDts: outputDts,
            duration: gapDuration
        };

        if (this.logged_video_recovery_gap_count_ < 8) {
            this.logged_video_recovery_gap_count_++;
            Log.v(
                this.TAG,
                `Preserve MMTS video recovery gap #${this.logged_video_recovery_gap_count_}, ` +
                `expected_dts=${Math.round(recoveryGap.expectedDts)}, ` +
                `recovery_dts=${Math.round(recoveryGap.recoveryDts)}, ` +
                `gap=${Math.round(recoveryGap.duration)} ms`
            );
        }

        return recoveryGap;
    }

    private appendTimedVideoAccessUnit(accessUnit: MMTSTimedVideoAccessUnit): void {
        const packetId = accessUnit.packetId;
        const mpuSequenceNumber = accessUnit.mpuSequenceNumber;
        const sampleNumber = accessUnit.sampleNumber;
        const auIndex = accessUnit.auIndex;
        const filePosition = accessUnit.filePosition;
        const normalizedAccessUnit = normalizeH265AccessUnitForSampleEntry(
            this.video_sample_entry_type_,
            accessUnit.units,
            accessUnit.length
        );
        const units = normalizedAccessUnit.units;
        const length = normalizedAccessUnit.length;
        const keyframe = accessUnit.keyframe;
        const mseRandomAccessSafe = keyframe && accessUnit.mseRandomAccessSafe !== false;

        if (accessUnit.outputAllowed === false) {
            this.dropped_video_sample_count_++;
            this.video_recovery_gap_pending_ = this.last_video_dts_ >= 0;
            this.logDroppedVideoSample(
                packetId,
                mpuSequenceNumber,
                units,
                accessUnit.descriptorTimestamp,
                accessUnit.dropReason || 'hevc-no-rasl-output'
            );
            return;
        }

        const resumesFromRandomAccess = this.video_waiting_random_access_;
        if (resumesFromRandomAccess) {
            if (!keyframe) {
                this.dropped_video_sample_count_++;
                this.logDroppedVideoSample(
                    packetId,
                    mpuSequenceNumber,
                    units,
                    accessUnit.descriptorTimestamp,
                    'waiting-random-access'
                );
                return;
            }
        }

        if (!this.video_started_) {
            if (!keyframe) {
                this.dropped_video_sample_count_++;
                this.logDroppedVideoSample(packetId, mpuSequenceNumber, units, accessUnit.descriptorTimestamp);
                return;
            }
            this.video_started_ = true;
        }

        if (keyframe && this.video_track_.samples.length > 0 && !this.video_recovery_gap_pending_) {
            this.dispatchVideoMediaSegment();
        }

        const previousVideoDts = this.last_video_dts_;
        const previousVideoDuration = this.last_video_duration_;
        const videoTimestamp = this.consumeVideoAccessUnitTimestamp(accessUnit);
        if (videoTimestamp === null) {
            this.dropped_video_sample_count_++;
            this.logDroppedVideoSample(packetId, mpuSequenceNumber, units, null, 'stale-backward-timestamp');
            return;
        }
        this.initializeVideoOutputBases(videoTimestamp);
        if (resumesFromRandomAccess) {
            this.video_waiting_random_access_ = false;
            this.audio_switch_video_bootstrap_pending_ = false;
            this.video_random_access_safe_pending_ = true;
            this.dropped_video_timestamp_keys_ = {};
            Log.v(
                this.TAG,
                `Resume MMTS video after random access packet_id=${formatHex(packetId, 4)}, ` +
                `mpu_seq=${mpuSequenceNumber}`
            );
        }
        const sourceDts = videoTimestamp.dts - this.output_video_dts_base_;
        const dts = sourceDts;
        const pts = videoTimestamp.pts - this.output_video_dts_base_;
        const exactDts = videoTimestamp.rawDtsTicks !== undefined &&
            this.output_video_raw_dts_base_ticks_ >= 0 ?
            videoTimestamp.rawDtsTicks - this.output_video_raw_dts_base_ticks_ : undefined;
        const exactPts = videoTimestamp.rawPtsTicks !== undefined &&
            this.output_video_raw_dts_base_ticks_ >= 0 ?
            videoTimestamp.rawPtsTicks - this.output_video_raw_dts_base_ticks_ : undefined;
        const timestampRestartFilePosition = this.program_ &&
            typeof this.program_.getTimestampRestartFilePosition === 'function' ?
            this.program_.getTimestampRestartFilePosition(packetId, mpuSequenceNumber) : null;
        const restartFilePosition = timestampRestartFilePosition ?? filePosition;
        const recoveryGap = this.takePendingVideoRecoveryGap(
            videoTimestamp,
            dts,
            previousVideoDts,
            previousVideoDuration
        );
        this.video_sample_index_++;

        const sourceInfo: MMTSSampleSourceInfo = {
            packetId,
            mpuSequenceNumber,
            sampleNumber,
            auIndex,
            filePosition,
            restartFilePosition,
            rawDts: videoTimestamp.rawDts,
            rawPts: videoTimestamp.rawPts,
            rawDtsTicks: videoTimestamp.rawDtsTicks,
            rawPtsTicks: videoTimestamp.rawPtsTicks,
            timescale: videoTimestamp.timescale,
            decodingIndex: videoTimestamp.decodingIndex,
            presentationIndex: videoTimestamp.presentationIndex,
            dts,
            pts
        };
        const discontinuity = this.takePendingVideoDiscontinuity();
        if (discontinuity !== null) {
            sourceInfo.discontinuity = discontinuity;
        }

        const sample: any = {
            units,
            length,
            // ISO-BMFF sync metadata describes the coded frame itself: CRA is
            // an HEVC keyframe even when it is not a safe standalone seek
            // landing point because leading RASL pictures follow it.  Keep the
            // stricter no-RASL-output decision in mmtsRandomAccessSafe only.
            isKeyframe: keyframe,
            isLeading: accessUnit.isLeading === true,
            dts,
            pts,
            cts: pts - dts,
            mmtsDts: exactDts,
            mmtsPts: exactPts,
            mmtsTimescale: videoTimestamp.timescale,
            file_position: filePosition,
            fileposition: filePosition,
            mmtsSourceInfo: sourceInfo
        };
        const randomAccessSafe = mseRandomAccessSafe && this.video_random_access_safe_pending_;
        if (randomAccessSafe) {
            sample.mmtsRandomAccessSafe = true;
        }
        if (discontinuity !== null) {
            sample.mmtsDiscontinuity = discontinuity;
        }
        if (recoveryGap !== null) {
            sample.mmtsVideoGapBefore = recoveryGap;
        }
        this.video_track_.samples.push(sample);
        this.video_track_.length += length;
        if (randomAccessSafe) {
            this.video_random_access_safe_pending_ = false;
        }
        this.updateVodMediaInfoIndex(
            pts,
            restartFilePosition,
            filePosition,
            keyframe,
            this.getVideoRefSampleDuration()
        );
        this.maybeSeedAudioAfterVideoBootstrap(sourceDts);
        this.logVideoSample(packetId, mpuSequenceNumber, units, keyframe, dts, pts, videoTimestamp);

        if (this.video_track_.samples.length >= 8) {
            this.dispatchVideoMediaSegment();
        }
    }

    private initializeVideoOutputBases(videoTimestamp: VideoTimestamp): void {
        const seekMediaTime = this.pending_seek_media_time_;
        if (this.output_video_dts_base_ < 0 && this.video_sample_index_ === 0) {
            if (seekMediaTime !== undefined && !this.seek_preserved_video_timestamp_base_) {
                this.output_video_dts_base_ = videoTimestamp.dts - seekMediaTime;
            } else {
                this.output_video_dts_base_ = videoTimestamp.dts;
            }
        }

        if (this.output_video_raw_dts_base_ < 0 && videoTimestamp.rawDts !== undefined) {
            if (seekMediaTime !== undefined && !this.seek_preserved_video_timestamp_base_) {
                this.output_video_raw_dts_base_ = videoTimestamp.rawDts - seekMediaTime;
            } else {
                this.output_video_raw_dts_base_ = videoTimestamp.rawDts;
            }
            this.subtitle_assembler_.flush();
        }

        if (this.output_video_raw_dts_base_ticks_ < 0 &&
            videoTimestamp.rawDtsTicks !== undefined &&
            videoTimestamp.timescale !== undefined &&
            videoTimestamp.timescale > 0) {
            if (seekMediaTime !== undefined && !this.seek_preserved_video_timestamp_base_) {
                this.output_video_raw_dts_base_ticks_ = videoTimestamp.rawDtsTicks -
                    Math.round(seekMediaTime * videoTimestamp.timescale / 1000);
            } else {
                this.output_video_raw_dts_base_ticks_ = videoTimestamp.rawDtsTicks;
            }
            this.video_timestamp_timescale_ = videoTimestamp.timescale;
        }

        if (this.output_video_dts_base_ >= 0 &&
            (this.output_video_raw_dts_base_ >= 0 || videoTimestamp.rawDts === undefined)) {
            this.pending_seek_media_time_ = undefined;
            this.seek_preserved_video_timestamp_base_ = false;
        }
    }

    private updateVodMediaInfoIndex(presentationTime: number,
                                    restartFilePosition: number,
                                    randomAccessFilePosition: number,
                                    keyframe: boolean,
                                    sampleDuration: number): void {
        if (this.config_.isLive) {
            return;
        }

        const mi = this.media_info_;
        this.applyPlaybackModeMediaInfo(mi);

        if (keyframe) {
            this.insertVodKeyframe(
                presentationTime,
                restartFilePosition,
                randomAccessFilePosition
            );
        }
        this.updateVodDurationEndpoint(presentationTime, sampleDuration);

        if (keyframe && mi.isComplete()) {
            this.onMediaInfo && this.onMediaInfo(mi);
        }
    }

    private applyPlaybackModeMediaInfo(mi: MediaInfo): void {
        if (this.config_.isLive) {
            mi.duration = Infinity;
            mi.hasKeyframesIndex = false;
            mi.keyframesIndex = null;
            return;
        }

        mi.hasKeyframesIndex = true;
        mi.keyframesIndex = this.keyframes_index_;
        if (this.last_media_info_duration_ > 0) {
            mi.duration = this.last_media_info_duration_;
        }
    }

    private insertVodKeyframe(milliseconds: number,
                              restartFilePosition: number,
                              randomAccessFilePosition: number): void {
        const index = this.keyframes_index_;
        if (index.times.length === 0 || milliseconds > index.times[index.times.length - 1]) {
            index.times.push(milliseconds);
            index.filepositions.push(restartFilePosition);
            index.randomAccessFilepositions.push(randomAccessFilePosition);
            return;
        }

        let pos = 0;
        while (pos < index.times.length && index.times[pos] < milliseconds) {
            pos++;
        }
        if (index.times[pos] === milliseconds) {
            index.filepositions[pos] = Math.min(index.filepositions[pos], restartFilePosition);
            index.randomAccessFilepositions[pos] = Math.min(
                index.randomAccessFilepositions[pos],
                randomAccessFilePosition
            );
            return;
        }

        index.times.splice(pos, 0, milliseconds);
        index.filepositions.splice(pos, 0, restartFilePosition);
        index.randomAccessFilepositions.splice(pos, 0, randomAccessFilePosition);
    }

    private updateVodDurationEndpoint(presentationTime: number, sampleDuration: number): void {
        if (this.duration_overridden_) {
            return;
        }

        const duration = presentationTime + Math.max(sampleDuration, 0);

        if (duration > this.last_media_info_duration_) {
            this.last_media_info_duration_ = duration;
            this.media_info_.duration = duration;
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
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `sample=${fragment.sampleNumber !== undefined ? fragment.sampleNumber : 'n/a'}, ` +
            `offset=${fragment.offset !== undefined ? fragment.offset : 'n/a'}, ` +
            `frag=${fragment.fragmentationIndicator}, rap=${randomAccess ? 1 : 0}, type=${naluType}, len=${unitLength}`
        );
    }

    private logDroppedVideoSample(packetId: number,
                                  mpuSequenceNumber: number,
                                  units: H265NaluHVC1[],
                                  timestamp: MMTSTimestamp | null,
                                  reason: string = 'non-keyframe'): void {
        if (this.logged_dropped_video_sample_count_ >= 12) {
            return;
        }

        this.logged_dropped_video_sample_count_++;
        Log.v(
            this.TAG,
            `Drop MMTS video sample before keyframe #${this.logged_dropped_video_sample_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `asset_dts=${timestamp !== null ? formatMsTimestamp(timestamp.dts, timestamp.timescale) : 'n/a'}, ` +
            `asset_pts=${timestamp !== null ? formatMsTimestamp(timestamp.pts, timestamp.timescale) : 'n/a'}, ` +
            `raw_dts=${timestamp !== null ? formatMsTimestamp(timestamp.rawDts, timestamp.timescale) : 'n/a'}, ` +
            `raw_pts=${timestamp !== null ? formatMsTimestamp(timestamp.rawPts, timestamp.timescale) : 'n/a'}, ` +
            `reason=${reason}, nal_types=${formatH265NaluTypes(units)}`
        );
    }

    private logVideoSample(packetId: number,
                           mpuSequenceNumber: number,
                           units: H265NaluHVC1[],
                           keyframe: boolean,
                           dts: number,
                           pts: number,
                           timestamp: VideoTimestamp): void {
        if (this.logged_video_sample_count_ >= 12) {
            return;
        }

        this.logged_video_sample_count_++;
        Log.v(
            this.TAG,
            `MMTS video sample #${this.logged_video_sample_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `keyframe=${keyframe ? 1 : 0}, media_dts=${dts}, media_pts=${pts}, ` +
            `asset_dts=${timestamp.dts}, asset_pts=${timestamp.pts}, ` +
            `raw_dts=${timestamp.rawDts !== undefined ? timestamp.rawDts : 'n/a'}, ` +
            `raw_pts=${timestamp.rawPts !== undefined ? timestamp.rawPts : 'n/a'}, ` +
            `raw_base=${this.output_video_raw_dts_base_ >= 0 ? this.output_video_raw_dts_base_ : 'n/a'}, ` +
            `source=${timestamp.source}, ` +
            `nal_types=${formatH265NaluTypes(units)}`
        );
    }

    private dropVideoTimestamp(packetId: number, mpuSequenceNumber: number, auIndex: number): MMTSTimestamp | null {
        return this.program_.getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex);
    }

    private makeVideoTimestampKey(packetId: number,
                                  mpuSequenceNumber: number,
                                  auIndex: number): string {
        return `${packetId}:${mpuSequenceNumber}:${auIndex}`;
    }

    private dropVideoTimestampOnceWithResult(packetId: number,
                                             mpuSequenceNumber: number,
                                             auIndex: number): DroppedVideoTimestamp {
        const key = this.makeVideoTimestampKey(packetId, mpuSequenceNumber, auIndex);
        if (this.dropped_video_timestamp_keys_[key]) {
            return {timestamp: null, consumed: false};
        }

        this.dropped_video_timestamp_keys_[key] = true;
        return {
            timestamp: this.dropVideoTimestamp(packetId, mpuSequenceNumber, auIndex),
            consumed: true
        };
    }

    private dropVideoTimestampOnce(packetId: number,
                                   mpuSequenceNumber: number,
                                   auIndex: number): MMTSTimestamp | null {
        return this.dropVideoTimestampOnceWithResult(packetId, mpuSequenceNumber, auIndex).timestamp;
    }

    private getFirstTimedMfuFragment(mpu: MPUInfo): MFUFragment | null {
        for (const fragment of mpu.mfuFragments) {
            if (fragment.timed && fragment.sampleNumber !== undefined) {
                return fragment;
            }
        }
        return null;
    }

    private reconcileVideoAccessUnitOnMpuDiscontinuity(packetId: number, mpu: MPUInfo): void {
        const fragment = this.getFirstTimedMfuFragment(mpu);
        const result = this.video_mpu_assembler_.reconcileMpuDiscontinuity(
            packetId,
            mpu.mpuSequenceNumber,
            fragment !== null ? fragment.sampleNumber : undefined
        );

        if (result.completed.length > 0) {
            for (const accessUnit of result.completed) {
                this.appendVideoAccessUnit(accessUnit);
            }
            return;
        }

        const droppedAccessUnit = result.dropped;
        if (droppedAccessUnit === null) {
            return;
        }

        const dropped = this.dropVideoTimestampOnceWithResult(
            droppedAccessUnit.packetId,
            droppedAccessUnit.mpuSequenceNumber,
            droppedAccessUnit.auIndex
        );
        if (dropped.consumed) {
            this.dropped_video_sample_count_++;
            this.logDroppedVideoSample(
                droppedAccessUnit.packetId,
                droppedAccessUnit.mpuSequenceNumber,
                droppedAccessUnit.units,
                dropped.timestamp,
                'discard-open-au-on-discontinuity'
            );
        }
    }

    private dropFragmentedVideoSampleOnMpuDiscontinuity(packetId: number, mpu: MPUInfo): void {
        const fragment = this.getFirstTimedMfuFragment(mpu);
        if (fragment === null ||
            fragment.sampleNumber === undefined ||
            (fragment.fragmentationIndicator !== FragmentationIndicator.MiddleFragment &&
             fragment.fragmentationIndicator !== FragmentationIndicator.LastFragment)) {
            return;
        }

        const auIndex = fragment.sampleNumber !== undefined && fragment.sampleNumber > 0 ?
            fragment.sampleNumber - 1 :
            0;
        const dropped = this.dropVideoTimestampOnceWithResult(packetId, mpu.mpuSequenceNumber, auIndex);
        if (!dropped.consumed) {
            return;
        }

        this.dropped_video_sample_count_++;
        this.logDroppedVideoSample(
            packetId,
            mpu.mpuSequenceNumber,
            [],
            dropped.timestamp,
            'missing-mfu-fragment'
        );
    }

    private handleMpuDiscontinuity(packetId: number,
                                   asset: MMTAsset | undefined,
                                   mpu: MPUInfo,
                                   loss: MMTSPacketLossInfo,
                                   allowRemuxerReset: boolean): void {
        if (asset === undefined ||
            asset.mediaType !== 'video' ||
            packetId !== this.primary_video_packet_id_) {
            return;
        }

        const mpuSequenceNumber = mpu.mpuSequenceNumber;
        this.rejected_video_mpus_[this.videoMpuKey(packetId, mpuSequenceNumber)] = true;
        if (this.pending_video_mpu_sequence_number_ !== undefined) {
            this.rejected_video_mpus_[this.videoMpuKey(
                packetId,
                this.pending_video_mpu_sequence_number_
            )] = true;
        }
        this.hevc_poc_recovery_.rejectMpu();
        // Waiting for a CRA does not clear the decoder's missing references.
        // Arm the existing recovery path so the CRA is appended only after a
        // SourceBuffer parser reset and a fresh initialization segment.
        this.video_reference_recovery_pending_ = true;
        const shouldResetRemuxer = allowRemuxerReset &&
            this.shouldResetRemuxerOnMpuDiscontinuity(packetId, mpuSequenceNumber);
        this.markPendingVideoDiscontinuity(packetId, mpuSequenceNumber, loss);

        this.reconcileVideoAccessUnitOnMpuDiscontinuity(packetId, mpu);
        this.dropFragmentedVideoSampleOnMpuDiscontinuity(packetId, mpu);
        if (shouldResetRemuxer) {
            this.dispatchVideoMediaSegment(true);
        }

        if (shouldResetRemuxer) {
            this.dispatchAudioMediaSegment(true);
            this.onDiscontinuity && this.onDiscontinuity();
            this.last_video_source_info_ = null;
        }
        this.video_waiting_random_access_ = true;
        this.video_recovery_gap_pending_ = false;
        this.video_random_access_safe_pending_ = true;
        this.dropped_video_timestamp_keys_ = {};

        if (this.logged_video_discontinuity_count_ >= 8) {
            return;
        }

        this.logged_video_discontinuity_count_++;
        Log.v(
            this.TAG,
            `MMTS video packet discontinuity #${this.logged_video_discontinuity_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `reset=${shouldResetRemuxer ? 1 : 0}` +
            (shouldResetRemuxer ? '; wait random access' : '; preserve media timeline')
        );
    }

    private markPendingVideoDiscontinuity(packetId: number,
                                          mpuSequenceNumber: number,
                                          loss: MMTSPacketLossInfo): void {
        if (!loss.packetSequenceGap) {
            return;
        }
        this.pending_video_discontinuity_ = {
            packetId,
            mpuSequenceNumber,
            reason: 'packet-sequence-gap',
            expectedSeq: loss.expectedSeq,
            actualSeq: loss.actualSeq
        };
    }

    private takePendingVideoDiscontinuity(): MMTSVideoDiscontinuityInfo | null {
        const discontinuity = this.pending_video_discontinuity_;
        this.pending_video_discontinuity_ = null;
        return discontinuity;
    }

    private handleAudioMpuDiscontinuity(packetId: number, asset: MMTAsset | undefined, mpu: MPUInfo): void {
        if (asset === undefined ||
            (asset.assetType !== 'mp4a' && asset.codec !== 'aac-latm' && asset.codec !== 'aac')) {
            return;
        }

        const state = this.audio_parse_states_by_packet_id_[packetId];
        if (state !== undefined) {
            state.lastIncompleteData = null;
        }
        delete this.audio_switch_cache_by_packet_id_[packetId];

        if (packetId === this.primary_audio_packet_id_) {
            this.dispatchAudioMediaSegment();
        }

        if (this.logged_audio_discontinuity_count_ >= 8) {
            return;
        }

        this.logged_audio_discontinuity_count_++;
        Log.v(
            this.TAG,
            `MMTS audio packet discontinuity #${this.logged_audio_discontinuity_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpu.mpuSequenceNumber}; reset parser fragment`
        );
    }

    private shouldResetRemuxerOnMpuDiscontinuity(packetId: number, mpuSequenceNumber: number): boolean {
        if (!this.video_started_ ||
            !this.video_init_segment_dispatched_ ||
            !this.audio_init_segment_dispatched_) {
            return true;
        }
        if (this.last_video_source_info_ !== null &&
            mpuSequenceNumber >= this.last_video_source_info_.mpuSequenceNumber) {
            return false;
        }

        const auIndex = this.getNextVideoAccessUnitIndexForDiscontinuity(packetId, mpuSequenceNumber);
        const timestamp = this.program_.peekTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex);
        if (timestamp === null || this.last_video_dts_ < 0) {
            return false;
        }

        const mappedTimestamp = this.mapVideoDescriptorTimestamp(timestamp);
        if (mappedTimestamp === null) {
            return false;
        }
        const dts = mappedTimestamp.dts;
        const duration = dts - this.last_video_dts_;
        return duration <= 0;
    }

    private getNextVideoAccessUnitIndexForDiscontinuity(packetId: number, mpuSequenceNumber: number): number {
        return this.video_mpu_assembler_.getNextAccessUnitIndex(packetId, mpuSequenceNumber);
    }

    private getVideoRefSampleDuration(): number {
        const details = this.video_metadata_ ? this.video_metadata_.details : undefined;
        const frameRate = details ? details.frame_rate : undefined;
        if (frameRate &&
            typeof frameRate.fps_num === 'number' &&
            typeof frameRate.fps_den === 'number' &&
            frameRate.fps_num > 0 &&
            frameRate.fps_den > 0) {
            return 1000 * (frameRate.fps_den / frameRate.fps_num);
        }

        return this.last_video_duration_ > 0 ? this.last_video_duration_ : 17;
    }

    private getRepairableVideoTimestampGapThreshold(): number {
        const refSampleDuration = this.getVideoRefSampleDuration();
        return Math.max(1000, refSampleDuration * 60);
    }

    private isRepairableVideoTimestampGap(duration: number): boolean {
        return duration > 0 && duration < this.getRepairableVideoTimestampGapThreshold();
    }

    private maybeUpdateVideoSampleDuration(duration: number): void {
        if (duration <= 0) {
            return;
        }

        const refSampleDuration = this.getVideoRefSampleDuration();
        const maxNormalDuration = Math.max(refSampleDuration * 1.5, refSampleDuration + 8);
        if (duration <= maxNormalDuration) {
            this.last_video_duration_ = duration;
        }
    }

    private isStaleBackwardVideoTimestamp(dts: number): boolean {
        if (this.last_video_dts_ < 0 || this.pending_seek_media_time_ !== undefined) {
            return false;
        }

        return dts <= this.last_video_dts_;
    }

    private logStaleBackwardVideoTimestamp(packetId: number,
                                           mpuSequenceNumber: number,
                                           dts: number,
                                           pts: number): void {
        if (this.logged_stale_video_timestamp_count_ >= 8) {
            return;
        }

        this.logged_stale_video_timestamp_count_++;
        Log.v(
            this.TAG,
            `Drop stale MMTS video timestamp #${this.logged_stale_video_timestamp_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
            `dts=${dts}, pts=${pts}, last_dts=${this.last_video_dts_}`
        );
    }

    private consumeVideoAccessUnitTimestamp(accessUnit: MMTSTimedVideoAccessUnit): VideoTimestamp | null {
        const packetId = accessUnit.packetId;
        const mpuSequenceNumber = accessUnit.mpuSequenceNumber;
        const sampleNumber = accessUnit.sampleNumber;
        const auIndex = accessUnit.auIndex;
        const filePosition = accessUnit.filePosition;
        const timestamp = accessUnit.descriptorTimestamp;
        const source: 'descriptor' = 'descriptor';
        let pts: number;
        let dts: number;
        let rawPts: number | undefined;
        let rawDts: number | undefined;
        let rawPtsTicks: number | undefined;
        let rawDtsTicks: number | undefined;
        let timescale: number | undefined;
        let decodingIndex: number | undefined;
        let presentationIndex: number | undefined;

        if (timestamp !== null) {
            const mappedTimestamp = this.mapVideoDescriptorTimestamp(timestamp);
            if (mappedTimestamp === null) {
                return null;
            }
            pts = mappedTimestamp.pts;
            dts = mappedTimestamp.dts;
            rawPts = mappedTimestamp.rawPts;
            rawDts = mappedTimestamp.rawDts;
            rawPtsTicks = mappedTimestamp.rawPtsTicks;
            rawDtsTicks = mappedTimestamp.rawDtsTicks;
            timescale = mappedTimestamp.timescale;
            decodingIndex = timestamp.decodingIndex;
            presentationIndex = timestamp.presentationIndex;
            if (this.last_video_dts_ >= 0) {
                const duration = dts - this.last_video_dts_;
                this.maybeUpdateVideoSampleDuration(duration);
                if (this.isStaleBackwardVideoTimestamp(dts)) {
                    this.video_waiting_random_access_ = true;
                    this.hevc_poc_recovery_.rejectMpu();
                    this.video_recovery_gap_pending_ = false;
                    this.video_random_access_safe_pending_ = true;
                    this.dropped_video_timestamp_keys_ = {};
                    this.logStaleBackwardVideoTimestamp(packetId, mpuSequenceNumber, dts, pts);
                    return null;
                }
            }
        } else {
            this.logMissingVideoTimestamp(packetId, mpuSequenceNumber, auIndex);
            return null;
        }

        if (pts < dts) {
            this.logStaleBackwardVideoTimestamp(packetId, mpuSequenceNumber, dts, pts);
            return null;
        }

        const sourceInfo: MMTSSampleSourceInfo = {
            packetId,
            mpuSequenceNumber,
            sampleNumber,
            auIndex,
            filePosition,
            rawDts,
            rawPts,
            rawDtsTicks,
            rawPtsTicks,
            timescale,
            decodingIndex,
            presentationIndex,
            dts,
            pts
        };
        this.last_video_dts_ = dts;
        this.last_video_pts_ = pts;
        this.last_video_source_info_ = sourceInfo;
        return {
            dts,
            pts,
            rawDts,
            rawPts,
            rawDtsTicks,
            rawPtsTicks,
            timescale,
            decodingIndex,
            presentationIndex,
            source
        };
    }

    private logMissingVideoTimestamp(packetId: number, mpuSequenceNumber: number, auIndex: number): void {
        if (this.logged_missing_video_timestamp_count_ >= 8) {
            return;
        }

        this.logged_missing_video_timestamp_count_++;
        Log.w(
            this.TAG,
            `Drop MMTS video sample without descriptor timestamp #${this.logged_missing_video_timestamp_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, au=${auIndex}`
        );
    }

    private consumeAudioTimestamp(packetId: number,
                                  mpuSequenceNumber: number,
                                  sampleNumber: number | undefined,
                                  state: AudioParseState): number | undefined {
        const auIndex = this.getAudioAccessUnitIndex(state, mpuSequenceNumber, sampleNumber);
        const timestamp = this.program_.getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex);
        if (timestamp !== null) {
            const pts = Math.floor(timestamp.pts * 1000 / timestamp.timescale);
            const rawPts = Math.floor(timestamp.rawPts * 1000 / timestamp.timescale);
            if (this.output_video_raw_dts_base_ >= 0) {
                const mediaPts = rawPts - this.output_video_raw_dts_base_;
                if (this.logged_audio_timestamp_mapping_count_ < 8) {
                    this.logged_audio_timestamp_mapping_count_++;
                    Log.v(
                        this.TAG,
                        `Map MMTS audio timestamp #${this.logged_audio_timestamp_mapping_count_}, ` +
                        `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
                        `sample=${sampleNumber}, raw_pts=${rawPts}, video_raw_base=${this.output_video_raw_dts_base_}, ` +
                        `media_pts=${mediaPts}`
                    );
                }
                return mediaPts;
            }

            return pts;
        }

        if (this.logged_missing_audio_timestamp_count_ < 4) {
            this.logged_missing_audio_timestamp_count_++;
            Log.v(
                this.TAG,
                `Skip MMTS AAC frame without descriptor timestamp #${this.logged_missing_audio_timestamp_count_}, ` +
                `packet_id=${formatHex(packetId, 4)}, mpu_seq=${mpuSequenceNumber}, ` +
                `sample=${sampleNumber !== undefined ? sampleNumber : 'n/a'}, au=${auIndex}`
            );
        }
        return undefined;
    }

    private getAudioAccessUnitIndex(state: AudioParseState,
                                    mpuSequenceNumber: number,
                                    sampleNumber: number | undefined): number {
        if (state.timestampMpuSequenceNumber !== mpuSequenceNumber) {
            state.timestampMpuSequenceNumber = mpuSequenceNumber;
            state.nextAccessUnitIndex = 0;
        }

        if (sampleNumber !== undefined && sampleNumber > 0) {
            const auIndex = sampleNumber - 1;
            if (state.nextAccessUnitIndex <= auIndex) {
                state.nextAccessUnitIndex = auIndex + 1;
            }
            return auIndex;
        }

        return state.nextAccessUnitIndex++;
    }

    private recordAudioTimestampCursor(state: AudioParseState, pts: number | undefined): void {
        if (pts !== undefined) {
            state.lastTimestampPts = pts;
        }
    }

    private maybeSelectPrimaryAudioAsset(asset: MMTAsset): void {
        if (asset.assetType !== 'mp4a' && asset.codec !== 'aac-latm' && asset.codec !== 'aac') {
            return;
        }

        if (this.primary_audio_packet_id_ >= 0 || this.manually_selected_audio_packet_id_ >= 0) {
            return;
        }

        const info = this.audio_track_infos_by_packet_id_[asset.packetId];
        if (info === undefined) {
            return;
        }

        if (!isMMTSAudioTrackSelectable(info)) {
            this.logUnsupportedMMTSAudioTrack(asset.packetId, info);
            return;
        }

        if (!hasKnownMMTSAudioSupport(info)) {
            return;
        }

        const declaredPrimary = this.findPreferredDeclaredAudioTrack();
        if (declaredPrimary !== undefined &&
            declaredPrimary.packetId !== asset.packetId &&
            !hasKnownMMTSAudioSupport(declaredPrimary)) {
            return;
        }

        const primary = this.findPreferredAudioTrack(true);
        if (primary === undefined) {
            return;
        }

        this.primary_audio_packet_id_ = primary.packetId;
        Log.v(this.TAG, `Select primary MMTS audio packet_id=${formatHex(primary.packetId, 4)}`);
        this.dispatchAudioTracksIfChanged();
    }

    public selectAudioTrack(packetId: number,
                            timelineSeed?: number,
                            onSwitchBoundary?: () => void,
                            rebuildFromSeek: boolean = false,
                            switchIdentity?: PlaybackSwitchIdentity): MMTSAudioTrackSelectionResult {
        return this.selectAudioTrackInternal(
            packetId, true, timelineSeed, onSwitchBoundary, rebuildFromSeek, switchIdentity
        );
    }

    public getPendingAudioTrackSwitch(): {
        scopeId?: string,
        transactionKey?: string,
        attemptKey?: string,
        kind?: 'audio-switch',
        id: number,
        transactionId: number,
        attempt: number,
        packetId: number,
        requestedStart: number,
        requestedStartMicroseconds: number,
    } | null {
        return this.pending_audio_track_switch_ ? Object.assign({}, this.pending_audio_track_switch_) : null;
    }

    private withAudioTrackSelectionIdentity(
        result: MMTSAudioTrackSelectionResult,
        switchIdentity?: PlaybackSwitchIdentity
    ): MMTSAudioTrackSelectionResult {
        if (switchIdentity === undefined || switchIdentity === null ||
            typeof switchIdentity !== 'object') {
            return result;
        }
        return Object.assign({}, result, switchIdentity);
    }

    private selectAudioTrackInternal(packetId: number,
                                     manual: boolean,
                                     timelineSeed?: number,
                                     onSwitchBoundary?: () => void,
                                     rebuildFromSeek: boolean = false,
                                     switchIdentity?: PlaybackSwitchIdentity): MMTSAudioTrackSelectionResult {
        const info = this.audio_track_infos_by_packet_id_[packetId];
        if (info === undefined) {
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: packetId, reason: 'unknown-track'},
                switchIdentity
            );
        }
        if (!isMMTSAudioTrackSelectable(info)) {
            this.logUnsupportedMMTSAudioTrack(packetId, info);
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: packetId, reason: 'unsupported-track'},
                switchIdentity
            );
        }

        const samePacket = this.primary_audio_packet_id_ === packetId;
        const transactionBoundary = switchIdentity !== undefined;
        if (transactionBoundary && (!isPlaybackSwitchIdentity(switchIdentity) ||
            switchIdentity.kind !== 'audio-switch')) {
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: packetId, reason: 'invalid-timeline'},
                switchIdentity
            );
        }
        if (samePacket && !rebuildFromSeek && !transactionBoundary) {
            this.manually_selected_audio_packet_id_ = manual ? packetId : -1;
            return this.withAudioTrackSelectionIdentity({
                accepted: true,
                changed: false,
                requestedPacketId: packetId,
                selectedPacketId: packetId,
                reason: 'already-selected',
            }, switchIdentity);
        }

        const fallbackTimelineSeed = timelineSeed !== undefined ? timelineSeed : this.getAudioFallbackTimelineSeed();
        if (typeof fallbackTimelineSeed !== 'number' ||
            !isFinite(fallbackTimelineSeed) || fallbackTimelineSeed < 0) {
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: packetId, reason: 'invalid-timeline'},
                switchIdentity
            );
        }
        const cachedSamples = rebuildFromSeek || samePacket ? [] :
            this.getCachedAudioSwitchSamples(packetId, fallbackTimelineSeed);
        this.resetAudioTrack();
        if (rebuildFromSeek) {
            this.audio_parse_states_by_packet_id_ = {};
            this.audio_switch_cache_by_packet_id_ = {};
            this.audio_timeline_ && this.audio_timeline_.destroy();
            this.audio_timeline_ = new MMTSAudioTimeline();
        }
        onSwitchBoundary && onSwitchBoundary();
        this.primary_audio_packet_id_ = packetId;
        this.manually_selected_audio_packet_id_ = manual ? packetId : -1;
        const switchId = switchIdentity ?
            switchIdentity.id : ++this.next_audio_track_switch_id_;
        this.next_audio_track_switch_id_ = Math.max(this.next_audio_track_switch_id_, switchId);
        this.pending_audio_track_switch_ = Object.assign({
            id: switchId,
            transactionId: switchId,
            attempt: switchIdentity ? switchIdentity.attempt : 0,
            packetId,
            requestedStart: fallbackTimelineSeed / 1000,
            requestedStartMicroseconds: Math.round(fallbackTimelineSeed * 1000),
        }, switchIdentity || {});
        // A track switch is a SourceBuffer parser boundary even when both
        // tracks share the same codec and channel layout.
        this.audio_init_segment_pending_ = true;
        this.audio_last_sample_pts_ = rebuildFromSeek ? undefined : fallbackTimelineSeed;
        this.audio_timeline_.clearPacket(packetId);
        if (!rebuildFromSeek && cachedSamples.length === 0) {
            this.seedAudioParseState(packetId, fallbackTimelineSeed);
        }
        Log.v(this.TAG, `Select MMTS audio packet_id=${formatHex(packetId, 4)}`);
        this.dispatchAudioTracksIfChanged(true);
        if (cachedSamples.length > 0) {
            this.appendCachedAudioSwitchSamples(packetId, fallbackTimelineSeed);
        }
        return this.withAudioTrackSelectionIdentity({
            accepted: true,
            changed: !samePacket,
            requestedPacketId: packetId,
            selectedPacketId: packetId,
            reason: samePacket ? 'already-selected' : 'selected',
        }, switchIdentity);
    }

    private getAudioFallbackTimelineSeed(): number | undefined {
        if (this.audio_last_sample_pts_ !== undefined) {
            return this.audio_last_sample_pts_;
        }

        if (this.last_video_dts_ >= 0 && this.output_video_dts_base_ >= 0) {
            return this.last_video_dts_ - this.output_video_dts_base_;
        }

        return undefined;
    }

    private seedAudioParseState(packetId: number, fallbackTimelineSeed: number | undefined): void {
        const state = this.getAudioParseState(packetId);
        if (fallbackTimelineSeed === undefined) {
            state.lastSamplePts = undefined;
            this.audio_timeline_.clearPendingSeed(packetId);
            return;
        }

        state.lastSamplePts = fallbackTimelineSeed;
        this.audio_timeline_.seed(packetId, fallbackTimelineSeed);
        Log.v(
            this.TAG,
            `Seed MMTS audio packet_id=${formatHex(packetId, 4)} fallback timeline pts=${Math.floor(fallbackTimelineSeed)}`
        );
    }

    private seedCurrentAudioTimelineAfterVideoSwitch(videoDts: number): void {
        if (this.primary_audio_packet_id_ < 0) {
            return;
        }

        this.audio_last_sample_pts_ = videoDts;
        this.audio_timeline_.clearPacket(this.primary_audio_packet_id_);
        this.seedAudioParseState(this.primary_audio_packet_id_, videoDts);
    }

    private maybeSeedAudioAfterVideoBootstrap(videoDts: number): void {
        if (!this.seed_audio_after_video_bootstrap_) {
            return;
        }

        this.seed_audio_after_video_bootstrap_ = false;
        this.seedCurrentAudioTimelineAfterVideoSwitch(videoDts);
    }

    private alignAudioTimestampToTimeline(packetId: number, pts: number, refSampleDuration: number): number {
        const mapping = this.audio_timeline_.mapTimestamp(packetId, pts, refSampleDuration);
        if (mapping.alignment !== undefined && this.logged_audio_timestamp_alignment_count_ < 8) {
            this.logged_audio_timestamp_alignment_count_++;
            Log.v(
                this.TAG,
                `Align MMTS audio packet_id=${formatHex(packetId, 4)} timestamp ` +
                `raw_pts=${Math.floor(mapping.alignment.rawPts)}, ` +
                `offset=${Math.floor(mapping.alignment.offset)}, ` +
                `mapped_pts=${Math.floor(mapping.alignment.mappedPts)}`
            );
        }
        return mapping.pts;
    }

    private clampAudioTimestampGap(packetId: number,
                                   pts: number,
                                   refSampleDuration: number,
                                   state: AudioParseState): number {
        if (!this.config_.mmtsClampAudioTimestampGap ||
            packetId !== this.primary_audio_packet_id_ ||
            state.lastSamplePts === undefined ||
            !this.video_started_ ||
            !this.audio_init_segment_dispatched_) {
            return pts;
        }

        const expectedPts = state.lastSamplePts + refSampleDuration;
        const maxAudioFramesDrift = 3;
        const drift = pts - expectedPts;
        const forwardThreshold = maxAudioFramesDrift * refSampleDuration;
        const maxRepairableGap = Math.max(1000, refSampleDuration * 48);
        if (drift < 0) {
            return pts;
        }
        if (drift < forwardThreshold) {
            return pts;
        }
        if (drift >= maxRepairableGap) {
            return pts;
        }

        if (this.logged_audio_timestamp_gap_clamp_count_ < 8) {
            this.logged_audio_timestamp_gap_clamp_count_++;
            Log.w(
                this.TAG,
                `Clamp MMTS audio packet_id=${formatHex(packetId, 4)} timestamp gap ` +
                `raw_pts=${Math.floor(pts)}, expected_pts=${Math.floor(expectedPts)}, ` +
                `gap=${Math.round(drift)} ms`
            );
        }

        return expectedPts;
    }

    private isStaleBackwardAudioTimestamp(packetId: number,
                                          pts: number,
                                          refSampleDuration: number,
                                          state: AudioParseState): boolean {
        if (packetId !== this.primary_audio_packet_id_ ||
            state.lastSamplePts === undefined ||
            this.pending_seek_media_time_ !== undefined ||
            !this.video_started_ ||
            !this.audio_init_segment_dispatched_) {
            return false;
        }

        const rewind = state.lastSamplePts - pts;
        const threshold = Math.max(1000, refSampleDuration * 48);
        return rewind >= threshold;
    }

    private logStaleBackwardAudioTimestamp(packetId: number, pts: number, state: AudioParseState): void {
        if (this.logged_stale_audio_timestamp_count_ >= 8) {
            return;
        }

        this.logged_stale_audio_timestamp_count_++;
        Log.v(
            this.TAG,
            `Drop stale MMTS audio timestamp #${this.logged_stale_audio_timestamp_count_}, ` +
            `packet_id=${formatHex(packetId, 4)}, pts=${Math.floor(pts)}, ` +
            `last_pts=${Math.floor(state.lastSamplePts)}`
        );
    }

    private getAudioSwitchCacheDuration(): number {
        const duration = this.config_.mmtsAudioTrackSwitchCacheDuration;
        if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
            return 0;
        }

        if (this.config_.isLive) {
            const forwardTarget = this.config_.mseBufferForwardTargetDuration;
            const switchWindow = typeof forwardTarget === 'number' && isFinite(forwardTarget) && forwardTarget > 0 ?
                forwardTarget + 2 : 0;
            return Math.max(duration, switchWindow);
        }

        if (!this.config_.lazyLoad || (this.config_.isLive && !this.config_.lazyLoadOnLive)) {
            return duration;
        }

        const lazyLoadMaxDuration = this.config_.lazyLoadMaxDuration;
        const lazyLoadRecoverDuration = this.config_.lazyLoadRecoverDuration;
        const switchWindow = (typeof lazyLoadMaxDuration === 'number' && isFinite(lazyLoadMaxDuration) ? lazyLoadMaxDuration : 0) +
            (typeof lazyLoadRecoverDuration === 'number' && isFinite(lazyLoadRecoverDuration) ? lazyLoadRecoverDuration : 0) +
            2;
        return Math.max(duration, switchWindow);
    }

    private cacheAudioSwitchSample(packetId: number,
                                   sample: CachedAudioSample,
                                   refSampleDuration: number,
                                   metadata: AACAudioMetadata): boolean {
        let cache = this.audio_switch_cache_by_packet_id_[packetId];
        if (cache === undefined) {
            cache = {
                samples: [],
                length: 0
            };
            this.audio_switch_cache_by_packet_id_[packetId] = cache;
        }

        if (cache.metadata !== undefined && !this.isSameAudioMetadata(cache.metadata, metadata)) {
            cache.samples = [];
            cache.length = 0;
        }
        const lastSample = cache.samples.length > 0 ? cache.samples[cache.samples.length - 1] : null;
        if (lastSample !== null) {
            const delta = sample.pts - lastSample.pts;
            if (delta <= 0) {
                return false;
            }
            if (delta > Math.max(100, refSampleDuration * 4)) {
                cache.samples = [];
                cache.length = 0;
            }
        }

        cache.metadata = {...metadata};
        cache.refSampleDuration = refSampleDuration;
        cache.samples.push(sample);
        cache.length += sample.length;

        const keepFrom = sample.pts - this.getAudioSwitchCacheDuration() * 1000;
        while (cache.samples.length > 0 && cache.samples[0].pts < keepFrom) {
            cache.length -= cache.samples.shift().length;
        }
        return true;
    }

    private getCachedAudioSwitchSamples(packetId: number, timelineSeed: number | undefined): CachedAudioSample[] {
        const cache = this.audio_switch_cache_by_packet_id_[packetId];
        if (cache === undefined || cache.samples.length === 0) {
            return [];
        }

        if (timelineSeed === undefined) {
            return cache.samples.slice();
        }

        return cache.samples.filter((sample) => sample.pts >= timelineSeed);
    }

    private hasCompleteAudioMetadata(metadata: AACAudioMetadata): boolean {
        return metadata !== undefined &&
            metadata.audio_object_type !== undefined &&
            metadata.sampling_freq_index !== undefined &&
            metadata.sampling_frequency !== undefined &&
            metadata.channel_config !== undefined;
    }

    private isSameAudioMetadata(left: AACAudioMetadata | undefined, right: AACAudioMetadata | undefined): boolean {
        return this.hasCompleteAudioMetadata(left) &&
            this.hasCompleteAudioMetadata(right) &&
            left.audio_object_type === right.audio_object_type &&
            left.sampling_freq_index === right.sampling_freq_index &&
            left.sampling_frequency === right.sampling_frequency &&
            left.channel_config === right.channel_config;
    }

    private appendCachedAudioSwitchSamples(packetId: number, timelineSeed: number | undefined): boolean {
        const cache = this.audio_switch_cache_by_packet_id_[packetId];
        if (cache === undefined || !this.hasCompleteAudioMetadata(cache.metadata)) {
            return false;
        }

        const samples = this.getCachedAudioSwitchSamples(packetId, timelineSeed);
        if (samples.length === 0) {
            return false;
        }

        const metadataChanged = !this.isSameAudioMetadata(cache.metadata, this.audio_metadata_);
        if (!this.audio_init_segment_dispatched_ || metadataChanged || this.audio_init_segment_pending_) {
            this.audio_metadata_ = cache.metadata;
            this.dispatchAudioInitSegmentFromMetadata(cache.metadata);
        } else {
            this.audio_metadata_ = cache.metadata;
        }

        for (const sample of samples) {
            this.audio_track_.samples.push({
                unit: sample.unit,
                length: sample.length,
                pts: sample.pts,
                dts: sample.dts
            });
            this.audio_track_.length += sample.length;
        }

        const lastSample = samples[samples.length - 1];
        const state = this.getAudioParseState(packetId);
        state.lastSamplePts = lastSample.pts;
        state.switchReplayEndPts = lastSample.pts;
        this.audio_last_sample_pts_ = lastSample.pts;
        if (lastSample.rawPts !== undefined) {
            this.audio_timeline_.setMapping(packetId, lastSample.rawPts, lastSample.pts);
        } else if (timelineSeed !== undefined) {
            this.audio_timeline_.seed(packetId, timelineSeed);
        }

        Log.v(
            this.TAG,
            `Apply cached MMTS audio packet_id=${formatHex(packetId, 4)}, ` +
            `samples=${samples.length}, begin_pts=${samples[0].pts}, end_pts=${lastSample.pts}`
        );
        this.dispatchAudioMediaSegment(true);
        delete this.audio_switch_cache_by_packet_id_[packetId];
        return true;
    }

    public selectVideoTrack(packetId: number,
                            switchIdentity?: PlaybackSwitchIdentity): MMTSVideoTrackSelectionResult {
        const identityResult = switchIdentity !== undefined && switchIdentity !== null ?
            Object.assign({}, switchIdentity) : {};
        if (switchIdentity !== undefined &&
            (!isPlaybackSwitchIdentity(switchIdentity) || switchIdentity.kind !== 'video-switch')) {
            return Object.assign({
                accepted: false,
                changed: false,
                requestedPacketId: packetId,
                reason: 'invalid-identity' as MMTSVideoTrackSelectionReason,
            }, identityResult);
        }

        if (!Number.isInteger(packetId) || packetId < 0) {
            return Object.assign({
                accepted: false,
                changed: false,
                requestedPacketId: packetId,
                reason: 'unknown-track' as MMTSVideoTrackSelectionReason,
            }, identityResult);
        }
        const info = this.video_track_infos_by_packet_id_[packetId];
        const asset = this.program_.getAsset(packetId);
        if (info === undefined && (asset === undefined || asset.mediaType !== 'video')) {
            return Object.assign({
                accepted: false,
                changed: false,
                requestedPacketId: packetId,
                reason: 'unknown-track' as MMTSVideoTrackSelectionReason,
            }, identityResult);
        }

        const samePacket = this.primary_video_packet_id_ === packetId;
        if (samePacket && switchIdentity === undefined) {
            return Object.assign({
                accepted: true,
                changed: false,
                requestedPacketId: packetId,
                selectedPacketId: packetId,
                reason: 'already-selected' as MMTSVideoTrackSelectionReason,
            }, identityResult);
        }

        this.beginVideoTrackSwitch(packetId, switchIdentity);
        Log.v(this.TAG, `Select MMTS video packet_id=${formatHex(packetId, 4)}`);
        this.dispatchVideoTracksIfChanged(true);
        return Object.assign({
            accepted: true,
            changed: !samePacket,
            requestedPacketId: packetId,
            selectedPacketId: packetId,
            reason: samePacket ?
                'already-selected' as MMTSVideoTrackSelectionReason :
                'selected' as MMTSVideoTrackSelectionReason,
        }, identityResult);
    }

    private beginVideoTrackSwitch(packetId: number,
                                  switchIdentity?: PlaybackSwitchIdentity): void {
        const seedAudioAfterBootstrap = this.shouldSeedAudioAfterVideoBootstrap();
        this.flushCurrentVideoAccessUnit();
        this.dispatchVideoMediaSegment(true);
        this.onVideoDiscontinuity && this.onVideoDiscontinuity();
        this.primary_video_packet_id_ = packetId;
        if (this.config_) {
            this.config_.mmtsVideoPacketId = packetId;
        }
        this.program_.resetMpuPacketState(packetId);
        this.resetVideoBootstrapState(true);
        this.seed_audio_after_video_bootstrap_ = seedAudioAfterBootstrap;
        const switchId = switchIdentity ? switchIdentity.id : ++this.next_video_track_switch_id_;
        this.next_video_track_switch_id_ = Math.max(this.next_video_track_switch_id_, switchId);
        this.pending_video_track_switch_ = Object.assign({
            id: switchId,
            transactionId: switchId,
            attempt: switchIdentity ? switchIdentity.attempt : 0,
            packetId,
        }, switchIdentity || {});
    }

    private shouldSeedAudioAfterVideoBootstrap(): boolean {
        return this.video_started_ &&
            this.audio_init_segment_dispatched_ &&
            this.primary_audio_packet_id_ >= 0;
    }

    public selectPrimaryAudioTrack(timelineSeed?: number,
                                   onSwitchBoundary?: () => void,
                                   rebuildFromSeek: boolean = false,
                                   switchIdentity?: PlaybackSwitchIdentity): MMTSAudioTrackSelectionResult {
        const primary = this.findPreferredAudioTrack(false);
        if (primary !== undefined) {
            return this.selectAudioTrackInternal(
                primary.packetId,
                false,
                timelineSeed,
                onSwitchBoundary,
                rebuildFromSeek,
                switchIdentity
            );
        }
        return this.withAudioTrackSelectionIdentity(
            {accepted: false, changed: false, requestedPacketId: -1, reason: 'unknown-track'},
            switchIdentity
        );
    }

    public selectSecondaryAudioTrack(timelineSeed?: number,
                                     onSwitchBoundary?: () => void,
                                     rebuildFromSeek: boolean = false,
                                     switchIdentity?: PlaybackSwitchIdentity): MMTSAudioTrackSelectionResult {
        const tracks = this.getSortedAudioTrackInfos();
        if (tracks.length === 0) {
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: -1, reason: 'unknown-track'},
                switchIdentity
            );
        }

        const selectableTracks = tracks.filter((track) => isMMTSAudioTrackSelectable(track));
        if (selectableTracks.length === 0) {
            return this.withAudioTrackSelectionIdentity(
                {accepted: false, changed: false, requestedPacketId: -1, reason: 'unsupported-track'},
                switchIdentity
            );
        }

        const currentIndex = selectableTracks.findIndex((track) => track.packetId === this.primary_audio_packet_id_);
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % selectableTracks.length : 0;
        return this.selectAudioTrack(
            selectableTracks[nextIndex].packetId,
            timelineSeed,
            onSwitchBoundary,
            rebuildFromSeek,
            switchIdentity
        );
    }

    private maybeSelectPrimaryVideoAsset(asset: MMTAsset, hasCurrentUnit: boolean): void {
        if (asset.mediaType !== 'video' || this.video_started_) {
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
            const currentAsset = this.program_.getAsset(this.primary_video_packet_id_);
            if (this.compareVideoAssetPriority(asset, currentAsset) >= 0) {
                return;
            }
            this.resetVideoBootstrapState();
        }

        this.primary_video_packet_id_ = asset.packetId;
        Log.v(
            this.TAG,
            `Select primary MMTS video packet_id=${formatHex(asset.packetId, 4)}, ` +
            `score=${score}, resolution=${videoResolutionLabel(asset)}` +
            `${asset.assetGroupId !== undefined ? `, asset_group=${asset.assetGroupId}` : ''}` +
            `${asset.assetSelectionLevel !== undefined ? `, selection_level=${asset.assetSelectionLevel}` : ''}` +
            `${asset.hierarchyChannel !== undefined ? `, hierarchy_channel=${asset.hierarchyChannel}` : ''}` +
            `${asset.hierarchyLayerIndex !== undefined ? `, hierarchy_layer=${asset.hierarchyLayerIndex}` : ''}` +
            `${asset.hierarchyEmbeddedLayerIndex !== undefined ? `, hierarchy_base=${asset.hierarchyEmbeddedLayerIndex}` : ''}` +
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
            `Waiting for forced MMTS video packet_id=${formatHex(forcedPacketId, 4)}, ` +
            `seen_mpu=${this.mmtp_mpu_counts_by_packet_id_[forcedPacketId] || 0}, ` +
            `parsed_packets=${this.parsed_mmtp_count_}, ` +
            `seen_packet_ids=${formatPacketCounts(this.mmtp_mpu_counts_by_packet_id_)}` +
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
            const naluType = readH265NaluType(pendingUnit.unit);
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
                    if (isH265IrapNalu(naluType)) {
                        score += 1000;
                    } else if (isH265VclNalu(naluType)) {
                        score += 2;
                    }
                    break;
            }
        }
        return score;
    }

    private compareVideoAssetPriority(candidate: MMTAsset,
                                      current: MMTAsset | undefined): number {
        if (current === undefined) {
            return -1;
        }

        // asset_selection_level only defines an ordering inside one declared
        // asset group.  Some broadcasts omit it on the normal 4K service but
        // set level=1 on the 1080p heavy-rain fallback.  Treating the mere
        // presence of the field as a global score makes that fallback win.
        if (candidate.assetGroupId !== undefined &&
            current.assetGroupId !== undefined &&
            candidate.assetGroupId === current.assetGroupId &&
            candidate.assetSelectionLevel !== undefined &&
            current.assetSelectionLevel !== undefined &&
            candidate.assetSelectionLevel !== current.assetSelectionLevel) {
            return candidate.assetSelectionLevel - current.assetSelectionLevel;
        }

        const resolutionOrder = (current.videoResolution || 0) -
            (candidate.videoResolution || 0);
        if (resolutionOrder !== 0) {
            return resolutionOrder;
        }

        const activityOrder = this.scorePendingVideoAsset(current.packetId) -
            this.scorePendingVideoAsset(candidate.packetId);
        if (activityOrder !== 0) {
            return activityOrder;
        }

        return candidate.packetId - current.packetId;
    }

    private resetVideoBootstrapState(preserveTimeline: boolean = false): void {
        const videoSampleIndex = this.video_sample_index_;
        const lastVideoDts = this.last_video_dts_;
        const lastVideoPts = this.last_video_pts_;
        const lastVideoDuration = this.last_video_duration_;
        const lastVideoSourceInfo = this.last_video_source_info_;
        const outputVideoDtsBase = this.output_video_dts_base_;
        const outputVideoRawDtsBase = this.output_video_raw_dts_base_;
        const outputVideoRawDtsBaseTicks = this.output_video_raw_dts_base_ticks_;
        const videoTimestampTimescale = this.video_timestamp_timescale_;

        this.video_metadata_ = {
            vps: undefined,
            sps: undefined,
            pps: undefined,
            details: undefined
        };
        this.video_track_ = {type: 'video', id: 1, sequenceNumber: this.video_track_.sequenceNumber, samples: [], length: 0};
        this.video_init_segment_dispatched_ = false;
        this.video_sample_entry_type_ = 'hvc1';
        this.video_parameter_sets_in_band_ = false;
        this.video_sample_index_ = 0;
        this.video_started_ = false;
        this.last_video_dts_ = -1;
        this.last_video_pts_ = -1;
        this.last_video_duration_ = 17;
        this.last_video_source_info_ = null;
        this.output_video_dts_base_ = -1;
        this.output_video_raw_dts_base_ = -1;
        this.output_video_raw_dts_base_ticks_ = -1;
        this.video_timestamp_timescale_ = 0;
        this.logged_video_nalu_count_ = 0;
        this.logged_dropped_video_sample_count_ = 0;
        this.logged_video_discontinuity_count_ = 0;
        this.logged_video_sample_count_ = 0;
        this.logged_video_recovery_gap_count_ = 0;
        this.logged_video_reference_recovery_count_ = 0;
        this.logged_stale_video_timestamp_count_ = 0;
        this.logged_stale_audio_timestamp_count_ = 0;
        this.video_mpu_assembler_.reset();
        this.pending_video_access_units_ = [];
        this.pending_video_mpu_sequence_number_ = undefined;
        this.video_parameter_sets_ = {vps: {}, sps: {}, pps: {}};
        this.video_parameter_set_versions_ = {vps: {}, sps: {}, pps: {}};
        this.video_parameter_set_chains_by_nalu_ = new WeakMap();
        this.next_video_parameter_set_generation_ = 1;
        this.active_video_parameter_set_signature_ = undefined;
        this.hevc_poc_recovery_.reset(true);
        this.rejected_video_mpus_ = {};
        this.nominal_video_mpu_access_unit_count_ = 0;
        this.video_reference_recovery_pending_ = false;
        this.video_reference_recovery_parameter_set_generation_limit_ = 0;
        this.video_reference_recovery_watch_remaining_ = 0;
        this.video_reference_recovery_watch_delay_ = 0;
        this.video_waiting_random_access_ = true;
        this.video_recovery_gap_pending_ = false;
        this.seed_audio_after_video_bootstrap_ = false;
        this.audio_switch_video_bootstrap_pending_ = false;
        this.video_random_access_safe_pending_ = true;
        this.dropped_video_timestamp_keys_ = {};
        this.pending_video_discontinuity_ = null;
        this.pre_init_video_units_ = [];
        this.pending_video_track_switch_ = null;

        if (preserveTimeline) {
            this.video_sample_index_ = videoSampleIndex;
            this.last_video_dts_ = lastVideoDts;
            this.last_video_pts_ = lastVideoPts;
            this.last_video_duration_ = lastVideoDuration;
            this.last_video_source_info_ = lastVideoSourceInfo;
            this.output_video_dts_base_ = outputVideoDtsBase;
            this.output_video_raw_dts_base_ = outputVideoRawDtsBase;
            this.output_video_raw_dts_base_ticks_ = outputVideoRawDtsBaseTicks;
            this.video_timestamp_timescale_ = videoTimestampTimescale;
        }
    }

    private updateTrackInfo(asset: MMTAsset): void {
        if (asset.assetType === 'hev1' || asset.mediaType === 'video') {
            const active = (this.mmtp_mpu_counts_by_packet_id_[asset.packetId] || 0) > 0 ||
                this.scorePendingVideoAsset(asset.packetId) > 0;
            this.video_track_infos_by_packet_id_[asset.packetId] = createMMTSVideoTrackInfo(
                asset,
                this.video_track_infos_by_packet_id_[asset.packetId],
                active,
                asset.packetId === this.primary_video_packet_id_
            );
            this.dispatchVideoTracksIfChanged();
            return;
        }

        if (asset.assetType === 'mp4a' || asset.codec === 'aac-latm' || asset.codec === 'aac') {
            this.audio_track_infos_by_packet_id_[asset.packetId] = createMMTSAudioTrackInfo(
                asset,
                this.audio_track_infos_by_packet_id_[asset.packetId],
                asset.packetId === this.primary_audio_packet_id_
            );
            this.dispatchAudioTracksIfChanged();
            return;
        }

        if (asset.assetType === 'stpp' || (asset.mediaType === 'subtitle' && asset.codec === 'ttml')) {
            this.subtitle_track_infos_by_packet_id_[asset.packetId] = createMMTSSubtitleTrackInfo(
                asset,
                this.subtitle_track_infos_by_packet_id_[asset.packetId]
            );
            this.dispatchSubtitleTracksIfChanged();
        }
    }

    private updateAudioTrackInfoFromFrame(packetId: number, frame: LOASAACFrame): void {
        const prev = this.audio_track_infos_by_packet_id_[packetId];
        this.audio_track_infos_by_packet_id_[packetId] = updateMMTSAudioTrackInfoFromFrame(
            packetId,
            frame,
            prev,
            packetId === this.primary_audio_packet_id_
        );
        this.maybePromotePrimaryAudioTrack(packetId);
        this.dispatchAudioTracksIfChanged();
    }

    private maybePromotePrimaryAudioTrack(packetId: number): void {
        const manualPacketId = this.manually_selected_audio_packet_id_;
        if (manualPacketId >= 0 && packetId !== manualPacketId) {
            return;
        }

        const info = this.audio_track_infos_by_packet_id_[packetId];
        if (!isMMTSAudioTrackSelectable(info)) {
            if (this.primary_audio_packet_id_ === packetId && !this.audio_init_segment_dispatched_) {
                this.primary_audio_packet_id_ = -1;
                if (this.manually_selected_audio_packet_id_ === packetId) {
                    this.manually_selected_audio_packet_id_ = -1;
                }
                this.dispatchAudioTracksIfChanged(true);
            }
            this.logUnsupportedMMTSAudioTrack(packetId, info);
            return;
        }

        if (!hasKnownMMTSAudioSupport(info)) {
            return;
        }

        if (manualPacketId >= 0) {
            return;
        }

        if (this.audio_init_segment_dispatched_) {
            return;
        }

        const declaredPrimary = this.findPreferredDeclaredAudioTrack();
        if (declaredPrimary !== undefined &&
            declaredPrimary.packetId !== packetId &&
            !hasKnownMMTSAudioSupport(declaredPrimary)) {
            return;
        }

        const primary = this.findPreferredAudioTrack(true);
        if (primary === undefined || primary.packetId === this.primary_audio_packet_id_) {
            return;
        }

        this.primary_audio_packet_id_ = primary.packetId;
        Log.v(this.TAG, `Select primary MMTS audio packet_id=${formatHex(primary.packetId, 4)}`);
        this.dispatchAudioTracksIfChanged(true);
    }

    private findPreferredAudioTrack(requireKnownSupport: boolean): MMTSAudioTrackInfo | undefined {
        return findPreferredAudioTrack(this.getSortedAudioTrackInfos(), requireKnownSupport);
    }

    private findPreferredDeclaredAudioTrack(): MMTSAudioTrackInfo | undefined {
        return findPreferredDeclaredAudioTrack(this.getSortedAudioTrackInfos());
    }

    private logUnsupportedMMTSAudioTrack(packetId: number, info: MMTSAudioTrackInfo | undefined): void {
        if (this.logged_unsupported_audio_packet_ids_[packetId]) {
            return;
        }
        this.logged_unsupported_audio_packet_ids_[packetId] = true;

        const parts: string[] = [`packet_id=${formatHex(packetId, 4)}`];
        if (info && info.codec) {
            parts.push(`codec=${info.codec}`);
        }
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

    private logUnsupportedMMTSSubtitleTrack(packetId: number, asset: MMTAsset): void {
        if (this.logged_unsupported_subtitle_packet_ids_[packetId]) {
            return;
        }
        this.logged_unsupported_subtitle_packet_ids_[packetId] = true;
        Log.w(
            this.TAG,
            `Skip unsupported MMTS subtitle track (packet_id=${formatHex(packetId, 4)}, ` +
            `compression_type=${asset.subtitleCompressionType})`
        );
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
                previousFrame: null,
                nextAccessUnitIndex: 0
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
        const fallback = isMMTSVideoFallback(tracks, this.primary_video_packet_id_);
        const fallbackReason = fallback ? 'higher-inactive' : undefined;
        const selectedRole = getMMTSSelectedVideoRole(tracks, this.primary_video_packet_id_, fallback);
        const primaryTrack = findMMTSPrimaryVideoTrack(tracks);
        const secondaryTrack = findMMTSSecondaryVideoTrack(tracks, primaryTrack);
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
                packetId: formatHex(track.packetId, 4),
                assetType: track.assetType,
                codec: track.codec || 'unknown',
                language: track.language || 'und',
                componentTag: track.componentTag !== undefined ? formatHex(track.componentTag, 4) : undefined,
                dataComponentId: track.dataComponentId !== undefined ? formatHex(track.dataComponentId, 4) : undefined,
                dataComponentInfo: track.dataComponentInfo ? toHex(track.dataComponentInfo) : undefined,
                accessControlCaSystemId: track.accessControlCaSystemId !== undefined ?
                    formatHex(track.accessControlCaSystemId, 4) : undefined,
                accessControlPacketId: track.accessControlPacketId !== undefined ?
                    formatHex(track.accessControlPacketId, 4) : undefined,
                scramblerLayerType: track.scramblerLayerType,
                scrambleSystemId: track.scrambleSystemId,
                messageAuthenticationLayerType: track.messageAuthenticationLayerType,
                messageAuthenticationSystemId: track.messageAuthenticationSystemId
            };
        }))}`);
    }

    private getSortedAudioTrackInfos(): MMTSAudioTrackInfo[] {
        return getSortedAudioTrackInfos(this.audio_track_infos_by_packet_id_);
    }

    private getSortedVideoTrackInfos(): MMTSVideoTrackInfo[] {
        return getSortedVideoTrackInfos(this.video_track_infos_by_packet_id_);
    }

    private getSortedSubtitleTrackInfos(): MMTSSubtitleTrackInfo[] {
        return getSortedSubtitleTrackInfos(this.subtitle_track_infos_by_packet_id_);
    }

    private logSubtitleData(subtitle: MMTSSubtitleData): void {
        if (this.logged_subtitle_data_count_ >= 12) {
            return;
        }

        this.logged_subtitle_data_count_++;
        Log.v(
            this.TAG,
            `MMTS subtitle #${this.logged_subtitle_data_count_}, ` +
            `packet_id=${formatHex(subtitle.packetId, 4)}, ` +
            `asset=${subtitle.assetType}, codec=${subtitle.codec || 'unknown'}, ` +
            `lang=${subtitle.language || 'und'}, mpu_seq=${subtitle.mpuSequenceNumber}, ` +
            `sample=${subtitle.sampleNumber !== undefined ? subtitle.sampleNumber : 'n/a'}, ` +
            `pts=${subtitle.pts !== undefined ? subtitle.pts : 'n/a'}, ` +
            `dts=${subtitle.dts !== undefined ? subtitle.dts : 'n/a'}, ` +
            `raw_pts=${subtitle.rawPts !== undefined ? subtitle.rawPts : 'n/a'}, ` +
            `raw_dts=${subtitle.rawDts !== undefined ? subtitle.rawDts : 'n/a'}, ` +
            `tmd=${subtitle.subtitleTimingMode !== undefined ? subtitle.subtitleTimingMode : 'n/a'}, ` +
            `ref_start=${subtitle.subtitleReferenceStartTime !== undefined ? subtitle.subtitleReferenceStartTime : 'n/a'}, ` +
            `ref_media=${subtitle.subtitleReferenceStartMediaTime !== undefined ? subtitle.subtitleReferenceStartMediaTime : 'n/a'}, ` +
            `video_media_dts=${subtitle.videoMediaDts !== undefined ? subtitle.videoMediaDts : 'n/a'}, ` +
            `video_media_pts=${subtitle.videoMediaPts !== undefined ? subtitle.videoMediaPts : 'n/a'}, ` +
            `video_raw_base=${subtitle.videoRawDtsBase !== undefined ? subtitle.videoRawDtsBase : 'n/a'}, ` +
            `video_dts_base=${subtitle.videoDtsBase !== undefined ? subtitle.videoDtsBase : 'n/a'}, ` +
            `video_samples=${subtitle.videoSampleIndex !== undefined ? subtitle.videoSampleIndex : 'n/a'}, ` +
            `dropped_video=${subtitle.droppedVideoSampleCount !== undefined ? subtitle.droppedVideoSampleCount : 'n/a'}, ` +
            `len=${subtitle.len}, resources=${subtitle.resources ? subtitle.resources.length : 0}, ` +
            `resources_complete=${subtitle.resourcesComplete ? 1 : 0}`
        );
        // Log.v(this.TAG, `MMTS subtitle TTML:\n${subtitle.text || ''}`);
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

    private cachePendingMfuUnit(packetId: number,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment,
                                filePosition: number,
                                randomAccess: boolean,
                                unit: Uint8Array): void {
        const unitLength = MPU.readLengthPrefixedUnitLength(unit);
        if (unitLength === undefined || unitLength !== unit.byteLength - 4 || unit.byteLength < 6) {
            return;
        }

        const naluType = (unit[4] >> 1) & 0x3f;
        if (!isH265VclNalu(naluType) &&
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
            filePosition,
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
            `Replay ${pending.length} pending MFU units for packet_id=${formatHex(asset.packetId, 4)}, ` +
            `asset=${asset.assetType}`
        );

        for (const pendingUnit of pending) {
            this.processCompleteMfuUnit(
                asset.packetId,
                asset,
                pendingUnit.mpuSequenceNumber,
                pendingUnit.fragment,
                pendingUnit.filePosition,
                pendingUnit.randomAccess,
                pendingUnit.unit
            );
        }
    }

    private cachePreInitVideoUnit(mpuSequenceNumber: number,
                                  fragment: MFUFragment,
                                  filePosition: number,
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
            filePosition,
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
                pendingUnit.filePosition,
                pendingUnit.randomAccess,
                pendingUnit.unit
            );
        }
        this.flushCurrentVideoAccessUnit();
    }

    private dispatchAudioInitSegment(sample: AudioData): void {
        const frame = sample.data;
        this.dispatchAudioInitSegmentFromMetadata({
            codec: 'aac',
            audio_object_type: frame.audio_object_type,
            sampling_freq_index: frame.sampling_freq_index,
            sampling_frequency: frame.sampling_frequency,
            channel_config: frame.channel_config
        });
    }

    private dispatchAudioInitSegmentFromMetadata(metadata: AACAudioMetadata): void {
        const meta: any = {};
        const audioObjectType = metadata.audio_object_type;
        const samplingFrequencyIndex = metadata.sampling_freq_index;
        const channelConfig = metadata.channel_config;
        const audioSpecificConfig = new AudioSpecificConfig({
            audio_object_type: audioObjectType,
            sampling_freq_index: samplingFrequencyIndex,
            sampling_frequency: metadata.sampling_frequency,
            channel_config: channelConfig,
            data: null
        });

        meta.type = 'audio';
        meta.id = this.audio_track_.id;
        meta.timescale = 1000;
        meta.duration = 0;
        meta.audioSampleRate = audioSpecificConfig.sampling_rate;
        meta.channelCount = audioSpecificConfig.channel_count;
        meta.codec = audioSpecificConfig.codec_mimetype;
        meta.originalCodec = audioSpecificConfig.original_codec_mimetype;
        meta.config = audioSpecificConfig.config;
        meta.refSampleDuration = 1024 / meta.audioSampleRate * meta.timescale;
        if (this.pending_audio_track_switch_ !== null) {
            meta.mmtsAudioTrackSwitch = Object.assign({}, this.pending_audio_track_switch_);
        }

        if (!this.audio_init_segment_dispatched_) {
            Log.v(this.TAG, `Generated first MMTS AAC AudioSpecificConfig for mimeType: ${meta.codec}`);
        }

        this.onTrackMetadata && this.onTrackMetadata('audio', meta);
        this.audio_init_segment_dispatched_ = true;
        this.audio_init_segment_pending_ = false;

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
        this.applyPlaybackModeMediaInfo(mi);

        if (mi.isComplete()) {
            this.onMediaInfo && this.onMediaInfo(mi);
        }
    }

    private dispatchAudioMediaSegment(force: boolean = false): void {
        if (!this.audio_init_segment_dispatched_ || (!force && this.audio_track_.length === 0)) {
            return;
        }

        if (this.audio_track_.length > 0) {
            if (this.pending_audio_track_switch_ !== null) {
                this.audio_track_.mmtsAudioTrackSwitch = Object.assign({}, this.pending_audio_track_switch_);
            }
            if (this.onDataAvailable) {
                this.onDataAvailable(this.audio_track_, null, force);
                this.pending_audio_track_switch_ = null;
            }
        } else if (force) {
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

    private resetAudioTrack(): void {
        this.audio_track_ = {
            type: 'audio',
            id: 2,
            sequenceNumber: this.audio_track_.sequenceNumber,
            samples: [],
            length: 0
        };
    }

    private dispatchVideoInitSegment(referenceRecovery: boolean = false): void {
        // The HEVC parameter sets can arrive before the matching B60 timestamp
        // descriptor.  Wait for its exact clock instead of publishing a 1 kHz
        // init segment that permanently quantizes 60000/1001 presentation.
        if (!Number.isInteger(this.video_timestamp_timescale_) || this.video_timestamp_timescale_ <= 0) {
            return;
        }
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
        // MSE の HEVC デコーダーが SPS 内の VUI だけでは色特性を反映しない実装に備え、
        // ISO BMFF の colr/nclx box へ書き出す値を init segment metadata に引き継ぐ。
        meta.videoFullRangeFlag = details.video_full_range_flag;
        // ブラウザー内蔵の HLG tone mapping を回避できるか切り分けるため、demo から明示的に
        // 有効化した場合だけ SDR BT.709 の primaries / transfer を広告する。YUV から非線形 RGB への
        // 変換係数まで BT.709 に変えると元の BT.2020-NCL と一致しないため、matrix は放送値を保持する。
        const forceSDRColorimetry = this.config_.mmtsForceSDRColorimetry === true;
        meta.colourPrimaries = forceSDRColorimetry ? 1 : details.colour_primaries;
        meta.transferCharacteristics = forceSDRColorimetry ? 1 : details.transfer_characteristics;
        meta.matrixCoefficients = details.matrix_coeffs;
        if (forceSDRColorimetry) {
            Log.i(this.TAG, 'Force MMTS HEVC sample-entry colorimetry to SDR ' +
                `(primaries=${details.colour_primaries}->1, transfer=${details.transfer_characteristics}->1, ` +
                `matrix=${details.matrix_coeffs}).`);
        }
        meta.refSampleDuration = 1000 * (meta.frameRate.fps_den / meta.frameRate.fps_num);
        if (Number.isInteger(this.video_timestamp_timescale_) && this.video_timestamp_timescale_ > 0) {
            meta.mmtsMp4Timescale = this.video_timestamp_timescale_;
            meta.mmtsMp4RefSampleDuration = Math.round(
                this.video_timestamp_timescale_ * meta.frameRate.fps_den / meta.frameRate.fps_num
            );
        }
        meta.codec = details.codec_mimetype.replace(/^hvc1/, this.video_sample_entry_type_);
        if (referenceRecovery) {
            meta.mmtsVideoReferenceRecovery = true;
        }
        if (this.pending_video_track_switch_ !== null) {
            meta.mmtsVideoTrackSwitch = Object.assign({}, this.pending_video_track_switch_);
        }

        const vps = this.video_metadata_.vps.data.subarray(4);
        const sps = this.video_metadata_.sps.data.subarray(4);
        const pps = this.video_metadata_.pps.data.subarray(4);
        meta.hvcc = new HEVCDecoderConfigurationRecord(
            vps,
            sps,
            pps,
            details,
            this.video_sample_entry_type_ === 'hvc1'
        ).getData();

        this.onTrackMetadata && this.onTrackMetadata('video', meta);
        this.video_init_segment_dispatched_ = true;
        this.replayPreInitVideoUnits();

        const mi = this.media_info_;
        mi.hasVideo = true;
        // Do not publish a video-only MediaInfo while an announced AAC track
        // has not selected a primary stream yet.  The startup contract needs a
        // definitive answer: selected audio is required, no declared audio
        // means video-only, and every other state remains unresolved.
        mi.hasAudio = this.getSortedAudioTrackInfos().length === 0 ?
            false :
            (this.primary_audio_packet_id_ >= 0 ? true : null);
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
        this.applyPlaybackModeMediaInfo(mi);

        if (mi.isComplete()) {
            this.onMediaInfo && this.onMediaInfo(mi);
        }
    }

    private dispatchVideoMediaSegment(force: boolean = false): void {
        if (!this.video_init_segment_dispatched_ || this.video_track_.length === 0) {
            return;
        }

        if (this.pending_video_track_switch_ !== null) {
            (this.video_track_ as any).mmtsVideoTrackSwitch = Object.assign({}, this.pending_video_track_switch_);
        }
        this.onDataAvailable && this.onDataAvailable(null, this.video_track_, force);
        this.pending_video_track_switch_ = null;
        this.video_track_ = {
            type: 'video',
            id: 1,
            sequenceNumber: this.video_track_.sequenceNumber,
            samples: [],
            length: 0
        };
    }

}

export default MMTSDemuxer;

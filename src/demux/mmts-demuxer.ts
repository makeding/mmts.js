import BaseDemuxer from './base-demuxer';
import TLV from './tlv';
import CompressedIP from './compressed-ip';
import MMTP, {MMTPEncryptionFlag, MMTPPayloadType} from './mmtp';
import MMTSI, {MMTAsset, SignalingFragmentState} from './mmt-si';
import MPU, {FragmentationIndicator, MFUFragment, MPUFragmentType} from './mpu';
import {H265NaluHVC1, H265NaluPayload, H265NaluType, HEVCDecoderConfigurationRecord} from './h265';
import H265Parser from './h265-parser';
import MediaInfo from '../core/media-info';
import Log from '../utils/logger.js';

interface MFUFragmentState {
    data: number[];
    lastSeq: number;
    mpuSequenceNumber: number;
    state: 'init' | 'not-started' | 'in-fragment' | 'skip';
}

interface VideoAccessUnitState {
    sampleNumber: number;
    units: H265NaluHVC1[];
    length: number;
    keyframe: boolean;
}

interface PendingMFUUnit {
    fragment: MFUFragment;
    unit: Uint8Array;
}

class MMTSDemuxer extends BaseDemuxer {

    private readonly TAG: string = 'MMTSDemuxer';

    private config_: any;
    private stash_: Uint8Array = null;
    private parsed_packet_count_: number = 0;
    private parsed_mmtp_count_: number = 0;
    private last_summary_tlv_count_: number = 0;
    private tlv_packet_type_counts_: {[packetType: number]: number} = {};
    private mmtp_packet_id_counts_: {[packetId: number]: number} = {};
    private signaling_fragment_states_: {[packetId: number]: SignalingFragmentState} = {};
    private mfu_fragment_states_: {[packetId: number]: MFUFragmentState} = {};
    private assets_by_packet_id_: {[packetId: number]: MMTAsset} = {};
    private pending_mfu_units_by_packet_id_: {[packetId: number]: PendingMFUUnit[]} = {};
    private logged_asset_keys_: {[key: string]: boolean} = {};
    private logged_mpu_header_count_: number = 0;
    private logged_mfu_unit_count_: number = 0;
    private logged_video_nalu_count_: number = 0;
    private logged_video_sample_count_: number = 0;
    private logged_video_segment_count_: number = 0;
    private dropped_video_sample_count_: number = 0;
    private primary_video_packet_id_: number = -1;
    private media_info_ = new MediaInfo();
    private video_metadata_ = {
        vps: undefined,
        sps: undefined,
        pps: undefined,
        details: undefined
    };
    private video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    private video_init_segment_dispatched_: boolean = false;
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
        this.signaling_fragment_states_ = null;
        this.mfu_fragment_states_ = null;
        this.assets_by_packet_id_ = null;
        this.pending_mfu_units_by_packet_id_ = null;
        this.logged_asset_keys_ = null;
        this.media_info_ = null;
        this.video_metadata_ = null;
        this.video_track_ = null;
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
        let state = this.signaling_fragment_states_[mmtp.packetId];
        if (state === undefined) {
            state = MMTSI.createFragmentState();
            this.signaling_fragment_states_[mmtp.packetId] = state;
        }

        const result = MMTSI.parseSignalingPayload(
            mmtp.payload,
            mmtp.packetSequenceNumber,
            state
        );

        for (const asset of result.assets) {
            if (asset.packetId < 0) {
                continue;
            }

            this.assets_by_packet_id_[asset.packetId] = asset;
            if (asset.assetType === 'hev1' && this.primary_video_packet_id_ < 0) {
                this.primary_video_packet_id_ = asset.packetId;
                Log.v(this.TAG, `Selected primary MMTS video packet_id=${this.formatHex(asset.packetId, 4)}`);
            }
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
        const asset = this.assets_by_packet_id_[mmtp.packetId];
        const mpu = MPU.parse(mmtp.payload);
        if (mpu === null) {
            return;
        }

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

        for (const fragment of mpu.mfuFragments) {
            const completeUnit = this.assembleMfuFragment(
                mmtp.packetId,
                mmtp.packetSequenceNumber,
                mpu.mpuSequenceNumber,
                fragment
            );

            if (completeUnit !== null) {
                this.logCompleteMfuUnit(mmtp.packetId, asset, mpu.mpuSequenceNumber, fragment, completeUnit);
                this.processCompleteMfuUnit(mmtp.packetId, asset, fragment, completeUnit);
            }
        }
    }

    private assembleMfuFragment(packetId: number,
                                packetSequenceNumber: number,
                                mpuSequenceNumber: number,
                                fragment: MFUFragment): Uint8Array | null {
        let state = this.mfu_fragment_states_[packetId];
        if (state === undefined) {
            state = {
                data: [],
                lastSeq: 0,
                mpuSequenceNumber: 0,
                state: 'init'
            };
            this.mfu_fragment_states_[packetId] = state;
        }

        if (state.state === 'init') {
            state.state = 'skip';
        } else if (((state.lastSeq + 1) >>> 0) !== packetSequenceNumber) {
            state.data = [];
            state.state = 'skip';
        }
        state.lastSeq = packetSequenceNumber;

        if (state.mpuSequenceNumber !== 0 && state.mpuSequenceNumber !== mpuSequenceNumber && state.state === 'in-fragment') {
            state.data = [];
            state.state = 'skip';
        }
        state.mpuSequenceNumber = mpuSequenceNumber;

        switch (fragment.fragmentationIndicator) {
            case FragmentationIndicator.NotFragmented:
                state.data = [];
                state.state = 'not-started';
                return fragment.payload;
            case FragmentationIndicator.FirstFragment:
                if (state.state === 'in-fragment') {
                    state.data = [];
                    state.state = 'skip';
                    return null;
                }
                state.data = Array.prototype.slice.call(fragment.payload);
                state.state = 'in-fragment';
                return null;
            case FragmentationIndicator.MiddleFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                this.appendToState(state, fragment.payload);
                return null;
            case FragmentationIndicator.LastFragment:
                if (state.state !== 'in-fragment') {
                    return null;
                }
                this.appendToState(state, fragment.payload);
                const completeUnit = new Uint8Array(state.data);
                state.data = [];
                state.state = 'not-started';
                return completeUnit;
            default:
                return null;
        }
    }

    private appendToState(state: MFUFragmentState, data: Uint8Array): void {
        for (let i = 0; i < data.byteLength; i++) {
            state.data.push(data[i]);
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
                                   fragment: MFUFragment,
                                   unit: Uint8Array): void {
        if (asset === undefined) {
            this.cachePendingMfuUnit(packetId, fragment, unit);
            return;
        }

        if (asset.assetType !== 'hev1') {
            return;
        }

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
            this.cachePreInitVideoUnit(fragment, unit);
            return;
        }

        if (!this.video_init_segment_dispatched_ || !this.isH265VclNalu(naluType)) {
            if (this.video_init_segment_dispatched_ && fragment.sampleNumber !== undefined) {
                this.appendH265NaluToAccessUnit(fragment.sampleNumber, hvc1, false);
            }
            return;
        }

        const keyframe = this.isH265IrapNalu(naluType);

        if (fragment.sampleNumber === undefined) {
            this.appendStandaloneVideoSample([hvc1], hvc1.data.byteLength, keyframe);
            return;
        }

        this.appendH265NaluToAccessUnit(fragment.sampleNumber, hvc1, keyframe);
    }

    private appendH265NaluToAccessUnit(sampleNumber: number, nalu: H265NaluHVC1, keyframe: boolean): void {
        if (this.current_video_access_unit_ !== null && this.current_video_access_unit_.sampleNumber !== sampleNumber) {
            this.flushCurrentVideoAccessUnit();
        }

        if (this.current_video_access_unit_ === null) {
            this.current_video_access_unit_ = {
                sampleNumber,
                units: [],
                length: 0,
                keyframe: false
            };
        }

        this.current_video_access_unit_.units.push(nalu);
        this.current_video_access_unit_.length += nalu.data.byteLength;
        this.current_video_access_unit_.keyframe = this.current_video_access_unit_.keyframe || keyframe;
    }

    private flushCurrentVideoAccessUnit(): void {
        const accessUnit = this.current_video_access_unit_;
        this.current_video_access_unit_ = null;

        if (accessUnit === null || accessUnit.units.length === 0) {
            return;
        }

        this.appendStandaloneVideoSample(accessUnit.units, accessUnit.length, accessUnit.keyframe);
    }

    private appendStandaloneVideoSample(units: H265NaluHVC1[], length: number, keyframe: boolean): void {
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
            Log.v(this.TAG, `Start MMTS video at keyframe, units=${units.length}, length=${length}`);
        }

        const pts = Math.round(this.video_sample_index_ * 1000 / 60);
        const dts = pts;
        this.video_sample_index_++;

        this.video_track_.samples.push({
            units,
            length,
            isKeyframe: keyframe,
            dts,
            pts,
            cts: 0,
            file_position: 0
        });
        this.video_track_.length += length;

        if (this.logged_video_sample_count_ < 16) {
            this.logged_video_sample_count_++;
            Log.v(
                this.TAG,
                `Video sample #${this.video_sample_index_}, units=${units.length}, ` +
                `length=${length}, keyframe=${keyframe ? 1 : 0}, dts=${dts}`
            );
        }

        if (this.video_track_.samples.length >= 1) {
            this.dispatchVideoMediaSegment();
        }
    }

    private isH265VclNalu(naluType: number): boolean {
        return naluType >= 0 && naluType <= 31;
    }

    private isH265IrapNalu(naluType: number): boolean {
        return naluType >= 16 && naluType <= 23;
    }

    private cachePendingMfuUnit(packetId: number, fragment: MFUFragment, unit: Uint8Array): void {
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
            this.processCompleteMfuUnit(asset.packetId, asset, pendingUnit.fragment, pendingUnit.unit);
        }
    }

    private cachePreInitVideoUnit(fragment: MFUFragment, unit: Uint8Array): void {
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
            unit: unitCopy
        });
    }

    private replayPreInitVideoUnits(): void {
        if (this.pre_init_video_units_.length === 0 || this.primary_video_packet_id_ < 0) {
            return;
        }

        const pending = this.pre_init_video_units_;
        this.pre_init_video_units_ = [];
        const asset = this.assets_by_packet_id_[this.primary_video_packet_id_];
        if (asset === undefined) {
            return;
        }

        Log.v(this.TAG, `Replay ${pending.length} pre-init MMTS video NAL units`);
        for (const pendingUnit of pending) {
            this.processCompleteMfuUnit(asset.packetId, asset, pendingUnit.fragment, pendingUnit.unit);
        }
        this.flushCurrentVideoAccessUnit();
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
        mi.hasAudio = false;
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
                `Parsed TLV total=${this.parsed_packet_count_}, total_mmtp=${this.parsed_mmtp_count_}, streams=${Object.keys(this.assets_by_packet_id_).length}`
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

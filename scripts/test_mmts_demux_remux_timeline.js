#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');
const {recordAudioSwitchSelectionResult} = require('./probe_mmts_demux_remux_stream');

function loadModule(relativePath, requireMap) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = {
        require: (id) => {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) {
                return requireMap[id];
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

function loggerStub() {
    return {__esModule: true, default: {e() {}, v() {}, w() {}, i() {}, d() {}}};
}

const playbackOperationContract = loadModule('src/core/playback-operation.ts', {});

function createTestOperation(kind, transactionId, attempt, requestedTimeMilliseconds, packetId) {
    let operation = playbackOperationContract.createPlaybackOperation({
        scopeId: 'demux-remux-contract-test',
        timelineGeneration: transactionId,
        kind,
        transactionId,
        requestedTimeMilliseconds,
        packetId,
    });
    for (let index = 0; index < attempt; index++) {
        operation = playbackOperationContract.createNextPlaybackAttempt(operation);
    }
    return operation;
}

function createTestSwitchIdentity(kind, transactionId, attempt, packetId,
                                  requestedTimeMilliseconds = 0) {
    return playbackOperationContract.createPlaybackSwitchIdentity(
        createTestOperation(kind, transactionId, attempt, requestedTimeMilliseconds, packetId)
    );
}

function createTestAudioSwitchContext(transactionId, attempt, packetId, requestedStart) {
    return Object.assign(
        {
            packetId,
            requestedStart,
            requestedStartMicroseconds: Math.round(requestedStart * 1000000),
        },
        createTestSwitchIdentity(
            'audio-switch',
            transactionId,
            attempt,
            packetId,
            requestedStart * 1000
        )
    );
}

function createTestVideoSwitchContext(transactionId, attempt, packetId) {
    return Object.assign(
        {packetId},
        createTestSwitchIdentity('video-switch', transactionId, attempt, packetId)
    );
}

function testProbeRejectsStructuredAudioSelectionFailure() {
    const probe = {selectAccepted: true, selectionResult: null};
    const result = {
        accepted: false,
        changed: false,
        requestedPacketId: 0xffff,
        selectedPacketId: undefined,
        reason: 'unknown-track',
    };
    assert.strictEqual(recordAudioSwitchSelectionResult(probe, result), false);
    assert.strictEqual(probe.selectAccepted, false);
    assert.strictEqual(probe.selectionResult, result);
}

function loadDemuxer(options = {}) {
    class BaseDemuxer {}
    class MMTSAudioTimeline {
        clearPacket() {}
        destroy() {}
    }
    class MMTSSubtitleAssembler {}
    class MMTSAudioTrackList {}
    class HEVCPocRecovery {
        reset() {}
        rejectMpu() {}
        prepareMpu() { return null; }
        commit() { return true; }
        get waitingForRandomAccess() { return false; }
    }
    class AACLOASParser {
        constructor() {
            this.frames = options.aacFrames ? options.aacFrames.slice() : [];
        }
        readNextAACFrame() {
            return this.frames.shift() || null;
        }
        hasIncompleteData() {
            return false;
        }
        getIncompleteData() {
            return null;
        }
    }
    class AudioSpecificConfig {
        constructor(config) {
            this.sampling_rate = config.sampling_frequency;
            this.channel_count = config.channel_config;
            this.codec_mimetype = `mp4a.40.${config.audio_object_type}`;
            this.original_codec_mimetype = this.codec_mimetype;
            this.config = [config.audio_object_type, config.sampling_freq_index, config.channel_config];
        }
    }
    const H265NaluType = {
        kSliceTRAIL_N: 0,
        kSliceTRAIL_R: 1,
        kSliceRASL_N: 8,
        kSliceRASL_R: 9,
        kSliceIDR_W_RADL: 19,
        kSliceIDR_N_LP: 20,
        kSliceVPS: 32,
        kSliceSPS: 33,
        kSlicePPS: 34,
        kSliceCRA_NUT: 21,
        kSliceAUD: 35
    };
    const mpuStub = {
        readLengthPrefixedUnitLength(unit) {
            if (!unit || unit.byteLength < 4) {
                return undefined;
            }
            return (unit[0] << 24) | (unit[1] << 16) | (unit[2] << 8) | unit[3];
        }
    };
    const demuxerUtils = {
        createMMTSAudioTrackInfo() { return {}; },
        createMMTSSubtitleTrackInfo() { return {}; },
        createMMTSVideoTrackInfo() { return {}; },
        findMMTSPrimaryVideoTrack() { return undefined; },
        findMMTSSecondaryVideoTrack() { return undefined; },
        findPreferredAudioTrack() { return undefined; },
        findPreferredDeclaredAudioTrack() { return undefined; },
        formatAssetConditionalAccessInfo() { return ''; },
        formatH265NaluTypes() { return ''; },
        formatHex(value) { return `0x${value.toString(16)}`; },
        formatMmtpScramblingInfo() { return ''; },
        formatMsTimestamp(value) { return String(value); },
        formatPacketCounts() { return ''; },
        getSortedAudioTrackInfos(value) { return Array.isArray(value) ? value : Object.values(value || {}); },
        getSortedSubtitleTrackInfos(value) { return value; },
        getSortedVideoTrackInfos(value) { return value; },
        getMMTSSelectedVideoRole() { return undefined; },
        hasH265CraNalu(units) {
            return units.some((unit) => unit.type === H265NaluType.kSliceCRA_NUT);
        },
        hasH265IdrNalu(units) {
            return units.some((unit) => {
                return unit.type === H265NaluType.kSliceIDR_W_RADL ||
                    unit.type === H265NaluType.kSliceIDR_N_LP;
            });
        },
        hasH265PostCraTrailingVclNalu(units) {
            return units.some((unit) => {
                return unit.type >= 0 && unit.type <= 31 &&
                    unit.type !== H265NaluType.kSliceCRA_NUT &&
                    unit.type !== H265NaluType.kSliceRASL_N &&
                    unit.type !== H265NaluType.kSliceRASL_R;
            });
        },
        hasH265RaslNalu(units) {
            return units.some((unit) => {
                return unit.type === H265NaluType.kSliceRASL_N ||
                    unit.type === H265NaluType.kSliceRASL_R;
            });
        },
        hasKnownMMTSAudioSupport() { return true; },
        isH265IrapNalu() { return false; },
        isH265VclNalu(type) { return type >= 0 && type <= 31; },
        isMMTSAudioTrackSelectable(info) {
            return typeof options.audioTrackSelectable === 'function' ?
                options.audioTrackSelectable(info) : true;
        },
        isMMTSVideoFallback() { return false; },
        isSupportedAACChannelConfig() { return true; },
        payloadTypeName() { return ''; },
        readH265NaluType() { return 0; },
        scramblingName() { return ''; },
        toHex(value) { return String(value); },
        updateMMTSAudioTrackInfoFromFrame(packetId, frame, previous, selected) {
            return Object.assign({}, previous || {}, {
                packetId,
                selected,
                codec: 'aac-latm',
                audioSampleRate: frame.sampling_frequency,
                audioChannelCount: frame.channel_config
            });
        },
        videoResolutionLabel() { return ''; },
    };
    const videoMpuAssembler = loadModule('src/demux/mmts-video-mpu-assembler.ts', {
        './h265': {
            H265NaluType
        },
        './mpu': {__esModule: true, default: mpuStub},
        '../utils/mmts-demuxer-utils': demuxerUtils,
    });
    const h265SampleEntry = loadModule('src/demux/h265-sample-entry.ts', {
        './h265': {
            H265NaluType
        }
    });

    return loadModule('src/demux/mmts-demuxer.ts', {
        './base-demuxer': {__esModule: true, default: BaseDemuxer},
        './tlv': {__esModule: true, default: {}},
        './compressed-ip': {__esModule: true, default: {}},
        './mmtp': {__esModule: true, default: {}, MMTPPayloadType: {}},
        './mmt-si': {},
        './mpu': {__esModule: true, default: mpuStub, FragmentationIndicator: {}, MFUFragment: {}, MPUInfo: {}},
        './mmts-program': {__esModule: true, default: class MMTSProgram {}},
        './aac': {AACLOASParser, AudioSpecificConfig, LOASAACFrame: class {}},
        './mpeg4-audio': {MPEG4AudioObjectTypes: {}, MPEG4SamplingFrequencyIndex: {}},
        './h265': {
            H265NaluHVC1: class {},
            H265NaluPayload: class {},
            H265NaluType,
            HEVCDecoderConfigurationRecord: class {}
        },
        './h265-parser': {__esModule: true, default: {parseVPS() {}, parseSPS() {}, parsePPS() {}}},
        './hevc-poc': {__esModule: true, default: HEVCPocRecovery},
        './h265-sample-entry': h265SampleEntry,
        './mmts-video-mpu-assembler': videoMpuAssembler,
        '../core/media-info': {__esModule: true, default: class MediaInfo {}},
        '../utils/logger.js': loggerStub(),
        '../utils/logger': loggerStub(),
        '../utils/mmts-audio-timeline': {__esModule: true, default: MMTSAudioTimeline},
        '../utils/mmts-subtitle-assembler': {__esModule: true, default: MMTSSubtitleAssembler},
        '../utils/mmts-demuxer-utils': demuxerUtils,
        './mmts-track-data': {MMTSAudioTrackList},
        '../core/playback-operation': Object.assign(
            {__esModule: true},
            playbackOperationContract
        ),
    }).default;
}

function loadRemuxer() {
    class SampleInfo {
        constructor(dts, pts, duration, originalDts, isSyncPoint) {
            this.dts = dts;
            this.pts = pts;
            this.duration = duration;
            this.originalDts = originalDts;
            this.isSyncPoint = isSyncPoint;
        }
    }
    class MediaSegmentInfo {
        constructor() {
            this.syncPoints = [];
        }
        appendSyncPoint(syncPoint) {
            this.syncPoints.push(syncPoint);
        }
    }
    class MediaSegmentInfoList {
        constructor() {
            this.items = [];
        }
        isEmpty() { return this.items.length === 0; }
        append(info) { this.items.push(info); }
        getLastSampleBefore() { return null; }
        clear() { this.items = []; }
    }
    return loadModule('src/remux/mp4-remuxer.js', {
        '../utils/logger.js': loggerStub(),
        './mp4-generator.js': {
            __esModule: true,
            default: {
                types: {
                    mdat: new Uint8Array([0x6d, 0x64, 0x61, 0x74])
                },
                generateInitSegment() {
                    return new Uint8Array([0]);
                },
                moof() {
                    return new Uint8Array([0, 0, 0, 0]);
                }
            }
        },
        './aac-silent.js': {__esModule: true, default: {}},
        '../utils/browser.js': {__esModule: true, default: {safari: false}},
        '../core/media-segment-info.js': {
            SampleInfo,
            MediaSegmentInfo,
            MediaSegmentInfoList,
        },
        '../utils/exception.js': {IllegalStateException: class IllegalStateException extends Error {}},
    }).default;
}

function loadControllerWithDemuxer(MMTSDemuxer, browser = {safari: false}) {
    const emptyClass = class {};
    const playbackOperation = loadModule('src/core/playback-operation.ts', {});
    const startupGroupLifecycle = loadModule('src/core/mmts-startup-group-lifecycle.ts', {
        './playback-operation': Object.assign({__esModule: true}, playbackOperation),
    });
    return loadModule('src/core/transmuxing-controller.js', {
        '../utils/logger.js': loggerStub(),
        '../utils/browser.js': {__esModule: true, default: browser},
        './media-info.js': {__esModule: true, default: emptyClass},
        '../demux/flv-demuxer.js': {__esModule: true, default: emptyClass},
        '../demux/ts-demuxer': {__esModule: true, default: emptyClass},
        '../demux/mmts-demuxer': {__esModule: true, default: MMTSDemuxer},
        '../remux/mp4-remuxer.js': {__esModule: true, default: emptyClass},
        '../demux/demux-errors.js': {__esModule: true, default: {}},
        '../io/io-controller.js': {__esModule: true, default: emptyClass},
        './transmuxing-events': {
            __esModule: true,
            default: {
                INIT_SEGMENT: 'init_segment',
                MEDIA_SEGMENT: 'media_segment',
                MMTS_AUDIO_TRACKS: 'mmts_audio_tracks',
                MMTS_AUDIO_TRACK_SELECTION_RESULT: 'mmts_audio_track_selection_result',
            },
        },
        '../io/loader.js': {LoaderStatus: {}, LoaderErrors: {}},
        './playback-operation': Object.assign({__esModule: true}, playbackOperation),
        './mmts-startup-group-lifecycle': Object.assign(
            {__esModule: true},
            startupGroupLifecycle
        ),
    }).default;
}

function makeDemuxerHarness() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.config_ = {isLive: false};
    demuxer.primary_video_packet_id_ = 0x100;
    demuxer.last_video_dts_ = 5000;
    demuxer.last_video_pts_ = 5000;
    demuxer.last_video_duration_ = 17;
    demuxer.video_waiting_random_access_ = false;
    demuxer.video_recovery_gap_pending_ = false;
    demuxer.hevc_poc_recovery_ = {rejectMpu() {}, reset() {}};
    demuxer.rejected_video_mpus_ = {};
    demuxer.video_drop_leading_rasl_ = false;
    demuxer.pending_video_leading_rasl_drop_ = null;
    demuxer.video_random_access_safe_pending_ = false;
    demuxer.output_video_dts_compression_ = 0;
    demuxer.dropped_video_timestamp_keys_ = {};
    demuxer.logged_missing_video_timestamp_count_ = 0;
    demuxer.last_video_source_info_ = {
        packetId: 0x100,
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 100000,
        rawDts: 5000,
        rawPts: 5000,
        dts: 5000,
        pts: 5000,
    };
    return demuxer;
}

function makeAudioInitDemuxerHarness(aacFrame) {
    const MMTSDemuxer = loadDemuxer({aacFrames: [aacFrame]});
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.config_ = {isLive: false};
    demuxer.primary_audio_packet_id_ = 0x110;
    demuxer.audio_init_segment_dispatched_ = false;
    demuxer.audio_init_segment_pending_ = false;
    demuxer.audio_metadata_ = {};
    demuxer.audio_track_ = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};
    demuxer.audio_track_infos_by_packet_id_ = {};
    demuxer.audio_switch_cache_by_packet_id_ = {};
    demuxer.logged_unsupported_audio_packet_ids_ = {};
    demuxer.logged_audio_timestamp_gap_clamp_count_ = 0;
    demuxer.logged_stale_audio_timestamp_count_ = 0;
    demuxer.video_started_ = false;
    demuxer.pending_seek_media_time_ = undefined;
    demuxer.media_info_ = {
        isComplete() {
            return false;
        }
    };
    demuxer.keyframes_index_ = [];
    demuxer.last_media_info_duration_ = 0;
    demuxer.onTrackMetadataCalls = [];
    demuxer.onTrackMetadata = (type, metadata) => {
        demuxer.onTrackMetadataCalls.push({type, metadata});
    };
    return demuxer;
}

function makeAudioAppendDemuxerHarness(aacFrame) {
    const demuxer = makeAudioInitDemuxerHarness(aacFrame);
    demuxer.audio_init_segment_dispatched_ = true;
    demuxer.audio_init_segment_pending_ = false;
    demuxer.video_started_ = true;
    demuxer.audio_metadata_ = {
        codec: 'aac',
        audio_object_type: aacFrame.audio_object_type,
        sampling_freq_index: aacFrame.sampling_freq_index,
        sampling_frequency: aacFrame.sampling_frequency,
        channel_config: aacFrame.channel_config
    };
    return demuxer;
}

function makeTimedAccessUnit(demuxer, packetId, mpuSequenceNumber, sampleNumber, auIndex, filePosition) {
    return {
        packetId,
        mpuSequenceNumber,
        sampleNumber,
        auIndex,
        filePosition,
        units: [],
        length: 0,
        keyframe: false,
        descriptorTimestamp: demuxer.program_.getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex)
    };
}

function consumeVideoAccessUnitTimestamp(demuxer, packetId, mpuSequenceNumber, sampleNumber, auIndex, filePosition) {
    return demuxer.consumeVideoAccessUnitTimestamp(
        makeTimedAccessUnit(demuxer, packetId, mpuSequenceNumber, sampleNumber, auIndex, filePosition)
    );
}

function makeVideoSampleAppendHarness() {
    const demuxer = makeDemuxerHarness();
    demuxer.config_ = {isLive: false, mmtsClampVideoTimestampGap: false};
    demuxer.video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    demuxer.video_sample_entry_type_ = 'hvc1';
    demuxer.video_started_ = true;
    demuxer.video_waiting_random_access_ = false;
    demuxer.video_recovery_gap_pending_ = false;
    demuxer.video_drop_leading_rasl_ = false;
    demuxer.pending_video_leading_rasl_drop_ = null;
    demuxer.video_random_access_safe_pending_ = false;
    demuxer.video_sample_index_ = 1;
    demuxer.output_video_dts_base_ = 0;
    demuxer.output_video_raw_dts_base_ = 0;
    demuxer.output_video_dts_compression_ = 0;
    demuxer.logged_video_sample_count_ = 12;
    demuxer.logged_dropped_video_sample_count_ = 8;
    demuxer.updateVodMediaInfoIndex = () => {};
    demuxer.maybeSeedAudioAfterVideoBootstrap = () => {};
    demuxer.dispatchVideoMediaSegment = () => {};
    return demuxer;
}

function makeTimedOutputAccessUnit(packetId, mpuSequenceNumber, sampleNumber, auIndex, filePosition, timestamp) {
    return {
        packetId,
        mpuSequenceNumber,
        sampleNumber,
        auIndex,
        filePosition,
        units: [],
        length: 4,
        keyframe: false,
        descriptorTimestamp: {
            dts: timestamp,
            pts: timestamp,
            rawDts: timestamp,
            rawPts: timestamp,
            decodingIndex: auIndex,
            presentationIndex: auIndex,
            timescale: 1000
        }
    };
}

const TEST_H265_NALU_TYPE = {
    TRAIL_R: 1,
    RASL_R: 9,
    CRA_NUT: 21,
};

function makeReorderedVideoAccessUnit(naluType, dts, pts, sampleNumber, keyframe = false) {
    const data = new Uint8Array([sampleNumber, sampleNumber, sampleNumber, sampleNumber]);
    return {
        packetId: 0x100,
        mpuSequenceNumber: 10,
        sampleNumber,
        auIndex: sampleNumber - 1,
        filePosition: sampleNumber * 1000,
        units: [{type: naluType, data}],
        length: data.byteLength,
        keyframe,
        descriptorTimestamp: dts === null ? null : {
            dts,
            pts,
            rawDts: dts,
            rawPts: pts,
            decodingIndex: sampleNumber - 1,
            presentationIndex: sampleNumber - 1,
            timescale: 1000
        }
    };
}

function makeCraRaslAppendHarness() {
    const demuxer = makeVideoSampleAppendHarness();
    demuxer.last_video_dts_ = -1;
    demuxer.last_video_pts_ = -1;
    demuxer.last_video_duration_ = 17;
    demuxer.last_video_source_info_ = null;
    demuxer.video_started_ = false;
    demuxer.video_sample_index_ = 0;
    demuxer.output_video_dts_base_ = -1;
    demuxer.output_video_raw_dts_base_ = -1;
    demuxer.output_video_dts_compression_ = 0;
    demuxer.pending_video_leading_rasl_drop_ = null;
    demuxer.video_random_access_safe_pending_ = true;
    demuxer.pending_seek_media_time_ = undefined;
    demuxer.seek_preserved_video_timestamp_base_ = false;
    demuxer.pending_video_discontinuity_ = null;
    demuxer.dropped_video_sample_count_ = 0;
    demuxer.logged_missing_video_timestamp_count_ = 0;
    demuxer.logged_stale_video_timestamp_count_ = 0;
    demuxer.subtitle_assembler_ = {flush() {}};
    demuxer.vodIndexDts = [];
    demuxer.updateVodMediaInfoIndex = (dts, _filePosition, keyframe) => {
        if (keyframe) {
            demuxer.vodIndexDts.push(dts);
        }
    };
    return demuxer;
}

function appendCraLeadingRaslSequence(demuxer) {
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.CRA_NUT, 533, 700, 1, true)
    );
    [550, 567, 584, 600, 617, 634, 650].forEach((dts, index) => {
        demuxer.appendTimedVideoAccessUnit(
            makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.RASL_R, dts, dts, index + 2)
        );
    });
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 667, 834, 9)
    );
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 684, 767, 10)
    );
}

function appendContinuousCraLeadingRaslSequence(demuxer, sampleNumberBase = 1) {
    const accessUnits = [
        [TEST_H265_NALU_TYPE.CRA_NUT, 533, 817, true],
        [TEST_H265_NALU_TYPE.RASL_R, 550, 750, false],
        [TEST_H265_NALU_TYPE.RASL_R, 567, 717, false],
        [TEST_H265_NALU_TYPE.RASL_R, 584, 701, false],
        [TEST_H265_NALU_TYPE.RASL_R, 600, 734, false],
        [TEST_H265_NALU_TYPE.RASL_R, 617, 784, false],
        [TEST_H265_NALU_TYPE.RASL_R, 634, 768, false],
        [TEST_H265_NALU_TYPE.RASL_R, 650, 801, false],
        [TEST_H265_NALU_TYPE.TRAIL_R, 667, 951, false],
        [TEST_H265_NALU_TYPE.TRAIL_R, 684, 884, false],
    ];
    accessUnits.forEach(([type, dts, pts, keyframe], index) => {
        demuxer.appendTimedVideoAccessUnit(
            makeReorderedVideoAccessUnit(
                type,
                dts,
                pts,
                sampleNumberBase + index,
                keyframe
            )
        );
    });
}

function makeRemuxVideoTrack(samples, sequenceNumber = 0) {
    return {
        type: 'video',
        id: 1,
        sequenceNumber,
        samples,
        length: samples.reduce((length, sample) => length + sample.length, 0)
    };
}

function testDemuxerCompressesOnlyDroppedLeadingRaslDecodeTimeline() {
    const demuxer = makeCraRaslAppendHarness();
    appendCraLeadingRaslSequence(demuxer);

    assert.strictEqual(demuxer.dropped_video_sample_count_, 7);
    assert.strictEqual(demuxer.output_video_dts_compression_, 117);
    assert.strictEqual(demuxer.video_drop_leading_rasl_, false);
    assert.strictEqual(demuxer.last_video_dts_, 684);
    assert.deepStrictEqual(demuxer.vodIndexDts, [0]);
    assert.deepStrictEqual(
        demuxer.video_track_.samples.map((sample) => [sample.dts, sample.pts]),
        [[0, 167], [17, 301], [34, 234]]
    );
    assert.deepStrictEqual(
        demuxer.video_track_.samples.map((sample) => sample.cts),
        [167, 284, 200]
    );
    assert.strictEqual(demuxer.video_track_.samples[0].mmtsRandomAccessSafe, true);

    const MP4Remuxer = loadRemuxer();
    const remuxer = new MP4Remuxer({
        isLive: false,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    remuxer._videoMeta = {refSampleDuration: 17};
    remuxer._dtsBase = 0;
    remuxer._dtsBaseInited = true;
    const segments = [];
    remuxer.onMediaSegment = (_type, segment) => segments.push(segment);
    const startupSamples = demuxer.video_track_.samples.slice();
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples: startupSamples,
        length: startupSamples.reduce((length, sample) => length + sample.length, 0)
    }, true);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].info.firstSample.duration, 17);
    assert.strictEqual(segments[0].info.firstSample.dts, 0);
    assert.strictEqual(segments[0].info.firstSample.pts, 167);
    assert.strictEqual(segments[0].mmtsRandomAccessSafe, true);

    const audioTimelineSeeds = [];
    demuxer.maybeSeedAudioAfterVideoBootstrap = (timelineSeed) => audioTimelineSeeds.push(timelineSeed);
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.CRA_NUT, 701, 868, 11, true)
    );
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.RASL_R, 718, 801, 12)
    );
    assert.strictEqual(demuxer.output_video_dts_compression_, 117);
    assert.strictEqual(demuxer.dropped_video_sample_count_, 7);
    assert.strictEqual(demuxer.video_track_.samples.length, 5);
    assert.deepStrictEqual(
        demuxer.video_track_.samples.slice(-2).map((sample) => [sample.dts, sample.pts]),
        [[51, 335], [68, 268]]
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            demuxer.video_track_.samples[demuxer.video_track_.samples.length - 2],
            'mmtsRandomAccessSafe'
        ),
        false
    );
    assert.deepStrictEqual(audioTimelineSeeds, [168, 185]);
}

function testLiveDecoderBootstrapDropsOnlyRebuildLeadingRasl() {
    const continuousDemuxer = makeVideoSampleAppendHarness();
    continuousDemuxer.config_ = {isLive: true, mmtsClampVideoTimestampGap: false};
    continuousDemuxer.last_video_dts_ = 516;
    continuousDemuxer.last_video_pts_ = 683;
    continuousDemuxer.last_video_duration_ = 17;
    continuousDemuxer.last_video_source_info_ = null;
    continuousDemuxer.video_sample_index_ = 32;
    continuousDemuxer.dropped_video_sample_count_ = 0;
    appendContinuousCraLeadingRaslSequence(continuousDemuxer);

    assert.strictEqual(continuousDemuxer.dropped_video_sample_count_, 0);
    assert.deepStrictEqual(
        continuousDemuxer.video_track_.samples.map((sample) => sample.units[0].type),
        [
            TEST_H265_NALU_TYPE.CRA_NUT,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.RASL_R,
            TEST_H265_NALU_TYPE.TRAIL_R,
            TEST_H265_NALU_TYPE.TRAIL_R,
        ]
    );
    assert.strictEqual(
        continuousDemuxer.video_track_.samples.some((sample) =>
            sample.mmtsRandomAccessSafe === true
        ),
        false
    );

    const MP4Remuxer = loadRemuxer();
    const continuousRemuxer = new MP4Remuxer({
        isLive: true,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    continuousRemuxer._videoMeta = {refSampleDuration: 17};
    continuousRemuxer._dtsBase = 0;
    continuousRemuxer._dtsBaseInited = true;
    continuousRemuxer._videoStartupSegmentEmitted = true;
    const continuousSegments = [];
    continuousRemuxer.onMediaSegment = (_type, segment) => continuousSegments.push(segment);
    continuousRemuxer._remuxVideo(
        makeRemuxVideoTrack(continuousDemuxer.video_track_.samples.slice()),
        true
    );
    assert.strictEqual(continuousSegments.length, 1);
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(continuousSegments[0], 'mmtsRandomAccessSafe'),
        false
    );

    const rebuildDemuxer = makeVideoSampleAppendHarness();
    rebuildDemuxer.config_ = {isLive: true, mmtsClampVideoTimestampGap: false};
    rebuildDemuxer.primary_video_packet_id_ = 0x100;
    rebuildDemuxer.video_init_segment_dispatched_ = true;
    rebuildDemuxer.last_video_dts_ = 516;
    rebuildDemuxer.last_video_pts_ = 683;
    rebuildDemuxer.last_video_duration_ = 17;
    rebuildDemuxer.last_video_source_info_ = null;
    rebuildDemuxer.video_sample_index_ = 32;
    rebuildDemuxer.dropped_video_sample_count_ = 0;
    rebuildDemuxer.video_track_.samples.push({length: 4, dts: 517, pts: 684});
    rebuildDemuxer.video_track_.length = 4;
    let assemblerResetCount = 0;
    rebuildDemuxer.video_mpu_assembler_ = {
        reset() {
            assemblerResetCount++;
        }
    };

    assert.strictEqual(rebuildDemuxer.resetVideoForDecoderBootstrap(), true);
    assert.strictEqual(assemblerResetCount, 1);
    assert.strictEqual(rebuildDemuxer.video_track_.samples.length, 0);
    assert.strictEqual(rebuildDemuxer.video_waiting_random_access_, true);
    assert.strictEqual(rebuildDemuxer.audio_switch_video_bootstrap_pending_, true);
    assert.strictEqual(rebuildDemuxer.shouldHoldAudioUntilVideoRandomAccess(), false);
    assert.strictEqual(rebuildDemuxer.last_video_dts_, 516);
    assert.strictEqual(rebuildDemuxer.output_video_dts_base_, 0);

    rebuildDemuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.CRA_NUT, null, null, 1, true)
    );
    rebuildDemuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 517, 684, 2)
    );
    assert.strictEqual(rebuildDemuxer.video_waiting_random_access_, true);
    assert.strictEqual(rebuildDemuxer.video_track_.samples.length, 0);
    rebuildDemuxer.dropped_video_sample_count_ = 0;

    appendContinuousCraLeadingRaslSequence(rebuildDemuxer);
    assert.strictEqual(rebuildDemuxer.audio_switch_video_bootstrap_pending_, false);
    assert.strictEqual(rebuildDemuxer.dropped_video_sample_count_, 7);
    assert.strictEqual(rebuildDemuxer.output_video_dts_compression_, 117);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(rebuildDemuxer.video_track_.samples.map((sample) => [
            sample.units[0].type,
            sample.dts,
            sample.pts,
        ]))),
        [
            [TEST_H265_NALU_TYPE.CRA_NUT, 533, 817],
            [TEST_H265_NALU_TYPE.TRAIL_R, 550, 951],
            [TEST_H265_NALU_TYPE.TRAIL_R, 567, 884],
        ]
    );
    assert.strictEqual(rebuildDemuxer.video_track_.samples[0].mmtsRandomAccessSafe, true);
    assert.strictEqual(
        rebuildDemuxer.video_track_.samples.slice(1).some((sample) =>
            sample.mmtsRandomAccessSafe === true
        ),
        false
    );

    const rebuildRemuxer = new MP4Remuxer({
        isLive: true,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    rebuildRemuxer._videoMeta = {refSampleDuration: 17};
    rebuildRemuxer._dtsBase = 0;
    rebuildRemuxer._dtsBaseInited = true;
    rebuildRemuxer._videoStartupSegmentEmitted = true;
    rebuildRemuxer._videoStashedSamples = [{dts: 500, pts: 500}];
    rebuildRemuxer.resetVideoState();
    assert.strictEqual(rebuildRemuxer._videoStartupSegmentEmitted, false);
    assert.strictEqual(rebuildRemuxer._videoStashedSamples.length, 0);
    const rebuildSegments = [];
    rebuildRemuxer.onMediaSegment = (_type, segment) => rebuildSegments.push(segment);
    const rebuildSamples = rebuildDemuxer.video_track_.samples.slice();
    rebuildRemuxer._remuxVideo(makeRemuxVideoTrack(rebuildSamples), true);
    assert.strictEqual(rebuildSegments.length, 1);
    assert.strictEqual(rebuildSegments[0].mmtsRandomAccessSafe, true);
    assert.strictEqual(rebuildSegments[0].info.firstSample.isSyncPoint, true);

    rebuildDemuxer.video_track_.samples = [];
    rebuildDemuxer.video_track_.length = 0;
    rebuildDemuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 701, 985, 11)
    );
    rebuildDemuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 718, 918, 12)
    );
    const continuationSamples = rebuildDemuxer.video_track_.samples.slice();
    rebuildRemuxer._remuxVideo(makeRemuxVideoTrack(continuationSamples, 1), true);
    assert.strictEqual(rebuildSegments.length, 2);
    assert.strictEqual(
        rebuildSegments[1].info.beginDts,
        rebuildSegments[0].info.endDts
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(rebuildSegments[1], 'mmtsRandomAccessSafe'),
        false
    );
}

function testDemuxerDoesNotPartiallyCompressLeadingRaslWithoutFirstDescriptor() {
    const demuxer = makeCraRaslAppendHarness();
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.CRA_NUT, 533, 700, 1, true)
    );
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.RASL_R, null, null, 2)
    );
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.RASL_R, 567, 567, 3)
    );
    demuxer.appendTimedVideoAccessUnit(
        makeReorderedVideoAccessUnit(TEST_H265_NALU_TYPE.TRAIL_R, 667, 834, 4)
    );

    assert.strictEqual(demuxer.output_video_dts_compression_, 0);
    assert.strictEqual(demuxer.pending_video_leading_rasl_drop_, null);
    assert.deepStrictEqual(
        demuxer.video_track_.samples.map((sample) => [sample.dts, sample.pts]),
        [[0, 167], [134, 301]]
    );
}

function testDemuxerLeadingRaslCompressionResetSemantics() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = new MMTSDemuxer({syncOffset: 0}, {});
    demuxer.last_video_dts_ = 684;
    demuxer.last_video_pts_ = 767;
    demuxer.output_video_dts_base_ = 533;
    demuxer.output_video_raw_dts_base_ = 533;
    demuxer.output_video_dts_compression_ = 117;
    demuxer.video_drop_leading_rasl_ = true;
    demuxer.pending_video_leading_rasl_drop_ = {firstDroppedDts: 700};

    demuxer.resetVideoBootstrapState(true);
    assert.strictEqual(demuxer.output_video_dts_compression_, 117);
    assert.strictEqual(demuxer.output_video_dts_base_, 533);
    assert.strictEqual(demuxer.last_video_dts_, 684);
    assert.strictEqual(demuxer.video_drop_leading_rasl_, false);
    assert.strictEqual(demuxer.pending_video_leading_rasl_drop_, null);

    demuxer.video_drop_leading_rasl_ = true;
    demuxer.pending_video_leading_rasl_drop_ = {firstDroppedDts: 800};
    demuxer.resetVideoBootstrapState(false);
    assert.strictEqual(demuxer.output_video_dts_compression_, 0);
    assert.strictEqual(demuxer.output_video_dts_base_, -1);
    assert.strictEqual(demuxer.last_video_dts_, -1);
    assert.strictEqual(demuxer.video_drop_leading_rasl_, false);
    assert.strictEqual(demuxer.pending_video_leading_rasl_drop_, null);
}

function testDemuxerRecoveryGapUsesCompressedDecodeTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.config_ = {mmtsClampVideoTimestampGap: false};
    demuxer.video_recovery_gap_pending_ = true;
    demuxer.output_video_dts_base_ = 533;
    demuxer.output_video_dts_compression_ = 117;

    const recoveryGap = demuxer.takePendingVideoRecoveryGap(
        {dts: 1000, pts: 1000},
        350,
        684,
        17
    );

    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(recoveryGap)),
        {expectedDts: 51, recoveryDts: 350, duration: 299}
    );
    assert.strictEqual(demuxer.video_recovery_gap_pending_, false);
}

function testDemuxerAcceptsNormalDescriptorTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return {
                dts: 5017,
                pts: 5017,
                rawDts: 5017,
                rawPts: 5017,
                decodingIndex: 8,
                presentationIndex: 8,
                timescale: 1000,
            };
        }
    };

    const result = consumeVideoAccessUnitTimestamp(demuxer, 0x100, 10, 9, 8, 101000);
    assert.strictEqual(result.dts, 5017);
    assert.strictEqual(result.pts, 5017);
    assert.strictEqual(result.rawDts, 5017);
    assert.strictEqual(result.rawPts, 5017);
    assert.strictEqual(result.decodingIndex, 8);
    assert.strictEqual(result.presentationIndex, 8);
    assert.strictEqual(result.source, 'descriptor');
    assert.strictEqual(demuxer.last_video_dts_, 5017);
    assert.strictEqual(demuxer.last_video_source_info_.sampleNumber, 9);
    assert.strictEqual(demuxer.last_video_source_info_.decodingIndex, 8);
    assert.strictEqual(demuxer.last_video_source_info_.presentationIndex, 8);
}

function testDemuxerMapsSwitchedVideoToExistingRawTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.output_video_raw_dts_base_ = 92044;
    demuxer.last_video_dts_ = 9580;
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return {
                dts: 0,
                pts: 17,
                rawDts: 101641,
                rawPts: 101658,
                decodingIndex: 0,
                presentationIndex: 1,
                timescale: 1000,
            };
        }
    };

    const result = consumeVideoAccessUnitTimestamp(demuxer, 0x301, 20, 1, 0, 200000);
    assert.strictEqual(result.dts, 9597);
    assert.strictEqual(result.pts, 9614);
    assert.strictEqual(result.rawDts, 101641);
    assert.strictEqual(result.rawPts, 101658);
}

function testDemuxerValidatesSwitchedVideoMpuOnSharedRawTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.output_video_raw_dts_base_ = 92044;
    demuxer.last_video_dts_ = 9580;
    const makeTimestamp = (dts, pts, rawDts, rawPts) => ({
        dts,
        pts,
        rawDts,
        rawPts,
        decodingIndex: 0,
        presentationIndex: 0,
        timescale: 1000,
    });

    assert.strictEqual(demuxer.validateVideoMpuTimestamps([
        makeTimestamp(0, 0, 101641, 101641),
        makeTimestamp(17, 17, 101658, 101658),
    ]), true);
    assert.strictEqual(demuxer.validateVideoMpuTimestamps([
        makeTimestamp(0, 0, 101600, 101600),
        makeTimestamp(17, 17, 101617, 101617),
    ]), false);
}

function testDemuxerRejectsVideoWithoutDescriptorTimestamp() {
    const demuxer = makeDemuxerHarness();
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return null;
        }
    };

    const result = consumeVideoAccessUnitTimestamp(demuxer, 0x100, 10, 9, 8, 101000);
    assert.strictEqual(result, null);
    assert.strictEqual(demuxer.last_video_dts_, 5000);
    assert.strictEqual(demuxer.last_video_source_info_.sampleNumber, 8);
}

function testDemuxerRejectsStaleSourceWithoutAdvancingTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return {
                dts: 4900,
                pts: 4900,
                rawDts: 0,
                rawPts: 0,
                timescale: 1000,
            };
        }
    };

    const result = consumeVideoAccessUnitTimestamp(demuxer, 0x100, 9, 1, 0, 20000);
    assert.strictEqual(result, null);
    assert.strictEqual(demuxer.last_video_dts_, 5000);
    assert.strictEqual(demuxer.last_video_source_info_.mpuSequenceNumber, 10);
    assert.strictEqual(demuxer.video_waiting_random_access_, true);
    assert.strictEqual(demuxer.pending_video_leading_rasl_drop_, null);
}

function testDemuxerAllowsFileReorderWithoutRawDtsRollback() {
    const demuxer = makeDemuxerHarness();
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return {
                dts: 5017,
                pts: 5017,
                rawDts: 5017,
                rawPts: 5017,
                decodingIndex: 8,
                presentationIndex: 8,
                timescale: 1000
            };
        }
    };

    const result = consumeVideoAccessUnitTimestamp(demuxer, 0x100, 10, 9, 8, 90000);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result.dts, 5017);
    assert.strictEqual(demuxer.last_video_source_info_.filePosition, 90000);
}

function testDemuxerMarksOutputSampleAfterPacketDiscontinuity() {
    const demuxer = makeVideoSampleAppendHarness();
    demuxer.pending_video_discontinuity_ = {
        packetId: 0x100,
        mpuSequenceNumber: 11,
        reason: 'packet-sequence-gap',
        expectedSeq: 22,
        actualSeq: 24
    };

    demuxer.appendTimedVideoAccessUnit(
        makeTimedOutputAccessUnit(0x100, 11, 1, 0, 101000, 5017)
    );

    assert.strictEqual(demuxer.video_track_.samples.length, 1);
    const sample = demuxer.video_track_.samples[0];
    assert.strictEqual(sample.mmtsDiscontinuity.reason, 'packet-sequence-gap');
    assert.strictEqual(sample.mmtsDiscontinuity.expectedSeq, 22);
    assert.strictEqual(sample.mmtsDiscontinuity.actualSeq, 24);
    assert.strictEqual(sample.mmtsSourceInfo.discontinuity, sample.mmtsDiscontinuity);
    assert.strictEqual(demuxer.pending_video_discontinuity_, null);
}

function testDemuxerDoesNotConsumeDiscontinuityWhenDroppingVideoSample() {
    const demuxer = makeVideoSampleAppendHarness();
    demuxer.video_waiting_random_access_ = true;
    demuxer.pending_video_discontinuity_ = {
        packetId: 0x100,
        mpuSequenceNumber: 11,
        reason: 'packet-sequence-gap',
        expectedSeq: 22,
        actualSeq: 24
    };

    demuxer.appendTimedVideoAccessUnit(
        makeTimedOutputAccessUnit(0x100, 11, 1, 0, 101000, 5017)
    );

    assert.strictEqual(demuxer.video_track_.samples.length, 0);
    assert.notStrictEqual(demuxer.pending_video_discontinuity_, null);

    demuxer.video_waiting_random_access_ = false;
    demuxer.appendTimedVideoAccessUnit(
        makeTimedOutputAccessUnit(0x100, 11, 2, 1, 102000, 5034)
    );

    assert.strictEqual(demuxer.video_track_.samples.length, 1);
    assert.strictEqual(demuxer.video_track_.samples[0].mmtsDiscontinuity.reason, 'packet-sequence-gap');
    assert.strictEqual(demuxer.pending_video_discontinuity_, null);
}

function testParseMpuMarksNextOutputSampleAfterPacketSequenceGap() {
    const demuxer = makeVideoSampleAppendHarness();
    demuxer.pending_video_leading_rasl_drop_ = {firstDroppedDts: 5001};
    demuxer.video_init_segment_dispatched_ = true;
    demuxer.audio_init_segment_dispatched_ = true;
    demuxer.logged_video_discontinuity_count_ = 8;
    demuxer.logged_audio_discontinuity_count_ = 8;
    demuxer.video_mpu_assembler_ = {
        reconcileMpuDiscontinuity() {
            return {completed: [], dropped: null};
        },
        getNextAccessUnitIndex() {
            return 0;
        }
    };
    demuxer.program_ = {
        parseMpuPacket() {
            return {
                asset: {
                    packetId: 0x100,
                    assetType: 'hev1',
                    mediaType: 'video'
                },
                mpu: {
                    mpuSequenceNumber: 11,
                    mfuFragments: []
                },
                discontinuity: true,
                loss: {
                    packetSequenceGap: true,
                    fragmentedUnitDropped: false,
                    duplicatePacket: false,
                    expectedSeq: 22,
                    actualSeq: 24
                },
                units: []
            };
        },
        getTimestampAtAccessUnit() {
            return {
                dts: 5017,
                pts: 5017,
                rawDts: 5017,
                rawPts: 5017,
                decodingIndex: 0,
                presentationIndex: 0,
                timescale: 1000
            };
        },
        peekTimestampAtAccessUnit() {
            return {
                dts: 5017,
                pts: 5017,
                rawDts: 5017,
                rawPts: 5017,
                decodingIndex: 0,
                presentationIndex: 0,
                timescale: 1000
            };
        }
    };

    demuxer.parseMpu({packetId: 0x100}, 123456);
    assert.strictEqual(demuxer.pending_video_leading_rasl_drop_, null);
    assert.strictEqual(demuxer.pending_video_discontinuity_.reason, 'packet-sequence-gap');
    assert.strictEqual(demuxer.pending_video_discontinuity_.expectedSeq, 22);
    assert.strictEqual(demuxer.pending_video_discontinuity_.actualSeq, 24);

    demuxer.appendTimedVideoAccessUnit(
        makeTimedOutputAccessUnit(0x100, 11, 1, 0, 123456, 5017)
    );

    assert.strictEqual(demuxer.video_track_.samples.length, 1);
    const sample = demuxer.video_track_.samples[0];
    assert.strictEqual(sample.mmtsDiscontinuity.reason, 'packet-sequence-gap');
    assert.strictEqual(sample.mmtsDiscontinuity.expectedSeq, 22);
    assert.strictEqual(sample.mmtsDiscontinuity.actualSeq, 24);
    assert.strictEqual(sample.mmtsSourceInfo.decodingIndex, 0);
    assert.strictEqual(sample.mmtsSourceInfo.presentationIndex, 0);
    assert.strictEqual(sample.mmtsSourceInfo.discontinuity, sample.mmtsDiscontinuity);
    assert.strictEqual(demuxer.pending_video_discontinuity_, null);
}

function testRemuxerDoesNotFilterByMMTSSourceIdentity() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    assert.strictEqual(remuxer._filterStaleMMTSVideoSamples, undefined);

    const sourceInfo = remuxer._makeSegmentMMTSSourceInfo([
        {
            mmtsSourceInfo: {
                packetId: 0x100,
                mpuSequenceNumber: 10,
                sampleNumber: 9,
                filePosition: 101000,
                rawDts: 5017
            }
        },
        {
            mmtsSourceInfo: {
                packetId: 0x100,
                mpuSequenceNumber: 9,
                sampleNumber: 1,
                filePosition: 20000,
                rawDts: 0
            }
        }
    ]);

    assert.strictEqual(sourceInfo.firstSample.mpuSequenceNumber, 10);
    assert.strictEqual(sourceInfo.lastSample.mpuSequenceNumber, 9);
    assert.strictEqual(sourceInfo.lastSample.sampleNumber, 1);
}

function makeRemuxVideoSample(dts, pts, mpuSequenceNumber, sampleNumber, byte, discontinuity) {
    const sample = {
        dts,
        pts,
        cts: pts - dts,
        units: [{data: new Uint8Array([byte, byte, byte, byte])}],
        length: 4,
        isKeyframe: false,
        fileposition: byte,
        mmtsSourceInfo: {
            packetId: 0x100,
            mpuSequenceNumber,
            sampleNumber,
            filePosition: byte,
            rawDts: dts
        }
    };
    if (discontinuity) {
        sample.mmtsDiscontinuity = discontinuity;
        sample.mmtsSourceInfo.discontinuity = discontinuity;
    }
    return sample;
}

function testRemuxerPackagesMonotonicSamplesRegardlessOfMMTSSourceOrder() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = new MP4Remuxer({
        isLive: false,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    remuxer._videoMeta = {refSampleDuration: 17};
    remuxer._dtsBase = 0;
    remuxer._dtsBaseInited = true;

    const segments = [];
    remuxer.onMediaSegment = (type, segment) => {
        segments.push({type, segment});
    };

    const samples = [
        makeRemuxVideoSample(0, 0, 10, 9, 1),
        makeRemuxVideoSample(17, 17, 9, 1, 2)
    ];
    samples[0].isKeyframe = true;
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples,
        length: 8
    }, true);

    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].type, 'video');
    assert.strictEqual(segments[0].segment.sampleCount, 2);
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.firstSample.mpuSequenceNumber, 10);
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.lastSample.mpuSequenceNumber, 9);
    assert.strictEqual(segments[0].segment.info.beginDts, 0);
    assert.strictEqual(segments[0].segment.info.endDts, 34);
}

function testRemuxerDropsInitialVideoUntilRandomAccessPoint() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = new MP4Remuxer({
        isLive: false,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    remuxer._videoMeta = {refSampleDuration: 17};
    remuxer._dtsBase = 0;
    remuxer._dtsBaseInited = true;

    const segments = [];
    remuxer.onMediaSegment = (type, segment) => {
        segments.push({type, segment});
    };

    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples: [makeRemuxVideoSample(0, 0, 10, 1, 1)],
        length: 4
    }, true);
    assert.strictEqual(segments.length, 0);

    const rap = makeRemuxVideoSample(17, 17, 10, 2, 2);
    rap.isKeyframe = true;
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 1,
        samples: [rap, makeRemuxVideoSample(34, 34, 10, 3, 3)],
        length: 8
    }, true);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].segment.info.firstSample.isSyncPoint, true);
    assert.strictEqual(segments[0].segment.firstPlayableWindow.decodeStart, 0.017);
    assert.strictEqual(segments[0].segment.firstPlayableWindow.syncPoint, 0.017);

    const laterRap = makeRemuxVideoSample(51, 51, 11, 1, 3);
    laterRap.isKeyframe = true;
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 2,
        samples: [laterRap, makeRemuxVideoSample(68, 68, 11, 2, 4)],
        length: 8
    }, true);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[1].segment.firstPlayableWindow.decodeStart, 0.051);
    assert.strictEqual(segments[1].segment.firstPlayableWindow.syncPoint, 0.051);
}

function testRemuxerPreservesExplicitDiscontinuityThroughVideoRemux() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = new MP4Remuxer({
        isLive: false,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    remuxer._videoMeta = {refSampleDuration: 17};
    remuxer._dtsBase = 0;
    remuxer._dtsBaseInited = true;

    const discontinuity = {
        packetId: 0x100,
        mpuSequenceNumber: 11,
        reason: 'packet-sequence-gap',
        expectedSeq: 22,
        actualSeq: 24
    };
    const segments = [];
    remuxer.onMediaSegment = (type, segment) => {
        segments.push({type, segment});
    };

    const samples = [
        makeRemuxVideoSample(0, 0, 11, 1, 1, discontinuity),
        makeRemuxVideoSample(17, 17, 11, 2, 2)
    ];
    samples[0].isKeyframe = true;
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples,
        length: 8
    }, true);

    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].type, 'video');
    assert.strictEqual(segments[0].segment.sampleCount, 2);
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.firstSample.discontinuity.reason, 'packet-sequence-gap');
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.firstSample.discontinuity.expectedSeq, 22);
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.firstSample.discontinuity.actualSeq, 24);
    assert.strictEqual(segments[0].segment.mmtsSourceInfo.lastSample.discontinuity, undefined);
}

function testRemuxerPreservesMarkedVideoGapAcrossSegments() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = new MP4Remuxer({
        isLive: false,
        isMMTS: true,
        mmtsClampVideoTimestampGap: false,
        mmtsVideoTailStashDuration: 0
    });
    remuxer._videoMeta = {refSampleDuration: 17};
    remuxer._dtsBase = 0;
    remuxer._dtsBaseInited = true;

    const segments = [];
    remuxer.onMediaSegment = (_type, segment) => {
        segments.push(segment);
    };

    const first = makeRemuxVideoSample(0, 0, 20, 1, 1);
    first.isKeyframe = true;
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples: [first, makeRemuxVideoSample(17, 17, 20, 2, 2)],
        length: 8
    }, true);

    const recovered = makeRemuxVideoSample(500, 500, 21, 1, 3);
    recovered.mmtsVideoGapBefore = {
        expectedDts: 34,
        recoveryDts: 500,
        duration: 466
    };
    remuxer._remuxVideo({
        type: 'video',
        id: 1,
        sequenceNumber: 1,
        samples: [recovered, makeRemuxVideoSample(517, 517, 21, 2, 4)],
        length: 8
    }, true);

    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].info.endDts, 34);
    assert.strictEqual(segments[1].info.beginDts, 500);
}

function testRemuxerPreservesExplicitDiscontinuityMetadata() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    const sourceInfo = remuxer._makeSegmentMMTSSourceInfo([
        {
            mmtsSourceInfo: {
                packetId: 0x100,
                mpuSequenceNumber: 9,
                sampleNumber: 1,
                auIndex: 0,
                filePosition: 20000,
                rawDts: 0,
                discontinuity: {
                    packetId: 0x100,
                    mpuSequenceNumber: 9,
                    reason: 'packet-sequence-gap',
                    expectedSeq: 22,
                    actualSeq: 24
                }
            }
        },
        {
            mmtsSourceInfo: {
                packetId: 0x100,
                mpuSequenceNumber: 9,
                sampleNumber: 1,
                auIndex: 0,
                filePosition: 1000,
                rawDts: 0,
            }
        }
    ]);

    assert.strictEqual(sourceInfo.firstSample.discontinuity.reason, 'packet-sequence-gap');
    assert.strictEqual(sourceInfo.firstSample.discontinuity.expectedSeq, 22);
    assert.strictEqual(sourceInfo.lastSample.filePosition, 1000);
}

function testRemuxerClearsVideoStateOnSeek() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    remuxer._audioStashedLastSample = {};
    remuxer._videoStashedSamples = [{dts: 5000}];
    remuxer._videoLastCompositionEnd = 5017;
    remuxer._videoSegmentInfoList = {clear() { this.cleared = true; }};
    remuxer._audioSegmentInfoList = {clear() { this.cleared = true; }};
    remuxer._loggedAudioFrameDropCount = 2;
    remuxer._pendingMMTSVideoTrackSwitch = {id: 3, packetId: 0xf201};

    remuxer.seek(5000);
    assert.strictEqual(remuxer._videoStashedSamples.length, 0);
    assert.strictEqual(remuxer._videoSegmentInfoList.cleared, true);
    assert.strictEqual(remuxer._audioSegmentInfoList.cleared, true);
    assert.strictEqual(remuxer._pendingMMTSVideoTrackSwitch, null);
}

function testRemuxerExportsAudioTrackSwitchOnRemuxedTimeline() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    const context = createTestAudioSwitchContext(7, 0, 0xf111, 8.5);
    const audioSwitch = remuxer._makeMMTSAudioTrackSwitch(context, {
        beginDts: 9580,
        beginPts: 9580,
        endPts: 12000,
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(audioSwitch)), Object.assign({}, context, {
        audioDecodeStart: 9.58,
        audioStart: 9.58,
        audioEnd: 12,
    }));
}

function testRemuxerExportsVideoTrackSwitchOnRemuxedTimeline() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    const context = createTestVideoSwitchContext(9, 2, 0xf201);
    const videoSwitch = remuxer._makeMMTSVideoTrackSwitch(context, [
        {dts: 12000, pts: 12000, duration: 17, isKeyframe: true},
        {dts: 12017, pts: 12017, duration: 17, isKeyframe: false},
    ]);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(videoSwitch)), Object.assign({}, context, {
        videoDecodeStart: 12,
        videoCompositionStart: 12,
        syncPoint: 12,
        playableStart: 12,
        playableEnd: 12.034,
    }));
}

function testRemuxerCarriesVideoSwitchContextToInitSegment() {
    const MP4Remuxer = loadRemuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    let output = null;
    remuxer._onInitSegment = (_type, initSegment) => {
        output = initSegment;
    };

    remuxer._onTrackMetadataReceived('video', {
        codec: 'hvc1.2.1.L183.B0',
        duration: 0,
        mmtsVideoTrackSwitch: createTestVideoSwitchContext(9, 2, 0xf201),
    });

    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(output.mmtsVideoTrackSwitch)),
        createTestVideoSwitchContext(9, 2, 0xf201)
    );
}

function testDemuxerDispatchesPrimaryAudioInitBeforeVideoSamples() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 6,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const demuxer = makeAudioInitDemuxerHarness(frame);
    const state = {
        metadata: {},
        lastIncompleteData: null,
        previousFrame: null
    };

    demuxer.parseMMTSLOASAACPayload(0x110, new Uint8Array([0xaa]), undefined, false, state);

    assert.strictEqual(demuxer.audio_init_segment_dispatched_, true);
    assert.strictEqual(demuxer.audio_track_.samples.length, 0);
    assert.strictEqual(demuxer.onTrackMetadataCalls.length, 1);
    assert.strictEqual(demuxer.onTrackMetadataCalls[0].type, 'audio');
    assert.strictEqual(demuxer.onTrackMetadataCalls[0].metadata.codec, 'mp4a.40.2');
}

function testDemuxerDoesNotAppendPrimaryAudioAtZeroWithoutTimestampSeed() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 6,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const demuxer = makeAudioAppendDemuxerHarness(frame);
    const state = {
        metadata: demuxer.audio_metadata_,
        lastIncompleteData: null,
        previousFrame: null,
        lastSamplePts: undefined
    };

    demuxer.parseMMTSLOASAACPayload(0x110, new Uint8Array([0xaa]), undefined, true, state);

    assert.strictEqual(demuxer.audio_track_.samples.length, 0);
    assert.strictEqual(state.lastSamplePts, undefined);
}

function testDemuxerDoesNotAppendPrimaryAudioWithoutMfuTimestampFromPreviousSample() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 6,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const demuxer = makeAudioAppendDemuxerHarness(frame);
    const state = {
        metadata: demuxer.audio_metadata_,
        lastIncompleteData: null,
        previousFrame: null,
        lastSamplePts: 1000
    };

    demuxer.parseMMTSLOASAACPayload(0x110, new Uint8Array([0xaa]), undefined, true, state);

    assert.strictEqual(demuxer.audio_track_.samples.length, 0);
    assert.strictEqual(state.lastSamplePts, 1000);
}

function testDemuxerConsumesAudioTimestampBySampleNumber() {
    const demuxer = makeDemuxerHarness();
    demuxer.output_video_raw_dts_base_ = -1;
    demuxer.logged_missing_audio_timestamp_count_ = 0;
    let requested = null;
    demuxer.program_ = {
        getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex) {
            requested = {packetId, mpuSequenceNumber, auIndex};
            return {
                dts: 2048,
                pts: 2048,
                rawDts: 96000,
                rawPts: 96000,
                decodingIndex: auIndex,
                presentationIndex: auIndex,
                timescale: 48000
            };
        }
    };

    const state = {nextAccessUnitIndex: 0};
    const pts = demuxer.consumeAudioTimestamp(0x110, 30, 3, state);
    assert.deepStrictEqual(requested, {packetId: 0x110, mpuSequenceNumber: 30, auIndex: 2});
    assert.strictEqual(pts, 42);
    assert.strictEqual(state.nextAccessUnitIndex, 3);
}

function testDemuxerMapsSwitchedAudioToExistingVideoTimeline() {
    const demuxer = makeDemuxerHarness();
    demuxer.output_video_raw_dts_base_ = 92044;
    demuxer.logged_missing_audio_timestamp_count_ = 0;
    demuxer.program_ = {
        getTimestampAtAccessUnit() {
            return {
                dts: 101624,
                pts: 101624,
                rawDts: 101624,
                rawPts: 101624,
                decodingIndex: 0,
                presentationIndex: 0,
                timescale: 1000,
            };
        }
    };

    const pts = demuxer.consumeAudioTimestamp(0xf111, 30, 1, {nextAccessUnitIndex: 0});
    assert.strictEqual(pts, 9580);
}

function testDemuxerAllocatesAudioTimestampByMpuOrderWithoutSampleNumber() {
    const demuxer = makeDemuxerHarness();
    demuxer.output_video_raw_dts_base_ = -1;
    demuxer.logged_missing_audio_timestamp_count_ = 0;
    const requested = [];
    demuxer.program_ = {
        getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex) {
            requested.push({packetId, mpuSequenceNumber, auIndex});
            return {
                dts: auIndex * 1024,
                pts: auIndex * 1024,
                rawDts: auIndex * 1024,
                rawPts: auIndex * 1024,
                decodingIndex: auIndex,
                presentationIndex: auIndex,
                timescale: 48000
            };
        }
    };
    const state = {nextAccessUnitIndex: 0};

    const first = demuxer.consumeAudioTimestamp(0x110, 30, undefined, state);
    const second = demuxer.consumeAudioTimestamp(0x110, 30, undefined, state);
    assert.deepStrictEqual(requested, [
        {packetId: 0x110, mpuSequenceNumber: 30, auIndex: 0},
        {packetId: 0x110, mpuSequenceNumber: 30, auIndex: 1}
    ]);
    assert.strictEqual(first, 0);
    assert.strictEqual(second, 21);
}

function testDemuxerCarriesAudioSwitchContextToFirstAudioTrack() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const demuxer = makeAudioAppendDemuxerHarness(frame);
    demuxer.pending_audio_track_switch_ = {
        id: 7,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 8.5,
    };
    demuxer.audio_track_.samples.push({
        unit: new Uint8Array([1, 2, 3, 4]),
        length: 4,
        dts: 9580,
        pts: 9580,
    });
    demuxer.audio_track_.length = 4;

    let outputTrack = null;
    demuxer.onDataAvailable = (audioTrack) => {
        outputTrack = audioTrack;
    };
    demuxer.dispatchAudioMediaSegment();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(outputTrack.mmtsAudioTrackSwitch)), {
        id: 7,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 8.5,
    });
    assert.strictEqual(demuxer.pending_audio_track_switch_, null);
}

function testDemuxerCarriesVideoSwitchContextToFirstVideoTrack() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.video_init_segment_dispatched_ = true;
    demuxer.video_track_ = {
        type: 'video',
        id: 1,
        sequenceNumber: 0,
        samples: [{length: 4}],
        length: 4,
    };
    demuxer.pending_video_track_switch_ = {
        id: 9,
        attempt: 2,
        packetId: 0xf201,
    };

    let outputTrack = null;
    demuxer.onDataAvailable = (_audioTrack, videoTrack) => {
        outputTrack = videoTrack;
    };
    demuxer.dispatchVideoMediaSegment();

    assert.deepStrictEqual(JSON.parse(JSON.stringify(outputTrack.mmtsVideoTrackSwitch)), {
        id: 9,
        attempt: 2,
        packetId: 0xf201,
    });
    assert.strictEqual(demuxer.pending_video_track_switch_, null);
}

function testDemuxerVideoTrackSelectionAcknowledgesTransactionIdentity() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    let boundaryCount = 0;
    let flushCount = 0;
    let mediaDispatchCount = 0;
    let resetCount = 0;
    let tracksDispatchCount = 0;
    demuxer.config_ = {};
    demuxer.primary_video_packet_id_ = 0x100;
    demuxer.primary_audio_packet_id_ = -1;
    demuxer.next_video_track_switch_id_ = 4;
    demuxer.video_track_infos_by_packet_id_ = {
        0x100: {packetId: 0x100},
        0x101: {packetId: 0x101},
    };
    demuxer.program_ = {
        getAsset() { return undefined; },
        resetMpuPacketState() {},
    };
    demuxer.video_started_ = false;
    demuxer.audio_init_segment_dispatched_ = false;
    demuxer.flushCurrentVideoAccessUnit = () => { flushCount++; };
    demuxer.dispatchVideoMediaSegment = () => { mediaDispatchCount++; };
    demuxer.onVideoDiscontinuity = () => { boundaryCount++; };
    demuxer.resetVideoBootstrapState = () => {
        resetCount++;
        demuxer.pending_video_track_switch_ = null;
    };
    demuxer.dispatchVideoTracksIfChanged = () => { tracksDispatchCount++; };

    const selectedIdentity = createTestSwitchIdentity('video-switch', 22, 3, 0x101);
    const selected = demuxer.selectVideoTrack(0x101, selectedIdentity);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(selected)), Object.assign({
        accepted: true,
        changed: true,
        requestedPacketId: 0x101,
        selectedPacketId: 0x101,
        reason: 'selected',
    }, selectedIdentity));
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(demuxer.pending_video_track_switch_)),
        Object.assign({packetId: 0x101}, selectedIdentity)
    );
    assert.strictEqual(boundaryCount, 1);
    assert.strictEqual(flushCount, 1);
    assert.strictEqual(mediaDispatchCount, 1);
    assert.strictEqual(resetCount, 1);
    assert.strictEqual(tracksDispatchCount, 1);
    assert.strictEqual(demuxer.next_video_track_switch_id_, 22);
    const pendingContext = demuxer.pending_video_track_switch_;

    const alreadySelected = demuxer.selectVideoTrack(0x101);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(alreadySelected)), {
        accepted: true,
        changed: false,
        requestedPacketId: 0x101,
        selectedPacketId: 0x101,
        reason: 'already-selected',
    });
    assert.strictEqual(boundaryCount, 1);
    assert.strictEqual(demuxer.pending_video_track_switch_, pendingContext);

    const sameTrackIdentity = createTestSwitchIdentity('video-switch', 23, 4, 0x101);
    const transactionalSameTrack = demuxer.selectVideoTrack(0x101, sameTrackIdentity);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(transactionalSameTrack)), Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0x101,
        selectedPacketId: 0x101,
        reason: 'already-selected',
    }, sameTrackIdentity));
    assert.notStrictEqual(demuxer.pending_video_track_switch_, pendingContext);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(demuxer.pending_video_track_switch_)),
        Object.assign({packetId: 0x101}, sameTrackIdentity)
    );
    assert.strictEqual(demuxer.next_video_track_switch_id_, 23);
    assert.strictEqual(boundaryCount, 2);
    assert.strictEqual(flushCount, 2);
    assert.strictEqual(mediaDispatchCount, 2);
    assert.strictEqual(resetCount, 2);
    assert.strictEqual(tracksDispatchCount, 2);
    const transactionalPendingContext = demuxer.pending_video_track_switch_;

    const unknownIdentity = createTestSwitchIdentity('video-switch', 24, 0, 0x999);
    const unknown = demuxer.selectVideoTrack(0x999, unknownIdentity);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(unknown)), Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: 0x999,
        reason: 'unknown-track',
    }, unknownIdentity));
    const invalidIdentity = demuxer.selectVideoTrack(0x100, {id: -1, attempt: 0});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(invalidIdentity)), {
        accepted: false,
        changed: false,
        requestedPacketId: 0x100,
        reason: 'invalid-identity',
        id: -1,
        attempt: 0,
    });
    assert.strictEqual(demuxer.pending_video_track_switch_, transactionalPendingContext);
    assert.strictEqual(demuxer.next_video_track_switch_id_, 23);
    assert.strictEqual(boundaryCount, 2);
    assert.strictEqual(flushCount, 2);
    assert.strictEqual(mediaDispatchCount, 2);
    assert.strictEqual(resetCount, 2);
    assert.strictEqual(tracksDispatchCount, 2);
}

function testDemuxerAudioTrackSelectionAcknowledgesTransactionIdentity() {
    const makeSelectionHarness = (options = {}) => {
        const MMTSDemuxer = loadDemuxer(options);
        const demuxer = Object.create(MMTSDemuxer.prototype);
        demuxer.audio_track_infos_by_packet_id_ = {
            0xf110: {packetId: 0xf110},
            0xf111: {packetId: 0xf111},
        };
        demuxer.primary_audio_packet_id_ = 0xf110;
        demuxer.manually_selected_audio_packet_id_ = -1;
        demuxer.next_audio_track_switch_id_ = 4;
        demuxer.logged_unsupported_audio_packet_ids_ = {};
        demuxer.getCachedAudioSwitchSamples = () => [];
        demuxer.resetAudioTrack = () => {};
        demuxer.audio_timeline_ = {clearPacket() {}, destroy() {}};
        demuxer.seedAudioParseState = () => {};
        demuxer.dispatchAudioTracksIfChanged = () => {};
        return {MMTSDemuxer, demuxer};
    };

    const {MMTSDemuxer, demuxer} = makeSelectionHarness();
    const selectedIdentity = createTestSwitchIdentity('audio-switch', 50, 0, 0xf111, 8500);
    const selected = demuxer.selectAudioTrack(
        0xf111, 8500, undefined, false, selectedIdentity
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(selected)), Object.assign({
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }, selectedIdentity));

    const sameTrackIdentity = createTestSwitchIdentity('audio-switch', 51, 1, 0xf111, 8600);
    const alreadySelected = demuxer.selectAudioTrack(
        0xf111, 8600, undefined, false, sameTrackIdentity
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(alreadySelected)), Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    }, sameTrackIdentity));

    const unknownIdentity = createTestSwitchIdentity('audio-switch', 52, 0, 0xffff, 8600);
    const unknown = demuxer.selectAudioTrack(
        0xffff, 8600, undefined, false, unknownIdentity
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(unknown)), Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: 0xffff,
        reason: 'unknown-track',
    }, unknownIdentity));
    const invalidTimelineIdentity = createTestSwitchIdentity(
        'audio-switch', 53, 2, 0xf110, 8600
    );
    const invalidTimeline = demuxer.selectAudioTrack(
        0xf110, NaN, undefined, false, invalidTimelineIdentity
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(invalidTimeline)), Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: 0xf110,
        reason: 'invalid-timeline',
    }, invalidTimelineIdentity));
    const invalidIdentity = demuxer.selectAudioTrack(0xf110, 8600, undefined, false, {
        id: -1,
        attempt: 0,
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(invalidIdentity)), {
        accepted: false,
        changed: false,
        requestedPacketId: 0xf110,
        reason: 'invalid-timeline',
        id: -1,
        attempt: 0,
    });
    const legacyUnknown = demuxer.selectAudioTrack(0xffff, 8600);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyUnknown, 'transactionId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyUnknown, 'attempt'), false);

    const unsupportedHarness = makeSelectionHarness({
        audioTrackSelectable() { return false; },
    });
    const unsupported = unsupportedHarness.demuxer.selectAudioTrack(
        0xf111,
        8600,
        undefined,
        false,
        createTestSwitchIdentity('audio-switch', 54, 0, 0xf111, 8600)
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(unsupported)), Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: 0xf111,
        reason: 'unsupported-track',
    }, createTestSwitchIdentity('audio-switch', 54, 0, 0xf111, 8600)));

    demuxer.findPreferredAudioTrack = () => undefined;
    const missingPrimary = demuxer.selectPrimaryAudioTrack(
        8600,
        undefined,
        false,
        createTestSwitchIdentity('audio-switch', 55, 0, 0xf110, 8600)
    );
    assert.strictEqual(missingPrimary.reason, 'unknown-track');
    assert.strictEqual(missingPrimary.transactionId, 55);
    assert.strictEqual(missingPrimary.attempt, 0);
    demuxer.getSortedAudioTrackInfos = () => [];
    const missingSecondary = demuxer.selectSecondaryAudioTrack(
        8600,
        undefined,
        false,
        createTestSwitchIdentity('audio-switch', 56, 1, 0xf111, 8600)
    );
    assert.strictEqual(missingSecondary.reason, 'unknown-track');
    assert.strictEqual(missingSecondary.transactionId, 56);
    assert.strictEqual(missingSecondary.attempt, 1);

    const Controller = loadControllerWithDemuxer(MMTSDemuxer);
    const controller = new Controller({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const controllerDemuxer = Object.create(MMTSDemuxer.prototype);
    controllerDemuxer.audio_track_infos_by_packet_id_ = {};
    controllerDemuxer.pending_audio_track_switch_ = {
        id: 1,
        attempt: 0,
        packetId: 0xf110,
        requestedStart: 1,
    };
    controller._demuxer = controllerDemuxer;
    controller._remuxer = {resetAudioState() {}};
    const initialOperation = createTestOperation('audio-switch', 90, 0, 8600, 0xffff);
    const retryOperation = playbackOperationContract.createNextPlaybackAttempt(initialOperation);
    const operation = playbackOperationContract.createNextPlaybackAttempt(
        retryOperation,
        {phase: 'selecting'}
    );
    const acknowledgements = [];
    controller.on('mmts_audio_track_selection_result', (result, sourceOperation) => {
        acknowledgements.push({result, sourceOperation});
    });
    controller.setPlaybackOperation(initialOperation);
    controller.setPlaybackOperation(retryOperation);
    controller.setPlaybackOperation(operation);
    const rejected = controller.selectAudioTrack(
        0xffff,
        8600,
        true,
        playbackOperationContract.createPlaybackSwitchIdentity(operation)
    );
    assert.strictEqual(rejected.accepted, false);
    assert.strictEqual(rejected.reason, 'unknown-track');
    assert.strictEqual(rejected.transactionId, 90);
    assert.strictEqual(rejected.attempt, 2);
    assert.strictEqual(acknowledgements.length, 1);
    assert.strictEqual(acknowledgements[0].result, rejected);
    assert.strictEqual(acknowledgements[0].sourceOperation.transactionId, 90);
    assert.strictEqual(acknowledgements[0].sourceOperation.attempt, 2);
    assert.strictEqual(controller._pendingMMTSVodAudioSwitchIntent, null);
    assert.strictEqual(controllerDemuxer.pending_audio_track_switch_.id, 1);
}

function testControllerEmitsAudioSelectionAckBeforeSynchronousOutputs() {
    const MMTSDemuxer = loadDemuxer();
    const Controller = loadControllerWithDemuxer(MMTSDemuxer);
    const cases = [
        {
            controllerMethod: 'selectAudioTrack',
            demuxerMethod: 'selectAudioTrack',
            transactionId: 100,
            packetId: 0xf111,
            argsPrefix: [0xf111, 8600, false],
            resultBase: {
                accepted: true,
                changed: true,
                requestedPacketId: 0xf111,
                selectedPacketId: 0xf111,
                reason: 'selected',
            },
        },
        {
            controllerMethod: 'selectPrimaryAudioTrack',
            demuxerMethod: 'selectPrimaryAudioTrack',
            transactionId: 101,
            packetId: 0xf110,
            argsPrefix: [8600, false],
            resultBase: {
                accepted: true,
                changed: true,
                requestedPacketId: 0xf110,
                selectedPacketId: 0xf110,
                reason: 'selected',
            },
        },
        {
            controllerMethod: 'selectSecondaryAudioTrack',
            demuxerMethod: 'selectSecondaryAudioTrack',
            transactionId: 102,
            packetId: 0xf112,
            argsPrefix: [8600, false],
            resultBase: {
                accepted: false,
                changed: false,
                requestedPacketId: 0xf112,
                reason: 'unknown-track',
            },
        },
    ];

    cases.forEach((testCase) => {
        const controller = new Controller({
            segments: [{duration: 1000}],
            duration: 1000,
        }, {isMMTS: true});
        const operation = createTestOperation(
            'audio-switch', testCase.transactionId, 0, 8600, testCase.packetId
        );
        const identity = playbackOperationContract.createPlaybackSwitchIdentity(operation);
        const result = Object.assign({}, testCase.resultBase, identity);
        const laterOperation = createTestOperation(
            'audio-switch', testCase.transactionId + 1000, 0, 8600, testCase.packetId
        );
        const demuxer = Object.create(MMTSDemuxer.prototype);
        const observations = [];
        controller._demuxer = demuxer;
        controller._remuxer = {resetAudioState() {}};
        controller.on('mmts_audio_track_selection_result', (result, sourceOperation) => {
            observations.push({type: 'ack', result, operation: sourceOperation});
        });
        controller.on('mmts_audio_tracks', (tracks, sourceOperation) => {
            observations.push({type: 'tracks', tracks, operation: sourceOperation});
        });
        controller.on('init_segment', (type, segment, sourceOperation) => {
            observations.push({type: 'init', mediaType: type, segment, operation: sourceOperation});
        });
        controller.on('media_segment', (type, segment, sourceOperation) => {
            observations.push({type: 'media', mediaType: type, segment, operation: sourceOperation});
        });
        controller.setPlaybackOperation(operation);
        demuxer[testCase.demuxerMethod] = () => {
            controller._onMMTSAudioTracks({selectedPacketId: 0xf111});
            controller._onRemuxerInitSegmentArrival('audio', {
                type: 'audio-init',
                mmtsAudioTrackSwitch: {
                    ...createTestAudioSwitchContext(
                        testCase.transactionId, 0, testCase.packetId, 8.6
                    ),
                },
            });
            controller._onRemuxerMediaSegmentArrival('audio', {
                type: 'audio-media',
                info: {beginDts: 8500, endDts: 9000},
                mmtsAudioTrackSwitch: {
                    ...createTestAudioSwitchContext(
                        testCase.transactionId, 0, testCase.packetId, 8.6
                    ),
                },
            });
            controller._playbackOperation = laterOperation;
            return result;
        };

        const returned = controller[testCase.controllerMethod](
            ...testCase.argsPrefix,
            identity
        );
        assert.strictEqual(returned, result);
        assert.deepStrictEqual(
            observations.map((observation) => observation.type),
            ['ack', 'tracks', 'init', 'media']
        );
        assert.strictEqual(
            observations.filter((observation) => observation.type === 'ack').length,
            1
        );
        observations.forEach((observation) => {
            assert.deepStrictEqual(
                JSON.parse(JSON.stringify(observation.operation)),
                JSON.parse(JSON.stringify(operation))
            );
        });
        observations.filter((observation) => observation.segment).forEach((observation) => {
            assert.deepStrictEqual(
                JSON.parse(JSON.stringify(observation.segment.playbackOperation)),
                JSON.parse(JSON.stringify(operation))
            );
            assert.strictEqual(
                observation.segment.mseBufferGeneration,
                operation.timelineGeneration
            );
        });
    });
}

function testControllerResetsFirefoxLiveVideoBootstrapBeforeDeferredAudioOutputs() {
    const MMTSDemuxer = loadDemuxer();
    const Controller = loadControllerWithDemuxer(MMTSDemuxer, {safari: false, firefox: true});
    const controller = new Controller({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true, isLive: true});
    const operation = createTestOperation('audio-switch', 103, 0, 8600, 0xf111);
    const identity = playbackOperationContract.createPlaybackSwitchIdentity(operation);
    const result = Object.assign({
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }, identity);
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const observations = [];
    controller._demuxer = demuxer;
    controller._remuxer = {
        resetAudioState() {},
        resetVideoState() {
            observations.push('remux-video-reset');
        }
    };
    controller.setPlaybackOperation(operation);
    controller.on('mmts_audio_track_selection_result', () => observations.push('ack'));
    controller.on('mmts_audio_tracks', () => observations.push('tracks'));
    controller.on('init_segment', () => observations.push('init'));
    controller.on('media_segment', () => observations.push('media'));
    demuxer.resetVideoForDecoderBootstrap = () => {
        observations.push('demux-video-reset');
        return true;
    };
    demuxer.selectAudioTrack = () => {
        controller._onMMTSAudioTracks({selectedPacketId: 0xf111});
        controller._onRemuxerInitSegmentArrival('audio', {
            type: 'audio-init',
            mmtsAudioTrackSwitch: createTestAudioSwitchContext(103, 0, 0xf111, 8.6),
        });
        controller._onRemuxerMediaSegmentArrival('audio', {
            type: 'audio-media',
            info: {beginDts: 8500, endDts: 9000},
            mmtsAudioTrackSwitch: createTestAudioSwitchContext(103, 0, 0xf111, 8.6),
        });
        return result;
    };

    assert.strictEqual(
        controller.selectAudioTrack(0xf111, 8600, false, identity),
        result
    );
    assert.deepStrictEqual(observations, [
        'ack',
        'demux-video-reset',
        'remux-video-reset',
        'tracks',
        'init',
        'media',
    ]);
}

function testControllerPreservesChromiumVideoDuringLiveAudioSwitch() {
    const MMTSDemuxer = loadDemuxer();
    const Controller = loadControllerWithDemuxer(MMTSDemuxer, {safari: false, chrome: true});
    const controller = Object.create(Controller.prototype);
    let demuxResetCount = 0;
    let remuxResetCount = 0;
    controller._config = {isLive: true};
    controller._demuxer = Object.create(MMTSDemuxer.prototype);
    controller._demuxer.resetVideoForDecoderBootstrap = () => {
        demuxResetCount++;
        return true;
    };
    controller._remuxer = {
        resetVideoState() {
            remuxResetCount++;
        }
    };

    assert.strictEqual(controller._resetMMTSLiveAudioSwitchVideoBootstrap(
        {accepted: true}, false, {kind: 'audio-switch'}
    ), false);
    assert.strictEqual(demuxResetCount, 0);
    assert.strictEqual(remuxResetCount, 0);
}

function testControllerDiscardsDeferredAudioSelectionOutputsOnException() {
    const MMTSDemuxer = loadDemuxer();
    const Controller = loadControllerWithDemuxer(MMTSDemuxer);
    const controller = new Controller({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const operation = createTestOperation('audio-switch', 110, 0, 8600, 0xf111);
    const identity = playbackOperationContract.createPlaybackSwitchIdentity(operation);
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const observations = [];
    const selectionError = new Error('selection failed');
    controller._demuxer = demuxer;
    controller._remuxer = {resetAudioState() {}};
    controller.setPlaybackOperation(operation);
    controller.on('mmts_audio_track_selection_result', () => observations.push('ack'));
    controller.on('mmts_audio_tracks', () => observations.push('tracks'));
    controller.on('init_segment', () => observations.push('init'));
    controller.on('media_segment', () => observations.push('media'));
    demuxer.selectAudioTrack = () => {
        controller._onMMTSAudioTracks({selectedPacketId: 0xf111});
        controller._onRemuxerInitSegmentArrival('audio', {type: 'audio-init'});
        controller._onRemuxerMediaSegmentArrival('audio', {
            type: 'audio-media',
            info: {beginDts: 8500, endDts: 9000},
        });
        throw selectionError;
    };

    let thrown;
    try {
        controller.selectAudioTrack(0xf111, 8600, false, identity);
    } catch (error) {
        thrown = error;
    }
    assert.strictEqual(thrown, selectionError);
    assert.deepStrictEqual(observations, []);
    controller._withCurrentPlaybackOperation(() => {
        controller._onMMTSAudioTracks({selectedPacketId: 0xf110});
    });
    assert.deepStrictEqual(observations, ['tracks']);

    demuxer.selectAudioTrack = () => {
        return controller.selectPrimaryAudioTrack(
            8600,
            false,
            identity
        );
    };
    demuxer.selectPrimaryAudioTrack = () => Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    }, identity);
    assert.throws(() => {
        controller.selectAudioTrack(0xf111, 8600, false, identity);
    }, /Nested transmuxing event deferral/);
    assert.deepStrictEqual(observations, ['tracks']);
}

function testDemuxerAlwaysRequestsFreshInitAtAudioSwitchBoundary() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.audio_track_infos_by_packet_id_ = {0xf111: {packetId: 0xf111}};
    demuxer.primary_audio_packet_id_ = 0xf110;
    demuxer.next_audio_track_switch_id_ = 0;
    demuxer.getCachedAudioSwitchSamples = () => [];
    demuxer.resetAudioTrack = () => {};
    demuxer.audio_timeline_ = {clearPacket() {}};
    demuxer.seedAudioParseState = () => {};
    demuxer.dispatchAudioTracksIfChanged = () => {};

    const switched = demuxer.selectAudioTrackInternal(0xf111, true, 8500, () => {});

    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched)), {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    assert.strictEqual(demuxer.audio_init_segment_pending_, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.pending_audio_track_switch_)), {
        id: 1,
        transactionId: 1,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 8.5,
        requestedStartMicroseconds: 8500000,
    });
}

function testDemuxerSameTrackTransactionInstallsFreshParserBoundary() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    let resetCount = 0;
    let boundaryCount = 0;
    let seedCount = 0;
    demuxer.audio_track_infos_by_packet_id_ = {
        0xf111: {packetId: 0xf111, channelConfig: 2, channelCount: 2},
    };
    demuxer.primary_audio_packet_id_ = 0xf111;
    demuxer.next_audio_track_switch_id_ = 10;
    demuxer.getCachedAudioSwitchSamples = () => {
        throw new Error('same-track transaction must not replay cached samples');
    };
    demuxer.resetAudioTrack = () => { resetCount++; };
    demuxer.audio_timeline_ = {clearPacket() {}};
    demuxer.seedAudioParseState = () => { seedCount++; };
    demuxer.dispatchVideoTracksIfChanged = () => {};
    demuxer.dispatchAudioTracksIfChanged = () => {};

    const ordinary = demuxer.selectAudioTrackInternal(0xf111, true, 8500, () => {
        boundaryCount++;
    });
    assert.strictEqual(ordinary.reason, 'already-selected');
    assert.strictEqual(resetCount, 0);
    assert.strictEqual(boundaryCount, 0);

    const identity = createTestSwitchIdentity('audio-switch', 77, 2, 0xf111, 8600);
    const transactional = demuxer.selectAudioTrackInternal(
        0xf111,
        true,
        8600,
        () => { boundaryCount++; },
        false,
        identity
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(transactional)), Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    }, identity));
    assert.strictEqual(resetCount, 1);
    assert.strictEqual(boundaryCount, 1);
    assert.strictEqual(seedCount, 1);
    assert.strictEqual(demuxer.audio_init_segment_pending_, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.pending_audio_track_switch_)), Object.assign({
        packetId: 0xf111,
        requestedStart: 8.6,
        requestedStartMicroseconds: 8600000,
    }, identity));
}

function testDemuxerLiveAudioSwitchPreservesSharedTimelineState() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const program = {timestampState: 'preserved'};
    const videoTrack = {samples: [{pts: 8500}]};
    const oldAudioState = {lastSamplePts: 8480, previousFrame: {streamMuxConfig: true}};
    const newAudioState = {lastSamplePts: 8460, previousFrame: {streamMuxConfig: true}};
    const cachedTrack = {samples: [], length: 0};
    const clearedPackets = [];
    const seededPackets = [];
    let switchBoundaryCalled = false;
    let timelineDestroyed = false;
    demuxer.audio_track_infos_by_packet_id_ = {0xf111: {packetId: 0xf111}};
    demuxer.primary_audio_packet_id_ = 0xf110;
    demuxer.next_audio_track_switch_id_ = 2;
    demuxer.program_ = program;
    demuxer.video_track_ = videoTrack;
    demuxer.audio_track_ = {type: 'audio', id: 2, sequenceNumber: 4, samples: [{pts: 8480}], length: 4};
    demuxer.audio_parse_states_by_packet_id_ = {
        0xf110: oldAudioState,
        0xf111: newAudioState,
    };
    demuxer.audio_switch_cache_by_packet_id_ = {0xf111: cachedTrack};
    demuxer.audio_timeline_ = {
        clearPacket(packetId) {
            clearedPackets.push(packetId);
        },
        seed(packetId, timelineSeed) {
            seededPackets.push({packetId, timelineSeed});
        },
        destroy() {
            timelineDestroyed = true;
        },
    };
    demuxer.getCachedAudioSwitchSamples = () => [];
    demuxer.dispatchAudioTracksIfChanged = () => {};

    const switched = demuxer.selectAudioTrackInternal(0xf111, true, 8500, () => {
        switchBoundaryCalled = true;
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched)), {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    assert.strictEqual(switchBoundaryCalled, true);
    assert.strictEqual(timelineDestroyed, false);
    assert.strictEqual(demuxer.program_, program);
    assert.strictEqual(demuxer.video_track_, videoTrack);
    assert.strictEqual(demuxer.audio_parse_states_by_packet_id_[0xf110], oldAudioState);
    assert.strictEqual(demuxer.audio_parse_states_by_packet_id_[0xf111], newAudioState);
    assert.strictEqual(demuxer.audio_switch_cache_by_packet_id_[0xf111], cachedTrack);
    assert.deepStrictEqual(clearedPackets, [0xf111]);
    assert.deepStrictEqual(seededPackets, [{packetId: 0xf111, timelineSeed: 8500}]);
    assert.strictEqual(demuxer.audio_track_.length, 0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.pending_audio_track_switch_)), {
        id: 3,
        transactionId: 3,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 8.5,
        requestedStartMicroseconds: 8500000,
    });
}

function testDemuxerRebuildsSameAudioTrackAtTimelineZero() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    let switchBoundaryCalled = false;
    let timelineDestroyed = false;
    let cachedSamplesRequested = false;
    demuxer.audio_track_infos_by_packet_id_ = {0xf111: {packetId: 0xf111}};
    demuxer.primary_audio_packet_id_ = 0xf111;
    demuxer.next_audio_track_switch_id_ = 7;
    demuxer.audio_track_ = {type: 'audio', id: 2, sequenceNumber: 5, samples: [{pts: 20}], length: 4};
    demuxer.audio_parse_states_by_packet_id_ = {0xf111: {lastSamplePts: 20}};
    demuxer.audio_switch_cache_by_packet_id_ = {0xf111: {samples: [{pts: 0}], length: 4}};
    demuxer.audio_timeline_ = {
        clearPacket() {},
        destroy() {
            timelineDestroyed = true;
        },
    };
    demuxer.getCachedAudioSwitchSamples = () => {
        cachedSamplesRequested = true;
        return [{pts: 0}];
    };
    demuxer.dispatchAudioTracksIfChanged = () => {};

    const switched = demuxer.selectAudioTrackInternal(0xf111, true, 0, () => {
        switchBoundaryCalled = true;
    }, true);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched)), {
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    });
    assert.strictEqual(switchBoundaryCalled, true);
    assert.strictEqual(timelineDestroyed, true);
    assert.strictEqual(cachedSamplesRequested, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.audio_parse_states_by_packet_id_)), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.audio_switch_cache_by_packet_id_)), {});
    assert.strictEqual(demuxer.audio_last_sample_pts_, undefined);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.pending_audio_track_switch_)), {
        id: 8,
        transactionId: 8,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 0,
        requestedStartMicroseconds: 0,
    });
}

function testDemuxerRejectsInvalidAudioSwitchTimelineSeedWithoutMutation() {
    const MMTSDemuxer = loadDemuxer();
    for (const rebuildFromSeek of [false, true]) {
        for (const timelineSeed of [-1, NaN, Infinity]) {
            const demuxer = Object.create(MMTSDemuxer.prototype);
            const audioTrack = {type: 'audio', id: 2, sequenceNumber: 6, samples: [{pts: 1000}], length: 4};
            const parseStates = {0xf110: {lastSamplePts: 1000}};
            const switchCache = {0xf111: {samples: [{pts: 1000}], length: 4}};
            const timeline = {clearPacket() {}, destroy() {}};
            const pendingSwitch = {id: 9, attempt: 0, packetId: 0xf110, requestedStart: 1};
            let switchBoundaryCalled = false;
            demuxer.audio_track_infos_by_packet_id_ = {0xf111: {packetId: 0xf111}};
            demuxer.primary_audio_packet_id_ = 0xf110;
            demuxer.manually_selected_audio_packet_id_ = 0xf110;
            demuxer.next_audio_track_switch_id_ = 9;
            demuxer.audio_track_ = audioTrack;
            demuxer.audio_parse_states_by_packet_id_ = parseStates;
            demuxer.audio_switch_cache_by_packet_id_ = switchCache;
            demuxer.audio_timeline_ = timeline;
            demuxer.pending_audio_track_switch_ = pendingSwitch;
            demuxer.getCachedAudioSwitchSamples = () => {
                throw new Error('invalid switch must not inspect cached audio');
            };

            const switched = demuxer.selectAudioTrackInternal(
                0xf111,
                true,
                timelineSeed,
                () => {
                    switchBoundaryCalled = true;
                },
                rebuildFromSeek
            );

            assert.deepStrictEqual(JSON.parse(JSON.stringify(switched)), {
                accepted: false,
                changed: false,
                requestedPacketId: 0xf111,
                reason: 'invalid-timeline',
            });
            assert.strictEqual(switchBoundaryCalled, false);
            assert.strictEqual(demuxer.primary_audio_packet_id_, 0xf110);
            assert.strictEqual(demuxer.manually_selected_audio_packet_id_, 0xf110);
            assert.strictEqual(demuxer.next_audio_track_switch_id_, 9);
            assert.strictEqual(demuxer.audio_track_, audioTrack);
            assert.strictEqual(demuxer.audio_parse_states_by_packet_id_, parseStates);
            assert.strictEqual(demuxer.audio_switch_cache_by_packet_id_, switchCache);
            assert.strictEqual(demuxer.audio_timeline_, timeline);
            assert.strictEqual(demuxer.pending_audio_track_switch_, pendingSwitch);
        }
    }
}

function testDemuxerKeepsAudioSwitchContractUntilMediaIsEmitted() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const switchContract = {id: 10, attempt: 0, packetId: 0xf111, requestedStart: 10};
    demuxer.audio_init_segment_dispatched_ = true;
    demuxer.pending_audio_track_switch_ = switchContract;
    demuxer.audio_track_ = {
        type: 'audio',
        id: 2,
        sequenceNumber: 0,
        samples: [{unit: new Uint8Array([1]), length: 1, dts: 10000, pts: 10000}],
        length: 1,
    };
    demuxer.onDataAvailable = null;

    demuxer.dispatchAudioMediaSegment();
    assert.strictEqual(demuxer.pending_audio_track_switch_, switchContract);

    let outputTrack = null;
    demuxer.audio_track_.samples.push({
        unit: new Uint8Array([2]),
        length: 1,
        dts: 10021,
        pts: 10021,
    });
    demuxer.audio_track_.length = 1;
    demuxer.onDataAvailable = (audioTrack) => {
        outputTrack = audioTrack;
    };
    demuxer.dispatchAudioMediaSegment();

    assert(outputTrack);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(outputTrack.mmtsAudioTrackSwitch)), switchContract);
    assert.strictEqual(demuxer.pending_audio_track_switch_, null);
}

function testDemuxerRebuildFromSeekEmitsFreshSwitchContractWithoutCachedSamples() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    let oldTimelineDestroyed = false;
    let switchBoundaryCalled = false;
    let cachedSamplesRequested = false;
    let parseStateSeeded = false;
    let initMetadata = null;
    let outputTrack = null;
    demuxer.config_ = {isLive: false};
    demuxer.audio_track_infos_by_packet_id_ = {0xf111: {packetId: 0xf111}};
    demuxer.primary_audio_packet_id_ = 0xf110;
    demuxer.next_audio_track_switch_id_ = 4;
    const videoTrack = {samples: [{pts: 200000}]};
    const program = {timestampState: 'preserved'};
    demuxer.video_track_ = videoTrack;
    demuxer.program_ = program;
    demuxer.audio_track_ = {type: 'audio', id: 2, sequenceNumber: 3, samples: [{pts: 200000}], length: 4};
    demuxer.audio_init_segment_dispatched_ = true;
    demuxer.audio_init_segment_pending_ = false;
    demuxer.audio_parse_states_by_packet_id_ = {0xf110: {lastSamplePts: 200000}};
    demuxer.audio_switch_cache_by_packet_id_ = {
        0xf111: {samples: [{pts: 195500}], length: 4},
    };
    demuxer.audio_timeline_ = {
        destroy() {
            oldTimelineDestroyed = true;
        },
        clearPacket() {},
    };
    demuxer.pending_audio_track_switch_ = {id: 4, attempt: 0, packetId: 0xf110, requestedStart: 190};
    demuxer.audio_last_sample_pts_ = 200000;
    demuxer.getCachedAudioSwitchSamples = () => {
        cachedSamplesRequested = true;
        return [{pts: 195500}];
    };
    demuxer.seedAudioParseState = () => {
        parseStateSeeded = true;
    };
    demuxer.dispatchAudioTracksIfChanged = () => {};
    demuxer.appendCachedAudioSwitchSamples = () => {
        throw new Error('VOD rebuild must not append cached alternate audio');
    };
    demuxer.media_info_ = {
        hasVideo: false,
        isComplete() {
            return false;
        },
    };
    demuxer.keyframes_index_ = [];
    demuxer.last_media_info_duration_ = 0;
    demuxer.onTrackMetadata = (_type, metadata) => {
        initMetadata = metadata;
    };
    demuxer.onDataAvailable = (audioTrack) => {
        outputTrack = audioTrack;
    };

    const switched = demuxer.selectAudioTrackInternal(
        0xf111,
        true,
        195445,
        () => {
            switchBoundaryCalled = true;
        },
        true
    );

    assert.deepStrictEqual(JSON.parse(JSON.stringify(switched)), {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    assert.strictEqual(switchBoundaryCalled, true);
    assert.strictEqual(oldTimelineDestroyed, true);
    assert.strictEqual(cachedSamplesRequested, false);
    assert.strictEqual(parseStateSeeded, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.audio_parse_states_by_packet_id_)), {});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(demuxer.audio_switch_cache_by_packet_id_)), {});
    assert.strictEqual(demuxer.primary_audio_packet_id_, 0xf111);
    const switchContract = {
        id: 5,
        transactionId: 5,
        attempt: 0,
        packetId: 0xf111,
        requestedStart: 195.445,
        requestedStartMicroseconds: 195445000,
    };
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(demuxer.pending_audio_track_switch_)),
        switchContract
    );
    assert.strictEqual(demuxer.audio_last_sample_pts_, undefined);
    assert.strictEqual(demuxer.audio_init_segment_pending_, true);
    assert.strictEqual(demuxer.video_track_, videoTrack);
    assert.strictEqual(demuxer.program_, program);

    demuxer.dispatchAudioInitSegmentFromMetadata({
        codec: 'aac',
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
    });
    assert(initMetadata);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(initMetadata.mmtsAudioTrackSwitch)),
        switchContract
    );

    demuxer.audio_track_.samples.push({
        unit: new Uint8Array([1, 2, 3, 4]),
        length: 4,
        dts: 195445,
        pts: 195445,
    });
    demuxer.audio_track_.length = 4;
    demuxer.dispatchAudioMediaSegment();
    assert(outputTrack);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(outputTrack.mmtsAudioTrackSwitch)),
        switchContract
    );
    assert.strictEqual(demuxer.pending_audio_track_switch_, null);
}

function testDemuxerRejectsBackwardAlternateAudioEpoch() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const metadata = {
        codec: 'aac',
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
    };
    demuxer.config_ = {
        mmtsAudioTrackSwitchCacheDuration: 10,
        mseBufferForwardTargetDuration: 18,
        lazyLoad: false,
        isLive: true,
    };
    demuxer.audio_switch_cache_by_packet_id_ = {};
    assert.strictEqual(demuxer.getAudioSwitchCacheDuration(), 20);

    assert.strictEqual(demuxer.cacheAudioSwitchSample(
        0xf111,
        {unit: new Uint8Array([1]), length: 1, pts: 37000, dts: 37000},
        1024 / 48,
        metadata
    ), true);
    assert.strictEqual(demuxer.cacheAudioSwitchSample(
        0xf111,
        {unit: new Uint8Array([2]), length: 1, pts: 18000, dts: 18000},
        1024 / 48,
        metadata
    ), false);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(
            demuxer.audio_switch_cache_by_packet_id_[0xf111].samples.map((sample) => sample.pts)
        )),
        [37000]
    );
}

function testDemuxerInactiveAudioCannotRewindSelectedCursor() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const MMTSDemuxer = loadDemuxer({aacFrames: [frame]});
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const state = {
        metadata: {},
        lastIncompleteData: null,
        previousFrame: null,
        nextAccessUnitIndex: 0,
    };
    demuxer.config_ = {
        mmtsAudioTrackSwitchCacheDuration: 10,
        mseBufferForwardTargetDuration: 18,
        lazyLoad: false,
        isLive: true,
    };
    demuxer.primary_audio_packet_id_ = 0xf110;
    demuxer.audio_last_sample_pts_ = 10000;
    demuxer.audio_switch_cache_by_packet_id_ = {};
    demuxer.audio_track_infos_by_packet_id_ = {};
    demuxer.logged_unsupported_audio_packet_ids_ = {};
    demuxer.dispatchAudioTracksIfChanged = () => {};
    demuxer.audio_timeline_ = {
        hasMapping() { return true; },
        mapTimestamp(_packetId, pts) { return {pts}; },
    };

    demuxer.parseMMTSLOASAACPayload(0xf111, new Uint8Array([0xaa]), 37000, false, state);
    demuxer.parseMMTSLOASAACPayload(0xf111, new Uint8Array([0xaa]), 18000, false, state);

    assert.strictEqual(demuxer.audio_last_sample_pts_, 10000);
    assert.strictEqual(state.lastSamplePts, 37000);
}

function testDemuxerDropsCachedReplayOverlapAfterDiscontinuity() {
    const frame = {
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
        data: new Uint8Array([1, 2, 3, 4])
    };
    const MMTSDemuxer = loadDemuxer({aacFrames: Array.from({length: 11}, () => frame)});
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const metadata = {
        codec: 'aac',
        audio_object_type: 2,
        sampling_freq_index: 3,
        sampling_frequency: 48000,
        channel_config: 2,
    };
    const state = {
        metadata,
        lastIncompleteData: new Uint8Array([1]),
        previousFrame: null,
        lastSamplePts: 8226,
        nextAccessUnitIndex: 0,
        switchReplayEndPts: 8226,
    };
    demuxer.config_ = {mmtsClampAudioTimestampGap: false};
    demuxer.primary_audio_packet_id_ = 0xf111;
    demuxer.audio_last_sample_pts_ = 8226;
    demuxer.audio_metadata_ = metadata;
    demuxer.audio_init_segment_dispatched_ = true;
    demuxer.audio_init_segment_pending_ = false;
    demuxer.video_started_ = true;
    demuxer.pending_seek_media_time_ = undefined;
    demuxer.audio_track_ = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};
    demuxer.audio_parse_states_by_packet_id_ = {0xf111: state};
    demuxer.audio_switch_cache_by_packet_id_ = {
        0xf111: {metadata, samples: [{unit: new Uint8Array([1]), length: 1, pts: 8000, dts: 8000}], length: 1}
    };
    demuxer.audio_track_infos_by_packet_id_ = {};
    demuxer.logged_unsupported_audio_packet_ids_ = {};
    demuxer.logged_audio_discontinuity_count_ = 8;
    demuxer.logged_audio_timestamp_alignment_count_ = 0;
    demuxer.logged_audio_timestamp_gap_clamp_count_ = 0;
    demuxer.logged_stale_audio_timestamp_count_ = 0;
    demuxer.dispatchAudioTracksIfChanged = () => {};
    demuxer.audio_timeline_ = {
        hasMapping() { return true; },
        mapTimestamp(_packetId, pts) { return {pts}; },
    };

    demuxer.handleAudioMpuDiscontinuity(0xf111, {assetType: 'mp4a'}, {mpuSequenceNumber: 10});
    assert.strictEqual(state.switchReplayEndPts, 8226);
    assert.strictEqual(demuxer.audio_switch_cache_by_packet_id_[0xf111], undefined);

    demuxer.parseMMTSLOASAACPayload(0xf111, new Uint8Array([0xaa]), 8034, true, state);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(demuxer.audio_track_.samples.map((sample) => sample.pts))),
        [8247]
    );
    assert.strictEqual(state.switchReplayEndPts, undefined);
}

function testDemuxerReusesExactParameterSetVersion() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.video_parameter_sets_ = {vps: {}, sps: {}, pps: {}};
    demuxer.video_parameter_set_versions_ = {vps: {}, sps: {}, pps: {}};
    demuxer.next_video_parameter_set_generation_ = 1;
    demuxer.video_init_segment_dispatched_ = true;
    demuxer.active_video_parameter_set_signature_ = 'active';
    const details = {pic_parameter_set_id: 3, seq_parameter_set_id: 0};
    const first = {data: new Uint8Array([0, 0, 0, 4, 0x44, 0x02, 0x91, 0x22])};
    const same = {data: new Uint8Array([0, 0, 0, 4, 0x44, 0x02, 0x91, 0x22])};
    const changed = {data: new Uint8Array([0, 0, 0, 4, 0x44, 0x04, 0x91, 0x22])};
    const repeated = {data: new Uint8Array([0, 0, 0, 4, 0x44, 0x02, 0x91, 0x22])};

    demuxer.updateVideoParameterSet('pps', first, details);
    const firstEntry = demuxer.video_parameter_sets_.pps[3];
    demuxer.updateVideoParameterSet('pps', same, details);
    assert.strictEqual(demuxer.video_parameter_sets_.pps[3], firstEntry);
    assert.strictEqual(demuxer.next_video_parameter_set_generation_, 2);

    demuxer.updateVideoParameterSet('pps', changed, details);
    assert.notStrictEqual(demuxer.video_parameter_sets_.pps[3], firstEntry);
    assert.strictEqual(demuxer.next_video_parameter_set_generation_, 3);

    demuxer.updateVideoParameterSet('pps', repeated, details);
    assert.strictEqual(demuxer.video_parameter_sets_.pps[3], firstEntry);
    assert.strictEqual(demuxer.next_video_parameter_set_generation_, 3);
}

function testDemuxerDefersInitialParameterSetActivation() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    demuxer.video_parameter_sets_ = {vps: {}, sps: {}, pps: {}};
    demuxer.video_parameter_set_versions_ = {vps: {}, sps: {}, pps: {}};
    demuxer.next_video_parameter_set_generation_ = 1;
    demuxer.video_init_segment_dispatched_ = false;
    demuxer.active_video_parameter_set_signature_ = undefined;
    demuxer.video_metadata_ = {vps: undefined, sps: undefined, pps: undefined, details: undefined};
    let initCount = 0;
    demuxer.dispatchVideoInitSegment = () => {
        initCount++;
        demuxer.video_init_segment_dispatched_ = true;
    };

    demuxer.updateVideoParameterSet(
        'vps',
        {data: new Uint8Array([0, 0, 0, 1, 1])},
        {video_parameter_set_id: 0, max_sub_layers_minus1: 3}
    );
    demuxer.updateVideoParameterSet(
        'sps',
        {data: new Uint8Array([0, 0, 0, 1, 2])},
        {seq_parameter_set_id: 0, video_parameter_set_id: 0, max_sub_layers_minus1: 3}
    );
    demuxer.updateVideoParameterSet(
        'pps',
        {data: new Uint8Array([0, 0, 0, 1, 3])},
        {pic_parameter_set_id: 0, seq_parameter_set_id: 0}
    );

    assert.strictEqual(initCount, 0);
    demuxer.tryActivateLatestCompleteParameterSet();
    assert.strictEqual(initCount, 1);
}

function testDemuxerKeepsHev1PpsUpdatesInBand() {
    const MMTSDemuxer = loadDemuxer();
    const demuxer = Object.create(MMTSDemuxer.prototype);
    const details = {
        codec_mimetype: 'hvc1.2.4.L183.B0',
        codec_size: {width: 7680, height: 4320},
        present_size: {width: 7680, height: 4320},
    };
    const chain = {
        vps: {id: 0, generation: 1, nalu: {data: new Uint8Array([1])}, details},
        sps: {id: 0, generation: 2, nalu: {data: new Uint8Array([2])}, details: {}},
        pps: {
            id: 0,
            generation: 4,
            nalu: {data: new Uint8Array([4])},
            details: {pic_parameter_set_id: 0, seq_parameter_set_id: 0},
        },
        signature: 'v0.1:s0.2:p0.4',
    };
    demuxer.video_init_segment_dispatched_ = true;
    demuxer.video_sample_entry_type_ = 'hev1';
    demuxer.active_video_parameter_set_signature_ = 'v0.1:s0.2:p0.3';
    demuxer.video_metadata_ = {
        vps: chain.vps.nalu,
        sps: chain.sps.nalu,
        pps: {data: new Uint8Array([3])},
        details,
    };
    let initCount = 0;
    let mediaCount = 0;
    demuxer.dispatchVideoInitSegment = () => { initCount++; };
    demuxer.dispatchVideoMediaSegment = () => { mediaCount++; };

    demuxer.activateVideoParameterSetChain(chain);

    assert.strictEqual(initCount, 0);
    assert.strictEqual(mediaCount, 0);
    assert.strictEqual(demuxer.active_video_parameter_set_signature_, chain.signature);
    assert.strictEqual(demuxer.video_metadata_.pps, chain.pps.nalu);
}

testProbeRejectsStructuredAudioSelectionFailure();
testDemuxerAcceptsNormalDescriptorTimeline();
testDemuxerMapsSwitchedVideoToExistingRawTimeline();
testDemuxerValidatesSwitchedVideoMpuOnSharedRawTimeline();
testDemuxerRejectsVideoWithoutDescriptorTimestamp();
testDemuxerRejectsStaleSourceWithoutAdvancingTimeline();
testDemuxerAllowsFileReorderWithoutRawDtsRollback();
testDemuxerMarksOutputSampleAfterPacketDiscontinuity();
testDemuxerDoesNotConsumeDiscontinuityWhenDroppingVideoSample();
testRemuxerDoesNotFilterByMMTSSourceIdentity();
testRemuxerPackagesMonotonicSamplesRegardlessOfMMTSSourceOrder();
testRemuxerDropsInitialVideoUntilRandomAccessPoint();
testRemuxerPreservesExplicitDiscontinuityThroughVideoRemux();
testRemuxerPreservesMarkedVideoGapAcrossSegments();
testRemuxerPreservesExplicitDiscontinuityMetadata();
testRemuxerClearsVideoStateOnSeek();
testRemuxerExportsAudioTrackSwitchOnRemuxedTimeline();
testRemuxerExportsVideoTrackSwitchOnRemuxedTimeline();
testRemuxerCarriesVideoSwitchContextToInitSegment();
testDemuxerDispatchesPrimaryAudioInitBeforeVideoSamples();
testDemuxerDoesNotAppendPrimaryAudioAtZeroWithoutTimestampSeed();
testDemuxerDoesNotAppendPrimaryAudioWithoutMfuTimestampFromPreviousSample();
testDemuxerConsumesAudioTimestampBySampleNumber();
testDemuxerMapsSwitchedAudioToExistingVideoTimeline();
testDemuxerAllocatesAudioTimestampByMpuOrderWithoutSampleNumber();
testDemuxerCarriesAudioSwitchContextToFirstAudioTrack();
testDemuxerCarriesVideoSwitchContextToFirstVideoTrack();
testDemuxerVideoTrackSelectionAcknowledgesTransactionIdentity();
testDemuxerAudioTrackSelectionAcknowledgesTransactionIdentity();
testControllerEmitsAudioSelectionAckBeforeSynchronousOutputs();
testControllerResetsFirefoxLiveVideoBootstrapBeforeDeferredAudioOutputs();
testControllerPreservesChromiumVideoDuringLiveAudioSwitch();
testControllerDiscardsDeferredAudioSelectionOutputsOnException();
testDemuxerAlwaysRequestsFreshInitAtAudioSwitchBoundary();
testDemuxerSameTrackTransactionInstallsFreshParserBoundary();
testDemuxerLiveAudioSwitchPreservesSharedTimelineState();
testDemuxerRebuildsSameAudioTrackAtTimelineZero();
testDemuxerRejectsInvalidAudioSwitchTimelineSeedWithoutMutation();
testDemuxerKeepsAudioSwitchContractUntilMediaIsEmitted();
testDemuxerRebuildFromSeekEmitsFreshSwitchContractWithoutCachedSamples();
testDemuxerRejectsBackwardAlternateAudioEpoch();
testDemuxerInactiveAudioCannotRewindSelectedCursor();
testDemuxerDropsCachedReplayOverlapAfterDiscontinuity();
testDemuxerReusesExactParameterSetVersion();
testDemuxerDefersInitialParameterSetActivation();
testDemuxerKeepsHev1PpsUpdatesInBand();

console.log('mmts demux/remux timeline tests passed');

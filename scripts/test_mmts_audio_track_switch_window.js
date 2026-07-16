#!/usr/bin/env node

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadTypeScriptModule(relativePath, requireMap = {}) {
    const sourcePath = path.resolve(__dirname, relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require(id) {
            return Object.prototype.hasOwnProperty.call(requireMap, id) ?
                requireMap[id] : require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        Promise,
        Number,
        Object,
        TypeError,
        Error,
        Map,
        isFinite,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

const playbackOperationModule = loadTypeScriptModule('../src/core/playback-operation.ts');
const playbackOperationResultModule = loadTypeScriptModule(
    '../src/player/playback-operation-result.ts',
    {'../core/playback-operation': playbackOperationModule}
);
const playbackOperationSchedulerModule = loadTypeScriptModule(
    '../src/player/playback-operation-scheduler.ts',
    {'../core/playback-operation': playbackOperationModule}
);
let playbackHarnessSequence = 0;

const TRANSMUXING_EVENT_NAMES = [
    'ASYNCHRONOUS_KLV_METADATA_ARRIVED',
    'DEMUX_ERROR',
    'INIT_SEGMENT',
    'IO_ERROR',
    'LOADING_COMPLETE',
    'MEDIA_INFO',
    'MEDIA_SEGMENT',
    'METADATA_ARRIVED',
    'MMTS_AUDIO_TRACKS',
    'MMTS_AUDIO_TRACK_SELECTION_RESULT',
    'MMTS_SUBTITLE_DATA_ARRIVED',
    'MMTS_SUBTITLE_TRACKS',
    'MMTS_VIDEO_TRACK_SELECTION_RESULT',
    'MMTS_VIDEO_TRACKS',
    'PES_PRIVATE_DATA_ARRIVED',
    'PES_PRIVATE_DATA_DESCRIPTOR',
    'PGS_SUBTITLE_ARRIVED',
    'RECOMMEND_SEEKPOINT',
    'RECOVERED_EARLY_EOF',
    'SCRIPTDATA_ARRIVED',
    'SCTE35_METADATA_ARRIVED',
    'SEI_ARRIVED',
    'SMPTE2038_METADATA_ARRIVED',
    'STARTUP_GROUP',
    'STARTUP_GROUP_FAILED',
    'STATISTICS_INFO',
    'SYNCHRONOUS_KLV_METADATA_ARRIVED',
    'TIMED_ID3_METADATA_ARRIVED',
];

const TRANSMUXING_EVENTS = Object.fromEntries(
    TRANSMUXING_EVENT_NAMES.map((name) => [name, name.toLowerCase()])
);
const vodSwitchStateMachineOutputs = new WeakMap();

function makeStartupGroupFailure(operation, phase = 'collecting', reason = 'timeout') {
    return {
        kind: 'startup-group',
        transactionId: operation.transactionId,
        playbackOperation: Object.assign({}, operation),
        mseBufferGeneration: operation.timelineGeneration,
        phase,
        reason,
        missing: ['video-media'],
    };
}

function isStartupGroupFailure(value, expectedOperation) {
    const operation = value && value.playbackOperation;
    return !!value && value.kind === 'startup-group' && operation &&
        value.transactionId === operation.transactionId &&
        value.mseBufferGeneration === operation.timelineGeneration &&
        ['collecting', 'appending'].includes(value.phase) &&
        typeof value.reason === 'string' && Array.isArray(value.missing) &&
        (!expectedOperation || playbackOperationModule.isSamePlaybackOperation(
            operation,
            expectedOperation
        ));
}

function loadAudioTrackSwitchCoordinator(playbackOperationModule) {
    const sourcePath = path.resolve(__dirname, '../src/player/mmts-audio-track-switch-transaction.ts');
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require(id) {
            if (id === '../core/playback-operation') return playbackOperationModule;
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        setTimeout,
        clearTimeout,
    }, {filename: sourcePath});
    return moduleObject.exports.default;
}

function loadVideoTrackSwitchCoordinator(playbackOperationModule) {
    const sourcePath = path.resolve(__dirname, '../src/player/mmts-video-track-switch-transaction.ts');
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require(id) {
            if (id === '../core/playback-operation') return playbackOperationModule;
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        setTimeout,
        clearTimeout,
    }, {filename: sourcePath});
    return moduleObject.exports.default;
}

function loadMMTSTrackSwitchWindow() {
    const sourcePath = path.resolve(__dirname, '../src/player/mmts-track-switch-window.ts');
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require,
        module: moduleObject,
        exports: moduleObject.exports,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

function loadPlayerEngineMainThread(options = {}) {
    const sourcePath = path.resolve(__dirname, '../src/player/player-engine-main-thread.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const emptyClass = class {};
    const playerEvents = new Proxy({}, {
        get(_target, property) {
            return String(property).toLowerCase();
        },
    });
    const Coordinator = loadAudioTrackSwitchCoordinator(playbackOperationModule);
    const VideoCoordinator = loadVideoTrackSwitchCoordinator(playbackOperationModule);
    const trackSwitchWindowModule = loadMMTSTrackSwitchWindow();
    const startupGroupLifecycleModule = {
        isMMTSStartupGroupFailure(value, expectedOperation) {
            return !!value && value.kind === 'startup-group' &&
                Number.isInteger(value.transactionId) &&
                playbackOperationModule.isPlaybackOperation(value.playbackOperation) &&
                value.mseBufferGeneration === value.playbackOperation.timelineGeneration &&
                ['collecting', 'appending'].includes(value.phase) &&
                typeof value.reason === 'string' && Array.isArray(value.missing) &&
                (!expectedOperation || playbackOperationModule.isSamePlaybackOperation(
                    value.playbackOperation,
                    expectedOperation
                ));
        },
    };
    const requireMap = {
        '../utils/browser': {__esModule: true, default: options.Browser || {chrome: false}},
        '../utils/logger': {__esModule: true, default: {v() {}, w() {}, e() {}}},
        '../config': {applyMediaDataSourceConfig() {}, createDefaultConfig() { return {}; }},
        '../core/mse-controller': {__esModule: true, default: emptyClass},
        './player-events': {__esModule: true, default: playerEvents},
        '../core/transmuxer': {__esModule: true, default: options.Transmuxer || emptyClass},
        '../core/media-info': {__esModule: true, default: emptyClass},
        '../core/mse-events': {__esModule: true, default: {}},
        './player-errors': {ErrorTypes: {}, ErrorDetails: {}},
        '../utils/exception': {IllegalStateException: class IllegalStateException extends Error {}},
        '../core/transmuxing-events': {__esModule: true, default: TRANSMUXING_EVENTS},
        './seeking-handler': {__esModule: true, default: emptyClass},
        './loading-controller': {__esModule: true, default: emptyClass},
        './mse-buffer-state-machine': {
            __esModule: true,
            default: options.MSEBufferStateMachine || emptyClass,
        },
        './startup-buffer-gate': {__esModule: true, default: emptyClass},
        './startup-stall-jumper': {__esModule: true, default: emptyClass},
        './live-latency-chaser': {__esModule: true, default: emptyClass},
        './live-latency-synchronizer': {__esModule: true, default: emptyClass},
        '../utils/mmts-demuxer-utils': {
            findPreferredAudioTrack(tracks) {
                return tracks.find((track) => track && track.mainComponent) || tracks[0];
            },
            isMMTSAudioTrackSelectable(track) {
                return !!track && track.selectable !== false;
            },
        },
        '../core/playback-operation': playbackOperationModule,
        './playback-operation-result': playbackOperationResultModule,
        './playback-operation-scheduler': playbackOperationSchedulerModule,
        '../core/mmts-startup-group-lifecycle': startupGroupLifecycleModule,
        './mmts-audio-track-switch-transaction': {__esModule: true, default: Coordinator},
        './mmts-video-track-switch-transaction': {__esModule: true, default: VideoCoordinator},
        './mmts-track-switch-window': trackSwitchWindowModule,
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        setTimeout: options.setTimeout || setTimeout,
        clearTimeout: options.clearTimeout || clearTimeout,
        window: {
            setTimeout: options.setTimeout || setTimeout,
            clearTimeout: options.clearTimeout || clearTimeout,
        },
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    moduleObject.exports.default.__TestCoordinator = Coordinator;
    moduleObject.exports.default.__TestVideoCoordinator = VideoCoordinator;
    return moduleObject.exports.default;
}

function makeAudioTracks(selectedPacketId) {
    return [
        {
            packetId: 0xf110,
            mainComponent: true,
            assetType: 'mp4a',
            codec: 'aac-latm',
            channelConfig: 6,
            selected: selectedPacketId === 0xf110,
        },
        {
            packetId: 0xf111,
            mainComponent: false,
            assetType: 'mp4a',
            codec: 'aac-latm',
            channelConfig: 2,
            selected: selectedPacketId === 0xf111,
        },
    ];
}

function makeAudioSwitchContract(operation, packetId, requestedTime) {
    return Object.assign(
        playbackOperationModule.createPlaybackSwitchIdentity(operation),
        {
            packetId,
            requestedStart: requestedTime,
            requestedStartMicroseconds: Math.round(requestedTime * 1000000),
        }
    );
}

function getQueuedAudioReservation(engine) {
    const intent = engine._operation_scheduler && engine._operation_scheduler.queued.find(
        (entry) => entry.operation.kind === 'audio-switch'
    );
    return intent && intent.payload ? intent.payload.reservation : null;
}

function getQueuedVideoReservation(engine) {
    const intent = engine._operation_scheduler && engine._operation_scheduler.queued.find(
        (entry) => entry.operation.kind === 'video-switch'
    );
    return intent && intent.payload ? intent.payload.reservation : null;
}

function flushPendingMMTSSeek(engine) {
    if (engine._pending_mmts_seek_timer != null) {
        clearTimeout(engine._pending_mmts_seek_timer);
        engine._pending_mmts_seek_timer = null;
    }
    const pending = engine._pending_mmts_seek;
    engine._pending_mmts_seek = null;
    if (pending) {
        engine._scheduleInteractiveOperation({
            operation: pending.operation,
            payload: {
                type: 'seek',
                targetSeconds: pending.targetSeconds,
                source: pending.source,
            },
        }, true);
    }
}

function attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread, options = {}) {
    engine._audio_track_switch_coordinator = new PlayerEngineMainThread.__TestCoordinator({
        onTimeout(transaction) { engine._onUnifiedAudioTrackSwitchTimeout(transaction); },
        stageTimeout(stage) {
            return ['requested', 'preparing', 'selecting'].includes(stage) ? 10000 : 45000;
        },
        setTimer: options.setTimeout || (() => ({})),
        clearTimer: options.clearTimeout || (() => {}),
    });
    engine._video_track_switch_coordinator = new PlayerEngineMainThread.__TestVideoCoordinator({
        onTimeout(transaction) {
            engine._failUnifiedMMTSVideoTrackSwitch(
                transaction.operation,
                `timeout:${transaction.stage}`
            );
        },
        stageTimeout(stage) {
            return ['requested', 'selecting'].includes(stage) ? 10000 : 45000;
        },
        setTimer: options.setTimeout || (() => ({})),
        clearTimer: options.clearTimeout || (() => {}),
    });
}

function makeVodSwitchHarness(currentTime, options = {}) {
    class CapturingMSEBufferStateMachine {
        constructor(_config, output) {
            this.output = output;
        }
    }
    const PlayerEngineMainThread = loadPlayerEngineMainThread({
        Browser: options.Browser,
        MSEBufferStateMachine: CapturingMSEBufferStateMachine,
        setTimeout: options.setTimeout,
        clearTimeout: options.clearTimeout,
    });
    const engine = Object.create(PlayerEngineMainThread.prototype);
    const operations = [];
    engine._emitter = new EventEmitter();
    engine._config = {isMMTS: true, isLive: false};
    engine._media_element = {currentTime, paused: false};
    engine._seeking_handler = {
        directSeek(targetTime) {
            engine._media_element.currentTime = targetTime;
        },
    };
    engine._selected_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_video_packet_id = null;
    engine._mmts_video_tracks = [];
    engine._mmts_audio_tracks = makeAudioTracks(0xf110);
    engine._mmts_live_video_rebuild_window = null;
    engine._pending_audio_track_switch_media_segments = [];
    engine._pending_audio_track_switch_resume_playback = false;
    engine._resume_playback_after_audio_track_switch_rebuild = false;
    engine._mmts_audio_track_switch_rebuild_in_progress = false;
    engine._pending_mmts_vod_audio_track_switch = null;
    engine._playback_scope_id = `audio-window-harness-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._playback_recovery_roots = new Map();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._desired_mmts_audio_packet_id = engine._selected_mmts_audio_packet_id;
    engine._desired_mmts_video_packet_id = null;
    engine._mmts_video_tracks = [];
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread, options);
    engine._pending_audio_track_switch_request_time = null;
    engine._pending_audio_track_switch_expected_packet_id = null;
    engine._accepted_audio_track_switch_time = null;
    engine._pending_audio_track_switch_init_segment = {type: 'audio'};
    engine._mse_buffer_state_machine = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onMMTSVodAudioTrackRebuild(targetTime) {
            operations.push({type: 'rebuild', targetTime});
            this.pendingRebuild = true;
            this.paused = true;
            return true;
        },
        cancelAudioTrackSwitch(operation) {
            operations.push({type: 'cancel_state_machine', transactionId: operation.transactionId});
            this.pendingRebuild = false;
            this.paused = false;
            return true;
        },
        onFatal(error) {
            operations.push({type: 'fatal', error});
        },
        onAudioTrackSwitch(request) {
            operations.push({type: 'plan', request});
            return true;
        },
        onUserSeek(targetTime) {
            operations.push({type: 'user_seek', targetTime});
        },
        onSeek(targetTime) {
            operations.push({type: 'unbuffered_seek', targetTime});
        },
    };
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        beginMMTSVodAudioTrackRebuild() {
            operations.push({type: 'begin'});
            this.activeIntent = true;
        },
        completeMMTSVodAudioTrackRebuild() {
            operations.push({type: 'complete'});
        },
        acknowledgeMMTSVodAudioTrackStartup() {
            operations.push({type: 'ack_startup'});
            this.activeIntent = false;
        },
        cancelMMTSVodAudioTrackRebuild() {
            operations.push({type: 'cancel'});
            this.activeIntent = false;
        },
        seek(milliseconds) {
            operations.push({type: 'seek', milliseconds});
        },
        seekAndSelectAudioTrack(milliseconds, operation, packetId, timelineSeed,
                                switchIdentity) {
            operations.push({
                type: 'seek_and_select',
                milliseconds,
                operation,
                packetId,
                timelineSeed,
                switchIdentity,
            });
        },
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek) {
            operations.push({type: 'select', packetId, timelineSeed, rebuildFromSeek});
        },
    };
    vodSwitchStateMachineOutputs.set(engine, engine._createMSEBufferStateMachine().output);
    return {engine, operations};
}

function completeVodSwitchTransaction(engine, operations, packetId, requestedTime, deferCompletion = false) {
    engine._transmuxer.seek(Math.floor(requestedTime * 1000));
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, packetId);
    const playbackTime = Math.max(requestedTime, engine._media_element.currentTime);
    const audioSwitch = Object.assign(makeAudioSwitchContract(
        engine._pending_mmts_vod_audio_track_switch.operation,
        packetId,
        requestedTime
    ), {
        audioDecodeStart: playbackTime - 0.1,
        audioStart: playbackTime - 0.1,
        audioEnd: playbackTime + 0.3,
    });
    const makeSegment = (type) => ({
        type,
        data: {byteLength: 32},
        mmtsRandomAccessSafe: type === 'video' ? true : undefined,
        info: {
            beginDts: (playbackTime - 0.1) * 1000,
            endDts: (playbackTime + 0.3) * 1000,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: type === 'video' ? {
            decodeStart: playbackTime - 0.1,
            compositionStart: playbackTime - 0.1,
            syncPoint: playbackTime - 0.1,
            playableStart: playbackTime - 0.1,
            playableEnd: playbackTime + 0.3,
        } : undefined,
        mmtsAudioTrackSwitch: type === 'audio' ? audioSwitch : undefined,
    });
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment: {type: 'video', data: {byteLength: 8}},
        audioInitSegment: {
            type: 'audio',
            data: {byteLength: 8},
            mmtsAudioTrackSwitch: audioSwitch,
        },
        videoMediaSegment: makeSegment('video'),
        audioMediaSegment: makeSegment('audio'),
    }).status, 'accepted');
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'rebuilding');
    if (deferCompletion) {
        return engine._pending_mmts_vod_audio_track_switch.operation;
    }
    const output = vodSwitchStateMachineOutputs.get(engine);
    output.onAudioTrackSwitchRebuildComplete(
        engine._pending_mmts_vod_audio_track_switch.operation
    );
    assert.strictEqual(engine._selected_mmts_audio_packet_id, packetId);
    return operations;
}

function confirmVodAudioTrackSwitch(engine, packetId, changed) {
    const transaction = engine._audio_track_switch_coordinator.active;
    assert(transaction, 'expected active audio-track transaction');
    const trackData = {
        tracks: makeAudioTracks(packetId),
        selectedPacketId: packetId,
    };
    assert.strictEqual(
        engine._audio_track_switch_coordinator.setConfirmedTrackData(transaction.operation, trackData),
        true
    );
    const selectionChanged = changed === undefined ?
        packetId !== transaction.priorCommittedPacketId : changed;
    engine._onMMTSAudioTrackSelectionResult(Object.assign({
        accepted: true,
        changed: selectionChanged,
        requestedPacketId: packetId,
        selectedPacketId: packetId,
        reason: selectionChanged ? 'selected' : 'already-selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)),
    transaction.operation);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.confirmedPacketId, packetId);
}

function loadTransmuxer() {
    const sourcePath = path.resolve(__dirname, '../src/core/transmuxer.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const emptyClass = class {};
    const transmuxingEvents = {
        INIT_SEGMENT: 'init_segment',
        MEDIA_SEGMENT: 'media_segment',
        LOADING_COMPLETE: 'loading_complete',
        MMTS_AUDIO_TRACKS: 'mmts_audio_tracks',
    };
    const requireMap = {
        events: EventEmitter,
        '../utils/webworkify-webpack': {__esModule: true, default() {}},
        '../utils/logger.js': {__esModule: true, default: {v() {}, w() {}, e() {}}},
        '../utils/logging-control.js': {
            __esModule: true,
            default: {registerListener() {}, removeListener() {}, getConfig() { return {}; }},
        },
        './transmuxing-controller.js': {__esModule: true, default: emptyClass},
        './transmuxing-events': {__esModule: true, default: transmuxingEvents},
        './transmuxing-worker.js': {__esModule: true, default: {}},
        './media-info.js': {__esModule: true, default: emptyClass},
        '../demux/ts-demuxer.ts': {__esModule: true, default: emptyClass},
        '../demux/mmts-demuxer.ts': {__esModule: true, default: emptyClass},
        './playback-operation': playbackOperationModule,
        './mmts-startup-group-lifecycle': {
            isMMTSStartupGroupFailure: isStartupGroupFailure,
        },
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        Promise,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return {Transmuxer: moduleObject.exports.default, transmuxingEvents};
}

function loadMP4Remuxer() {
    const sourcePath = path.resolve(__dirname, '../src/remux/mp4-remuxer.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    class MediaSegmentInfoList {
        isEmpty() { return true; }
        append() {}
        clear() {}
    }
    const requireMap = {
        '../utils/logger.js': {__esModule: true, default: {v() {}, w() {}, e() {}}},
        './mp4-generator.js': {
            __esModule: true,
            default: {
                generateInitSegment() { return new Uint8Array([0]); },
                types: {mdat: new Uint8Array([0, 0, 0, 0])},
                moof() { return new Uint8Array([0, 0, 0, 0]); },
            },
        },
        './aac-silent.js': {__esModule: true, default: {}},
        '../utils/browser.js': {__esModule: true, default: {safari: false}},
        '../core/media-segment-info.js': {
            SampleInfo: class {},
            MediaSegmentInfo: class {},
            MediaSegmentInfoList,
        },
        '../utils/exception.js': {IllegalStateException: class IllegalStateException extends Error {}},
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports.default;
}

function testRemuxedAudioSwitchPreservesRetryIdentityInInitAndMedia() {
    const MP4Remuxer = loadMP4Remuxer();
    const remuxer = Object.create(MP4Remuxer.prototype);
    const initialOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'audio-window-remux',
        timelineGeneration: 77,
        kind: 'audio-switch',
        transactionId: 77,
        requestedTimeMilliseconds: 20821,
        packetId: 0xf111,
    });
    const operation = playbackOperationModule.createNextPlaybackAttempt(initialOperation, {
        phase: 'adaptive-retry',
    });
    const identity = Object.assign(
        playbackOperationModule.createPlaybackSwitchIdentity(operation),
        {
            packetId: 0xf111,
            requestedStart: 20.821,
            requestedStartMicroseconds: 20821000,
        }
    );
    let initSegment = null;
    remuxer._mp3UseMpegAudio = false;
    remuxer._onInitSegment = (_type, segment) => { initSegment = segment; };
    remuxer._onTrackMetadataReceived('audio', {
        codec: 'mp4a.40.2',
        duration: 459659,
        mmtsAudioTrackSwitch: identity,
    });
    const mediaIdentity = remuxer._makeMMTSAudioTrackSwitch(identity, {
        beginDts: 20700,
        beginPts: 20700,
        endPts: 21200,
    });
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(initSegment.mmtsAudioTrackSwitch)),
        JSON.parse(JSON.stringify(identity))
    );
    for (const key of [
        'scopeId', 'transactionKey', 'attemptKey', 'kind', 'id',
        'transactionId', 'attempt', 'packetId', 'requestedStart',
        'requestedStartMicroseconds',
    ]) {
        assert.strictEqual(mediaIdentity[key], identity[key]);
    }
}

function loadTransmuxingWorker() {
    const sourcePath = path.resolve(__dirname, '../src/core/transmuxing-worker.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const controllers = [];
    class FakeMMTSDemuxer {}
    class FakeTSDemuxer {}
    class FakeController extends EventEmitter {
        constructor() {
            super();
            this._demuxer = new FakeMMTSDemuxer();
            this.operations = [];
            controllers.push(this);
        }
        start() {}
        stop() {}
        pause() {}
        resume() {}
        destroy() {}
        resetMMTSStartupGroup() {
            this.operations.push({type: 'reset_startup'});
        }
        cancelMMTSVodAudioTrackRebuild() {}
        acknowledgeMMTSVodAudioTrackStartup() {}
        seek(milliseconds) {
            this.operations.push({type: 'seek', milliseconds});
        }
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek, switchIdentity) {
            this.operations.push({
                type: 'select', packetId, timelineSeed, rebuildFromSeek, switchIdentity,
            });
        }
    }
    const transmuxingEvents = TRANSMUXING_EVENTS;
    const requireMap = {
        '../utils/logger.js': {__esModule: true, default: {v() {}, w() {}, e() {}}},
        '../utils/logging-control.js': {
            __esModule: true,
            default: {
                applyConfig() {},
                addLogListener() {},
                removeLogListener() {},
            },
        },
        '../utils/polyfill.js': {__esModule: true, default: {install() {}}},
        './transmuxing-controller.js': {__esModule: true, default: FakeController},
        './transmuxing-events': {__esModule: true, default: transmuxingEvents},
        '../demux/ts-demuxer.ts': {__esModule: true, default: FakeTSDemuxer},
        '../demux/mmts-demuxer.ts': {__esModule: true, default: FakeMMTSDemuxer},
        './playback-operation': {
            clonePlaybackOperation(operation) { return Object.assign({}, operation); },
            isPlaybackOperation(operation) { return operation != null; },
            isSamePlaybackOperation(left, right) {
                if (!left || !right) return false;
                return left.timelineGeneration === right.timelineGeneration &&
                    left.transactionId === right.transactionId && left.kind === right.kind &&
                    left.attempt === right.attempt && left.phase === right.phase &&
                    left.requestedTimeMilliseconds === right.requestedTimeMilliseconds &&
                left.packetId === right.packetId;
            },
        },
        './mmts-startup-group-lifecycle': {
            isMMTSStartupGroupFailure: isStartupGroupFailure,
        },
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return {
        TransmuxingWorker: moduleObject.exports.default,
        controllers,
        transmuxingEvents,
    };
}

function testTransmuxingWorkerAtomicallySeeksAndSelectsVodAudioTrack() {
    const {TransmuxingWorker, controllers, transmuxingEvents} = loadTransmuxingWorker();
    const posted = [];
    let onMessage = null;
    const workerScope = {
        addEventListener(type, listener) {
            if (type === 'message') {
                onMessage = listener;
            }
        },
        postMessage(message) {
            posted.push(message);
        },
    };
    TransmuxingWorker(workerScope);
    const dispatch = (data) => onMessage({data});

    dispatch({cmd: 'init', param: [{}, {}]});
    const controller = controllers[0];
    controller.emit(transmuxingEvents.INIT_SEGMENT, 'audio', {data: new ArrayBuffer(0)});
    dispatch({
        cmd: 'seek_and_select_audio_track',
        param: 195445,
        packet_id: 0xf111,
        timeline_seed: 195445,
        mmts_audio_switch_identity: {id: 9, attempt: 0},
        mmts_vod_audio_track_rebuild_epoch: 4,
    });
    controller.emit(transmuxingEvents.MMTS_AUDIO_TRACKS, {selectedPacketId: 0xf111});
    controller.emit(transmuxingEvents.INIT_SEGMENT, 'audio', {data: new ArrayBuffer(0)});
    dispatch({
        cmd: 'sync_mmts_vod_audio_track_rebuild_epoch',
        mmts_vod_audio_track_rebuild_epoch: 5,
    });
    controller.emit(transmuxingEvents.MEDIA_SEGMENT, 'audio', {data: new ArrayBuffer(0)});

    assert.strictEqual(posted[0].mmts_vod_audio_track_rebuild_epoch, 0);
    assert.strictEqual(posted[1].mmts_vod_audio_track_rebuild_epoch, 4);
    assert.strictEqual(posted[2].mmts_vod_audio_track_rebuild_epoch, 4);
    assert.strictEqual(posted[3].mmts_vod_audio_track_rebuild_epoch, 5);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(controller.operations)), [
        {type: 'reset_startup'},
        {type: 'seek', milliseconds: 195445},
        {
            type: 'select',
            packetId: 0xf111,
            timelineSeed: 195445,
            rebuildFromSeek: true,
            switchIdentity: {id: 9, attempt: 0},
        },
    ]);
}

function testVodRebuildCancellationImmediatelySynchronizesWorkerEpoch() {
    const {Transmuxer} = loadTransmuxer();
    const posted = [];
    const transmuxer = Object.create(Transmuxer.prototype);
    transmuxer._worker = {
        postMessage(message) {
            posted.push(message);
        },
    };
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 4;
    transmuxer._mmtsVodAudioTrackRebuildPending = true;
    transmuxer._mmtsVodAudioTrackRebuildSeekPending = false;

    transmuxer.cancelMMTSVodAudioTrackRebuild();

    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildEpoch, 5);
    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildPending, false);
    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildSeekPending, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), [{
        cmd: 'sync_mmts_vod_audio_track_rebuild_epoch',
        mmts_vod_audio_track_rebuild_epoch: 5,
    }]);
}

async function testVodRebuildInvalidatesQueuedAndStaleWorkerEvents() {
    const {Transmuxer, transmuxingEvents} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    const events = [];
    transmuxer._emitter = new EventEmitter();
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 0;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer.on(transmuxingEvents.INIT_SEGMENT, (type, segment) => {
        events.push({event: 'init', type, id: segment.id});
    });
    transmuxer.on(transmuxingEvents.MEDIA_SEGMENT, (type, segment) => {
        events.push({event: 'media', type, id: segment.id});
    });
    transmuxer.on(transmuxingEvents.MMTS_AUDIO_TRACKS, (tracks) => {
        events.push({event: 'tracks', selectedPacketId: tracks.selectedPacketId});
        transmuxer.completeMMTSVodAudioTrackRebuild();
    });

    transmuxer._onInitSegment('audio', {id: 'queued-init'});
    transmuxer._onMediaSegment('video', {id: 'queued-video'});
    transmuxer.beginMMTSVodAudioTrackRebuild();
    transmuxer.completeMMTSVodAudioTrackRebuild();
    await Promise.resolve();

    assert.deepStrictEqual(events, []);

    transmuxer.beginMMTSVodAudioTrackRebuild();
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.INIT_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {type: 'audio', data: {id: 'stale-init'}},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MEDIA_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {type: 'video', data: {id: 'stale-video'}},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MMTS_AUDIO_TRACKS,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {selectedPacketId: 0xf111},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.INIT_SEGMENT,
        data: {type: 'audio', data: {id: 'untagged-init'}},
    }});
    assert.deepStrictEqual(events, []);

    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MMTS_AUDIO_TRACKS,
        mmts_vod_audio_track_rebuild_epoch: 2,
        data: {selectedPacketId: 0xf111},
    }});
    assert.deepStrictEqual(events, [{event: 'tracks', selectedPacketId: 0xf111}]);

    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MEDIA_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {type: 'audio', data: {id: 'late-stale-media'}},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.INIT_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 2,
        data: {type: 'audio', data: {id: 'rebuilt-init'}},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MEDIA_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 2,
        data: {type: 'audio', data: {id: 'rebuilt-media'}},
    }});
    assert.deepStrictEqual(events, [
        {event: 'tracks', selectedPacketId: 0xf111},
        {event: 'init', type: 'audio', id: 'rebuilt-init'},
        {event: 'media', type: 'audio', id: 'rebuilt-media'},
    ]);
}

async function testInlineVodRebuildKeepsFreshQueuedOutput() {
    const {Transmuxer, transmuxingEvents} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    const events = [];
    transmuxer._emitter = new EventEmitter();
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 0;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer.on(transmuxingEvents.MMTS_AUDIO_TRACKS, (tracks) => {
        events.push({event: 'tracks', selectedPacketId: tracks.selectedPacketId});
        transmuxer.completeMMTSVodAudioTrackRebuild();
    });
    transmuxer.on(transmuxingEvents.INIT_SEGMENT, (_type, segment) => {
        events.push({event: 'init', id: segment.id});
    });
    transmuxer.on(transmuxingEvents.MEDIA_SEGMENT, (_type, segment) => {
        events.push({event: 'media', id: segment.id});
    });

    transmuxer.beginMMTSVodAudioTrackRebuild();
    transmuxer._onMMTSAudioTracks({selectedPacketId: 0xf111});
    transmuxer._onInitSegment('audio', {id: 'fresh-init'});
    transmuxer._onMediaSegment('audio', {id: 'fresh-media'});
    await Promise.resolve();

    assert.deepStrictEqual(events, [
        {event: 'tracks', selectedPacketId: 0xf111},
        {event: 'init', id: 'fresh-init'},
        {event: 'media', id: 'fresh-media'},
    ]);
}

function testVodRebuildUsesOneAtomicWorkerCommand() {
    const {Transmuxer} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    const messages = [];
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 0;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer._worker = {
        postMessage(message) {
            messages.push(message);
        },
    };

    transmuxer.beginMMTSVodAudioTrackRebuild();
    transmuxer.seekAndSelectAudioTrack(
        195445,
        undefined,
        0xf111,
        195445,
        {id: 9, attempt: 0}
    );

    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        {
            cmd: 'seek_and_select_audio_track',
            param: 195445,
            packet_id: 0xf111,
            timeline_seed: 195445,
            mmts_audio_switch_identity: {id: 9, attempt: 0},
            mmts_vod_audio_track_rebuild_epoch: 1,
        },
    ]);
}

function testVodRebuildCancellationTagsNextSeekAndRejectsOldEpoch() {
    const {Transmuxer, transmuxingEvents} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    const messages = [];
    const events = [];
    transmuxer._emitter = new EventEmitter();
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 0;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer._mmtsVodAudioTrackRebuildSeekPending = false;
    transmuxer._worker = {
        postMessage(message) {
            messages.push(message);
        },
    };
    transmuxer.on(transmuxingEvents.MMTS_AUDIO_TRACKS, (tracks) => {
        events.push({type: 'tracks', selectedPacketId: tracks.selectedPacketId});
    });
    transmuxer.on(transmuxingEvents.INIT_SEGMENT, (type, segment) => {
        events.push({type: 'init', trackType: type, id: segment.id});
    });

    transmuxer.beginMMTSVodAudioTrackRebuild();
    transmuxer.cancelMMTSVodAudioTrackRebuild();
    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildEpoch, 2);
    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildPending, false);

    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.MMTS_AUDIO_TRACKS,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {selectedPacketId: 0xf111},
    }});
    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.INIT_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 1,
        data: {type: 'audio', data: {id: 'stale-init'}},
    }});
    assert.deepStrictEqual(events, []);

    transmuxer.seek(220000);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [
        {
            cmd: 'sync_mmts_vod_audio_track_rebuild_epoch',
            mmts_vod_audio_track_rebuild_epoch: 2,
        },
        {
            cmd: 'seek',
            param: 220000,
            mmts_vod_audio_track_rebuild_epoch: 2,
        },
    ]);
    assert.strictEqual(transmuxer._mmtsVodAudioTrackRebuildSeekPending, false);

    transmuxer._onWorkerMessage({data: {
        msg: transmuxingEvents.INIT_SEGMENT,
        mmts_vod_audio_track_rebuild_epoch: 2,
        data: {type: 'audio', data: {id: 'fresh-init'}},
    }});
    assert.deepStrictEqual(events, [
        {type: 'init', trackType: 'audio', id: 'fresh-init'},
    ]);
}

function testInlineVodRebuildResetsStartupCollectorAtSeek() {
    const {Transmuxer} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    const operations = [];
    transmuxer._worker = null;
    transmuxer._mmtsVodAudioTrackRebuildPending = true;
    transmuxer._controller = {
        resetMMTSStartupGroup() {
            operations.push({type: 'reset_startup'});
        },
        seek(milliseconds) {
            operations.push({type: 'seek', milliseconds});
        },
    };

    transmuxer.seek(195445);
    assert.deepStrictEqual(operations, [
        {type: 'reset_startup'},
        {type: 'seek', milliseconds: 195445},
    ]);

    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer.seek(196000);
    assert.deepStrictEqual(operations, [
        {type: 'reset_startup'},
        {type: 'seek', milliseconds: 195445},
        {type: 'seek', milliseconds: 196000},
    ]);
}

function testMainVodRebuildRequestsAtomicSeekAndSelection() {
    const {engine, operations} = makeVodSwitchHarness(3.03);
    engine.selectAudioTrack(0xf111);
    const transaction = engine._pending_mmts_vod_audio_track_switch;
    const output = vodSwitchStateMachineOutputs.get(engine);

    output.seekTransmuxer(
        3030,
        'MMTS_VOD_AUDIO_TRACK_REBUILD',
        transaction.operation
    );

    const atomic = operations.find((operation) => operation.type === 'seek_and_select');
    assert(atomic, 'expected one atomic VOD seek-and-select request');
    assert.strictEqual(atomic.milliseconds, 3030);
    assert.strictEqual(atomic.packetId, 0xf111);
    assert.strictEqual(atomic.timelineSeed, 3030);
    assert.strictEqual(atomic.operation, transaction.operation);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(atomic.switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)
        ))
    );
    assert.strictEqual(operations.some((operation) => operation.type === 'seek'), false);
    assert.strictEqual(operations.some((operation) => operation.type === 'select'), false);
}

function testMainThreadRebuildReleasesOldMediaSourceBeforeAttachAndResumesAfterSeek() {
    let stateMachineOutput = null;
    class CapturingMSEBufferStateMachine {
        constructor(_config, output) {
            stateMachineOutput = output;
        }
    }
    const PlayerEngineMainThread = loadPlayerEngineMainThread({
        MSEBufferStateMachine: CapturingMSEBufferStateMachine,
    });
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    const operations = [];
    const oldController = {
        abandon() {
            operations.push({type: 'abandon'});
        },
        revokeObjectURL() {
            operations.push({type: 'revoke'});
        },
        shutdown() {
            throw new Error('old MediaSource must not be shutdown');
        },
    };
    const replacementController = {
        setMediaDuration(duration) {
            operations.push({type: 'duration', duration});
        },
    };
    engine._config = {isLive: false};
    engine._media_info = {duration: 459659};
    engine._media_element = {
        paused: false,
        ended: false,
        play() {
            operations.push({type: 'play'});
            return Promise.resolve();
        },
    };
    engine._mse_controller = oldController;
    engine._mse_source_opened = true;
    engine._mmts_audio_track_switch_rebuild_in_progress = true;
    engine._seeking_handler = {
        directSeek(targetTime) {
            operations.push({type: 'seek_media', targetTime});
        },
    };
    engine._createMSEController = () => replacementController;
    engine._attachMSEControllerToMediaElement = (controller) => {
        operations.push({type: 'attach', replacement: controller === replacementController});
    };

    assert.strictEqual(engine._executeMMTSAudioTrackSwitchMediaSourceRebuild({
        resumePlayback: true,
    }), true);
    assert.strictEqual(engine._mse_controller, replacementController);
    assert.strictEqual(engine._mse_source_opened, false);
    assert.deepStrictEqual(operations, [
        {type: 'abandon'},
        {type: 'attach', replacement: true},
        {type: 'revoke'},
        {type: 'duration', duration: 459.659},
    ]);

    engine._createMSEBufferStateMachine();
    stateMachineOutput.seekMedia(195.445, 'AUDIO_TRACK_SWITCH_REBUILD');
    stateMachineOutput.onAudioTrackSwitchRebuildComplete();
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, true);
    engine._mmts_audio_track_switch_rebuild_in_progress = false;
    engine._resumePlaybackAfterMMTSAudioTrackSwitchRebuild();
    assert.strictEqual(operations[operations.length - 1].type, 'play');

    engine._mmts_audio_track_switch_rebuild_in_progress = true;
    engine._resume_playback_after_audio_track_switch_rebuild = false;
    stateMachineOutput.seekMedia(196, 'AUDIO_TRACK_SWITCH_REBUILD');
    stateMachineOutput.onAudioTrackSwitchRebuildComplete();
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, true);
    engine._mmts_audio_track_switch_rebuild_in_progress = false;
    engine._resumePlaybackAfterMMTSAudioTrackSwitchRebuild();
    assert.strictEqual(operations.filter((operation) => operation.type === 'play').length, 1);
}

function testMainThreadRebuildDoesNotResumeAfterUserPauses() {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    const operations = [];
    engine._config = {isLive: true};
    engine._media_element = {
        paused: true,
        ended: false,
        play() {
            operations.push({type: 'play'});
            return Promise.resolve();
        },
    };
    engine._mse_controller = {
        abandon() {
            operations.push({type: 'abandon'});
        },
        revokeObjectURL() {
            operations.push({type: 'revoke'});
        },
    };
    const replacementController = {};
    engine._createMSEController = () => replacementController;
    engine._attachMSEControllerToMediaElement = () => {
        operations.push({type: 'attach'});
    };

    assert.strictEqual(engine._executeMMTSAudioTrackSwitchMediaSourceRebuild({
        resumePlayback: true,
    }), true);
    assert.strictEqual(engine._resume_playback_after_audio_track_switch_rebuild, false);
    engine._resumePlaybackAfterMMTSAudioTrackSwitchRebuild();
    assert.deepStrictEqual(operations, [
        {type: 'abandon'},
        {type: 'attach'},
        {type: 'revoke'},
    ]);
}

function testVodAudioSwitchPreservesFractionalMillisecondContract() {
    const requestedTime = 2.213875;
    const {engine, operations} = makeVodSwitchHarness(requestedTime);

    engine.selectAudioTrack(0xf111);
    engine._issueMMTSVodAudioTrackSelection();

    const selection = operations.find((operation) => operation.type === 'select');
    assert(selection, 'expected audio-track selection command');
    assert.strictEqual(
        selection.timelineSeed,
        engine._audio_track_switch_coordinator.active.operation.requestedTimeMilliseconds
    );

    confirmVodAudioTrackSwitch(engine, 0xf111);
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup(
        makeVodRebuildStartupGroup(engine, 0xf111, selection.timelineSeed / 1000)
    ).status, 'accepted');
}

function testVodAudioSwitchRebuildsCurrentTimelineWindow() {
    const {engine, operations} = makeVodSwitchHarness(195.445);

    engine.selectAudioTrack(0xf111);
    engine.selectAudioTrack(0xf111);

    assert.deepStrictEqual(operations, [
        {type: 'begin'},
        {type: 'rebuild', targetTime: 195.445},
    ]);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.selectionIssued, false);
    assert.strictEqual(engine._pending_audio_track_switch_request_time, null);
    assert.strictEqual(engine._accepted_audio_track_switch_time, null);
    assert.strictEqual(engine._pending_audio_track_switch_init_segment, null);

    engine._transmuxer.seek(195445);
    engine._issueMMTSVodAudioTrackSelection();

    assert.deepStrictEqual(operations, [
        {type: 'begin'},
        {type: 'rebuild', targetTime: 195.445},
        {type: 'seek', milliseconds: 195445},
        {type: 'select', packetId: 0xf111, timelineSeed: 195445, rebuildFromSeek: true},
    ]);
    assert.strictEqual(
        operations.some((operation) =>
            (operation.type === 'seek' && operation.milliseconds === 0) ||
            (operation.type === 'select' && operation.timelineSeed === 0)
        ),
        false
    );

    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf111);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(operations.some((operation) => operation.type === 'complete'), false);

    confirmVodAudioTrackSwitch(engine, 0xf111);
    assert.strictEqual(operations[operations.length - 1].type, 'complete');
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.confirmedPacketId, 0xf111);

    const matchingSwitch = makeAudioSwitchContract(
        engine._pending_mmts_vod_audio_track_switch.operation,
        0xf111,
        195.445
    );
    const matchingMediaSwitch = Object.assign({}, matchingSwitch, {
        audioDecodeStart: 195.2,
        audioStart: 195.2,
        audioEnd: 195.36,
    });

    const videoInitSegment = {
        type: 'video',
        container: 'video/mp4',
        codec: 'hvc1.2.1.L183.B0',
        data: {byteLength: 32},
    };
    const audioInitSegment = {
        type: 'audio',
        codec: 'mp4a.40.5',
        mmtsAudioTrackSwitch: matchingSwitch,
    };
    const videoMediaSegment = {
        type: 'video',
        data: {byteLength: 64},
        mmtsRandomAccessSafe: true,
        info: {
            beginDts: 195200,
            endDts: 195350,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: {
            decodeStart: 195.2,
            compositionStart: 195.2,
            syncPoint: 195.2,
            playableStart: 195.2,
            playableEnd: 195.35,
        },
    };
    const audioMediaSegment = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 195200, endDts: 195360},
        mmtsAudioTrackSwitch: matchingMediaSwitch,
    };
    const staleOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._pending_mmts_vod_audio_track_switch.operation.scopeId,
        timelineGeneration:
            engine._pending_mmts_vod_audio_track_switch.operation.timelineGeneration + 1,
        kind: 'audio-switch',
        transactionId: matchingSwitch.id + 1,
        phase: 'requested',
        requestedTimeMilliseconds: 195445,
        packetId: 0xf111,
    });
    const staleTransactionSwitch = makeAudioSwitchContract(staleOperation, 0xf111, 195.445);
    const staleMediaSwitch = Object.assign({}, staleTransactionSwitch, {
        audioDecodeStart: 195.2,
        audioStart: 195.2,
        audioEnd: 195.36,
    });
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment,
        audioInitSegment: Object.assign({}, audioInitSegment, {
            mmtsAudioTrackSwitch: staleTransactionSwitch,
        }),
        videoMediaSegment,
        audioMediaSegment: Object.assign({}, audioMediaSegment, {
            mmtsAudioTrackSwitch: staleMediaSwitch,
        }),
    }).status, 'stale');
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'waiting_startup');
    assert.strictEqual(operations.some((operation) => operation.type === 'plan'), false);
    const mixedOperationResult = engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment,
        audioInitSegment: Object.assign({}, audioInitSegment, {
            mmtsAudioTrackSwitch: Object.assign({}, matchingSwitch, {id: 8}),
        }),
        videoMediaSegment,
        audioMediaSegment,
    });
    assert.strictEqual(mixedOperationResult.status, 'invalid');
    assert.strictEqual(mixedOperationResult.reason, 'mixed-operation');
    assert.notStrictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    const invalidVideoWindowResult = engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment,
        audioInitSegment,
        videoMediaSegment: Object.assign({}, videoMediaSegment, {
            firstPlayableWindow: Object.assign({}, videoMediaSegment.firstPlayableWindow, {
                playableStart: 197,
                playableEnd: 198,
            }),
        }),
        audioMediaSegment,
    });
    assert.strictEqual(invalidVideoWindowResult.status, 'invalid');
    assert.strictEqual(invalidVideoWindowResult.reason, 'missing-video-window');
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment,
        audioInitSegment,
        videoMediaSegment,
        audioMediaSegment,
    }).status, 'accepted');
    assert.notStrictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(
        operations.some((operation) => operation.type === 'plan'),
        false
    );

    const discontinuousVideoSegment = {
        type: 'video',
        data: {byteLength: 64},
        info: {beginDts: 195600, endDts: 195700},
    };
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'video',
        discontinuousVideoSegment
    ), false);

    const videoContinuation = {
        type: 'video',
        data: {byteLength: 64},
        info: {beginDts: 195350, endDts: 195470},
    };
    const audioContinuation = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 195360, endDts: 195460},
    };
    const staleAttemptAudioContinuation = Object.assign({}, audioContinuation, {
        mmtsAudioTrackSwitch: Object.assign({}, matchingMediaSwitch, {
            attempt: matchingMediaSwitch.attempt + 1,
            audioEnd: 195.46,
        }),
    });
    const videoCoverage = {
        type: 'video',
        data: {byteLength: 64},
        info: {beginDts: 195470, endDts: 195650},
    };
    const audioCoverage = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 195460, endDts: 195640},
    };
    const audioSafetyMargin = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 195640, endDts: 195820},
    };
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'video',
        videoContinuation
    ), true);
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'audio',
        staleAttemptAudioContinuation
    ), false);
    assert.strictEqual(engine._tryApplyMMTSVodAudioTrackSwitchRebuild(), false);
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'audio',
        audioContinuation
    ), true);
    assert.strictEqual(engine._tryApplyMMTSVodAudioTrackSwitchRebuild(), false);
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'video',
        videoCoverage
    ), true);
    assert.strictEqual(engine._tryApplyMMTSVodAudioTrackSwitchRebuild(), false);
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'audio',
        audioCoverage
    ), true);
    assert.strictEqual(engine._tryApplyMMTSVodAudioTrackSwitchRebuild(), false);
    assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia(
        'audio',
        audioSafetyMargin
    ), true);
    assert.strictEqual(engine._tryApplyMMTSVodAudioTrackSwitchRebuild(), true);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'rebuilding');
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, true);
    const operationCount = operations.length;
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(operations.length, operationCount);
    const queuedAudioIntent = engine._operation_scheduler.queued.find(
        (intent) => intent.operation.kind === 'audio-switch'
    );
    assert(queuedAudioIntent);
    assert.strictEqual(queuedAudioIntent.payload.reservation.targetPacketId, 0xf110);
    const planOperation = operations.find((operation) => operation.type === 'plan');
    assert(planOperation);
    assert.strictEqual(planOperation.request.stage, 'rebuild_ready');
    assert.strictEqual(planOperation.request.mode, 'vod-forward');
    assert.strictEqual(planOperation.request.replaceMediaSource, false);
    assert.strictEqual(planOperation.request.preserveVideoBuffer, true);
    assert.strictEqual(planOperation.request.switchTime, 195.445);
    assert.strictEqual(planOperation.request.seekTime, 195.445);
    assert.strictEqual(planOperation.request.resumePlayback, true);
    assert.strictEqual(planOperation.request.videoInitSegment, null);
    assert.strictEqual(planOperation.request.audioInitSegment, audioInitSegment);
    assert.strictEqual(planOperation.request.videoSegments.length, 0);
    assert.strictEqual(planOperation.request.audioSegments.length, 4);
    assert.strictEqual(planOperation.request.audioSegments[0], audioMediaSegment);
    assert.strictEqual(planOperation.request.audioSegments[1], audioContinuation);
    assert.strictEqual(planOperation.request.audioSegments[2], audioCoverage);
    assert.strictEqual(planOperation.request.audioSegments[3], audioSafetyMargin);
    assert.strictEqual('resetParserState' in audioInitSegment, false);
    assert.strictEqual('rebuildSourceBuffer' in audioInitSegment, false);
}

function testVodAudioSwitchRebuildsImmediatelyWhenStartupGroupCoversTarget() {
    const {engine, operations} = makeVodSwitchHarness(12.345);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(12345);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);

    const matchingSwitch = makeAudioSwitchContract(
        engine._pending_mmts_vod_audio_track_switch.operation,
        0xf111,
        12.345
    );
    const audioSwitch = Object.assign({}, matchingSwitch, {
        audioDecodeStart: 12.2,
        audioStart: 12.2,
        audioEnd: 12.7,
    });
    const videoMediaSegment = {
        type: 'video',
        data: {byteLength: 64},
        mmtsRandomAccessSafe: true,
        info: {
            beginDts: 12000,
            endDts: 12133,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: {
            decodeStart: 12,
            compositionStart: 12.18,
            syncPoint: 12.345,
            playableStart: 12.345,
            playableEnd: 12.5,
        },
    };
    const audioMediaSegment = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 12200, endDts: 12700},
        mmtsAudioTrackSwitch: audioSwitch,
    };
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment: {type: 'video'},
        audioInitSegment: {type: 'audio', mmtsAudioTrackSwitch: matchingSwitch},
        videoMediaSegment,
        audioMediaSegment,
    }).status, 'accepted');

    const plan = operations.find((operation) => operation.type === 'plan').request;
    assert.strictEqual(plan.seekTime, 12.345);
    assert.strictEqual(plan.preserveVideoBuffer, true);
    assert.strictEqual(plan.videoSegments.length, 0);
    assert.strictEqual(plan.audioSegments.length, 1);
    assert.strictEqual(
        operations.some((operation) =>
            (operation.type === 'seek' && operation.milliseconds === 0) ||
            (operation.type === 'select' && operation.timelineSeed === 0)
        ),
        false
    );
}

function testVodAudioSwitchCollectsBeyondThirtyTwoSegments() {
    const requestedTime = 105;
    const {engine, operations} = makeVodSwitchHarness(requestedTime);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(requestedTime * 1000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);

    const matchingSwitch = makeAudioSwitchContract(
        engine._pending_mmts_vod_audio_track_switch.operation,
        0xf111,
        requestedTime
    );
    const segmentDuration = 125;
    const timelineStart = 100000;
    const startupEnd = timelineStart + segmentDuration;
    const videoStartupSegment = {
        type: 'video',
        data: {byteLength: 64},
        mmtsRandomAccessSafe: true,
        info: {
            beginDts: timelineStart,
            endDts: startupEnd,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: {
            decodeStart: timelineStart / 1000,
            compositionStart: timelineStart / 1000,
            syncPoint: timelineStart / 1000,
            playableStart: timelineStart / 1000,
            playableEnd: startupEnd / 1000,
        },
    };
    const audioStartupSegment = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: timelineStart, endDts: startupEnd},
        mmtsAudioTrackSwitch: Object.assign({}, matchingSwitch, {
            audioDecodeStart: timelineStart / 1000,
            audioStart: timelineStart / 1000,
            audioEnd: startupEnd / 1000,
        }),
    };
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup({
        hasVideo: true,
        hasAudio: true,
        videoInitSegment: {type: 'video'},
        audioInitSegment: {type: 'audio', mmtsAudioTrackSwitch: matchingSwitch},
        videoMediaSegment: videoStartupSegment,
        audioMediaSegment: audioStartupSegment,
    }).status, 'accepted');

    const appendSegmentPair = (index) => {
        const beginDts = timelineStart + index * segmentDuration;
        const endDts = beginDts + segmentDuration;
        assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia('video', {
            type: 'video',
            data: {byteLength: 64},
            info: {beginDts, endDts},
        }), true);
        const videoApplied = engine._tryApplyMMTSVodAudioTrackSwitchRebuild();
        assert.strictEqual(engine._collectMMTSVodAudioTrackSwitchMedia('audio', {
            type: 'audio',
            data: {byteLength: 32},
            info: {beginDts, endDts},
        }), true);
        const audioApplied = engine._tryApplyMMTSVodAudioTrackSwitchRebuild();
        return {videoApplied, audioApplied};
    };

    for (let index = 1; index < 32; index++) {
        assert.deepStrictEqual(appendSegmentPair(index), {
            videoApplied: false,
            audioApplied: false,
        });
    }
    assert.strictEqual(
        operations.some((operation) => operation.type === 'plan'),
        false
    );
    assert.strictEqual(
        engine._pending_mmts_vod_audio_track_switch.rebuildWindow.videoSegments.length,
        32
    );
    assert.strictEqual(
        engine._pending_mmts_vod_audio_track_switch.rebuildWindow.audioSegments.length,
        32
    );

    for (let index = 32; index <= 41; index++) {
        const result = appendSegmentPair(index);
        assert.strictEqual(result.videoApplied, false);
        assert.strictEqual(result.audioApplied, index === 41);
    }

    const plan = operations.find((operation) => operation.type === 'plan').request;
    assert.strictEqual(plan.stage, 'rebuild_ready');
    assert.strictEqual(plan.seekTime, requestedTime);
    assert.strictEqual(plan.preserveVideoBuffer, true);
    assert.strictEqual(plan.videoSegments.length, 0);
    assert.strictEqual(plan.audioSegments.length, 42);
}

function testEarlyVodAudioSwitchContinuesFromStreamStart() {
    const {engine, operations} = makeVodSwitchHarness(0);

    engine.selectAudioTrack(0xf111);

    assert.deepStrictEqual(operations, [
        {type: 'begin'},
        {type: 'rebuild', targetTime: 0},
    ]);

    engine._transmuxer.seek(0);
    engine._issueMMTSVodAudioTrackSelection();

    assert.deepStrictEqual(operations, [
        {type: 'begin'},
        {type: 'rebuild', targetTime: 0},
        {type: 'seek', milliseconds: 0},
        {type: 'select', packetId: 0xf111, timelineSeed: 0, rebuildFromSeek: true},
    ]);
    assert.strictEqual(engine._accepted_audio_track_switch_time, null);
    assert.strictEqual(engine._pending_audio_track_switch_request_time, null);
}

function testVodUserSeekCancelsRebuildAndAllowsSwitchBackToPrimary() {
    const {engine, operations} = makeVodSwitchHarness(195.445);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(195445);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);

    engine.selectAudioTrack(0xf110);
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf110);
    engine._media_element.currentTime = 220;

    assert.strictEqual(engine._onControlledSeekRequest(220, 'user'), true);
    flushPendingMMTSSeek(engine);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._pending_audio_track_switch_request_time, null);
    assert.strictEqual(engine._pending_audio_track_switch_expected_packet_id, null);
    assert.strictEqual(engine._accepted_audio_track_switch_time, null);
    assert.strictEqual(engine._pending_audio_track_switch_init_segment, null);
    assert.strictEqual(engine._pending_audio_track_switch_media_segments.length, 0);
    assert.strictEqual(engine._pending_audio_track_switch_resume_playback, false);
    assert.strictEqual(engine._resume_playback_after_audio_track_switch_rebuild, false);
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, false);
    assert.strictEqual(engine._mmts_live_video_rebuild_window, null);
    assert.deepStrictEqual(operations.slice(-3), [
        {type: 'cancel'},
        {type: 'cancel_state_machine', transactionId: 1},
        {type: 'user_seek', targetTime: 220},
    ]);

    const operationCount = operations.length;
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(operations.length, operationCount);
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf110);

    engine._onRequiredUnbufferedSeek(221000);
    flushPendingMMTSSeek(engine);
    assert.deepStrictEqual(operations.slice(-1), [
        {type: 'user_seek', targetTime: 221},
    ]);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
}

function testLiveAudioSwitchIsForwardOnlyAndSelectsRebuildStrategy(
    Browser = {chrome: false},
    expectedReplaceMediaSource = false
) {
    class FakeTransmuxer extends EventEmitter {
        constructor() {
            super();
            this.operations = [];
        }
        open() {}
        canSetPlaybackOperation() { return true; }
        setPlaybackOperation(operation) {
            this.playbackOperation = operation;
            return true;
        }
        emit(event, ...args) {
            args.push(this.playbackOperation);
            return super.emit(event, ...args);
        }
        seek(milliseconds) {
            this.operations.push({type: 'seek', milliseconds});
        }
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek = false, switchIdentity) {
            this.operations.push({type: 'select', packetId, timelineSeed, rebuildFromSeek, switchIdentity});
        }
    }

    const PlayerEngineMainThread = loadPlayerEngineMainThread({
        Browser,
        Transmuxer: FakeTransmuxer,
    });
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    const stateMachineOperations = [];
    const stateMachine = {
        pendingRebuild: false,
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onAudioTrackSwitch(request) {
            stateMachineOperations.push({type: 'switch', request});
            if (request.stage === 'rebuild_ready') {
                this.pendingRebuild = true;
            }
            return true;
        },
        cancelAudioTrackSwitch(operation) {
            stateMachineOperations.push({type: 'cancel_rebuild', transactionId: operation.transactionId});
            this.pendingRebuild = false;
            return true;
        },
        onUserSeek(targetTime) {
            stateMachineOperations.push({type: 'user_seek', targetTime});
        },
        onInitSegment(type, segment) {
            stateMachineOperations.push({type: 'init', trackType: type, segment});
        },
        onMediaSegment(type, segment) {
            stateMachineOperations.push({type: 'media', trackType: type, segment});
        },
        onStartupGroup(group) {
            stateMachineOperations.push({type: 'startup', group});
        },
        onMediaState() {},
    };
    engine._media_data_source = {type: 'mmts'};
    engine._config = {
        isMMTS: true,
        isLive: true,
        deferLoadAfterSourceOpen: false,
        lazyLoad: false,
        liveBufferLatencyChasing: false,
        liveSync: false,
        startupBufferDuration: 0,
        mmtsLiveInitialBufferDuration: 0,
    };
    engine._media_element = {currentTime: 10, readyState: 0, paused: false};
    engine._emitter = new EventEmitter();
    engine._transmuxer = null;
    engine._playback_scope_id = `audio-window-live-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._playback_recovery_roots = new Map();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._has_pending_load = false;
    engine._mse_source_opened = false;
    engine._selected_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_video_packet_id = null;
    engine._mmts_video_tracks = [];
    engine._mmts_audio_tracks = makeAudioTracks(0xf110);
    const videoInitSegment = {type: 'video', codec: 'hvc1.2.1.L183.B0'};
    engine._mmts_live_video_rebuild_window = null;
    engine._pending_audio_track_switch_media_segments = [];
    engine._pending_audio_track_switch_resume_playback = false;
    engine._mmts_audio_track_switch_rebuild_in_progress = false;
    engine._mse_controller = {
        getLastInitSegment(type) {
            return type === 'video' ? videoInitSegment : null;
        },
    };
    engine._createMSEBufferStateMachine = () => stateMachine;

    engine.load();
    const startupOperation = Object.assign({}, engine._active_playback_operation);
    videoInitSegment.playbackOperation = Object.assign({}, startupOperation);
    videoInitSegment.mseBufferGeneration = startupOperation.timelineGeneration;

    const videoMediaSegment = {
        type: 'video',
        data: {byteLength: 64},
        info: {syncPoints: [], beginDts: 10000, endDts: 10300},
        firstPlayableWindow: {
            decodeStart: 10,
            compositionStart: 10,
            syncPoint: 10,
            playableStart: 10,
            playableEnd: 10.3,
        },
        playbackOperation: Object.assign({}, startupOperation),
        mseBufferGeneration: startupOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment,
        videoMediaSegment,
        hasVideo: true,
        hasAudio: true,
        startupTime: 10,
    });
    stateMachineOperations.splice(0, stateMachineOperations.length);

    engine.selectAudioTrack(0xf111);
    engine.selectAudioTrack(0xf111);
    const switchOperation = Object.assign({}, engine._active_playback_operation);
    assert.strictEqual(engine._mmts_live_video_rebuild_window, null);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(engine._transmuxer.operations)), [
        {
            type: 'select',
            packetId: 0xf111,
            timelineSeed: 10500,
            rebuildFromSeek: false,
            switchIdentity: JSON.parse(JSON.stringify(
                playbackOperationModule.createPlaybackSwitchIdentity(switchOperation)
            )),
        },
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(stateMachineOperations)), [{
        type: 'switch',
        request: {
            stage: 'request',
            mode: 'live',
            operation: switchOperation,
            transactionId: 2,
        },
    }]);
    assert.strictEqual(engine._pending_audio_track_switch_request_time, 10.5);

    engine._transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf110),
        selectedPacketId: 0xf110,
    });
    assert.strictEqual(engine._pending_audio_track_switch_request_time, 10.5);
    assert.strictEqual(engine._pending_audio_track_switch_expected_packet_id, 0xf111);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);

    const staleSwitch = {
        id: 9,
        attempt: 0,
        packetId: 0xf110,
        requestedStart: 9.5,
        audioDecodeStart: 9.5,
        audioStart: 9.5,
        audioEnd: 10.5,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', {
        type: 'audio',
        codec: 'mp4a.40.2',
        mmtsAudioTrackSwitch: staleSwitch,
    });
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', {
        type: 'audio',
        info: {endDts: 10500},
        mmtsAudioTrackSwitch: staleSwitch,
    });
    assert.strictEqual(stateMachineOperations.length, 1);

    engine._transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', {
        type: 'audio',
        codec: 'mp4a.40.2',
        mmtsAudioTrackSwitch: staleSwitch,
    });
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', {
        type: 'audio',
        info: {endDts: 10500},
        mmtsAudioTrackSwitch: staleSwitch,
    });
    assert.strictEqual(stateMachineOperations.length, 1);

    const audioSwitch = Object.assign(makeAudioSwitchContract(
        engine._audio_track_switch_coordinator.active.operation,
        0xf111,
        10.5
    ), {
        audioDecodeStart: 10.4,
        audioStart: 10.4,
        audioEnd: 10.52,
    });
    const initSegment = {
        type: 'audio',
        container: 'audio/mp4',
        codec: 'mp4a.40.5',
        data: {byteLength: 16},
        mmtsAudioTrackSwitch: audioSwitch,
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', initSegment);
    assert.strictEqual(stateMachineOperations.length, 1);

    const mediaSegment = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 10400, endDts: 10520},
        mmtsAudioTrackSwitch: audioSwitch,
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', mediaSegment);
    assert.strictEqual(stateMachineOperations.length, 1);

    const audioContinuation = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 10520, endDts: 10700},
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', audioContinuation);
    assert.strictEqual(stateMachineOperations.length, 1);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.stage, 'selecting');
    const audioSafetyContinuation = {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 10700, endDts: 10800},
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', audioSafetyContinuation);
    assert.strictEqual(stateMachineOperations.length, 1);

    engine._transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACK_SELECTION_RESULT, Object.assign({
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(
        engine._audio_track_switch_coordinator.active.operation
    )));
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });
    const preservesVideoBuffer = Browser.firefox !== true;
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.stage,
        preservesVideoBuffer ? 'rebuilding' : 'collecting-overlap'
    );

    assert.strictEqual(stateMachineOperations.filter((operation) =>
        operation.type === 'switch' && operation.request.stage === 'rebuild_ready'
    ).length, preservesVideoBuffer ? 1 : 0);
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', videoMediaSegment);
    assert.strictEqual(stateMachineOperations.filter((operation) =>
        operation.type === 'switch' && operation.request.stage === 'rebuild_ready'
    ).length, preservesVideoBuffer ? 1 : 0,
    'old-generation cached video must not enter the rebuild plan');

    const currentVideoRAP = {
        type: 'video',
        data: {byteLength: 64},
        mmtsRandomAccessSafe: true,
        info: {
            syncPoints: [],
            beginDts: 10216,
            endDts: 10349,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: {
            decodeStart: 10.216,
            compositionStart: 10.35,
            syncPoint: 10.5,
            playableStart: 10.5,
            playableEnd: 10.65,
        },
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    };
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', currentVideoRAP);

    const rebuildOperations = stateMachineOperations.filter((operation) =>
        operation.type === 'switch' && operation.request.stage === 'rebuild_ready'
    );
    assert.strictEqual(rebuildOperations.length, 1);
    const rebuild = rebuildOperations[0].request;
    assert.strictEqual(rebuild.stage, 'rebuild_ready');
    assert.strictEqual(rebuild.mode, 'live');
    assert.strictEqual(rebuild.replaceMediaSource, expectedReplaceMediaSource);
    assert.strictEqual(rebuild.preserveVideoBuffer, preservesVideoBuffer);
    assert.strictEqual(rebuild.switchTime, 10.5);
    assert.strictEqual(rebuild.seekTime, 10.5);
    assert.strictEqual(rebuild.resumePlayback, true);
    if (preservesVideoBuffer) {
        assert.strictEqual(rebuild.videoInitSegment, null);
        assert.strictEqual(rebuild.videoSegments.length, 0);
    } else {
        assert.notStrictEqual(rebuild.videoInitSegment, videoInitSegment);
        assert.strictEqual(rebuild.videoInitSegment.codec, videoInitSegment.codec);
        assert.strictEqual(rebuild.videoInitSegment.data, videoInitSegment.data);
        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(rebuild.videoInitSegment.playbackOperation)),
            JSON.parse(JSON.stringify(switchOperation))
        );
        assert.strictEqual(
            rebuild.videoInitSegment.mseBufferGeneration,
            switchOperation.timelineGeneration
        );
        assert.strictEqual(rebuild.videoSegments.length, 1);
        assert.strictEqual(rebuild.videoSegments[0], currentVideoRAP);
    }
    assert.deepStrictEqual(videoInitSegment.playbackOperation, startupOperation);
    assert.strictEqual(videoInitSegment.mseBufferGeneration, startupOperation.timelineGeneration);
    assert.strictEqual(rebuild.audioInitSegment, initSegment);
    assert.strictEqual(rebuild.videoSegments.includes(videoMediaSegment), false);
    assert.strictEqual(rebuild.audioSegments.length, preservesVideoBuffer ? 3 : 2);
    assert.strictEqual(rebuild.audioSegments[0], mediaSegment);
    assert.strictEqual(rebuild.audioSegments[1], audioContinuation);
    if (preservesVideoBuffer) {
        assert.strictEqual(rebuild.audioSegments[2], audioSafetyContinuation);
    }
    assert.strictEqual('resetParserState' in initSegment, false);
    assert.strictEqual('rebuildSourceBuffer' in initSegment, false);
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, true);
    const appendedAudioBeforeLateTagged = stateMachineOperations.filter((operation) =>
        operation.type === 'media' && operation.trackType === 'audio'
    ).length;
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', {
        type: 'audio',
        data: {byteLength: 32},
        info: {beginDts: 10800, endDts: 10900},
        mmtsAudioTrackSwitch: audioSwitch,
        playbackOperation: Object.assign({}, switchOperation),
        mseBufferGeneration: switchOperation.timelineGeneration,
    });
    assert.strictEqual(stateMachineOperations.filter((operation) =>
        operation.type === 'media' && operation.trackType === 'audio'
    ).length, appendedAudioBeforeLateTagged);
    const transmuxerOperationCount = engine._transmuxer.operations.length;
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(engine._transmuxer.operations.length, transmuxerOperationCount);
    assert.strictEqual(
        engine._transmuxer.operations.some((operation) => operation.type === 'seek'),
        false
    );
    const staleOperation = engine._audio_track_switch_coordinator.active.operation;
    assert.strictEqual(engine._audio_track_switch_coordinator.active.stage, 'rebuilding');
    assert.strictEqual(stateMachine.pendingRebuild, true);
    engine._pending_audio_track_switch_resume_playback = true;
    engine._resume_playback_after_audio_track_switch_rebuild = true;
    engine._mmts_live_video_rebuild_window = {playableStart: 10, segments: []};
    const seekOperation = engine._reservePlaybackOperation(
        'seek', 11000, undefined, 'requested'
    );
    engine._scheduleInteractiveOperation({
        operation: seekOperation,
        payload: {type: 'seek', targetSeconds: 11, source: 'user'},
    });
    assert.strictEqual(stateMachine.pendingRebuild, false);
    assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._pending_audio_track_switch_resume_playback, false);
    assert.strictEqual(engine._resume_playback_after_audio_track_switch_rebuild, false);
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, false);
    assert.strictEqual(engine._mmts_live_video_rebuild_window, null);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(engine._active_playback_operation.kind, 'seek');
    assert.strictEqual(engine._active_playback_operation.requestedTimeMilliseconds, 11000);
    assert.deepStrictEqual(stateMachineOperations.slice(-2), [
        {type: 'cancel_rebuild', transactionId: 2},
        {type: 'user_seek', targetTime: 11},
    ]);
    engine._finishUnifiedLiveAudioTrackSwitch(staleOperation);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
}

function makeMainLiveFailureHarness() {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    const stateMachineOperations = [];
    const selections = [];
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    engine._config = {isMMTS: true, isLive: true};
    engine._media_element = {currentTime: 10, paused: false};
    engine._emitter = new EventEmitter();
    engine._selected_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_audio_packet_id = 0xf110;
    engine._desired_mmts_video_packet_id = null;
    engine._mmts_video_tracks = [];
    engine._mmts_audio_tracks = makeAudioTracks(0xf110).concat([{
        packetId: 0xf112,
        mainComponent: false,
        assetType: 'mp4a',
        codec: 'aac-latm',
        channelConfig: 2,
        selected: false,
    }]);
    engine._pending_mmts_vod_audio_track_switch = null;
    engine._pending_audio_track_switch_request_time = null;
    engine._pending_audio_track_switch_expected_packet_id = null;
    engine._accepted_audio_track_switch_time = null;
    engine._pending_audio_track_switch_init_segment = null;
    engine._pending_audio_track_switch_media_segments = [];
    engine._pending_audio_track_switch_resume_playback = false;
    engine._resume_playback_after_audio_track_switch_rebuild = false;
    engine._mmts_audio_track_switch_rebuild_in_progress = false;
    engine._mmts_live_video_rebuild_window = null;
    engine._playback_scope_id = `audio-window-live-failure-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._playback_recovery_roots = new Map();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._mse_buffer_state_machine = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onAudioTrackSwitch(request) {
            stateMachineOperations.push({type: 'audio_switch', request});
            return true;
        },
        cancelAudioTrackSwitch(operation) {
            stateMachineOperations.push({
                type: 'audio_switch_cancel',
                transactionId: operation.transactionId,
            });
            return true;
        },
        onFatal(error) {
            stateMachineOperations.push({type: 'fatal', error});
        },
        onMediaInfo() {},
    };
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek, switchIdentity) {
            selections.push({packetId, timelineSeed, rebuildFromSeek, switchIdentity});
        },
    };
    return {engine, stateMachineOperations, selections};
}

function makeMainLiveAudioSwitchContract(operation, packetId = 0xf111) {
    return Object.assign(makeAudioSwitchContract(
        operation,
        packetId,
        operation.requestedTimeMilliseconds / 1000
    ), {
        audioDecodeStart: 10,
        audioStart: 10,
        audioEnd: 10.1,
    });
}

function makeMainLiveAudioMedia(start, end, audioSwitch) {
    const segment = {
        type: 'audio',
        data: {byteLength: 8},
        info: {beginDts: start * 1000, endDts: end * 1000},
    };
    if (audioSwitch) {
        segment.mmtsAudioTrackSwitch = Object.assign({}, audioSwitch, {
            audioDecodeStart: start,
            audioStart: start,
            audioEnd: end,
        });
    }
    return segment;
}

function testMainLiveInvalidGapAndOverflowFailImmediatelyOnce() {
    const scenarios = [
        {
            reason: 'live-data:invalid-init',
            run(engine, operation, contract) {
                engine._consumeMMTSLiveAudioTrackSwitchInit({
                    type: 'audio',
                    container: 'audio/mp4',
                    codec: 'mp4a.40.5',
                    data: {byteLength: 0},
                    mmtsAudioTrackSwitch: contract,
                }, operation);
            },
        },
        {
            reason: 'live-data:forward-gap',
            run(engine, operation, contract) {
                engine._consumeMMTSLiveAudioTrackSwitchMedia(
                    makeMainLiveAudioMedia(10, 10.1, contract),
                    operation
                );
                engine._consumeMMTSLiveAudioTrackSwitchMedia(
                    makeMainLiveAudioMedia(10.3, 10.4),
                    operation
                );
            },
        },
        {
            reason: 'live-data:overflow',
            run(engine, operation, contract) {
                engine._consumeMMTSLiveAudioTrackSwitchMedia(
                    makeMainLiveAudioMedia(10, 10.1, contract),
                    operation
                );
                for (let index = 1; index <= 12; index++) {
                    engine._consumeMMTSLiveAudioTrackSwitchMedia(
                        makeMainLiveAudioMedia(10 + index / 10, 10 + (index + 1) / 10),
                        operation
                    );
                }
            },
        },
    ];

    for (const scenario of scenarios) {
        const {engine, stateMachineOperations, selections} = makeMainLiveFailureHarness();
        const reasons = [];
        const fail = engine._failUnifiedMMTSAudioTrackSwitch;
        engine._failUnifiedMMTSAudioTrackSwitch = (operation, reason) => {
            reasons.push(reason);
            fail.call(engine, operation, reason);
        };
        engine.selectAudioTrack(0xf111);
        const failedOperation = Object.assign(
            {},
            engine._audio_track_switch_coordinator.active.operation
        );
        const contract = makeMainLiveAudioSwitchContract(failedOperation);
        scenario.run(engine, failedOperation, contract);
        assert.deepStrictEqual(reasons, [scenario.reason]);
        assert.deepStrictEqual(selections.map((selection) => selection.packetId), [0xf111, 0xf110]);
        assert.deepStrictEqual(stateMachineOperations.filter((operation) =>
            operation.type === 'audio_switch_cancel'
        ), [{type: 'audio_switch_cancel', transactionId: failedOperation.transactionId}]);

        engine._failUnifiedMMTSAudioTrackSwitch(failedOperation, 'stale-failure');
        assert.deepStrictEqual(reasons, [scenario.reason, 'stale-failure']);
        assert.strictEqual(stateMachineOperations.filter((operation) =>
            operation.type === 'audio_switch_cancel'
        ).length, 1);
        assert.strictEqual(engine._consumeMMTSLiveAudioTrackSwitchMedia(
            makeMainLiveAudioMedia(11, 11.1, contract),
            failedOperation
        ), true, 'late tagged media must remain quarantined');
    }
}

function testMainLiveWatchdogsRecoverMissingAckInitAndMedia() {
    for (const missing of ['ack', 'init', 'media']) {
        const {engine, stateMachineOperations, selections} = makeMainLiveFailureHarness();
        engine.selectAudioTrack(0xf111);
        const operation = engine._audio_track_switch_coordinator.active.operation;
        if (missing !== 'ack') {
            engine._onMMTSAudioTrackSelectionResult(Object.assign({
                accepted: true,
                changed: true,
                requestedPacketId: 0xf111,
                selectedPacketId: 0xf111,
                reason: 'selected',
            }, playbackOperationModule.createPlaybackSwitchIdentity(operation)), operation);
        }
        if (missing === 'media') {
            engine._consumeMMTSLiveAudioTrackSwitchInit({
                type: 'audio',
                container: 'audio/mp4',
                codec: 'mp4a.40.5',
                data: {byteLength: 8},
                mmtsAudioTrackSwitch: makeMainLiveAudioSwitchContract(operation),
            }, operation);
        }
        assert.strictEqual(
            engine._audio_track_switch_coordinator.active.stage,
            missing === 'ack' ? 'selecting' : missing === 'init' ? 'waiting-init' : 'collecting-overlap'
        );
        engine._onUnifiedAudioTrackSwitchTimeout(engine._audio_track_switch_coordinator.active);
        const recovery = engine._audio_track_switch_coordinator.active;
        assert.strictEqual(recovery.targetPacketId, 0xf110);
        engine._onUnifiedAudioTrackSwitchTimeout(recovery);
        assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
        engine.selectAudioTrack(0xf111);
        assert.deepStrictEqual(selections.map((selection) => selection.packetId), [
            0xf111,
            0xf110,
            0xf111,
        ]);
        assert.deepStrictEqual(stateMachineOperations.filter((item) =>
            item.type === 'audio_switch_cancel'
        ).map((item) => item.transactionId), [
            operation.transactionId,
            recovery.operation.transactionId,
        ]);
    }
}

function testMainLiveTimeoutRollsBackBeforePromotingQueuedTarget() {
    const {engine, stateMachineOperations, selections} = makeMainLiveFailureHarness();
    engine.selectAudioTrack(0xf111);
    const failed = engine._audio_track_switch_coordinator.active;
    engine.selectAudioTrack(0xf112);
    const queued = getQueuedAudioReservation(engine);
    assert(failed.operation.timelineGeneration < failed.recoveryOperation.timelineGeneration);
    assert(failed.recoveryOperation.timelineGeneration < queued.operation.timelineGeneration);

    engine._onUnifiedAudioTrackSwitchTimeout(failed);
    const recovery = engine._audio_track_switch_coordinator.active;
    assert.strictEqual(recovery.targetPacketId, 0xf110);
    assert.strictEqual(
        recovery.operation.transactionId,
        failed.recoveryOperation.transactionId
    );
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf112);
    assert.deepStrictEqual(selections.map((selection) => selection.packetId), [0xf111, 0xf110]);
    assert.strictEqual(selections.some((selection) => selection.rebuildFromSeek), false);

    engine._onMMTSAudioTrackSelectionResult(Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0xf110,
        selectedPacketId: 0xf110,
        reason: 'already-selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(recovery.operation)),
    recovery.operation);
    assert(engine._audio_track_switch_coordinator.transition(
        recovery.operation,
        'waiting-init',
        'collecting-overlap'
    ));
    assert(engine._audio_track_switch_coordinator.transition(
        recovery.operation,
        'collecting-overlap',
        'submitted'
    ));
    assert(engine._audio_track_switch_coordinator.transition(
        recovery.operation,
        'submitted',
        'rebuilding'
    ));
    engine._finishUnifiedLiveAudioTrackSwitch(recovery.operation);

    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf112);
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.operation.transactionId,
        queued.operation.transactionId
    );
    assert.deepStrictEqual(selections.map((selection) => selection.packetId), [
        0xf111,
        0xf110,
        0xf112,
    ]);
    assert.deepStrictEqual(stateMachineOperations.filter((operation) =>
        operation.type === 'audio_switch_cancel'
    ), [{type: 'audio_switch_cancel', transactionId: failed.operation.transactionId}]);
}

function testMainPromotesImmutableLiveAudioTarget() {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    const selections = [];
    engine._config = {isMMTS: true, isLive: true};
    engine._media_element = {currentTime: 20, paused: false};
    engine._selected_mmts_audio_packet_id = 0xf110;
    engine._mmts_audio_tracks = makeAudioTracks(0xf110).concat([{
        packetId: 0xf112,
        selectable: true,
        mainComponent: false,
        selected: false,
    }]);
    engine._pending_audio_track_switch_media_segments = [];
    engine._pending_audio_track_switch_resume_playback = false;
    engine._mse_buffer_state_machine = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onAudioTrackSwitch() { return true; },
    };
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek, switchIdentity) {
            selections.push({packetId, timelineSeed, rebuildFromSeek, switchIdentity});
        },
    };
    engine._playback_scope_id = `audio-window-promote-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;

    const firstOperation = engine._reservePlaybackOperation(
        'audio-switch', 20500, 0xf111, 'requested'
    );
    const first = engine._audio_track_switch_coordinator.request({
        operation: firstOperation,
        priorCommittedPacketId: 0xf110,
        targetPacketId: 0xf111,
        strategy: 'live-forward',
        resumeIntent: true,
    });
    assert.strictEqual(first.type, 'activate');
    assert.strictEqual(engine._activatePlaybackOperation(firstOperation), true);
    const queuedOperation = engine._reservePlaybackOperation(
        'audio-switch', 20600, 0xf112, 'requested'
    );
    assert.strictEqual(engine._audio_track_switch_coordinator.request({
        operation: queuedOperation,
        priorCommittedPacketId: 0xf110,
        targetPacketId: 0xf112,
        strategy: 'live-forward',
        resumeIntent: true,
    }).type, 'queued');
    engine._audio_track_switch_coordinator.abort(firstOperation);
    engine._selected_mmts_audio_packet_id = 0xf111;
    engine._mmts_audio_tracks.reverse();

    engine._promoteUnifiedMMTSAudioTrackSwitch();
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf112);
    assert.strictEqual(engine._pending_audio_track_switch_expected_packet_id, 0xf112);
    assert.strictEqual(selections.length, 1);
    assert.strictEqual(selections[0].packetId, 0xf112);
}

function testMainThreadMpegTsAudioOutputIsNotMMTSGated() {
    class FakeTransmuxer extends EventEmitter {
        constructor() {
            super();
            this.operations = [];
        }
        open() {}
        switchPrimaryAudio(timelineSeed) {
            this.operations.push({type: 'primary', timelineSeed});
        }
    }

    const PlayerEngineMainThread = loadPlayerEngineMainThread({Transmuxer: FakeTransmuxer});
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread);
    const stateMachineOperations = [];
    engine._media_data_source = {type: 'mpegts'};
    engine._config = {
        isMMTS: false,
        isLive: false,
        deferLoadAfterSourceOpen: false,
        lazyLoad: false,
        liveBufferLatencyChasing: false,
        liveSync: false,
        startupBufferDuration: 0,
        mmtsLiveInitialBufferDuration: 0,
    };
    engine._media_element = {currentTime: 10, readyState: 0};
    engine._emitter = new EventEmitter();
    engine._transmuxer = null;
    engine._playback_scope_id = `audio-window-mpegts-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._playback_recovery_roots = new Map();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._has_pending_load = false;
    engine._mse_source_opened = false;
    engine._mmts_audio_tracks = [];
    engine._createMSEBufferStateMachine = () => ({
        onAudioTrackSwitch(request) {
            stateMachineOperations.push({type: 'switch', request});
            return true;
        },
        onInitSegment(type, segment) {
            stateMachineOperations.push({type: 'init', trackType: type, segment});
        },
        onMediaSegment(type, segment) {
            stateMachineOperations.push({type: 'media', trackType: type, segment});
        },
        onMediaState() {},
    });

    engine.load();
    engine.switchPrimaryAudio();
    assert.strictEqual(engine._pending_audio_track_switch_request_time, 10.5);

    const initSegment = {type: 'audio', codec: 'mp4a.40.2'};
    const mediaSegment = {type: 'audio', info: {endDts: 11500}};
    engine._transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', initSegment);
    engine._transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', mediaSegment);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(engine._transmuxer.operations)), [
        {type: 'primary', timelineSeed: 10500},
    ]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(stateMachineOperations)), [
        {type: 'switch', request: {stage: 'request'}},
        {type: 'init', trackType: 'audio', segment: initSegment},
        {type: 'media', trackType: 'audio', segment: mediaSegment},
    ]);
}

function makeVideoTracks(selectedPacketId) {
    return [0xf200, 0xf201].map((packetId) => ({
        packetId,
        selected: packetId === selectedPacketId,
    }));
}

function makeVideoSwitchSegment(type, transaction, overrides = {}) {
    const operation = Object.assign({}, transaction.operation);
    const videoSwitch = Object.assign(
        playbackOperationModule.createPlaybackSwitchIdentity(operation), {
        packetId: transaction.targetPacketId,
        videoDecodeStart: 11.98,
        videoCompositionStart: 12,
        syncPoint: 12,
        playableStart: 12,
        playableEnd: 13,
    }, overrides);
    return {
        type,
        container: 'video/mp4',
        codec: 'hvc1.2.1.L183.B0',
        data: {byteLength: 32},
        mmtsRandomAccessSafe: true,
        info: type === 'video' ? {
            beginDts: 11980,
            endDts: 13000,
            firstSample: {isSyncPoint: true, dts: 11980, pts: 12000},
        } : undefined,
        firstPlayableWindow: type === 'video' ? {
            decodeStart: videoSwitch.videoDecodeStart,
            compositionStart: videoSwitch.videoCompositionStart,
            syncPoint: videoSwitch.syncPoint,
            playableStart: videoSwitch.playableStart,
            playableEnd: videoSwitch.playableEnd,
        } : undefined,
        playbackOperation: operation,
        mseBufferGeneration: operation.timelineGeneration,
        mmtsVideoTrackSwitch: videoSwitch,
    };
}

function makeMainVideoSwitchHarness(options = {}) {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    attachAudioTrackSwitchCoordinator(engine, PlayerEngineMainThread, options);
    const requests = [];
    const selections = [];
    const events = [];
    const mediaEvents = [];
    const durations = [];
    engine._config = {isMMTS: true, isLive: options.isLive === true};
    engine._media_element = {currentTime: 12, paused: false};
    engine._selected_mmts_video_packet_id = 0xf200;
    engine._desired_mmts_video_packet_id = 0xf200;
    engine._selected_mmts_audio_packet_id = null;
    engine._desired_mmts_audio_packet_id = null;
    engine._mmts_audio_tracks = [];
    engine._mmts_video_tracks = makeVideoTracks(0xf200);
    engine._pending_video_track_switch_init_segment = null;
    engine._pending_video_track_switch_media_segment = null;
    engine._playback_scope_id = `video-window-harness-${++playbackHarnessSequence}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._playback_recovery_roots = new Map();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._emitter = new EventEmitter();
    engine._emitter.on('mmts_video_tracks', (data) => events.push(data));
    engine._emitter.on('media_info', (data) => mediaEvents.push(data));
    engine._mse_buffer_state_machine = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onVideoTrackSwitch(request) {
            requests.push(request);
            return true;
        },
        cancelVideoTrackSwitch(operation) {
            requests.push({stage: 'cancel', transactionId: operation.transactionId});
            return true;
        },
        onFatal(error) { requests.push({stage: 'fatal', error}); },
        onMediaInfo(mediaInfo) { requests.push({stage: 'media_info', mediaInfo}); },
    };
    engine._mse_controller = {
        setMediaDuration(duration) { durations.push(duration); },
    };
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        selectVideoTrack(packetId, switchIdentity) {
            selections.push({packetId, switchIdentity});
        },
        seekAndSelectVideoTrack(milliseconds, operation, packetId, switchIdentity) {
            selections.push({milliseconds, operation, packetId, switchIdentity});
        },
    };
    return {engine, requests, selections, events, mediaEvents, durations};
}

function acceptMainVideoSelection(engine, transaction) {
    engine._video_track_switch_coordinator.setConfirmedTrackData(transaction.operation, {
        tracks: makeVideoTracks(transaction.targetPacketId),
        selectedPacketId: transaction.targetPacketId,
    });
    engine._onMMTSVideoTrackSelectionResult(Object.assign({
        accepted: true,
        changed: transaction.priorCommittedPacketId !== transaction.targetPacketId,
        requestedPacketId: transaction.targetPacketId,
        selectedPacketId: transaction.targetPacketId,
        reason: transaction.priorCommittedPacketId === transaction.targetPacketId ?
            'already-selected' : 'selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)),
    transaction.operation);
}

function testVideoTrackSwitchCommitsOnlyAfterMSECompletionAndFencesData() {
    const {engine, requests, selections, events} = makeMainVideoSwitchHarness();
    engine.selectVideoTrack(0xf201);
    const transaction = engine._video_track_switch_coordinator.active;
    assert.strictEqual(selections.length, 1);
    assert.strictEqual(selections[0].milliseconds, 12000);
    assert.strictEqual(selections[0].packetId, 0xf201);
    assert.strictEqual(selections[0].operation.kind, 'video-switch');
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selections[0].switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)
        ))
    );
    acceptMainVideoSelection(engine, transaction);

    const media = makeVideoSwitchSegment('video', transaction);
    engine._consumeMMTSVideoTrackSwitchMedia(media, transaction.operation);
    assert.strictEqual(
        requests.filter((request) => request.stage === 'commit_ready').length,
        0,
        'media before init must be consumed without parser reset or append'
    );
    assert.strictEqual(engine._video_track_switch_coordinator.active.stage, 'waiting-init');

    const staleInit = makeVideoSwitchSegment('video', transaction, {
        id: transaction.operation.transactionId + 1,
    });
    engine._consumeMMTSVideoTrackSwitchInit(staleInit, transaction.operation);
    assert.strictEqual(engine._video_track_switch_coordinator.active.stage, 'waiting-init');

    const init = makeVideoSwitchSegment('video', transaction);
    engine._consumeMMTSVideoTrackSwitchInit(init, transaction.operation);
    engine._consumeMMTSVideoTrackSwitchMedia(media, transaction.operation);
    assert.strictEqual(engine._video_track_switch_coordinator.active.stage, 'submitted');
    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf200);
    assert.strictEqual(events.length, 0, 'track list must remain private before MSE completion');
    assert.strictEqual(
        requests.filter((request) => request.stage === 'commit_ready').length,
        1
    );

    engine._finishUnifiedMMTSVideoTrackSwitch(transaction.operation.transactionId + 1);
    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf200);
    engine._finishUnifiedMMTSVideoTrackSwitch(transaction.operation);
    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf201);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].selectedPacketId, 0xf201);
}

function testLiveVideoTrackSwitchContinuesForwardWithoutVodSeek() {
    const {engine, selections} = makeMainVideoSwitchHarness({isLive: true});
    engine.selectVideoTrack(0xf201);
    const transaction = engine._video_track_switch_coordinator.active;

    assert.strictEqual(selections.length, 1);
    assert.strictEqual(selections[0].milliseconds, undefined);
    assert.strictEqual(selections[0].operation, undefined);
    assert.strictEqual(selections[0].packetId, 0xf201);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selections[0].switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)
        ))
    );
}

function testVideoTrackSwitchUsesLWWAndDropsStaleContracts() {
    const {engine, requests, selections} = makeMainVideoSwitchHarness();
    engine.selectVideoTrack(0xf201);
    const switchToB = engine._video_track_switch_coordinator.active;
    engine.selectVideoTrack(0xf200);
    assert.strictEqual(getQueuedVideoReservation(engine).targetPacketId, 0xf200);
    engine.selectVideoTrack(0xf201);
    assert.strictEqual(getQueuedVideoReservation(engine).targetPacketId, 0xf201);
    engine.selectVideoTrack(0xf200);
    assert.strictEqual(getQueuedVideoReservation(engine).targetPacketId, 0xf200);

    acceptMainVideoSelection(engine, switchToB);
    engine._consumeMMTSVideoTrackSwitchInit(
        makeVideoSwitchSegment('video', switchToB),
        switchToB.operation
    );
    engine._consumeMMTSVideoTrackSwitchMedia(
        makeVideoSwitchSegment('video', switchToB),
        switchToB.operation
    );
    engine._finishUnifiedMMTSVideoTrackSwitch(switchToB.operation);
    const switchBackToA = engine._video_track_switch_coordinator.active;
    assert.strictEqual(switchBackToA.targetPacketId, 0xf200);

    const requestCount = requests.length;
    engine._consumeMMTSVideoTrackSwitchInit(
        makeVideoSwitchSegment('video', switchToB),
        switchToB.operation
    );
    engine._consumeMMTSVideoTrackSwitchMedia(
        makeVideoSwitchSegment('video', switchToB),
        switchToB.operation
    );
    assert.strictEqual(requests.length, requestCount, 'stale B data must never reach MSE');
    assert.deepStrictEqual(selections.map((selection) => selection.packetId), [0xf201, 0xf200]);
}

function testVideoAlreadySelectedAckStillRequiresMSECompletion() {
    const {engine, requests, selections, events} = makeMainVideoSwitchHarness();
    engine.selectVideoTrack(0xf201);
    const transaction = engine._video_track_switch_coordinator.active;
    engine.selectVideoTrack(0xf200);
    engine._video_track_switch_coordinator.setConfirmedTrackData(transaction.operation, {
        tracks: makeVideoTracks(0xf201),
        selectedPacketId: 0xf201,
    });
    engine._onMMTSVideoTrackSelectionResult(Object.assign({
        accepted: true,
        changed: false,
        requestedPacketId: 0xf201,
        selectedPacketId: 0xf201,
        reason: 'already-selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)),
    transaction.operation);

    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf200);
    assert.strictEqual(events.length, 0);
    assert.strictEqual(engine._video_track_switch_coordinator.active.stage, 'waiting-init');
    assert.strictEqual(
        requests.filter((request) => request.stage === 'cancel' &&
            request.transactionId === transaction.operation.transactionId).length,
        0
    );
    engine._consumeMMTSVideoTrackSwitchInit(
        makeVideoSwitchSegment('video', transaction),
        transaction.operation
    );
    engine._consumeMMTSVideoTrackSwitchMedia(
        makeVideoSwitchSegment('video', transaction),
        transaction.operation
    );
    assert.strictEqual(
        requests.filter((request) => request.stage === 'commit_ready').length,
        1
    );
    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf200);
    engine._finishUnifiedMMTSVideoTrackSwitch(transaction.operation);
    assert.strictEqual(engine._selected_mmts_video_packet_id, 0xf201);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].selectedPacketId, 0xf201);
    assert.strictEqual(engine._video_track_switch_coordinator.active.targetPacketId, 0xf200);
    assert.deepStrictEqual(selections.map((selection) => selection.packetId), [0xf201, 0xf200]);
}

function testVideoSeekTransferRequiresMatchingAck() {
    const beforeAck = makeMainVideoSwitchHarness();
    beforeAck.engine.selectVideoTrack(0xf201);
    beforeAck.engine._cancelMMTSVideoTrackSwitchForSeek();
    assert.strictEqual(beforeAck.engine._selected_mmts_video_packet_id, 0xf200);
    assert.strictEqual(beforeAck.events.length, 0);

    const afterAck = makeMainVideoSwitchHarness();
    afterAck.engine.selectVideoTrack(0xf201);
    const transaction = afterAck.engine._video_track_switch_coordinator.active;
    acceptMainVideoSelection(afterAck.engine, transaction);
    afterAck.engine._cancelMMTSVideoTrackSwitchForSeek();
    assert.strictEqual(afterAck.engine._selected_mmts_video_packet_id, 0xf201);
    assert.strictEqual(afterAck.events.length, 1);
    assert.strictEqual(afterAck.events[0].selectedPacketId, 0xf201);
}

function testMainVideoMediaInfoPublishesOnlyAfterMSECompletion() {
    const success = makeMainVideoSwitchHarness();
    success.engine.selectVideoTrack(0xf201);
    const transaction = success.engine._video_track_switch_coordinator.active;
    acceptMainVideoSelection(success.engine, transaction);
    const mediaInfo = {duration: 123000, marker: 'video-B'};
    assert.strictEqual(
        success.engine._video_track_switch_coordinator.setPendingMediaInfo(
            transaction.operation,
            mediaInfo
        ),
        true
    );
    success.engine._consumeMMTSVideoTrackSwitchInit(
        makeVideoSwitchSegment('video', transaction),
        transaction.operation
    );
    success.engine._consumeMMTSVideoTrackSwitchMedia(
        makeVideoSwitchSegment('video', transaction),
        transaction.operation
    );
    assert.strictEqual(success.mediaEvents.length, 0);
    assert.strictEqual(success.requests.some((request) => request.stage === 'media_info'), false);
    success.engine._finishUnifiedMMTSVideoTrackSwitch(transaction.operation);
    assert.strictEqual(success.mediaEvents.length, 1);
    assert.strictEqual(success.mediaEvents[0].marker, 'video-B');
    assert.strictEqual(success.requests.filter((request) =>
        request.stage === 'media_info' && request.mediaInfo.marker === 'video-B'
    ).length, 1);
    assert.deepStrictEqual(success.durations, [123]);

    const failure = makeMainVideoSwitchHarness();
    failure.engine.selectVideoTrack(0xf201);
    const failedTransaction = failure.engine._video_track_switch_coordinator.active;
    acceptMainVideoSelection(failure.engine, failedTransaction);
    const failedMediaInfo = {duration: 456000, marker: 'failed-video-B'};
    failure.engine._video_track_switch_coordinator.setPendingMediaInfo(
        failedTransaction.operation,
        failedMediaInfo
    );
    failure.engine._failUnifiedMMTSVideoTrackSwitch(
        failedTransaction.operation,
        'mse-failed:append-media'
    );
    assert.strictEqual(failure.mediaEvents.length, 0);
    assert.strictEqual(failure.requests.some((request) =>
        request.stage === 'media_info' && request.mediaInfo.marker === 'failed-video-B'
    ), false);
    assert.strictEqual(failure.durations.includes(456), false);
}

function testMainTrackSwitchesQueueLatestIntentAcrossTypes() {
    const audioFirst = makeVodSwitchHarness(12).engine;
    audioFirst._selected_mmts_video_packet_id = 0xf200;
    audioFirst._mmts_video_tracks = makeVideoTracks(0xf200);
    audioFirst.selectAudioTrack(0xf111);
    const audioOperation = Object.assign({}, audioFirst._active_playback_operation);
    const audioGeneration = audioFirst._playback_timeline_generation;
    audioFirst.selectVideoTrack(0xf201);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(audioFirst._active_playback_operation)),
        JSON.parse(JSON.stringify(audioOperation))
    );
    assert(audioFirst._playback_timeline_generation > audioGeneration);
    assert.strictEqual(audioFirst._video_track_switch_coordinator.active, null);
    assert.strictEqual(getQueuedVideoReservation(audioFirst).targetPacketId, 0xf201);

    const videoFirst = makeMainVideoSwitchHarness().engine;
    videoFirst._selected_mmts_audio_packet_id = 0xf110;
    videoFirst._desired_mmts_audio_packet_id = 0xf110;
    videoFirst._mmts_audio_tracks = makeAudioTracks(0xf110);
    videoFirst.selectVideoTrack(0xf201);
    const videoOperation = Object.assign({}, videoFirst._active_playback_operation);
    const videoGeneration = videoFirst._playback_timeline_generation;
    videoFirst.selectAudioTrack(0xf111);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(videoFirst._active_playback_operation)),
        JSON.parse(JSON.stringify(videoOperation))
    );
    assert(videoFirst._playback_timeline_generation > videoGeneration);
    assert.strictEqual(videoFirst._audio_track_switch_coordinator.active, null);
    assert.strictEqual(getQueuedAudioReservation(videoFirst).targetPacketId, 0xf111);
}

function testMainFatalReportingDoesNotReenterStateOrDuplicate() {
    class ReentrantMSEBufferStateMachine {
        constructor(_config, output) {
            this.output = output;
            this.externalErrors = [];
        }
        onExternalMSEError(error) {
            this.externalErrors.push(error);
            this.output.emitFatal(error);
        }
    }
    const PlayerEngineMainThread = loadPlayerEngineMainThread({
        MSEBufferStateMachine: ReentrantMSEBufferStateMachine,
    });
    const engine = Object.create(PlayerEngineMainThread.prototype);
    const emitted = [];
    engine._config = {isMMTS: true};
    engine._emitter = new EventEmitter();
    engine._emitter.on('error', (...args) => emitted.push(args));
    engine._mse_controller = {};
    engine._mse_buffer_state_machine = engine._createMSEBufferStateMachine();

    const internalError = {code: 1, msg: 'internal fatal'};
    engine._mse_buffer_state_machine.output.emitFatal(internalError);
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(engine._mse_buffer_state_machine.externalErrors.length, 0);

    const externalError = {code: 2, msg: 'external MSE error'};
    engine._onMSEError(externalError);
    assert.strictEqual(emitted.length, 2);
    assert.deepStrictEqual(engine._mse_buffer_state_machine.externalErrors, [externalError]);
}

function testVideoSelectionRejectCleansExactlyOnceAndRollsBack() {
    const {engine, requests, selections} = makeMainVideoSwitchHarness();
    engine.selectVideoTrack(0xf201);
    const transaction = engine._video_track_switch_coordinator.active;
    const rejection = Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: transaction.targetPacketId,
        reason: 'unknown-track',
    }, playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation));
    engine._onMMTSVideoTrackSelectionResult(rejection, transaction.operation);
    engine._onMMTSVideoTrackSelectionResult(rejection, transaction.operation);
    assert.strictEqual(
        requests.filter((request) => request.stage === 'cancel').length,
        1
    );
    assert.deepStrictEqual(selections.map((selection) => selection.packetId), [0xf201, 0xf200]);
    assert.strictEqual(engine._video_track_switch_coordinator.active.recoveryDepth, 1);
}

function testVodAudioSwitchQueuesLastRequestedTargetAcrossFullLifecycles() {
    const {engine, operations} = makeVodSwitchHarness(10.5);
    engine.selectAudioTrack(0xf111);
    engine._media_element.currentTime = 11;
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf110);
    engine.selectAudioTrack(0xf111);
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf111);
    engine._media_element.currentTime = 11.25;
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(
        getQueuedAudioReservation(engine).operation.requestedTimeMilliseconds,
        11250
    );

    engine._media_element.currentTime = 11.75;
    completeVodSwitchTransaction(engine, operations, 0xf111, 10.5);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.requestedTime, 11.75);
    completeVodSwitchTransaction(engine, operations, 0xf110, 11.75);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);

    engine._media_element.currentTime = 12;
    engine.selectAudioTrack(0xf111);
    completeVodSwitchTransaction(engine, operations, 0xf111, 12);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(
        operations.filter((operation) => operation.type === 'begin').length,
        3
    );
}

function testMainCommitReentrantSameTargetClearsOlderQueuedIntent() {
    const {engine, operations} = makeVodSwitchHarness(15);
    let reentered = false;
    engine._emitter.on('mmts_audio_tracks', (tracks) => {
        if (!reentered && tracks.selectedPacketId === 0xf111) {
            reentered = true;
            engine.selectAudioTrack(0xf111);
        }
    });
    engine.selectAudioTrack(0xf111);
    engine.selectAudioTrack(0xf110);
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf110);
    completeVodSwitchTransaction(engine, operations, 0xf111, 15);
    assert.strictEqual(reentered, true);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(operations.filter((operation) => operation.type === 'begin').length, 1);
}

function testMainCommitReentrantNewTargetReplacesOlderQueuedIntent() {
    const {engine, operations} = makeVodSwitchHarness(16);
    let reentered = false;
    engine._emitter.on('mmts_audio_tracks', (tracks) => {
        if (!reentered && tracks.selectedPacketId === 0xf111) {
            reentered = true;
            engine._mmts_audio_tracks.push({
                packetId: 0xf112,
                mainComponent: false,
                assetType: 'mp4a',
                codec: 'aac-latm',
                channelConfig: 2,
                selected: false,
            });
            engine.selectAudioTrack(0xf112);
        }
    });
    engine.selectAudioTrack(0xf111);
    engine.selectAudioTrack(0xf110);
    completeVodSwitchTransaction(engine, operations, 0xf111, 16);
    assert.strictEqual(reentered, true);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf112);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf112);
    assert.strictEqual(operations.filter((operation) => operation.type === 'begin').length, 2);
}

function testVodAudioSwitchWatchdogRestoresLivenessBeforeSelection() {
    const {engine, operations} = makeVodSwitchHarness(20);
    engine.selectAudioTrack(0xf111);
    const generation = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._media_element.currentTime = 20.5;
    engine.selectAudioTrack(0xf110);
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);

    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.deepStrictEqual(operations.slice(-2), [
        {type: 'cancel'},
        {type: 'cancel_state_machine', transactionId: 1},
    ]);

    engine._media_element.currentTime = 21;
    engine.selectAudioTrack(0xf111);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf111);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    engine._cancelMMTSAudioTrackSwitchForSeek();
}

function testVodAudioSwitchWatchdogUsesStageSpecificDeadlines() {
    const delays = [];
    const timers = new Set();
    const {engine} = makeVodSwitchHarness(25, {
        setTimeout(callback, delay) {
            const timer = {callback, delay, unref() {}};
            timers.add(timer);
            delays.push(delay);
            return timer;
        },
        clearTimeout(timer) {
            timers.delete(timer);
        },
    });
    engine.selectAudioTrack(0xf111);
    assert.strictEqual(delays[delays.length - 1], 10000);
    engine._transmuxer.seek(25000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    assert.strictEqual(delays[delays.length - 1], 45000);
    assert.strictEqual(timers.size, 1);
    engine._cancelMMTSAudioTrackSwitchForSeek();
    assert.strictEqual(timers.size, 0);
}

function testVodAudioSwitchRecommendationAndCompletionAreTransactionScoped() {
    const {engine, operations} = makeVodSwitchHarness(20.821);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(20821);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    assert.strictEqual(engine._handleMMTSVodAudioTrackSwitchRecommendedSeek(23657), true);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.resolvedSeekTime, 23.657);

    const cancelledOperation = engine._audio_track_switch_coordinator.active.operation;
    engine._cancelMMTSAudioTrackSwitchForSeek();
    engine._completeScheduledOperation(
        cancelledOperation, 'cancelled', 'test-seek-cancelled'
    );
    engine._media_element.currentTime = 24;
    engine.selectAudioTrack(0xf110);
    const operation = completeVodSwitchTransaction(engine, operations, 0xf110, 24, true);
    const completion = vodSwitchStateMachineOutputs.get(engine).onAudioTrackSwitchRebuildComplete;
    completion(undefined);
    assert.strictEqual(
        engine._pending_mmts_vod_audio_track_switch.generation,
        operation.transactionId
    );
    completion(playbackOperationModule.createNextPlaybackAttempt(operation));
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(
        engine._pending_mmts_vod_audio_track_switch.generation,
        operation.transactionId
    );
    completion(operation);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
}

function testVodAudioSwitchFailureCallbackRequiresExactTransactionId() {
    const {engine, operations} = makeVodSwitchHarness(40);
    engine.selectAudioTrack(0xf111);
    const operation = completeVodSwitchTransaction(engine, operations, 0xf111, 40, true);
    const failure = vodSwitchStateMachineOutputs.get(engine).onAudioTrackSwitchRebuildFailed;
    failure(undefined);
    failure({
        kind: 'audio-switch',
        operation: playbackOperationModule.createNextPlaybackAttempt(operation),
        phase: 'append-media',
        error: new Error('stale'),
    });
    assert.strictEqual(
        engine._pending_mmts_vod_audio_track_switch.generation,
        operation.transactionId
    );
    failure({
        kind: 'audio-switch',
        operation,
        phase: 'append-media',
        error: new Error('append failed'),
    });
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf110);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.recoveryDepth, 1);
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, false);
}

function testVodAudioSwitchPostConfirmationTimeoutRetriesThenCleansUp() {
    const {engine, operations} = makeVodSwitchHarness(20.821);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(20821);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    const firstGeneration = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._media_element.currentTime = 30;
    engine._onMMTSVodAudioTrackSwitchTimeout(firstGeneration);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'preparing');
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.retryCount, 1);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.requestedTime, 30);
    assert.strictEqual(operations.some((operation) => operation.type === 'fatal'), false);

    engine._transmuxer.seek(30000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    const retryGeneration = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._onMMTSVodAudioTrackSwitchTimeout(retryGeneration);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf110);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.recoveryDepth, 1);
    engine._transmuxer.seek(30000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf110, true);
    const recoveryGeneration = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._onMMTSVodAudioTrackSwitchTimeout(recoveryGeneration);
    engine._transmuxer.seek(30000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf110, false);
    engine._onMMTSVodAudioTrackSwitchTimeout(recoveryGeneration);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(getQueuedAudioReservation(engine), null);
    assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
    assert.strictEqual(engine._mmts_audio_track_switch_rebuild_in_progress, false);
    assert.strictEqual(engine._transmuxer.activeIntent, false);
    assert.strictEqual(engine._mse_buffer_state_machine.pendingRebuild, false);
    assert.strictEqual(engine._mse_buffer_state_machine.paused, false);
    assert.strictEqual(operations.filter((operation) => operation.type === 'fatal').length, 1);
}

function testVodAudioSwitchTimeoutForcesQueuedCommittedTargetRecovery() {
    const {engine, operations} = makeVodSwitchHarness(50);
    engine._mmts_audio_tracks = makeAudioTracks(0xf110).concat([{
        packetId: 0xf112,
        mainComponent: false,
        assetType: 'mp4a',
        codec: 'aac-latm',
        channelConfig: 2,
        selected: false,
    }]);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(50000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    const failedOperation = Object.assign(
        {},
        engine._audio_track_switch_coordinator.active.operation
    );
    const reservedRecoveryOperation = Object.assign(
        {},
        engine._audio_track_switch_coordinator.active.recoveryOperation
    );
    engine.selectAudioTrack(0xf112);
    const queuedOperation = Object.assign(
        {},
        getQueuedAudioReservation(engine).operation
    );
    assert(failedOperation.timelineGeneration < reservedRecoveryOperation.timelineGeneration);
    assert(reservedRecoveryOperation.timelineGeneration < queuedOperation.timelineGeneration);
    const generation = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf111);
    engine._transmuxer.seek(50000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111, false);
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf110);
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.operation.transactionId,
        reservedRecoveryOperation.transactionId
    );
    assert.strictEqual(getQueuedAudioReservation(engine).targetPacketId, 0xf112);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'preparing');
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.selectionIssued, false);

    const cancelCount = operations.filter((operation) =>
        operation.type === 'cancel_state_machine' &&
        operation.transactionId === failedOperation.transactionId
    ).length;
    engine._failUnifiedMMTSAudioTrackSwitch(failedOperation, 'stale-failure');
    assert.strictEqual(operations.filter((operation) =>
        operation.type === 'cancel_state_machine' &&
        operation.transactionId === failedOperation.transactionId
    ).length, cancelCount);

    completeVodSwitchTransaction(engine, operations, 0xf110, 50);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf112);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf112);
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.operation.transactionId,
        queuedOperation.transactionId
    );
}

function testVodUserSeekDuringSelectingDoesNotTransferBeforeAck() {
    const {engine} = makeVodSwitchHarness(60);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(60000);
    engine._issueMMTSVodAudioTrackSelection();
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'selecting');
    engine._media_element.currentTime = 61;
    assert.strictEqual(engine._onControlledSeekRequest(61, 'user'), true);
    flushPendingMMTSSeek(engine);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(
        engine._mmts_audio_tracks.find((track) => track.packetId === 0xf110).selected,
        true
    );
}

function testVodUserSeekDuringSelectingTransfersAfterAck() {
    const {engine} = makeVodSwitchHarness(60);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(60000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    engine._media_element.currentTime = 61;
    assert.strictEqual(engine._onControlledSeekRequest(61, 'user'), true);
    flushPendingMMTSSeek(engine);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(
        engine._mmts_audio_tracks.find((track) => track.packetId === 0xf111).selected,
        true
    );
}

function testVodUserSeekBeforeSelectionKeepsCommittedTarget() {
    const {engine} = makeVodSwitchHarness(62);
    engine.selectAudioTrack(0xf111);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.stage, 'preparing');
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.selectionMayHaveMutated,
        false
    );
    assert.strictEqual(engine._onControlledSeekRequest(63, 'user'), true);
    flushPendingMMTSSeek(engine);
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf110);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(
        engine._mmts_audio_tracks.find((track) => track.packetId === 0xf110).selected,
        true
    );
}

async function testRapidSeekDropsQueuedOutputFromSupersededTimeline() {
    const {Transmuxer, transmuxingEvents} = loadTransmuxer();
    const transmuxer = Object.create(Transmuxer.prototype);
    transmuxer._isMMTS = true;
    transmuxer._emitter = new EventEmitter();
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 0;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    const seekA = playbackOperationModule.createPlaybackOperation({
        scopeId: 'rapid-seek-output-test',
        timelineGeneration: 1,
        kind: 'seek',
        transactionId: 1,
        phase: 'requested',
        requestedTimeMilliseconds: 1000,
    });
    const seekB = playbackOperationModule.createPlaybackOperation({
        scopeId: 'rapid-seek-output-test',
        timelineGeneration: 2,
        kind: 'seek',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 2000,
    });
    transmuxer._playbackOperation = seekA;
    const emitted = [];
    transmuxer._emitter.on(transmuxingEvents.MEDIA_SEGMENT, (_type, segment) => {
        emitted.push(segment.id);
    });

    transmuxer._onMediaSegment('video', {
        id: 'A',
        playbackOperation: Object.assign({}, seekA),
        mseBufferGeneration: seekA.timelineGeneration,
    }, seekA);
    transmuxer._playbackOperation = seekB;
    transmuxer._onMediaSegment('video', {
        id: 'B',
        playbackOperation: Object.assign({}, seekB),
        mseBufferGeneration: seekB.timelineGeneration,
    }, seekB);
    await Promise.resolve();
    assert.deepStrictEqual(emitted, ['B']);

    const retryB = playbackOperationModule.createNextPlaybackAttempt(seekB, {
        phase: 'adaptive-retry',
    });
    assert.strictEqual(transmuxer._acceptPlaybackOperation(retryB), false);
    assert.strictEqual(transmuxer._playbackOperation.attempt, 0);
    assert.strictEqual(transmuxer._acceptPlaybackOperation(seekB), true);
    transmuxer.setPlaybackOperation(seekB);
    assert.strictEqual(transmuxer._playbackOperation.attempt, 0);
    transmuxer.setPlaybackOperation(seekA);
    assert.strictEqual(transmuxer._playbackOperation.timelineGeneration, 2);
    assert.throws(
        () => transmuxer.setPlaybackOperation(
            Object.assign({}, retryB, {transactionId: 3})
        ),
        /Invalid MMTS playback operation/
    );
    assert.strictEqual(transmuxer._playbackOperation.transactionId, 2);
    const workerMessages = [];
    transmuxer._worker = {postMessage(message) { workerMessages.push(message); }};
    transmuxer.seek(123000, seekA);
    transmuxer.seek(124000, seekB);
    transmuxer.open(seekA);
    assert.strictEqual(workerMessages.length, 2);
    assert.strictEqual(workerMessages[0].cmd, 'set_playback_operation');
    assert.strictEqual(
        playbackOperationModule.isSamePlaybackOperation(
            workerMessages[0].playback_operation,
            seekB
        ),
        true
    );
    assert.strictEqual(workerMessages[1].cmd, 'seek');
    assert.strictEqual(workerMessages[1].param, 124000);
}

function testMainAdaptiveSeekAttemptSynchronizesMSEAndFencesStaleOutput() {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    const attempt0 = playbackOperationModule.createPlaybackOperation({
        scopeId: 'main-adaptive-seek-test',
        timelineGeneration: 4,
        kind: 'seek',
        transactionId: 4,
        phase: 'requested',
        requestedTimeMilliseconds: 40000,
    });
    const attempt1 = playbackOperationModule.createNextPlaybackAttempt(attempt0, {
        phase: 'adaptive-retry',
    });
    const accepted = [];
    const synchronized = [];
    engine._config = {isMMTS: true};
    engine._active_playback_operation = attempt0;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
    };
    engine._mse_buffer_state_machine = {
        currentOperation: attempt0,
        canSetPlaybackOperation(operation) { return operation.attempt !== 2; },
        setPlaybackOperation(operation) {
            synchronized.push(Object.assign({}, operation));
            if (operation.attempt === 2) return false;
            this.currentOperation = Object.assign({}, operation);
            return true;
        },
        onStartupGroup(group) {
            accepted.push({type: 'startup', id: group.id, attempt: this.currentOperation.attempt});
        },
        onMediaSegment(_type, segment) {
            accepted.push({type: 'media', id: segment.id, attempt: this.currentOperation.attempt});
        },
    };
    const deliver = (operation, type, value) => {
        if (!engine._adoptPlaybackOperation(operation)) return;
        if (type === 'startup') engine._mse_buffer_state_machine.onStartupGroup(value);
        else engine._mse_buffer_state_machine.onMediaSegment('video', value);
    };

    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt0,
        attempt1,
        'mmts-vod-seek-lookback'
    ), true);
    deliver(attempt1, 'startup', {id: 'retry-startup'});
    deliver(attempt1, 'media', {id: 'retry-media'});
    deliver(attempt0, 'media', {id: 'old-attempt'});
    deliver(
        playbackOperationModule.withPlaybackOperationPhase(attempt1, 'requested'),
        'media',
        {id: 'phase-only-update'}
    );
    assert.deepStrictEqual(accepted, [
        {type: 'startup', id: 'retry-startup', attempt: 1},
        {type: 'media', id: 'retry-media', attempt: 1},
        {type: 'media', id: 'phase-only-update', attempt: 1},
    ]);
    assert.deepStrictEqual(synchronized.map((operation) => operation.attempt), [1]);
    assert.strictEqual(engine._active_playback_operation.attempt, 1);
    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt1,
        playbackOperationModule.createNextPlaybackAttempt(attempt1, {
            phase: 'adaptive-retry-2',
        }),
        'mmts-vod-seek-lookback'
    ), false);
    assert.strictEqual(engine._active_playback_operation.attempt, 1);
}

function testMainStartupGroupFailureRoutingIsExactAndAdoptsRetryAttempt() {
    const PlayerEngineMainThread = loadPlayerEngineMainThread();
    const engine = Object.create(PlayerEngineMainThread.prototype);
    const attempt0 = playbackOperationModule.createPlaybackOperation({
        scopeId: 'startup-failure-routing-test',
        timelineGeneration: 8,
        kind: 'seek',
        transactionId: 8,
        phase: 'requested',
        requestedTimeMilliseconds: 8000,
    });
    const attempt1 = playbackOperationModule.createNextPlaybackAttempt(attempt0, {
        phase: 'adaptive-retry',
    });
    const routed = [];
    engine._config = {isMMTS: true};
    engine._active_playback_operation = attempt0;
    engine._audio_track_switch_coordinator = {active: null};
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._transmuxer = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
    };
    engine._mse_buffer_state_machine = {
        canSetPlaybackOperation() { return true; },
        setPlaybackOperation() { return true; },
        onStartupGroupFailure(failure) { routed.push(failure); },
    };

    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt0,
        attempt1,
        'mmts-vod-seek-lookback'
    ), true);
    engine._onMMTSStartupGroupFailure(makeStartupGroupFailure(attempt1), attempt1);
    assert.strictEqual(engine._active_playback_operation.attempt, 1);
    assert.strictEqual(routed.length, 1);
    engine._onMMTSStartupGroupFailure(makeStartupGroupFailure(attempt0), attempt0);
    engine._onMMTSStartupGroupFailure(
        makeStartupGroupFailure(
            playbackOperationModule.withPlaybackOperationPhase(attempt1, 'phase-update')
        ),
        playbackOperationModule.withPlaybackOperationPhase(attempt1, 'phase-update')
    );
    assert.strictEqual(routed.length, 2);

    const startupOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'startup-failure-routing-test',
        timelineGeneration: 9,
        kind: 'startup',
        transactionId: 9,
        phase: 'loading',
        requestedTimeMilliseconds: 9000,
    });
    engine._active_playback_operation = startupOperation;
    engine._onMMTSStartupGroupFailure(
        makeStartupGroupFailure(startupOperation, 'collecting', 'loading-complete'),
        startupOperation
    );
    assert.strictEqual(routed.length, 3);

    const audioOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'startup-failure-routing-test',
        timelineGeneration: 10,
        kind: 'audio-switch',
        transactionId: 10,
        phase: 'requested',
        requestedTimeMilliseconds: 10000,
        packetId: 0xf111,
    });
    const audioFailures = [];
    engine._active_playback_operation = audioOperation;
    engine._audio_track_switch_coordinator = {active: {operation: audioOperation}};
    engine._failUnifiedMMTSAudioTrackSwitch = (operation, reason) => {
        audioFailures.push({operation, reason});
    };
    engine._onMMTSStartupGroupFailure(makeStartupGroupFailure(audioOperation), audioOperation);
    assert.strictEqual(audioFailures.length, 1);
    assert.strictEqual(audioFailures[0].reason, 'startup-group:collecting:timeout');

    engine._audio_track_switch_coordinator.active = null;
    engine._onMMTSStartupGroupFailure(makeStartupGroupFailure(audioOperation), audioOperation);
    engine._onMMTSStartupGroupFailure(
        makeStartupGroupFailure(Object.assign({}, audioOperation, {phase: 'stale'})),
        Object.assign({}, audioOperation, {phase: 'stale'})
    );
    assert.strictEqual(audioFailures.length, 1);
}

function testMainAuthorizesSequentialAudioAttemptsAndFencesOlderMedia() {
    const {engine} = makeVodSwitchHarness(75);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(75000);
    engine._issueMMTSVodAudioTrackSelection();
    const attempt0 = engine._pending_mmts_vod_audio_track_switch.operation;
    const skippedAttempt = Object.assign({}, attempt0, {
        attempt: 2,
        phase: 'adaptive-retry',
    });
    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt0,
        skippedAttempt,
        'invalid-skipped-attempt'
    ), false);
    const attempt1 = playbackOperationModule.createNextPlaybackAttempt(attempt0, {
        phase: 'adaptive-retry',
    });
    const attempt2 = playbackOperationModule.createNextPlaybackAttempt(attempt1, {
        phase: 'adaptive-retry',
    });
    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt0,
        attempt1,
        'audio-retry-1'
    ), true);
    assert.strictEqual(engine._activateOwnerRetryAttempt(
        attempt1,
        attempt2,
        'audio-retry-2'
    ), true);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.operation.attempt, 2);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.operation.attempt, 2);
    confirmVodAudioTrackSwitch(engine, 0xf111);
    const identity0 = makeAudioSwitchContract(attempt0, 0xf111, 75);
    const identity1 = makeAudioSwitchContract(attempt1, 0xf111, 75);
    const identity2 = makeAudioSwitchContract(attempt2, 0xf111, 75);
    assert.strictEqual(engine._doesMMTSVodAudioTrackSwitchMatch(
        identity0,
        engine._pending_mmts_vod_audio_track_switch
    ), false);
    assert.strictEqual(engine._doesMMTSVodAudioTrackSwitchMatch(
        identity1,
        engine._pending_mmts_vod_audio_track_switch
    ), false);
    assert.strictEqual(engine._doesMMTSVodAudioTrackSwitchMatch(
        identity2,
        engine._pending_mmts_vod_audio_track_switch
    ), true);
}

function makeVodRebuildStartupGroup(engine, packetId, requestedTime) {
    const transaction = engine._pending_mmts_vod_audio_track_switch;
    const audioSwitch = Object.assign(makeAudioSwitchContract(
        transaction.operation,
        packetId,
        requestedTime
    ), {
        audioDecodeStart: requestedTime - 0.1,
        audioStart: requestedTime - 0.1,
        audioEnd: requestedTime + 0.3,
    });
    return {
        hasVideo: true,
        hasAudio: true,
        videoInitSegment: {type: 'video', data: {byteLength: 8}},
        audioInitSegment: {type: 'audio', data: {byteLength: 8}, mmtsAudioTrackSwitch: audioSwitch},
        videoMediaSegment: {
            type: 'video',
            data: {byteLength: 32},
            mmtsRandomAccessSafe: true,
            info: {
                beginDts: (requestedTime - 0.1) * 1000,
                endDts: (requestedTime + 0.3) * 1000,
                firstSample: {isSyncPoint: true},
            },
            firstPlayableWindow: {
                decodeStart: requestedTime - 0.1,
                compositionStart: requestedTime - 0.1,
                syncPoint: requestedTime - 0.1,
                playableStart: requestedTime - 0.1,
                playableEnd: requestedTime + 0.3,
            },
        },
        audioMediaSegment: {
            type: 'audio',
            data: {byteLength: 32},
            info: {
                beginDts: (requestedTime - 0.1) * 1000,
                endDts: (requestedTime + 0.3) * 1000,
            },
            mmtsAudioTrackSwitch: audioSwitch,
        },
    };
}

function testChromiumVodAudioSwitchUsesDedicatedAudioOnlyRebuild() {
    const {engine, operations} = makeVodSwitchHarness(105, {
        Browser: {chrome: true},
    });
    engine.selectAudioTrack(0xf111);
    const transaction = engine._audio_track_switch_coordinator.active;
    assert(transaction, 'expected Chromium VOD reseek transaction');
    assert.strictEqual(transaction.strategy, 'vod-reseek');
    assert.notStrictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(operations.some((operation) => operation.type === 'begin'), true);
    assert.strictEqual(operations.some((operation) => operation.type === 'rebuild'), true);
    engine._transmuxer.seek(105000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup(
        makeVodRebuildStartupGroup(engine, 0xf111, 105)
    ).status, 'accepted');

    const rebuild = operations.filter((operation) =>
        operation.type === 'plan' && operation.request.stage === 'rebuild_ready'
    )[0];
    assert(rebuild, 'expected Chromium VOD dedicated audio-only rebuild plan');
    assert.strictEqual(rebuild.request.replaceMediaSource, false);
    assert.strictEqual(rebuild.request.preserveVideoBuffer, true);
    assert.strictEqual(rebuild.request.videoInitSegment, null);
    assert.strictEqual(rebuild.request.videoSegments.length, 0);
    assert.strictEqual(rebuild.request.audioSegments.length, 1);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.stage, 'rebuilding');
}

function testFirefoxVodAudioSwitchReseeksAndRebuildsMediaSource() {
    const {engine, operations} = makeVodSwitchHarness(2.32652, {
        Browser: {firefox: true},
    });
    engine.selectAudioTrack(0xf111);

    const transaction = engine._audio_track_switch_coordinator.active;
    assert(transaction, 'expected Firefox VOD reseek transaction');
    assert.strictEqual(transaction.strategy, 'vod-reseek');
    assert.notStrictEqual(engine._pending_mmts_vod_audio_track_switch, null);
    assert.strictEqual(operations.some((operation) => operation.type === 'begin'), true);
    assert.strictEqual(operations.some((operation) => operation.type === 'rebuild'), true);
    engine._transmuxer.seek(2326.52);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    engine._media_element.currentTime = 17.927458;
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup(
        makeVodRebuildStartupGroup(engine, 0xf111, 2.32652)
    ).status, 'accepted');

    const rebuild = operations.find((operation) =>
        operation.type === 'plan' && operation.request.stage === 'rebuild_ready'
    );
    assert(rebuild, 'expected Firefox VOD full MediaSource rebuild plan');
    assert.strictEqual(rebuild.request.mode, 'vod');
    assert.strictEqual(rebuild.request.replaceMediaSource, true);
    assert.strictEqual(rebuild.request.preserveVideoBuffer, false);
    assert.strictEqual(rebuild.request.switchTime, 2.32652);
    assert.strictEqual(rebuild.request.seekTime, 2.32652);
    assert.notStrictEqual(rebuild.request.videoInitSegment, null);
    assert.strictEqual(rebuild.request.videoSegments.length, 1);
    assert.strictEqual(rebuild.request.audioSegments.length, 1);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.stage, 'submitted');
}

function testMainMSESubmissionRejectionRunsBoundedRecovery() {
    const {engine, operations} = makeVodSwitchHarness(90);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(90000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    engine._mse_buffer_state_machine.onAudioTrackSwitch = (request) => {
        operations.push({type: 'reject_plan', request});
        return false;
    };
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup(
        makeVodRebuildStartupGroup(engine, 0xf111, 90)
    ).status, 'accepted');
    assert.strictEqual(engine._audio_track_switch_coordinator.active.recoveryDepth, 1);
    assert.strictEqual(engine._pending_mmts_vod_audio_track_switch.expectedPacketId, 0xf110);
    engine._transmuxer.seek(90000);
    engine._issueMMTSVodAudioTrackSelection();
    const recovery = engine._audio_track_switch_coordinator.active;
    engine._onMMTSAudioTrackSelectionResult(Object.assign({
        accepted: false,
        changed: false,
        requestedPacketId: 0xf110,
        reason: 'unknown-track',
    }, playbackOperationModule.createPlaybackSwitchIdentity(recovery.operation)),
    recovery.operation);
    assert.strictEqual(engine._audio_track_switch_coordinator.active, null);
    assert.strictEqual(operations.filter((operation) => operation.type === 'fatal').length, 1);
}

function testMainRetryActivationFailureUsesAdvancedTokenForRecovery() {
    const {engine} = makeVodSwitchHarness(95);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(95000);
    engine._issueMMTSVodAudioTrackSelection();
    confirmVodAudioTrackSwitch(engine, 0xf111);
    const generation = engine._pending_mmts_vod_audio_track_switch.generation;
    engine._transmuxer.setPlaybackOperation = (operation) =>
        !(operation.transactionId === generation && operation.attempt === 1);
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.recoveryDepth, 1);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf110);
}

function testMainCommitsTrackStateFromAckWithoutTrackListEvent() {
    const {engine} = makeVodSwitchHarness(105);
    const committedEvents = [];
    engine._emitter.on('mmts_audio_tracks', (data) => committedEvents.push(data));
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(105000);
    engine._issueMMTSVodAudioTrackSelection();
    const transaction = engine._audio_track_switch_coordinator.active;
    engine._onMMTSAudioTrackSelectionResult(Object.assign({
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }, playbackOperationModule.createPlaybackSwitchIdentity(transaction.operation)),
    transaction.operation);
    assert.strictEqual(committedEvents.length, 0);
    assert.strictEqual(engine._applyMMTSVodAudioTrackSwitchStartupGroup(
        makeVodRebuildStartupGroup(engine, 0xf111, 105)
    ).status, 'accepted');
    engine._mse_controller = {abandon() {}, revokeObjectURL() {}};
    engine._createMSEController = () => ({});
    engine._attachMSEControllerToMediaElement = () => {};
    assert.strictEqual(engine._executeMMTSAudioTrackSwitchMediaSourceRebuild({
        resumePlayback: false,
    }), true);
    vodSwitchStateMachineOutputs.get(engine).onAudioTrackSwitchRebuildComplete(
        transaction.operation
    );
    assert.strictEqual(committedEvents.length, 1);
    assert.strictEqual(committedEvents[0].selectedPacketId, 0xf111);
    assert.strictEqual(
        committedEvents[0].tracks.find((track) => track.packetId === 0xf111).selected,
        true
    );
}

function testMainSelectingTimeoutWithoutAckRollsBack() {
    const {engine} = makeVodSwitchHarness(110);
    engine.selectAudioTrack(0xf111);
    engine._transmuxer.seek(110000);
    engine._issueMMTSVodAudioTrackSelection();
    const generation = engine._pending_mmts_vod_audio_track_switch.generation;
    assert.strictEqual(
        engine._audio_track_switch_coordinator.active.selectionMayHaveMutated,
        true
    );
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);
    engine._onMMTSVodAudioTrackSwitchTimeout(generation);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.recoveryDepth, 1);
    assert.strictEqual(engine._audio_track_switch_coordinator.active.targetPacketId, 0xf110);
}

async function main() {
    testRemuxedAudioSwitchPreservesRetryIdentityInInitAndMedia();
    testTransmuxingWorkerAtomicallySeeksAndSelectsVodAudioTrack();
    testVodRebuildCancellationImmediatelySynchronizesWorkerEpoch();
    testVodRebuildUsesOneAtomicWorkerCommand();
    testVodRebuildCancellationTagsNextSeekAndRejectsOldEpoch();
    testInlineVodRebuildResetsStartupCollectorAtSeek();
    testMainVodRebuildRequestsAtomicSeekAndSelection();
    testMainThreadRebuildReleasesOldMediaSourceBeforeAttachAndResumesAfterSeek();
    testMainThreadRebuildDoesNotResumeAfterUserPauses();
    testVodAudioSwitchPreservesFractionalMillisecondContract();
    testVodAudioSwitchRebuildsCurrentTimelineWindow();
    testVodAudioSwitchRebuildsImmediatelyWhenStartupGroupCoversTarget();
    testVodAudioSwitchCollectsBeyondThirtyTwoSegments();
    testEarlyVodAudioSwitchContinuesFromStreamStart();
    testVodUserSeekCancelsRebuildAndAllowsSwitchBackToPrimary();
    testLiveAudioSwitchIsForwardOnlyAndSelectsRebuildStrategy();
    testLiveAudioSwitchIsForwardOnlyAndSelectsRebuildStrategy({chrome: true}, false);
    testLiveAudioSwitchIsForwardOnlyAndSelectsRebuildStrategy({firefox: true}, true);
    testMainLiveInvalidGapAndOverflowFailImmediatelyOnce();
    testMainLiveWatchdogsRecoverMissingAckInitAndMedia();
    testMainLiveTimeoutRollsBackBeforePromotingQueuedTarget();
    testMainPromotesImmutableLiveAudioTarget();
    testMainThreadMpegTsAudioOutputIsNotMMTSGated();
    testVideoTrackSwitchCommitsOnlyAfterMSECompletionAndFencesData();
    testLiveVideoTrackSwitchContinuesForwardWithoutVodSeek();
    testVideoTrackSwitchUsesLWWAndDropsStaleContracts();
    testVideoAlreadySelectedAckStillRequiresMSECompletion();
    testVideoSeekTransferRequiresMatchingAck();
    testMainVideoMediaInfoPublishesOnlyAfterMSECompletion();
    testMainTrackSwitchesQueueLatestIntentAcrossTypes();
    testMainFatalReportingDoesNotReenterStateOrDuplicate();
    testVideoSelectionRejectCleansExactlyOnceAndRollsBack();
    testVodAudioSwitchQueuesLastRequestedTargetAcrossFullLifecycles();
    testMainCommitReentrantSameTargetClearsOlderQueuedIntent();
    testMainCommitReentrantNewTargetReplacesOlderQueuedIntent();
    testVodAudioSwitchWatchdogRestoresLivenessBeforeSelection();
    testVodAudioSwitchWatchdogUsesStageSpecificDeadlines();
    testVodAudioSwitchRecommendationAndCompletionAreTransactionScoped();
    testVodAudioSwitchFailureCallbackRequiresExactTransactionId();
    testVodAudioSwitchPostConfirmationTimeoutRetriesThenCleansUp();
    testVodAudioSwitchTimeoutForcesQueuedCommittedTargetRecovery();
    testVodUserSeekDuringSelectingDoesNotTransferBeforeAck();
    testVodUserSeekDuringSelectingTransfersAfterAck();
    testVodUserSeekBeforeSelectionKeepsCommittedTarget();
    testMainAuthorizesSequentialAudioAttemptsAndFencesOlderMedia();
    testMainAdaptiveSeekAttemptSynchronizesMSEAndFencesStaleOutput();
    testMainStartupGroupFailureRoutingIsExactAndAdoptsRetryAttempt();
    testChromiumVodAudioSwitchUsesDedicatedAudioOnlyRebuild();
    testFirefoxVodAudioSwitchReseeksAndRebuildsMediaSource();
    testMainMSESubmissionRejectionRunsBoundedRecovery();
    testMainRetryActivationFailureUsesAdvancedTokenForRecovery();
    testMainCommitsTrackStateFromAckWithoutTrackListEvent();
    testMainSelectingTimeoutWithoutAckRollsBack();
    await testVodRebuildInvalidatesQueuedAndStaleWorkerEvents();
    await testInlineVodRebuildKeepsFreshQueuedOutput();
    await testRapidSeekDropsQueuedOutputFromSupersededTimeline();

    console.log('mmts track-switch contract tests passed');
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});

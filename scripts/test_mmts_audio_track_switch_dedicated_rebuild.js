#!/usr/bin/env node

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

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
    'PLAYBACK_OPERATION_RETRY_REJECTED',
    'PLAYBACK_OPERATION_RETRY_REQUIRED',
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

function makePlaybackRetryRequest(operation, overrides = {}) {
    return Object.assign({
        requestId: `${operation.attemptKey}:mmts-vod-seek-lookback:1`,
        reason: 'mmts-vod-seek-lookback',
        sourceTransactionKey: operation.transactionKey,
        sourceAttemptKey: operation.attemptKey,
        sourceTimelineGeneration: operation.timelineGeneration,
        sourceTransactionId: operation.transactionId,
        sourceAttempt: operation.attempt,
        segmentIndex: 0,
        requestedTimeMicroseconds: operation.requestedTimeMicroseconds,
        requestedTimeMilliseconds: operation.requestedTimeMilliseconds,
        filePosition: 1000,
        estimatedPosition: 2000,
        lookbackBytes: 1000,
    }, overrides);
}

function compileModule(relativePath, requireMap, globals = {}) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        },
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = Object.assign({
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        Promise,
        setTimeout,
        clearTimeout,
    }, globals);
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

const playbackOperationModule = compileModule('src/core/playback-operation.ts', {});
const playbackOperationResultModule = compileModule(
    'src/player/playback-operation-result.ts',
    {'../core/playback-operation': playbackOperationModule}
);
const playbackOperationSchedulerModule = compileModule(
    'src/player/playback-operation-scheduler.ts',
    {'../core/playback-operation': playbackOperationModule}
);

function makeAudioTracks(selectedPacketId) {
    return [
        {
            packetId: 0xf110,
            mainComponent: true,
            channelCount: 6,
            selected: selectedPacketId === 0xf110,
        },
        {
            packetId: 0xf111,
            mainComponent: false,
            channelCount: 2,
            selected: selectedPacketId === 0xf111,
        },
    ];
}

function makeVideoTracks(selectedPacketId) {
    return [0xf200, 0xf201].map((packetId) => ({
        packetId,
        selected: packetId === selectedPacketId,
    }));
}

function makeInitSegment(type, audioSwitch) {
    const segment = {
        type,
        container: `${type}/mp4`,
        codec: type === 'video' ? 'hvc1.2.1.L183.B0' : 'mp4a.40.5',
        data: new Uint8Array([1, 2, 3]).buffer,
    };
    if (audioSwitch) {
        segment.mmtsAudioTrackSwitch = Object.assign({}, audioSwitch);
    }
    return segment;
}

function makeVideoSegment(start, end) {
    return {
        type: 'video',
        mmtsRandomAccessSafe: true,
        data: new Uint8Array([4, 5, 6]).buffer,
        info: {
            beginDts: start * 1000,
            endDts: end * 1000,
            firstSample: {isSyncPoint: true},
        },
        firstPlayableWindow: {
            decodeStart: start,
            compositionStart: start,
            syncPoint: start,
            playableStart: start,
            playableEnd: end,
        },
    };
}

function makeVideoContinuation(start, end) {
    const segment = makeVideoSegment(start, end);
    delete segment.mmtsRandomAccessSafe;
    delete segment.firstPlayableWindow;
    segment.info.firstSample.isSyncPoint = false;
    return segment;
}

function makeCRAVideoSegment() {
    const segment = makeVideoSegment(2.553, 2.686);
    segment.info.endPts = 2987;
    segment.info.firstSample = {
        isSyncPoint: true,
        dts: 2553,
        pts: 2837,
        duration: 17,
    };
    segment.info.lastSample = {
        isSyncPoint: false,
        dts: 2669,
        pts: 2970,
        duration: 17,
    };
    segment.firstPlayableWindow = {
        decodeStart: 2.553,
        compositionStart: 2.837,
        syncPoint: 2.837,
        playableStart: 2.837,
        playableEnd: 2.987,
    };
    return segment;
}

function makeCRAVideoContinuation() {
    const segment = makeVideoContinuation(2.686, 2.853);
    segment.info.endPts = 3154;
    segment.info.firstSample = {
        isSyncPoint: false,
        dts: 2686,
        pts: 2987,
        duration: 17,
    };
    segment.info.lastSample = {
        isSyncPoint: false,
        dts: 2836,
        pts: 3137,
        duration: 17,
    };
    return segment;
}

function makeAudioSegment(start, end, audioSwitch) {
    const segment = {
        type: 'audio',
        data: new Uint8Array([7, 8, 9]).buffer,
        info: {
            beginDts: start * 1000,
            endDts: end * 1000,
        },
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

function makeVideoTrackSwitchSegment(operation, packetId, isInit, overrides = {}) {
    const segment = isInit ? makeInitSegment('video') : makeVideoSegment(12, 13);
    segment.playbackOperation = Object.assign({}, operation);
    segment.mseBufferGeneration = operation.timelineGeneration;
    segment.mmtsVideoTrackSwitch = Object.assign(
        playbackOperationModule.createPlaybackSwitchIdentity(operation), {
        packetId,
        videoDecodeStart: 11.98,
        videoCompositionStart: 12,
        syncPoint: 12,
        playableStart: 12,
        playableEnd: 13,
    }, overrides);
    return segment;
}

function loadWorker(options = {}) {
    const transmuxers = [];
    const stateMachines = [];
    const mseControllers = [];
    const mseLifecycle = [];

    class FakeTransmuxer extends EventEmitter {
        constructor() {
            super();
            this.operations = [];
            this.selectedAudioPacketId = 0xf110;
            this.selectedVideoPacketId = 0xf200;
            transmuxers.push(this);
        }
        setPlaybackOperation(operation) {
            this.playbackOperation = Object.assign({}, operation);
            return true;
        }
        canSetPlaybackOperation() { return true; }
        canContinuePlaybackOperationRetry(operation, request) {
            const pending = this.pendingPlaybackOperationRetry;
            return !!pending && pending.request.requestId === request.requestId &&
                playbackOperationModule.isPlaybackOperationRetryRequest(
                    request,
                    pending.sourceOperation
                ) &&
                playbackOperationModule.isSamePlaybackTransaction(
                    pending.sourceOperation,
                    operation
                ) &&
                operation.attempt === pending.sourceOperation.attempt + 1 &&
                operation.phase === 'adaptive-retry';
        }
        continuePlaybackOperationRetry(operation, request) {
            if (!this.canContinuePlaybackOperationRetry(operation, request)) {
                return false;
            }
            this.operations.push({type: 'continue_retry', operation, request});
            this.pendingPlaybackOperationRetry = null;
            return this.setPlaybackOperation(operation);
        }
        cancelPlaybackOperationRetry(request) {
            if (!this.pendingPlaybackOperationRetry ||
                this.pendingPlaybackOperationRetry.request.requestId !== request.requestId) {
                return false;
            }
            this.operations.push({type: 'cancel_retry', request});
            this.pendingPlaybackOperationRetry = null;
            return true;
        }
        requestPlaybackOperationRetry(request, sourceOperation) {
            this.pendingPlaybackOperationRetry = {
                request,
                sourceOperation: Object.assign({}, sourceOperation),
            };
            return this.emitForOperation(
                TRANSMUXING_EVENTS.PLAYBACK_OPERATION_RETRY_REQUIRED,
                sourceOperation,
                request
            );
        }
        open(operation) { this.setPlaybackOperation(operation); }
        emit(event, ...args) {
            if (Object.values(TRANSMUXING_EVENTS).includes(event)) {
                args.push(this.playbackOperation);
            }
            return super.emit(event, ...args);
        }
        emitForOperation(event, operation, ...args) {
            return super.emit(event, ...args, operation);
        }
        close() {}
        destroy() {}
        pause() { this.operations.push({type: 'pause'}); }
        resume() { this.operations.push({type: 'resume'}); }
        beginMMTSVodAudioTrackRebuild() { this.operations.push({type: 'begin'}); }
        completeMMTSVodAudioTrackRebuild() { this.operations.push({type: 'complete'}); }
        acknowledgeMMTSVodAudioTrackStartup() { this.operations.push({type: 'ack_startup'}); }
        cancelMMTSVodAudioTrackRebuild() { this.operations.push({type: 'cancel'}); }
        seek(milliseconds) { this.operations.push({type: 'seek', milliseconds}); }
        seekAndSelectAudioTrack(milliseconds, _operation, packetId, timelineSeed,
                                switchIdentity) {
            this.operations.push({
                type: 'select',
                seekMilliseconds: milliseconds,
                packetId,
                timelineSeed,
                rebuildFromSeek: true,
                switchIdentity,
            });
            if (!this.deferAudioSelection) {
                this.emitAudioSelection(packetId, switchIdentity);
            }
        }
        switchPrimaryAudio(timelineSeed, rebuildFromSeek = false, switchIdentity) {
            this.operations.push({type: 'primary', timelineSeed, rebuildFromSeek, switchIdentity});
            this.emitAudioSelection(0xf110, switchIdentity);
        }
        switchSecondaryAudio(timelineSeed, rebuildFromSeek = false, switchIdentity) {
            this.operations.push({type: 'secondary', timelineSeed, rebuildFromSeek, switchIdentity});
            this.emitAudioSelection(0xf111, switchIdentity);
        }
        selectAudioTrack(packetId, timelineSeed, rebuildFromSeek = false, switchIdentity) {
            this.operations.push({type: 'select', packetId, timelineSeed, rebuildFromSeek, switchIdentity});
            if (!this.deferAudioSelection) {
                this.emitAudioSelection(packetId, switchIdentity);
            }
        }
        emitAudioSelection(packetId, switchIdentity) {
            const changed = packetId !== this.selectedAudioPacketId;
            this.selectedAudioPacketId = packetId;
            this.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACK_SELECTION_RESULT, Object.assign({
                accepted: true,
                changed,
                requestedPacketId: packetId,
                selectedPacketId: packetId,
                reason: changed ? 'selected' : 'already-selected',
            }, switchIdentity || {}));
            this.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
                tracks: makeAudioTracks(packetId),
                selectedPacketId: packetId,
            });
        }
        selectVideoTrack(packetId, switchIdentity) {
            this.operations.push({type: 'select_video', packetId, switchIdentity});
            if (this.deferVideoSelection) {
                return;
            }
            this.emitVideoSelection(packetId, switchIdentity);
        }
        seekAndSelectVideoTrack(milliseconds, operation, packetId, switchIdentity) {
            this.operations.push({
                type: 'select_video',
                seekMilliseconds: milliseconds,
                operation,
                packetId,
                switchIdentity,
            });
            if (this.deferVideoSelection) {
                return;
            }
            this.emitVideoSelection(packetId, switchIdentity);
        }
        emitVideoSelection(packetId, switchIdentity) {
            const changed = packetId !== this.selectedVideoPacketId;
            this.selectedVideoPacketId = packetId;
            this.emit(TRANSMUXING_EVENTS.MMTS_VIDEO_TRACKS, {
                tracks: makeVideoTracks(packetId),
                selectedPacketId: packetId,
            });
            this.emit(TRANSMUXING_EVENTS.MMTS_VIDEO_TRACK_SELECTION_RESULT, Object.assign({
                accepted: true,
                changed,
                requestedPacketId: packetId,
                selectedPacketId: packetId,
                reason: changed ? 'selected' : 'already-selected',
            }, switchIdentity || {}));
        }
    }

    class FakeMSEController extends EventEmitter {
        constructor() {
            super();
            this.id = mseControllers.length + 1;
            this.handle = {id: this.id};
            this.calls = [];
            this.durations = [];
            mseControllers.push(this);
        }
        initialize() { this.calls.push('initialize'); }
        getHandle() { return this.handle; }
        setMediaDuration(duration) { this.durations.push(duration); }
        abandon() {
            this.calls.push('abandon');
            mseLifecycle.push({type: 'abandon', controllerId: this.id});
        }
        revokeObjectURL() { this.calls.push('revoke'); }
        shutdown() { this.calls.push('shutdown'); }
        destroy() { this.calls.push('destroy'); }
        clearBufferedRanges() {}
        appendInitSegmentDirect() { return {ok: true, empty: true}; }
        appendMediaSegmentDirect() { return {ok: true, empty: true}; }
        removeRangeDirect() { return {ok: true}; }
        resetParserStateDirect() { return {ok: true}; }
        endOfStream() {}
        getMediaSourceState() { return {readyState: 'open', sourceBuffers: {}}; }
        getForwardBufferInfo(currentTime) {
            return {currentTime, forwardDuration: 0, audioForwardDuration: 0, videoForwardDuration: 0};
        }
        getBufferedRanges() { return []; }
    }

    class FakeMSEBufferStateMachine {
        constructor(config, output) {
            this.config = config;
            this.output = output;
            this.operations = [];
            this.playbackOperations = [];
            stateMachines.push(this);
        }
        setPlaybackOperation(operation) {
            this.playbackOperation = Object.assign({}, operation);
            this.playbackOperations.push(Object.assign({}, operation));
            return true;
        }
        canSetPlaybackOperation() { return true; }
        destroy() {}
        flushPending() {}
        onSourceOpen() { this.operations.push({type: 'source_open'}); }
        onUpdateEnd() {}
        onQuotaExceeded() {}
        onEndOfStream() {}
        onMediaInfo(mediaInfo) { this.operations.push({type: 'media_info', mediaInfo}); }
        onRecommendedSeekPoint() {}
        onMediaState() {}
        onFatal(error) { this.output.emitFatal(error); }
        onSeek(targetTime) { this.operations.push({type: 'unbuffered_seek', targetTime}); }
        onUserSeek(targetTime) { this.operations.push({type: 'user_seek', targetTime}); }
        getForwardBufferInfo(currentTime) {
            return {currentTime, forwardDuration: 0, audioForwardDuration: 0, videoForwardDuration: 0};
        }
        onMMTSVodAudioTrackRebuild(targetTime, operation) {
            this.operations.push({type: 'vod_rebuild', targetTime});
            this.output.seekTransmuxer(
                targetTime * 1000,
                'MMTS_VOD_AUDIO_TRACK_REBUILD',
                operation
            );
            return true;
        }
        cancelAudioTrackSwitch(operation) {
            this.operations.push({
                type: 'audio_switch_cancel',
                transactionId: operation.transactionId,
            });
            return true;
        }
        onAudioTrackSwitch(request) {
            this.operations.push({type: 'audio_switch', request});
            if (request.stage !== 'rebuild_ready') {
                return true;
            }
            if (request.replaceMediaSource === false) {
                return true;
            }
            return this.output.rebuildMediaSource(Object.assign({type: 'audio_track_switch'}, request));
        }
        onVideoTrackSwitch(request) {
            this.operations.push({type: 'video_switch', request});
            return true;
        }
        cancelVideoTrackSwitch(operation) {
            this.operations.push({
                type: 'video_switch_cancel',
                transactionId: operation.transactionId,
            });
            return true;
        }
        onExternalMSEError(error) {
            this.operations.push({type: 'external_mse_error', error});
            this.output.emitFatal(error);
        }
        onStartupGroupFailure(failure) {
            this.operations.push({type: 'startup_group_failure', failure});
        }
        onInitSegment(type, segment) { this.operations.push({type: 'init', trackType: type, segment}); }
        onMediaSegment(type, segment) { this.operations.push({type: 'media', trackType: type, segment}); }
        onStartupGroup(group) { this.operations.push({type: 'startup', group}); }
    }

    const mseEvents = {
        SOURCE_OPEN: 'source_open',
        UPDATE_END: 'update_end',
        BUFFER_FULL: 'buffer_full',
        ERROR: 'error',
    };
    const playerEvents = new Proxy({}, {
        get(_target, property) { return String(property).toLowerCase(); },
    });
    const coordinatorSetTimeout = options.setTimeout || ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref?.();
        return timer;
    });
    const Coordinator = compileModule('src/player/mmts-audio-track-switch-transaction.ts', {
        '../core/playback-operation': playbackOperationModule,
        './playback-operation-result': playbackOperationResultModule,
        './playback-operation-scheduler': playbackOperationSchedulerModule,
    }, {
        setTimeout: coordinatorSetTimeout,
        clearTimeout: options.clearTimeout || clearTimeout,
        Date: options.Date || Date,
    }).default;
    const VideoCoordinator = compileModule('src/player/mmts-video-track-switch-transaction.ts', {
        '../core/playback-operation': playbackOperationModule,
    }, {
        setTimeout: coordinatorSetTimeout,
        clearTimeout: options.clearTimeout || clearTimeout,
        Date: options.Date || Date,
    }).default;
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
    const trackSwitchWindowModule = compileModule(
        'src/player/mmts-track-switch-window.ts',
        {}
    );
    const requireMap = {
        '../utils/browser': {__esModule: true, default: options.Browser || {chrome: false}},
        '../utils/logger': {__esModule: true, default: {v() {}, w() {}, e() {}}},
        '../utils/logging-control': {
            __esModule: true,
            default: {applyConfig() {}, addLogListener() {}, removeLogListener() {}},
        },
        '../utils/exception': {IllegalStateException: class IllegalStateException extends Error {}},
        '../core/media-info': {__esModule: true, default: class {}},
        '../core/mse-events': {__esModule: true, default: mseEvents},
        '../core/mse-controller': {__esModule: true, default: FakeMSEController},
        '../core/transmuxer': {__esModule: true, default: FakeTransmuxer},
        '../core/transmuxing-events': {__esModule: true, default: TRANSMUXING_EVENTS},
        './player-events': {__esModule: true, default: playerEvents},
        './player-errors': {ErrorTypes: {MEDIA_ERROR: 'media_error', MEDIA_MSE_ERROR: 'mse_error'}},
        './mse-buffer-state-machine': {__esModule: true, default: FakeMSEBufferStateMachine},
        '../utils/mmts-demuxer-utils': {
            findPreferredAudioTrack(tracks) {
                return tracks.find((track) => track.mainComponent) || tracks[0];
            },
            isMMTSAudioTrackSelectable(track) { return !!track && track.selectable !== false; },
        },
        './player-engine-worker-cmd-def.js': {},
        './player-engine-worker-msg-def.js': {},
        '../core/playback-operation': playbackOperationModule,
        './playback-operation-result': playbackOperationResultModule,
        './playback-operation-scheduler': playbackOperationSchedulerModule,
        '../core/mmts-startup-group-lifecycle': startupGroupLifecycleModule,
        './mmts-audio-track-switch-transaction': {__esModule: true, default: Coordinator},
        './mmts-video-track-switch-transaction': {__esModule: true, default: VideoCoordinator},
        './mmts-track-switch-window': trackSwitchWindowModule,
    };
    const exports = compileModule('src/player/player-engine-worker.ts', requireMap, {
        DedicatedWorkerGlobalScope: class {},
        setTimeout: options.setTimeout || setTimeout,
        clearTimeout: options.clearTimeout || clearTimeout,
    });
    return {
        PlayerEngineWorker: exports.default,
        transmuxers,
        stateMachines,
        mseControllers,
        mseLifecycle,
    };
}

function makeWorkerHarness({
    isMMTS = true,
    isLive,
    currentTime,
    Browser,
    setTimeoutImpl,
    clearTimeoutImpl,
    DateImpl,
}) {
    const loaded = loadWorker({
        Browser,
        setTimeout: setTimeoutImpl,
        clearTimeout: clearTimeoutImpl,
        Date: DateImpl,
    });
    const posted = [];
    let onMessage = null;
    const scope = {
        addEventListener(type, listener) {
            if (type === 'message') {
                onMessage = listener;
            }
        },
        postMessage(message) {
            if (message.msg === 'mse_init') {
                loaded.mseLifecycle.push({type: 'post-mse-init', rebuild: message.rebuild});
            }
            posted.push(message);
        },
    };
    loaded.PlayerEngineWorker(scope);
    let playbackGeneration = 1;
    const playbackScopeId = `dedicated-worker-test-${Date.now()}-${Math.random()}`;
    const dispatch = (data) => {
        if (isMMTS && (data.cmd === 'user_seek' || data.cmd === 'unbuffered_seek') &&
            !data.playback_operation) {
            playbackGeneration++;
            data.playback_operation = playbackOperationModule.createPlaybackOperation({
                scopeId: playbackScopeId,
                timelineGeneration: playbackGeneration,
                kind: 'seek',
                transactionId: playbackGeneration,
                phase: 'requested',
                requestedTimeMilliseconds: data.cmd === 'user_seek' ?
                    data.target_time * 1000 : data.milliseconds,
            });
        }
        if (isMMTS && (data.cmd === 'select_audio_track' || data.cmd === 'switch_audio') &&
            !data.playback_operation) {
            const targetPacketId = data.cmd === 'select_audio_track' ? data.packet_id :
                (data.audio_track === 'primary' ? 0xf110 : 0xf111);
            const timelineSeed = data.timeline_seed;
            const requestedGeneration = ++playbackGeneration;
            data.playback_operation = playbackOperationModule.createPlaybackOperation({
                scopeId: playbackScopeId,
                timelineGeneration: requestedGeneration,
                kind: 'audio-switch',
                transactionId: requestedGeneration,
                phase: 'requested',
                requestedTimeMilliseconds: timelineSeed,
                packetId: targetPacketId,
            });
            const committed = posted.slice().reverse().find((message) =>
                (message.msg === TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS &&
                    message.data && Number.isInteger(message.data.selectedPacketId)) ||
                (message.msg === 'player_event' &&
                    message.event === TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS && message.extraData &&
                    Number.isInteger(message.extraData.selectedPacketId))
            );
            const recoveryPacketId = committed ?
                (committed.data || committed.extraData).selectedPacketId : 0xf110;
            const recoveryGeneration = ++playbackGeneration;
            data.recovery_playback_operation = playbackOperationModule.createPlaybackOperation({
                scopeId: playbackScopeId,
                timelineGeneration: recoveryGeneration,
                kind: 'audio-switch',
                transactionId: recoveryGeneration,
                phase: 'recovery-reserved',
                requestedTimeMilliseconds: timelineSeed,
                packetId: recoveryPacketId,
            });
        }
        if (isMMTS && data.cmd === 'select_video_track' && !data.playback_operation) {
            const requestedGeneration = ++playbackGeneration;
            data.playback_operation = playbackOperationModule.createPlaybackOperation({
                scopeId: playbackScopeId,
                timelineGeneration: requestedGeneration,
                kind: 'video-switch',
                transactionId: requestedGeneration,
                phase: 'requested',
                requestedTimeMilliseconds: currentTime * 1000,
                packetId: data.packet_id,
            });
            const committed = posted.slice().reverse().find((message) =>
                message.msg === 'player_event' &&
                message.event === TRANSMUXING_EVENTS.MMTS_VIDEO_TRACKS &&
                message.extraData && Number.isInteger(message.extraData.selectedPacketId)
            );
            const recoveryPacketId = committed ? committed.extraData.selectedPacketId : 0xf200;
            const recoveryGeneration = ++playbackGeneration;
            data.recovery_playback_operation = playbackOperationModule.createPlaybackOperation({
                scopeId: playbackScopeId,
                timelineGeneration: recoveryGeneration,
                kind: 'video-switch',
                transactionId: recoveryGeneration,
                phase: 'recovery-reserved',
                requestedTimeMilliseconds: currentTime * 1000,
                packetId: recoveryPacketId,
            });
        }
        if (isMMTS && ['startup_jump', 'timeupdate', 'readystatechange',
            'pause_transmuxer', 'resume_transmuxer'].includes(data.cmd) &&
            !data.playback_operation) {
            const started = posted.slice().reverse().find((message) =>
                message.msg === 'playback_operation_started' && message.playback_operation
            );
            data.playback_operation = started ?
                Object.assign({}, started.playback_operation) : startupOperation;
        }
        onMessage({data});
    };
    dispatch({
        cmd: 'init',
        media_data_source: {type: isMMTS ? 'mmts' : 'mpegts'},
        config: {isMMTS, isLive, deferLoadAfterSourceOpen: false, lazyLoad: false},
    });
    const startupOperation = isMMTS ? playbackOperationModule.createPlaybackOperation({
        scopeId: playbackScopeId,
        timelineGeneration: 1,
        kind: 'startup',
        transactionId: 1,
        phase: 'loading',
        requestedTimeMilliseconds: 0,
    }) : undefined;
    dispatch({cmd: 'initialize_mse', playback_operation: startupOperation});
    dispatch({cmd: 'load', playback_operation: startupOperation});
    dispatch({cmd: 'timeupdate', current_time: currentTime});
    const transmuxer = loaded.transmuxers[0];
    if (isMMTS) {
        transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
            tracks: makeAudioTracks(0xf110),
            selectedPacketId: 0xf110,
        });
        transmuxer.emit(TRANSMUXING_EVENTS.MMTS_VIDEO_TRACKS, {
            tracks: makeVideoTracks(0xf200),
            selectedPacketId: 0xf200,
        });
    }
    return Object.assign({dispatch, posted, transmuxer}, loaded, {
        stateMachine: loaded.stateMachines[0],
    });
}

function getRebuildRequest(harness) {
    const operation = harness.stateMachine.operations.slice().reverse().find((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    );
    assert(operation, 'expected rebuild_ready request');
    return operation.request;
}

function getLastAudioSwitchIdentity(harness) {
    const operation = harness.transmuxer.operations.slice().reverse().find((item) =>
        item.switchIdentity
    );
    assert(operation, 'expected propagated audio switch identity');
    return operation.switchIdentity;
}

function getLastVideoSwitchOperation(harness) {
    const message = harness.posted.slice().reverse().find((packet) =>
        packet.msg === 'playback_operation_started' && packet.playback_operation &&
        packet.playback_operation.kind === 'video-switch'
    );
    assert(message, 'expected started video switch operation');
    return message.playback_operation;
}

function getVideoTrackEvents(harness) {
    return harness.posted.filter((packet) =>
        packet.msg === 'player_event' &&
        packet.event === TRANSMUXING_EVENTS.MMTS_VIDEO_TRACKS
    );
}

function submitWorkerVideoSwitchData(harness, operation, packetId) {
    harness.transmuxer.emit(
        TRANSMUXING_EVENTS.INIT_SEGMENT,
        'video',
        makeVideoTrackSwitchSegment(operation, packetId, true)
    );
    harness.transmuxer.emit(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        'video',
        makeVideoTrackSwitchSegment(operation, packetId, false)
    );
}

function assertOldControllerWasReleasedBeforeRebuildHandle(harness) {
    const controller = harness.mseControllers[0];
    assert.strictEqual(controller.calls.filter((call) => call === 'abandon').length, 1);
    assert.strictEqual(controller.calls.filter((call) => call === 'revoke').length, 1);
    assert.strictEqual(controller.calls.includes('shutdown'), false);
    assert.strictEqual(controller.calls.includes('destroy'), false);
    const releaseIndex = harness.mseLifecycle.findIndex((operation) =>
        operation.type === 'abandon' && operation.controllerId === controller.id
    );
    const rebuildHandleIndex = harness.mseLifecycle.findIndex((operation) =>
        operation.type === 'post-mse-init' && operation.rebuild === true
    );
    assert(releaseIndex >= 0 && rebuildHandleIndex > releaseIndex,
        'old SourceBuffers must be released before posting the replacement MediaSource handle');
}

function testLiveSwitchBuildsSynchronizedPlanWithoutSeek(
    Browser = {chrome: false},
    expectedReplaceMediaSource = false
) {
    const harness = makeWorkerHarness({isLive: true, currentTime: 10, Browser});
    harness.transmuxer.deferAudioSelection = true;
    const onAudioTrackSwitch = harness.stateMachine.onAudioTrackSwitch.bind(harness.stateMachine);
    let liveRequestCount = 0;
    harness.stateMachine.onAudioTrackSwitch = (request) => {
        if (request.stage === 'request') {
            assert.strictEqual(
                harness.transmuxer.operations.filter((operation) => operation.type === 'select').length,
                liveRequestCount,
                'live request must reach the state machine before selecting the new track'
            );
            liveRequestCount++;
        }
        return onAudioTrackSwitch(request);
    };
    const videoInit = makeInitSegment('video');
    const videoMedia = makeVideoSegment(10.2, 12);
    const startupOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    videoInit.playbackOperation = Object.assign({}, startupOperation);
    videoInit.mseBufferGeneration = startupOperation.timelineGeneration;
    videoMedia.playbackOperation = Object.assign({}, startupOperation);
    videoMedia.mseBufferGeneration = startupOperation.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: videoInit,
        audioInitSegment: makeInitSegment('audio'),
        videoMediaSegment: videoMedia,
        audioMediaSegment: makeAudioSegment(10.1, 12),
        startupTime: 10.2,
        playableStart: 10.2,
        playableEnd: 12,
        hasVideo: true,
        hasAudio: true,
    });

    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 10500,
        rebuild_from_seek: false,
    });
    const switchOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.transmuxer.operations)), [
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
    const initialRequests = harness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch' && item.request.stage === 'request'
    );
    assert.strictEqual(initialRequests.length, 1);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(initialRequests[0].request)),
        {
            stage: 'request',
            mode: 'live',
            operation: JSON.parse(JSON.stringify(switchOperation)),
            transactionId: 2,
        }
    );

    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 10.5,
        requestedStartMicroseconds: 10500000,
    });
    const audioInit = makeInitSegment('audio', switchContract);
    const firstAudioMedia = makeAudioSegment(10, 10.4, switchContract);
    const continuousAudioMedia = makeAudioSegment(10.4, 11.8);
    for (const segment of [audioInit, firstAudioMedia, continuousAudioMedia]) {
        segment.playbackOperation = Object.assign({}, switchOperation);
        segment.mseBufferGeneration = switchOperation.timelineGeneration;
    }
    harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', audioInit);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', firstAudioMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', continuousAudioMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    harness.transmuxer.emitAudioSelection(0xf111, getLastAudioSwitchIdentity(harness));
    const preservesVideoBuffer = Browser.firefox !== true;
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), preservesVideoBuffer);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', videoMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), preservesVideoBuffer, 'old-generation cached video must not enter the rebuild plan');
    const currentVideoRAP = makeVideoSegment(10.2, 12);
    currentVideoRAP.playbackOperation = Object.assign({}, switchOperation);
    currentVideoRAP.mseBufferGeneration = switchOperation.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', currentVideoRAP);

    const request = getRebuildRequest(harness);
    assert.strictEqual(request.replaceMediaSource, expectedReplaceMediaSource);
    assert.strictEqual(request.preserveVideoBuffer, preservesVideoBuffer);
    assert.strictEqual(request.switchTime, 10.5);
    assert.strictEqual(request.seekTime, 10.5);
    if (preservesVideoBuffer) {
        assert.strictEqual(request.videoInitSegment, null);
        assert.strictEqual(request.videoSegments.length, 0);
    } else {
        assert.notStrictEqual(request.videoInitSegment, videoInit);
        assert.strictEqual(request.videoInitSegment.data, videoInit.data);
        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(request.videoInitSegment.playbackOperation)),
            JSON.parse(JSON.stringify(switchOperation))
        );
        assert.strictEqual(
            request.videoInitSegment.mseBufferGeneration,
            switchOperation.timelineGeneration
        );
        assert.strictEqual(request.videoSegments.length, 1);
        assert.strictEqual(request.videoSegments[0], currentVideoRAP);
    }
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(videoInit.playbackOperation)),
        JSON.parse(JSON.stringify(startupOperation))
    );
    assert.strictEqual(videoInit.mseBufferGeneration, startupOperation.timelineGeneration);
    assert.strictEqual(request.audioInitSegment, audioInit);
    assert.strictEqual(request.videoSegments.includes(videoMedia), false);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        (item.type === 'init' || item.type === 'media') && item.trackType === 'video' &&
        item.segment && item.segment.playbackOperation &&
        item.segment.playbackOperation.transactionId === switchOperation.transactionId
    ), preservesVideoBuffer,
    'transaction video data should stay on the existing MSE only for audio-only rebuilds');
    assert.strictEqual(request.audioSegments.length, 2);
    assert.strictEqual(request.audioSegments[0], firstAudioMedia);
    assert.strictEqual(request.audioSegments[1], continuousAudioMedia);
    assert.strictEqual('resetParserState' in request.audioInitSegment, false);
    assert.strictEqual('rebuildSourceBuffer' in request.audioInitSegment, false);
    const appendedAudioBeforeLateTagged = harness.stateMachine.operations.filter((item) =>
        item.type === 'media' && item.trackType === 'audio'
    ).length;
    const lateTaggedAudio = makeAudioSegment(11.8, 12, switchContract);
    lateTaggedAudio.playbackOperation = Object.assign({}, switchOperation);
    lateTaggedAudio.mseBufferGeneration = switchOperation.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', lateTaggedAudio);
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'media' && item.trackType === 'audio'
    ).length, appendedAudioBeforeLateTagged);
    assert.strictEqual(harness.transmuxer.operations.some((item) => item.type === 'seek'), false);
    const mseInitMessages = harness.posted.filter((packet) => packet.msg === 'mse_init');
    if (expectedReplaceMediaSource) {
        assert.strictEqual(harness.mseControllers.length, 2);
        assert.deepStrictEqual(mseInitMessages.map((packet) => packet.rebuild), [false, true]);
        assert.strictEqual(mseInitMessages[1].handle, harness.mseControllers[1].handle);
        assertOldControllerWasReleasedBeforeRebuildHandle(harness);
    } else {
        assert.strictEqual(harness.mseControllers.length, 1);
        assert.deepStrictEqual(mseInitMessages.map((packet) => packet.rebuild), [false]);
        assert.strictEqual(harness.mseControllers[0].calls.includes('abandon'), false);
    }

    const operationCountBeforePlayable = harness.transmuxer.operations.length;
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 10750,
        rebuild_from_seek: false,
    });
    assert.strictEqual(harness.transmuxer.operations.length, operationCountBeforePlayable);

    if (!preservesVideoBuffer) {
        harness.stateMachine.output.seekMedia(10.5, 'AUDIO_TRACK_SWITCH_REBUILD');
    }
    harness.stateMachine.output.onAudioTrackSwitchRebuildComplete(request.operation);
    const controlledSeek = harness.posted.slice().reverse().find((packet) =>
        packet.msg === 'controlled_seek'
    );
    if (preservesVideoBuffer) {
        assert.strictEqual(controlledSeek, undefined);
    } else {
        assert.strictEqual(controlledSeek.msg, 'controlled_seek');
        assert.strictEqual(controlledSeek.reason, 'AUDIO_TRACK_SWITCH_REBUILD');
    }
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 11000,
        rebuild_from_seek: false,
    });
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.transmuxer.operations[harness.transmuxer.operations.length - 1])),
        {
            type: 'select',
            packetId: 0xf110,
            timelineSeed: preservesVideoBuffer ? 10500 : 11000,
            rebuildFromSeek: false,
            switchIdentity: JSON.parse(JSON.stringify(
                playbackOperationModule.createPlaybackSwitchIdentity(
                    harness.transmuxer.playbackOperation
                )
            )),
        }
    );
    assert.strictEqual(
        liveRequestCount,
        harness.transmuxer.operations.filter((operation) => operation.type === 'select').length
    );
}

function testLiveCRAPresentationWindowSubmitsWithoutDTSCoverage() {
    const harness = makeWorkerHarness({isLive: true, currentTime: 2.96});
    const startupOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    const startupVideoInit = makeInitSegment('video');
    const startupVideo = makeVideoSegment(2.4, 3.1);
    for (const segment of [startupVideoInit, startupVideo]) {
        segment.playbackOperation = Object.assign({}, startupOperation);
        segment.mseBufferGeneration = startupOperation.timelineGeneration;
    }
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: startupVideoInit,
        audioInitSegment: makeInitSegment('audio'),
        videoMediaSegment: startupVideo,
        audioMediaSegment: makeAudioSegment(2.4, 3.1),
        startupTime: 2.4,
        playableStart: 2.4,
        playableEnd: 3.1,
        hasVideo: true,
        hasAudio: true,
    });

    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 2960,
        rebuild_from_seek: false,
    });
    const switchOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 2.96,
        requestedStartMicroseconds: 2960000,
    });
    const audioInit = makeInitSegment('audio', switchContract);
    const audioMedia = makeAudioSegment(2.9, 3.3, switchContract);
    const craVideo = makeCRAVideoSegment();
    const unsafeCRAVideo = Object.assign({}, craVideo);
    delete unsafeCRAVideo.mmtsRandomAccessSafe;
    const videoContinuation = makeCRAVideoContinuation();
    for (const segment of [audioInit, audioMedia, craVideo, unsafeCRAVideo,
        videoContinuation]) {
        segment.playbackOperation = Object.assign({}, switchOperation);
        segment.mseBufferGeneration = switchOperation.timelineGeneration;
    }

    harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', audioInit);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', audioMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), true);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', unsafeCRAVideo);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', craVideo);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', videoContinuation);

    const request = getRebuildRequest(harness);
    assert.strictEqual(request.seekTime, 2.96);
    assert.strictEqual(request.preserveVideoBuffer, true);
    assert.strictEqual(request.videoInitSegment, null);
    assert.deepStrictEqual(Array.from(request.videoSegments), []);
    assert.deepStrictEqual(Array.from(request.audioSegments), [audioMedia]);
    const oldMSEVideoSegments = harness.stateMachine.operations.filter((item) =>
        item.type === 'media' && item.trackType === 'video' &&
        item.segment && item.segment.playbackOperation &&
        item.segment.playbackOperation.transactionId === switchOperation.transactionId
    ).map((item) => item.segment);
    assert.deepStrictEqual(
        oldMSEVideoSegments,
        [unsafeCRAVideo, craVideo, videoContinuation],
        'preserved video must keep feeding the existing MSE during the audio switch'
    );
    assert.strictEqual(
        oldMSEVideoSegments.includes(videoContinuation),
        true,
        'audio-only rebuilds must not intercept current video segments'
    );
}

function testWorkerVodSwitchPreservesFractionalMillisecondContract() {
    const requestedTime = 2.213875;
    const requestedTimeMilliseconds = requestedTime * 1000;
    const harness = makeWorkerHarness({isLive: false, currentTime: requestedTime});

    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: requestedTimeMilliseconds,
        rebuild_from_seek: true,
    });

    const selection = harness.transmuxer.operations.find((operation) =>
        operation.type === 'select'
    );
    assert(selection, 'expected worker audio-track selection command');
    assert.strictEqual(selection.timelineSeed, requestedTimeMilliseconds);
}

function testVodSwitchSeeksThenBuildsFreshStartupPlanAndRestoresDuration(
    Browser = {chrome: false},
    expectedReplaceMediaSource = false
) {
    const harness = makeWorkerHarness({
        isLive: false,
        currentTime: 195.445,
        Browser,
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_INFO, {duration: 459659});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 195445,
        rebuild_from_seek: true,
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.transmuxer.operations)), [
        {type: 'begin'},
        {
            type: 'select', seekMilliseconds: 195445, packetId: 0xf111,
            timelineSeed: 195445, rebuildFromSeek: true,
            switchIdentity: JSON.parse(JSON.stringify(
                playbackOperationModule.createPlaybackSwitchIdentity(
                    harness.transmuxer.playbackOperation
                )
            )),
        },
        {type: 'complete'},
    ]);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'request'
    ), false);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });
    assert.strictEqual(harness.transmuxer.operations[2].type, 'complete');

    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 195.445,
        requestedStartMicroseconds: 195445000,
    });
    const videoInit = makeInitSegment('video');
    const audioInit = makeInitSegment('audio', switchContract);
    const videoMedia = makeVideoSegment(195.4, 195.47);
    const audioMedia = makeAudioSegment(195.3, 195.47, switchContract);
    const continuedVideoMedia = makeVideoContinuation(195.47, 195.8);
    const continuedAudioMedia = makeAudioSegment(195.47, 195.8);
    const startupGroup = {
        videoInitSegment: videoInit,
        audioInitSegment: audioInit,
        videoMediaSegment: videoMedia,
        audioMediaSegment: audioMedia,
        startupTime: 195.4,
        playableStart: 195.4,
        playableEnd: 195.47,
        hasVideo: true,
        hasAudio: true,
    };
    if (Browser.firefox === true) {
        harness.dispatch({cmd: 'timeupdate', current_time: 210});
    }
    const currentOperation = harness.transmuxer.playbackOperation;
    const staleOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: currentOperation.scopeId,
        timelineGeneration: currentOperation.timelineGeneration + 1,
        kind: 'audio-switch',
        transactionId: currentOperation.transactionId + 1,
        phase: 'requested',
        requestedTimeMilliseconds: 195445,
        packetId: 0xf111,
    });
    const staleTransactionContract = Object.assign({}, switchContract,
        playbackOperationModule.createPlaybackSwitchIdentity(staleOperation));
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, Object.assign({}, startupGroup, {
        audioInitSegment: makeInitSegment('audio', staleTransactionContract),
        audioMediaSegment: makeAudioSegment(195.3, 195.47, staleTransactionContract),
    }));
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    assert.strictEqual(harness.mseControllers.length, 1);

    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, startupGroup);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    assert.strictEqual(harness.mseControllers.length, 1);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', continuedVideoMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    const staleAttemptContinuation = makeAudioSegment(195.47, 195.8, Object.assign({}, switchContract, {
        attempt: 1,
    }));
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', staleAttemptContinuation);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', continuedAudioMedia);

    const request = getRebuildRequest(harness);
    const preservesVideoBuffer = Browser.firefox !== true;
    assert.strictEqual(request.mode, preservesVideoBuffer ? 'vod-forward' : 'vod');
    assert.strictEqual(request.replaceMediaSource, expectedReplaceMediaSource);
    assert.strictEqual(request.preserveVideoBuffer, preservesVideoBuffer);
    assert.strictEqual(request.switchTime, 195.445);
    assert.strictEqual(request.seekTime, 195.445);
    if (preservesVideoBuffer) {
        assert.strictEqual(request.videoInitSegment, null);
        assert.strictEqual(request.videoSegments.length, 0);
    } else {
        assert.strictEqual(request.videoInitSegment, videoInit);
        assert.strictEqual(request.videoSegments.length, 2);
        assert.strictEqual(request.videoSegments[0], videoMedia);
        assert.strictEqual(request.videoSegments[1], continuedVideoMedia);
    }
    assert.strictEqual(request.audioSegments.length, 2);
    assert.strictEqual(request.audioSegments[0], audioMedia);
    assert.strictEqual(request.audioSegments[1], continuedAudioMedia);
    assert.strictEqual('resetParserState' in request.audioInitSegment, false);
    assert.strictEqual('rebuildSourceBuffer' in request.audioInitSegment, false);
    const mseInitMessages = harness.posted.filter((packet) => packet.msg === 'mse_init');
    if (expectedReplaceMediaSource) {
        assert.strictEqual(harness.mseControllers.length, 2);
        assert.deepStrictEqual(harness.mseControllers[1].durations, [459.659]);
        assertOldControllerWasReleasedBeforeRebuildHandle(harness);
        assert.deepStrictEqual(mseInitMessages.map((packet) => packet.rebuild), [false, true]);
    } else {
        assert.strictEqual(harness.mseControllers.length, 1);
        assert.deepStrictEqual(mseInitMessages.map((packet) => packet.rebuild), [false]);
        assert.strictEqual(harness.mseControllers[0].calls.includes('abandon'), false);
    }
}

function testChromiumVodSwitchUsesDedicatedAudioOnlyPlan() {
    const harness = makeWorkerHarness({
        isLive: false,
        currentTime: 195.445,
        Browser: {chrome: true},
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_INFO, {duration: 459659});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 195445,
        rebuild_from_seek: true,
    });

    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.transmuxer.operations)), [
        {type: 'begin'},
        {
            type: 'select',
            seekMilliseconds: 195445,
            packetId: 0xf111,
            timelineSeed: 195445,
            rebuildFromSeek: true,
            switchIdentity: JSON.parse(JSON.stringify(
                playbackOperationModule.createPlaybackSwitchIdentity(
                    harness.transmuxer.playbackOperation
                )
            )),
        },
        {type: 'complete'},
    ]);
    const requestOperation = harness.stateMachine.operations.find((item) =>
        item.type === 'audio_switch' && item.request.stage === 'request'
    );
    assert.strictEqual(requestOperation, undefined);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'vod_rebuild'
    ), true);

    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 195.445,
        requestedStartMicroseconds: 195445000,
    });
    const audioInit = makeInitSegment('audio', switchContract);
    const audioMedia = makeAudioSegment(195.4, 195.8, switchContract);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: audioInit,
        videoMediaSegment: makeVideoSegment(195.4, 195.8),
        audioMediaSegment: audioMedia,
        startupTime: 195.4,
        playableStart: 195.4,
        playableEnd: 195.8,
        hasVideo: true,
        hasAudio: true,
    });

    const request = getRebuildRequest(harness);
    assert.strictEqual(request.mode, 'vod-forward');
    assert.strictEqual(request.replaceMediaSource, false);
    assert.strictEqual(request.preserveVideoBuffer, true);
    assert.strictEqual(request.switchTime, 195.445);
    assert.strictEqual(request.seekTime, 195.445);
    assert.strictEqual(request.videoInitSegment, null);
    assert.strictEqual(request.videoSegments.length, 0);
    assert.strictEqual(request.audioInitSegment, audioInit);
    assert.strictEqual(request.audioSegments.length, 1);
    assert.strictEqual(request.audioSegments[0], audioMedia);
    assert.strictEqual(harness.mseControllers.length, 1);
    assert.strictEqual(harness.mseControllers[0].calls.includes('abandon'), false);
    assert.deepStrictEqual(harness.mseControllers[0].durations, [459.659]);

    harness.stateMachine.output.onAudioTrackSwitchRebuildComplete(
        request.operation
    );
    const release = harness.posted.find((message) =>
        message.msg === 'audio_switch_reservations_released'
    );
    assert(release);
    assert.deepStrictEqual(Array.from(release.transaction_keys), [
        request.operation.transactionKey,
        `${request.operation.scopeId}:audio-switch:3`,
    ]);
}

function testInvalidVodStartupGroupStartsAtomicRecovery() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 20});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 20000,
        rebuild_from_seek: true,
    });
    const failedOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 20,
        requestedStartMicroseconds: 20000000,
    });
    const invalidVideo = makeVideoSegment(19.9, 20.3);
    delete invalidVideo.firstPlayableWindow;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', switchContract),
        videoMediaSegment: invalidVideo,
        audioMediaSegment: makeAudioSegment(19.9, 20.3, switchContract),
        startupTime: 19.9,
        playableStart: 19.9,
        playableEnd: 20.3,
        hasVideo: true,
        hasAudio: true,
    });

    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    const started = harness.posted.filter((message) =>
        message.msg === 'playback_operation_started' &&
        message.playback_operation.kind === 'audio-switch'
    );
    const recoveryOperation = started[started.length - 1].playback_operation;
    assert.notStrictEqual(recoveryOperation.transactionId, failedOperation.transactionId);
    assert.strictEqual(recoveryOperation.packetId, 0xf110);
}

function testVodCRAPresentationWindowIsAcceptedBeyondDTSRange() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 2.5});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 2500,
        rebuild_from_seek: true,
    });
    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 2.5,
        requestedStartMicroseconds: 2500000,
    });
    const videoMedia = makeCRAVideoSegment();
    const audioMedia = makeAudioSegment(2.8, 3.2, switchContract);
    const startupGroup = {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', switchContract),
        videoMediaSegment: videoMedia,
        audioMediaSegment: audioMedia,
        startupTime: 2.837,
        playableStart: 2.837,
        playableEnd: 2.987,
        hasVideo: true,
        hasAudio: true,
    };
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, startupGroup);

    const request = getRebuildRequest(harness);
    assert.strictEqual(request.seekTime, 2.837);
    assert.strictEqual(request.preserveVideoBuffer, true);
    assert.deepStrictEqual(Array.from(request.videoSegments), []);
    assert.deepStrictEqual(Array.from(request.audioSegments), [audioMedia]);
    assert.strictEqual(harness.transmuxer.operations.filter((operation) =>
        operation.type === 'ack_startup'
    ).length, 1);
}

function completeDedicatedVodSwitch(harness, packetId, requestedTime, playbackTime = requestedTime) {
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(packetId),
        selectedPacketId: packetId,
    });
    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId,
        requestedStart: requestedTime,
        requestedStartMicroseconds: Math.round(requestedTime * 1000000),
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', switchContract),
        videoMediaSegment: makeVideoSegment(playbackTime - 0.1, playbackTime + 0.3),
        audioMediaSegment: makeAudioSegment(playbackTime - 0.1, playbackTime + 0.3, switchContract),
        startupTime: playbackTime - 0.1,
        playableStart: playbackTime - 0.1,
        playableEnd: playbackTime + 0.3,
        hasVideo: true,
        hasAudio: true,
    });
    harness.stateMachine.output.seekMedia(requestedTime, 'AUDIO_TRACK_SWITCH_REBUILD');
    harness.stateMachine.output.onAudioTrackSwitchRebuildComplete(
        getRebuildRequest(harness).operation
    );
}

function testDedicatedVodSwitchQueuesAndCompletesRepeatedTargets() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 10.5});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 10500,
        rebuild_from_seek: true,
    });
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 11000,
        rebuild_from_seek: true,
    });
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 11250,
        rebuild_from_seek: true,
    });
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 11500,
        rebuild_from_seek: true,
    });
    assert.strictEqual(
        harness.transmuxer.operations.filter((operation) => operation.type === 'begin').length,
        1
    );

    // Queued VOD activation recaptures the controlled-seek playback time while
    // retaining the outer-reserved generation and transaction identity.
    harness.dispatch({cmd: 'timeupdate', current_time: 11.5});
    completeDedicatedVodSwitch(harness, 0xf111, 10.5, 11.5);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.transmuxer.operations.slice(-3))),
        [
            {type: 'begin'},
            {
                type: 'select', seekMilliseconds: 10500, packetId: 0xf110,
                timelineSeed: 10500, rebuildFromSeek: true,
                switchIdentity: JSON.parse(JSON.stringify(
                    playbackOperationModule.createPlaybackSwitchIdentity(
                        harness.transmuxer.playbackOperation
                    )
                )),
            },
            {type: 'complete'},
        ]
    );
    completeDedicatedVodSwitch(harness, 0xf110, 10.5, 11.5);

    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 12000,
        rebuild_from_seek: true,
    });
    completeDedicatedVodSwitch(harness, 0xf111, 12);
    assert.strictEqual(
        harness.transmuxer.operations.filter((operation) => operation.type === 'begin').length,
        3
    );
    assert.strictEqual(
        harness.posted.filter((packet) => packet.msg === 'controlled_seek' &&
            packet.reason === 'AUDIO_TRACK_SWITCH_REBUILD').length,
        3
    );
}

function testDedicatedVodPostConfirmationTimeoutRetriesThenCleansUp() {
    const timers = [];
    const activeTimers = new Set();
    let now = 0;
    const harness = makeWorkerHarness({
        isLive: false,
        currentTime: 20.821,
        setTimeoutImpl(callback, delay) {
            const timer = {
                callback() {
                    activeTimers.delete(timer);
                    now += delay;
                    callback();
                },
                delay,
                unref() {},
            };
            timers.push(timer);
            activeTimers.add(timer);
            return timer;
        },
        clearTimeoutImpl(timer) {
            activeTimers.delete(timer);
        },
        DateImpl: {now() { return now; }},
    });
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 20821,
        rebuild_from_seek: true,
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });
    assert.strictEqual(timers[timers.length - 1].delay, 45000);
    timers[timers.length - 1].callback();
    assert.strictEqual(
        harness.transmuxer.operations.filter((operation) => operation.type === 'begin').length,
        2,
        JSON.stringify(harness.transmuxer.operations)
    );
    assert.strictEqual(
        harness.posted.some((packet) => packet.msg === 'player_event' && packet.event === 'error'),
        false
    );

    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });
    timers[timers.length - 1].callback();
    assert.strictEqual(
        harness.posted.filter((packet) => packet.msg === 'player_event' && packet.event === 'error').length,
        0
    );
    assert.strictEqual(
        harness.transmuxer.operations.some((operation) => operation.type === 'select' &&
            operation.packetId === 0xf110 && operation.switchIdentity &&
            operation.switchIdentity.id === 3),
        true
    );
    timers[timers.length - 1].callback();
    assert.strictEqual(
        harness.posted.filter((packet) => packet.msg === 'player_event' && packet.event === 'error').length,
        0
    );
    timers[timers.length - 1].callback();
    assert.strictEqual(activeTimers.size, 0);
    assert.strictEqual(
        harness.posted.filter((packet) => packet.msg === 'player_event' && packet.event === 'error').length,
        0
    );
}

function testDedicatedTimeoutForcesQueuedCommittedTargetRecovery() {
    const timers = [];
    let now = 0;
    const harness = makeWorkerHarness({
        isLive: false,
        currentTime: 70,
        setTimeoutImpl(callback, delay) {
            const timer = {callback() { now += delay; callback(); }, delay, unref() {}};
            timers.push(timer);
            return timer;
        },
        clearTimeoutImpl() {},
        DateImpl: {now() { return now; }},
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf110).concat([{
            packetId: 0xf112,
            mainComponent: false,
            assetType: 'mp4a',
            codec: 'aac-latm',
            channelConfig: 2,
            selected: false,
        }]),
        selectedPacketId: 0xf110,
    });
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 70000});
    const failedOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf112, timeline_seed: 70500});
    timers[timers.length - 1].callback();
    timers[timers.length - 1].callback();
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.transmuxer.operations.slice(-3))),
        [
            {type: 'begin'},
            {
                type: 'select', seekMilliseconds: 70000, packetId: 0xf110,
                timelineSeed: 70000, rebuildFromSeek: true,
                switchIdentity: JSON.parse(JSON.stringify(
                    playbackOperationModule.createPlaybackSwitchIdentity(
                        harness.transmuxer.playbackOperation
                    )
                )),
            },
            {type: 'complete'},
        ]
    );
    const cancelsBeforeStaleFailure = harness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel' &&
        item.transactionId === failedOperation.transactionId
    ).length;
    harness.stateMachine.output.onAudioTrackSwitchRebuildFailed({
        kind: 'audio-switch',
        operation: failedOperation,
        phase: 'late',
    });
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel' &&
        item.transactionId === failedOperation.transactionId
    ).length, cancelsBeforeStaleFailure);

    completeDedicatedVodSwitch(harness, 0xf110, 70);
    const lastSelection = harness.transmuxer.operations.slice().reverse().find((operation) =>
        operation.type === 'select'
    );
    assert.strictEqual(lastSelection.packetId, 0xf112);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(lastSelection.switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(
                harness.transmuxer.playbackOperation
            )
        ))
    );
}

function testWorkerLiveTimeoutRollsBackBeforePromotingQueuedTarget() {
    const timers = [];
    const activeTimers = new Set();
    let now = 0;
    const harness = makeWorkerHarness({
        isLive: true,
        currentTime: 10,
        setTimeoutImpl(callback, delay) {
            const timer = {callback, delay, unref() {}};
            timers.push(timer);
            activeTimers.add(timer);
            return timer;
        },
        clearTimeoutImpl(timer) {
            activeTimers.delete(timer);
        },
        DateImpl: {now() { return now; }},
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf110).concat([{
            packetId: 0xf112,
            mainComponent: false,
            assetType: 'mp4a',
            codec: 'aac-latm',
            channelConfig: 2,
            selected: false,
        }]),
        selectedPacketId: 0xf110,
    });
    const startupVideoInit = makeInitSegment('video');
    const startupOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    startupVideoInit.playbackOperation = Object.assign({}, startupOperation);
    startupVideoInit.mseBufferGeneration = startupOperation.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'video', startupVideoInit);
    harness.transmuxer.deferAudioSelection = true;
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
    const failedOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf112, timeline_seed: 10600});
    assert.deepStrictEqual(harness.transmuxer.operations.filter((operation) =>
        operation.type === 'select'
    ).map((operation) => operation.packetId), [0xf111]);

    const timer = Array.from(activeTimers).pop();
    activeTimers.delete(timer);
    now += timer.delay;
    timer.callback();
    const recoveryOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    assert.strictEqual(recoveryOperation.transactionId, 3);
    assert.strictEqual(recoveryOperation.packetId, 0xf110);
    assert.deepStrictEqual(harness.transmuxer.operations.filter((operation) =>
        operation.type === 'select'
    ).map((operation) => operation.packetId), [0xf111, 0xf110]);
    assert.strictEqual(harness.transmuxer.operations.some((operation) =>
        operation.type === 'seek'
    ), false);
    assert.strictEqual(harness.posted.some((message) =>
        message.msg === 'playback_operation_started' &&
        message.playback_operation.transactionId === 4
    ), false, 'queued C must not start before recovery A commits');

    const cancelsBeforeStaleFailure = harness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel'
    ).length;
    harness.stateMachine.output.onAudioTrackSwitchRebuildFailed({
        kind: 'audio-switch',
        transactionId: failedOperation.transactionId,
        phase: 'late',
    });
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel'
    ).length, cancelsBeforeStaleFailure);

    const recoveryIdentity = playbackOperationModule.createPlaybackSwitchIdentity(
        recoveryOperation
    );
    harness.transmuxer.emitAudioSelection(0xf110, recoveryIdentity);
    const videoMedia = makeVideoSegment(10.2, 10.8);
    videoMedia.playbackOperation = Object.assign({}, recoveryOperation);
    videoMedia.mseBufferGeneration = recoveryOperation.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', videoMedia);
    const recoveryContract = Object.assign({}, recoveryIdentity, {
        packetId: 0xf110,
        requestedStart: 10.5,
        requestedStartMicroseconds: 10500000,
    });
    const audioInit = makeInitSegment('audio', recoveryContract);
    const audioMedia = makeAudioSegment(10.4, 10.8, recoveryContract);
    for (const segment of [audioInit, audioMedia]) {
        segment.playbackOperation = Object.assign({}, recoveryOperation);
        segment.mseBufferGeneration = recoveryOperation.timelineGeneration;
    }
    harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', audioInit);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', audioMedia);
    const recoveryRebuild = getRebuildRequest(harness);
    assert.strictEqual(recoveryRebuild.transactionId, 3);
    assert.strictEqual(recoveryRebuild.preserveVideoBuffer, true);
    assert.strictEqual(recoveryRebuild.videoInitSegment, null);
    assert.deepStrictEqual(Array.from(recoveryRebuild.videoSegments), []);
    harness.stateMachine.output.onAudioTrackSwitchRebuildComplete(recoveryOperation);

    const selections = harness.transmuxer.operations.filter((operation) =>
        operation.type === 'select'
    );
    assert.deepStrictEqual(selections.map((operation) => operation.packetId), [
        0xf111,
        0xf110,
        0xf112,
    ]);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selections[2].switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(
                harness.transmuxer.playbackOperation
            )
        ))
    );
    assert.strictEqual(harness.transmuxer.operations.some((operation) =>
        operation.type === 'seek'
    ), false);
}

function testWorkerLiveInvalidGapAndOverflowFailImmediatelyOnce() {
    const scenarios = [
        {
            run(harness, operation, contract) {
                const invalidInit = makeInitSegment('audio', contract);
                invalidInit.data = new ArrayBuffer(0);
                invalidInit.playbackOperation = Object.assign({}, operation);
                invalidInit.mseBufferGeneration = operation.timelineGeneration;
                harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', invalidInit);
            },
        },
        {
            run(harness, operation, contract) {
                const first = makeAudioSegment(10, 10.1, contract);
                const gap = makeAudioSegment(10.3, 10.4);
                for (const segment of [first, gap]) {
                    segment.playbackOperation = Object.assign({}, operation);
                    segment.mseBufferGeneration = operation.timelineGeneration;
                    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', segment);
                }
            },
        },
        {
            run(harness, operation, contract) {
                const first = makeAudioSegment(10, 10.1, contract);
                first.playbackOperation = Object.assign({}, operation);
                first.mseBufferGeneration = operation.timelineGeneration;
                harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', first);
                for (let index = 1; index <= 12; index++) {
                    const segment = makeAudioSegment(
                        10 + index / 10,
                        10 + (index + 1) / 10
                    );
                    segment.playbackOperation = Object.assign({}, operation);
                    segment.mseBufferGeneration = operation.timelineGeneration;
                    harness.transmuxer.emit(
                        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
                        'audio',
                        segment
                    );
                }
            },
        },
    ];

    for (const scenario of scenarios) {
        const harness = makeWorkerHarness({isLive: true, currentTime: 10});
        harness.transmuxer.deferAudioSelection = true;
        harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
        const failedOperation = Object.assign({}, harness.transmuxer.playbackOperation);
        const contract = Object.assign(
            playbackOperationModule.createPlaybackSwitchIdentity(failedOperation), {
            packetId: 0xf111,
            requestedStart: 10.5,
            requestedStartMicroseconds: 10500000,
        });
        scenario.run(harness, failedOperation, contract);
        assert.deepStrictEqual(harness.transmuxer.operations.filter((operation) =>
            operation.type === 'select'
        ).map((operation) => operation.packetId), [0xf111, 0xf110]);
        assert.deepStrictEqual(harness.stateMachine.operations.filter((item) =>
            item.type === 'audio_switch_cancel'
        ).map((item) => item.transactionId), [failedOperation.transactionId]);
        assert.strictEqual(harness.stateMachine.operations.some((item) =>
            item.type === 'media' && item.trackType === 'audio'
        ), false);

        harness.stateMachine.output.onAudioTrackSwitchRebuildFailed({
            kind: 'audio-switch',
            operation: failedOperation,
            phase: 'late',
        });
        const lateTagged = makeAudioSegment(11, 11.1, contract);
        lateTagged.playbackOperation = Object.assign({}, failedOperation);
        lateTagged.mseBufferGeneration = failedOperation.timelineGeneration;
        harness.transmuxer.emitForOperation(
            TRANSMUXING_EVENTS.MEDIA_SEGMENT,
            failedOperation,
            'audio',
            lateTagged
        );
        assert.strictEqual(harness.stateMachine.operations.filter((item) =>
            item.type === 'audio_switch_cancel'
        ).length, 1);
        assert.strictEqual(harness.stateMachine.operations.some((item) =>
            item.type === 'media' && item.trackType === 'audio'
        ), false);
    }
}

function testWorkerLiveWatchdogsRecoverMissingAckInitAndMedia() {
    for (const missing of ['ack', 'init', 'media']) {
        const activeTimers = new Set();
        let now = 0;
        const harness = makeWorkerHarness({
            isLive: true,
            currentTime: 10,
            setTimeoutImpl(callback, delay) {
                const timer = {callback, delay, unref() {}};
                activeTimers.add(timer);
                return timer;
            },
            clearTimeoutImpl(timer) {
                activeTimers.delete(timer);
            },
            DateImpl: {now() { return now; }},
        });
        harness.transmuxer.deferAudioSelection = missing === 'ack';
        harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
        const failedOperation = Object.assign({}, harness.transmuxer.playbackOperation);
        if (missing === 'media') {
            const init = makeInitSegment('audio', {
                id: failedOperation.transactionId,
                attempt: failedOperation.attempt,
                packetId: 0xf111,
                requestedStart: 10.5,
            });
            init.playbackOperation = Object.assign({}, failedOperation);
            init.mseBufferGeneration = failedOperation.timelineGeneration;
            harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', init);
        }
        const firstTimer = Array.from(activeTimers).pop();
        assert.strictEqual(firstTimer.delay, missing === 'ack' ? 10000 : 45000);
        activeTimers.delete(firstTimer);
        now += firstTimer.delay;
        firstTimer.callback();
        const recoveryOperation = Object.assign({}, harness.transmuxer.playbackOperation);
        assert.strictEqual(recoveryOperation.transactionId, 3);

        const recoveryTimer = Array.from(activeTimers).pop();
        activeTimers.delete(recoveryTimer);
        now += recoveryTimer.delay;
        recoveryTimer.callback();
        assert.deepStrictEqual(harness.stateMachine.operations.filter((item) =>
            item.type === 'audio_switch_cancel'
        ).map((item) => item.transactionId), [2, 3]);
        assert.strictEqual(harness.posted.filter((message) =>
            message.msg === 'player_event' && message.event === 'error'
        ).length, 0);

        harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 11000});
        assert.deepStrictEqual(harness.transmuxer.operations.filter((operation) =>
            operation.type === 'select'
        ).map((operation) => operation.packetId), [0xf111, 0xf110, 0xf111]);
        assert.strictEqual(harness.posted.some((message) =>
            message.msg === 'playback_operation_started' &&
            message.playback_operation.transactionId === 4
        ), true);
    }
}

function testWorkerRebasesStaleOuterRecoveryPacketToCommittedTrack() {
    const harness = makeWorkerHarness({isLive: true, currentTime: 10});
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111).concat([{
            packetId: 0xf112,
            mainComponent: false,
            assetType: 'mp4a',
            codec: 'aac-latm',
            channelConfig: 2,
            selected: false,
        }]),
        selectedPacketId: 0xf111,
    });
    harness.transmuxer.deferAudioSelection = true;
    const scopeId = harness.transmuxer.playbackOperation.scopeId;
    const requested = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 2,
        kind: 'audio-switch',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 10500,
        packetId: 0xf112,
    });
    const staleOuterRecovery = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 3,
        kind: 'audio-switch',
        transactionId: 3,
        phase: 'recovery-reserved',
        requestedTimeMilliseconds: 10500,
        packetId: 0xf110,
    });
    assert.doesNotThrow(() => harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf112,
        timeline_seed: 10500,
        playback_operation: requested,
        recovery_playback_operation: staleOuterRecovery,
    }));
    const invalidInit = makeInitSegment('audio', Object.assign(
        playbackOperationModule.createPlaybackSwitchIdentity(requested), {
        packetId: 0xf112,
        requestedStart: 10.5,
        requestedStartMicroseconds: 10500000,
    }));
    invalidInit.data = new ArrayBuffer(0);
    invalidInit.playbackOperation = Object.assign({}, requested);
    invalidInit.mseBufferGeneration = requested.timelineGeneration;
    harness.transmuxer.emit(TRANSMUXING_EVENTS.INIT_SEGMENT, 'audio', invalidInit);

    const selections = harness.transmuxer.operations.filter((operation) =>
        operation.type === 'select'
    );
    assert.deepStrictEqual(selections.map((operation) => operation.packetId), [0xf112, 0xf111]);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selections[1].switchIdentity)),
        JSON.parse(JSON.stringify(
            playbackOperationModule.createPlaybackSwitchIdentity(
                harness.transmuxer.playbackOperation
            )
        ))
    );
    const recoveryStart = harness.posted.find((message) =>
        message.msg === 'playback_operation_started' &&
        message.playback_operation.transactionId === 3
    );
    assert.strictEqual(recoveryStart.playback_operation.packetId, 0xf111);
    const committedTrackEventIndex = harness.posted.findIndex((message) =>
        message.msg === 'player_event' && message.extraData &&
        message.extraData.selectedPacketId === 0xf111
    );
    const recoveryStartIndex = harness.posted.indexOf(recoveryStart);
    assert(committedTrackEventIndex >= 0 && committedTrackEventIndex < recoveryStartIndex);
}

function testWorkerRejectsMissingRecoveryPacketAtomically() {
    const harness = makeWorkerHarness({isLive: true, currentTime: 10});
    const scopeId = harness.transmuxer.playbackOperation.scopeId;
    const requested = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 2,
        kind: 'audio-switch',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 10500,
        packetId: 0xf111,
    });
    const recoveryWithoutPacket = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 3,
        kind: 'audio-switch',
        transactionId: 3,
        phase: 'recovery-reserved',
        requestedTimeMilliseconds: 10500,
    });
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 10500,
        playback_operation: requested,
        recovery_playback_operation: recoveryWithoutPacket,
    });

    const releases = harness.posted.filter((message) =>
        message.msg === 'audio_switch_reservations_released'
    );
    assert.strictEqual(releases.length, 1);
    assert.deepStrictEqual(Array.from(releases[0].transaction_keys), [
        requested.transactionKey,
        recoveryWithoutPacket.transactionKey,
    ]);
    assert.strictEqual(harness.transmuxer.operations.some((operation) =>
        operation.type === 'select'
    ), false);
    assert.strictEqual(harness.posted.some((message) =>
        message.msg === 'playback_operation_started' &&
        message.playback_operation.kind === 'audio-switch'
    ), false);
    assert.strictEqual(harness.stateMachine.operations.some((operation) =>
        operation.type === 'audio_switch'
    ), false);
}

function testWorkerSeekCancelsOldTrackSwitchBeforeAdvancingOperation() {
    for (const kind of ['audio', 'video']) {
        const harness = makeWorkerHarness({isLive: true, currentTime: 10});
        if (kind === 'audio') {
            harness.transmuxer.deferAudioSelection = true;
            harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
        } else {
            harness.transmuxer.deferVideoSelection = true;
            harness.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
        }
        const switchOperation = Object.assign({}, harness.transmuxer.playbackOperation);
        const order = [];
        const setPlaybackOperation = harness.stateMachine.setPlaybackOperation.bind(harness.stateMachine);
        harness.stateMachine.setPlaybackOperation = (operation) => {
            order.push(`set:${operation.kind}:${operation.transactionId}`);
            return setPlaybackOperation(operation);
        };
        if (kind === 'audio') {
            const cancel = harness.stateMachine.cancelAudioTrackSwitch.bind(harness.stateMachine);
            harness.stateMachine.cancelAudioTrackSwitch = (operation) => {
                order.push(`cancel:audio:${operation.transactionId}`);
                return cancel(operation);
            };
        } else {
            const cancel = harness.stateMachine.cancelVideoTrackSwitch.bind(harness.stateMachine);
            harness.stateMachine.cancelVideoTrackSwitch = (operation) => {
                order.push(`cancel:video:${operation.transactionId}`);
                return cancel(operation);
            };
        }
        harness.dispatch({cmd: 'user_seek', target_time: 11, source: 'user'});
        assert.deepStrictEqual(order.slice(0, 2), [
            `cancel:${kind}:${switchOperation.transactionId}`,
            'set:seek:4',
        ]);
    }

    const staleHarness = makeWorkerHarness({isLive: true, currentTime: 10});
    staleHarness.transmuxer.deferAudioSelection = true;
    staleHarness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
    const cancelCount = staleHarness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel'
    ).length;
    staleHarness.dispatch({
        cmd: 'user_seek',
        target_time: 11,
        source: 'stale',
        playback_operation: playbackOperationModule.createPlaybackOperation({
            scopeId: staleHarness.transmuxer.playbackOperation.scopeId,
            timelineGeneration: 1,
            kind: 'seek',
            transactionId: 1,
            phase: 'requested',
            requestedTimeMilliseconds: 11000,
        }),
    });
    assert.strictEqual(staleHarness.stateMachine.operations.filter((item) =>
        item.type === 'audio_switch_cancel'
    ).length, cancelCount);
    assert.strictEqual(staleHarness.transmuxer.playbackOperation.kind, 'audio-switch');
}

function testDedicatedUserSeekDuringSelectingTransfersTarget() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 80});
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 80000});
    const staleOperation = Object.assign({}, harness.transmuxer.playbackOperation);
    harness.dispatch({cmd: 'user_seek', target_time: 81, source: 'user'});
    const transferredTracks = harness.posted.slice().reverse().find((message) =>
        message.msg === 'player_event' && message.extraData &&
        message.extraData.selectedPacketId === 0xf111
    );
    assert(transferredTracks, 'seek must publish the demux-selected target');
    const selectedEventCount = harness.posted.filter((message) =>
        message.msg === 'player_event' && message.extraData &&
        message.extraData.selectedPacketId === 0xf111
    ).length;
    harness.stateMachine.output.onAudioTrackSwitchRebuildComplete(staleOperation);
    assert.strictEqual(harness.posted.filter((message) =>
        message.msg === 'player_event' && message.extraData &&
        message.extraData.selectedPacketId === 0xf111
    ).length, selectedEventCount);
    const operationCount = harness.transmuxer.operations.length;
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 81000});
    assert.strictEqual(harness.transmuxer.operations.length, operationCount);
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf110, timeline_seed: 81000});
    assert(harness.transmuxer.operations.length > operationCount);
    const resumedSelection = harness.transmuxer.operations.slice().reverse().find((operation) =>
        operation.type === 'select'
    );
    assert.strictEqual(resumedSelection.packetId, 0xf110);
    assert.strictEqual(resumedSelection.timelineSeed, 81000);
}

function testDedicatedUserSeekBeforeSelectionKeepsCommittedTarget() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 82});
    harness.stateMachine.onMMTSVodAudioTrackRebuild = function(targetTime) {
        this.operations.push({type: 'vod_rebuild_deferred', targetTime});
    };
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 82000});
    assert.strictEqual(
        harness.transmuxer.operations.some((operation) => operation.type === 'select'),
        false
    );
    harness.dispatch({cmd: 'user_seek', target_time: 83, source: 'user'});
    const selectedEvents = harness.posted.filter((message) =>
        message.msg === 'player_event' &&
        message.event === TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS && message.extraData &&
        Number.isInteger(message.extraData.selectedPacketId)
    );
    assert.strictEqual(selectedEvents[selectedEvents.length - 1].extraData.selectedPacketId, 0xf110);
    const operationCount = harness.transmuxer.operations.length;
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf110, timeline_seed: 83000});
    assert.strictEqual(harness.transmuxer.operations.length, operationCount);
}

function testWorkerUserSeekTransfersOnlyAcknowledgedTrackSelections() {
    const audioBeforeAck = makeWorkerHarness({isLive: false, currentTime: 84});
    audioBeforeAck.transmuxer.deferAudioSelection = true;
    const initialAudioEvents = audioBeforeAck.posted.filter((message) =>
        message.msg === 'player_event' &&
        message.event === TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS
    ).length;
    audioBeforeAck.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 84000,
    });
    audioBeforeAck.dispatch({cmd: 'user_seek', target_time: 85, source: 'user'});
    assert.strictEqual(audioBeforeAck.posted.filter((message) =>
        message.msg === 'player_event' &&
        message.event === TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS
    ).length, initialAudioEvents);

    const videoBeforeAck = makeWorkerHarness({isLive: false, currentTime: 86});
    videoBeforeAck.transmuxer.deferVideoSelection = true;
    const initialVideoEvents = getVideoTrackEvents(videoBeforeAck).length;
    videoBeforeAck.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    videoBeforeAck.dispatch({cmd: 'user_seek', target_time: 87, source: 'user'});
    assert.strictEqual(getVideoTrackEvents(videoBeforeAck).length, initialVideoEvents);

    const videoAfterAck = makeWorkerHarness({isLive: false, currentTime: 88});
    const acknowledgedVideoEvents = getVideoTrackEvents(videoAfterAck).length;
    videoAfterAck.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    videoAfterAck.dispatch({cmd: 'user_seek', target_time: 89, source: 'user'});
    const transferredVideoEvents = getVideoTrackEvents(videoAfterAck);
    assert.strictEqual(transferredVideoEvents.length, acknowledgedVideoEvents + 1);
    assert.strictEqual(
        transferredVideoEvents[transferredVideoEvents.length - 1].extraData.selectedPacketId,
        0xf201
    );
}

function testVodRebuildCollectsMoreThanThirtyTwoSegments() {
    const requestedTime = 33.5;
    const harness = makeWorkerHarness({isLive: false, currentTime: requestedTime});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: requestedTime * 1000,
        rebuild_from_seek: true,
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });

    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: requestedTime,
        requestedStartMicroseconds: Math.round(requestedTime * 1000000),
    });
    const firstVideoMedia = makeVideoSegment(0, 1);
    const firstAudioMedia = makeAudioSegment(0, 1, switchContract);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', switchContract),
        videoMediaSegment: firstVideoMedia,
        audioMediaSegment: firstAudioMedia,
        startupTime: 0,
        playableStart: 0,
        playableEnd: 1,
        hasVideo: true,
        hasAudio: true,
    });

    for (let index = 1; index <= 32; index++) {
        harness.transmuxer.emit(
            TRANSMUXING_EVENTS.MEDIA_SEGMENT,
            'video',
            makeVideoContinuation(index, index + 1)
        );
        harness.transmuxer.emit(
            TRANSMUXING_EVENTS.MEDIA_SEGMENT,
            'audio',
            makeAudioSegment(index, index + 1)
        );
    }
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    assert.strictEqual(harness.mseControllers.length, 1);

    const finalVideoMedia = makeVideoContinuation(33, 34);
    const finalAudioMedia = makeAudioSegment(33, 34);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'video', finalVideoMedia);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'rebuild_ready'
    ), false);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_SEGMENT, 'audio', finalAudioMedia);

    const request = getRebuildRequest(harness);
    assert.strictEqual(request.seekTime, requestedTime);
    assert.strictEqual(request.preserveVideoBuffer, true);
    assert.strictEqual(request.videoSegments.length, 0);
    assert.strictEqual(request.audioSegments.length, 34);
    assert.strictEqual(request.audioSegments[0], firstAudioMedia);
    assert.strictEqual(request.audioSegments[33], finalAudioMedia);
    assert.strictEqual(harness.mseControllers.length, 1);
}

function testVodUserSeekCancelsRebuildAndAllowsPrimarySwitch() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 10.5});
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 10500,
        rebuild_from_seek: true,
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS, {
        tracks: makeAudioTracks(0xf111),
        selectedPacketId: 0xf111,
    });

    const switchContract = Object.assign({}, getLastAudioSwitchIdentity(harness), {
        packetId: 0xf111,
        requestedStart: 10.5,
        requestedStartMicroseconds: 10500000,
    });
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', switchContract),
        videoMediaSegment: makeVideoSegment(10, 11),
        audioMediaSegment: makeAudioSegment(10, 11, switchContract),
        startupTime: 10,
        playableStart: 10,
        playableEnd: 11,
        hasVideo: true,
        hasAudio: true,
    });
    assert.strictEqual(harness.mseControllers.length, 1);

    const operationCount = harness.transmuxer.operations.length;
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 11000,
        rebuild_from_seek: true,
    });
    assert.strictEqual(harness.transmuxer.operations.length, operationCount);

    harness.dispatch({cmd: 'user_seek', target_time: 220, source: 'user'});
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.transmuxer.operations.slice(-1))),
        [{type: 'cancel'}]
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.stateMachine.operations.slice(-1))),
        [{type: 'user_seek', targetTime: 220}]
    );

    const operationCountAfterSeek = harness.transmuxer.operations.length;
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf110,
        timeline_seed: 220000,
        rebuild_from_seek: true,
    });
    assert(harness.transmuxer.operations.length > operationCountAfterSeek);
    assert.strictEqual(
        harness.transmuxer.operations.slice().reverse().find((operation) =>
            operation.type === 'select'
        ).packetId,
        0xf110
    );

    harness.dispatch({cmd: 'unbuffered_seek', milliseconds: 221000});
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.transmuxer.operations.slice(-1))),
        [{type: 'cancel'}]
    );
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(harness.stateMachine.operations.slice(-1))),
        [{type: 'unbuffered_seek', targetTime: 221}]
    );
}

function testMpegTsSwitchKeepsExistingRequestPath() {
    const harness = makeWorkerHarness({isMMTS: false, isLive: false, currentTime: 5});
    harness.dispatch({cmd: 'switch_audio', audio_track: 'secondary', timeline_seed: 5500});
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'audio_switch' && item.request.stage === 'request'
    ), true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.transmuxer.operations)), [
        {type: 'secondary', timelineSeed: 5500, rebuildFromSeek: false},
    ]);
    assert.strictEqual(harness.mseControllers.length, 1);
}

function testWorkerRejectsStalePlaybackCommandsAtomically() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 5});
    const scopeId = harness.transmuxer.playbackOperation.scopeId;
    const seekB = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 3,
        kind: 'seek',
        transactionId: 3,
        phase: 'requested',
        requestedTimeMilliseconds: 30000,
    });
    const seekA = playbackOperationModule.createPlaybackOperation({
        scopeId,
        timelineGeneration: 2,
        kind: 'seek',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 20000,
    });
    harness.dispatch({
        cmd: 'user_seek',
        target_time: 30,
        playback_operation: seekB,
    });
    const stateOperationCount = harness.stateMachine.operations.length;
    const transmuxerOperationCount = harness.transmuxer.operations.length;
    const mseControllerCount = harness.mseControllers.length;
    const transmuxerCount = harness.transmuxers.length;

    harness.dispatch({
        cmd: 'user_seek',
        target_time: 20,
        playback_operation: seekA,
    });
    harness.dispatch({
        cmd: 'unbuffered_seek',
        milliseconds: 21000,
        playback_operation: seekA,
    });
    harness.dispatch({cmd: 'initialize_mse', playback_operation: seekA});
    harness.dispatch({cmd: 'load', playback_operation: seekA});

    assert.strictEqual(harness.stateMachine.operations.length, stateOperationCount);
    assert.strictEqual(harness.transmuxer.operations.length, transmuxerOperationCount);
    assert.strictEqual(harness.mseControllers.length, mseControllerCount);
    assert.strictEqual(harness.transmuxers.length, transmuxerCount);
}

function testWorkerAdaptiveSeekAttemptSynchronizesMSEAndFencesStaleOutput() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 40});
    const attempt0 = Object.assign({}, harness.transmuxer.playbackOperation);
    const operationCount = harness.stateMachine.operations.length;
    const request = makePlaybackRetryRequest(attempt0);
    harness.transmuxer.requestPlaybackOperationRetry(request, attempt0);
    const attempt1 = Object.assign({}, harness.transmuxer.playbackOperation);
    assert.strictEqual(attempt1.attempt, 1);
    assert.strictEqual(attempt1.phase, 'adaptive-retry');
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.STARTUP_GROUP,
        attempt1,
        {id: 'retry-startup'}
    );
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        attempt1,
        'video',
        {id: 'retry-media'}
    );
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        attempt0,
        'video',
        {id: 'old-attempt'}
    );
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        playbackOperationModule.withPlaybackOperationPhase(attempt1, 'loading'),
        'video',
        {id: 'phase-update'}
    );
    assert.deepStrictEqual(
        harness.stateMachine.operations.slice(operationCount).map((item) => ({
            type: item.type,
            id: item.group ? item.group.id : item.segment && item.segment.id,
        })),
        [
            {type: 'startup', id: 'retry-startup'},
            {type: 'media', id: 'retry-media'},
            {type: 'media', id: 'phase-update'},
        ]
    );
    assert.strictEqual(harness.stateMachine.playbackOperations.slice(-1)[0].attempt, 1);
    assert.strictEqual(harness.stateMachine.playbackOperations.slice(-1)[0].phase, 'adaptive-retry');
}

function testWorkerStartupGroupFailureRoutingIsExactAndRecoversAudioSwitch() {
    const startupHarness = makeWorkerHarness({isLive: false, currentTime: 5});
    const startupOperation = Object.assign({}, startupHarness.transmuxer.playbackOperation);
    startupHarness.transmuxer.emit(
        TRANSMUXING_EVENTS.STARTUP_GROUP_FAILED,
        makeStartupGroupFailure(startupOperation, 'collecting', 'loading-complete')
    );
    const startupFailures = startupHarness.stateMachine.operations.filter(
        (item) => item.type === 'startup_group_failure'
    );
    assert.strictEqual(startupFailures.length, 1);
    assert.strictEqual(startupFailures[0].failure.reason, 'loading-complete');

    const seekHarness = makeWorkerHarness({isLive: false, currentTime: 8});
    seekHarness.dispatch({cmd: 'user_seek', target_time: 8});
    const attempt0 = Object.assign({}, seekHarness.transmuxer.playbackOperation);
    seekHarness.transmuxer.requestPlaybackOperationRetry(
        makePlaybackRetryRequest(attempt0),
        attempt0
    );
    const attempt1 = Object.assign({}, seekHarness.transmuxer.playbackOperation);
    seekHarness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.STARTUP_GROUP_FAILED,
        attempt1,
        makeStartupGroupFailure(attempt1)
    );
    assert.strictEqual(seekHarness.stateMachine.playbackOperations.slice(-1)[0].attempt, 1);
    assert.strictEqual(seekHarness.stateMachine.operations.filter(
        (item) => item.type === 'startup_group_failure'
    ).length, 1);
    seekHarness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.STARTUP_GROUP_FAILED,
        attempt0,
        makeStartupGroupFailure(attempt0)
    );
    assert.strictEqual(seekHarness.stateMachine.operations.filter(
        (item) => item.type === 'startup_group_failure'
    ).length, 1);

    const audioHarness = makeWorkerHarness({isLive: true, currentTime: 10});
    audioHarness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 10500,
        rebuild_from_seek: false,
    });
    const failedOperation = Object.assign({}, audioHarness.transmuxer.playbackOperation);
    const startsBeforeFailure = audioHarness.posted.filter(
        (message) => message.msg === 'playback_operation_started'
    ).length;
    const stateFailuresBefore = audioHarness.stateMachine.operations.filter(
        (item) => item.type === 'startup_group_failure'
    ).length;
    audioHarness.transmuxer.emit(
        TRANSMUXING_EVENTS.STARTUP_GROUP_FAILED,
        makeStartupGroupFailure(failedOperation)
    );
    const started = audioHarness.posted.filter(
        (message) => message.msg === 'playback_operation_started'
    );
    assert.strictEqual(started.length, startsBeforeFailure + 1);
    const recoveryOperation = started[started.length - 1].playback_operation;
    assert.strictEqual(recoveryOperation.kind, 'audio-switch');
    assert.notStrictEqual(recoveryOperation.transactionId, failedOperation.transactionId);
    assert.strictEqual(recoveryOperation.packetId, 0xf110);
    assert.strictEqual(audioHarness.stateMachine.operations.filter(
        (item) => item.type === 'startup_group_failure'
    ).length, stateFailuresBefore);

    audioHarness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.STARTUP_GROUP_FAILED,
        failedOperation,
        makeStartupGroupFailure(failedOperation)
    );
    assert.strictEqual(audioHarness.posted.filter(
        (message) => message.msg === 'playback_operation_started'
    ).length, started.length);
}

function testWorkerTrackSwitchesAreMutuallyExclusiveAcrossTypes() {
    const audioFirst = makeWorkerHarness({isLive: true, currentTime: 10});
    audioFirst.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
    const audioOperation = Object.assign({}, audioFirst.transmuxer.playbackOperation);
    audioFirst.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    assert.strictEqual(
        audioFirst.transmuxer.operations.some((item) => item.type === 'select_video'),
        false
    );
    assert.deepStrictEqual(audioFirst.transmuxer.playbackOperation, audioOperation);
    assert(audioFirst.posted.some((message) =>
        message.msg === 'video_switch_reservations_released'
    ));

    const videoFirst = makeWorkerHarness({isLive: true, currentTime: 10});
    videoFirst.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const videoOperation = Object.assign({}, videoFirst.transmuxer.playbackOperation);
    const audioSelectionCount = videoFirst.transmuxer.operations.filter((item) =>
        item.type === 'select'
    ).length;
    videoFirst.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
    assert.strictEqual(videoFirst.transmuxer.operations.filter((item) =>
        item.type === 'select'
    ).length, audioSelectionCount);
    assert.deepStrictEqual(videoFirst.transmuxer.playbackOperation, videoOperation);
    assert(videoFirst.posted.some((message) =>
        message.msg === 'audio_switch_reservations_released'
    ));
}

function testWorkerFatalReportingDoesNotReenterStateOrDuplicate() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 10});
    const errorEvents = () => harness.posted.filter((message) =>
        message.msg === 'player_event' && message.event === 'error'
    );
    const internalError = {code: 1, msg: 'internal fatal'};
    harness.stateMachine.onFatal(internalError);
    assert.strictEqual(errorEvents().length, 1);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'external_mse_error' && item.error === internalError
    ), false);

    const externalError = {code: 2, msg: 'external MSE error'};
    harness.mseControllers[0].emit('error', externalError);
    assert.strictEqual(errorEvents().length, 2);
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'external_mse_error' && item.error === externalError
    ).length, 1);
}

function testWorkerVideoSwitchFencesOutOfOrderDataAndCommitsAfterMSE() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 12});
    const initialEventCount = getVideoTrackEvents(harness).length;
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const operation = getLastVideoSwitchOperation(harness);
    const commitRequests = () => harness.stateMachine.operations.filter((item) =>
        item.type === 'video_switch' && item.request.stage === 'commit_ready'
    );

    harness.transmuxer.emit(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        'video',
        makeVideoTrackSwitchSegment(operation, 0xf201, false)
    );
    assert.strictEqual(commitRequests().length, 0, 'media before init must be dropped');
    harness.transmuxer.emit(
        TRANSMUXING_EVENTS.INIT_SEGMENT,
        'video',
        makeVideoTrackSwitchSegment(operation, 0xf201, true, {
            id: operation.transactionId + 1,
        })
    );
    assert.strictEqual(commitRequests().length, 0, 'stale init must be dropped');

    submitWorkerVideoSwitchData(harness, operation, 0xf201);
    assert.strictEqual(commitRequests().length, 1);
    assert.strictEqual(getVideoTrackEvents(harness).length, initialEventCount);
    harness.stateMachine.output.onVideoTrackSwitchComplete(
        playbackOperationModule.createNextPlaybackAttempt(operation)
    );
    assert.strictEqual(getVideoTrackEvents(harness).length, initialEventCount);
    harness.stateMachine.output.onVideoTrackSwitchComplete(operation);
    const committedEvents = getVideoTrackEvents(harness);
    assert.strictEqual(committedEvents.length, initialEventCount + 1);
    assert.strictEqual(committedEvents[committedEvents.length - 1].extraData.selectedPacketId, 0xf201);
}

function testWorkerVideoSwitchUsesLWWAndDropsSupersededContracts() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 12});
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const switchToB = getLastVideoSwitchOperation(harness);
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf200});
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf200});

    submitWorkerVideoSwitchData(harness, switchToB, 0xf201);
    harness.stateMachine.output.onVideoTrackSwitchComplete(switchToB);
    const switchBackToA = getLastVideoSwitchOperation(harness);
    assert.strictEqual(switchBackToA.packetId, 0xf200);
    const requestCount = harness.stateMachine.operations.length;
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.INIT_SEGMENT,
        switchToB,
        'video',
        makeVideoTrackSwitchSegment(switchToB, 0xf201, true)
    );
    harness.transmuxer.emitForOperation(
        TRANSMUXING_EVENTS.MEDIA_SEGMENT,
        switchToB,
        'video',
        makeVideoTrackSwitchSegment(switchToB, 0xf201, false)
    );
    assert.strictEqual(
        harness.stateMachine.operations.length,
        requestCount,
        'superseded B data must never reach MSE'
    );
    submitWorkerVideoSwitchData(harness, switchBackToA, 0xf200);
    harness.stateMachine.output.onVideoTrackSwitchComplete(switchBackToA);
    const videoSelections = harness.transmuxer.operations.filter(
        (item) => item.type === 'select_video'
    );
    assert.deepStrictEqual(
        videoSelections.map((item) => item.packetId),
        [0xf201, 0xf200]
    );
    assert.deepStrictEqual(videoSelections.map((item) => item.seekMilliseconds), [12000, 12000]);
    const committedEvents = getVideoTrackEvents(harness);
    assert.strictEqual(committedEvents[committedEvents.length - 1].extraData.selectedPacketId, 0xf200);
}

function testWorkerVideoAlreadySelectedAckStillRequiresMSECompletion() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 12});
    const initialEventCount = getVideoTrackEvents(harness).length;
    harness.transmuxer.selectedVideoPacketId = 0xf201;
    harness.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const operation = getLastVideoSwitchOperation(harness);
    assert.strictEqual(getVideoTrackEvents(harness).length, initialEventCount);
    assert.strictEqual(harness.stateMachine.operations.some((item) =>
        item.type === 'video_switch' && item.request.stage === 'commit_ready'
    ), false);
    submitWorkerVideoSwitchData(harness, operation, 0xf201);
    assert.strictEqual(getVideoTrackEvents(harness).length, initialEventCount);
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'video_switch' && item.request.stage === 'commit_ready'
    ).length, 1);
    assert.strictEqual(harness.stateMachine.operations.filter((item) =>
        item.type === 'video_switch_cancel' && item.transactionId === operation.transactionId
    ).length, 0);
    harness.stateMachine.output.onVideoTrackSwitchComplete(operation);
    const committedEvents = getVideoTrackEvents(harness);
    assert.strictEqual(committedEvents.length, initialEventCount + 1);
    assert.strictEqual(committedEvents[committedEvents.length - 1].extraData.selectedPacketId, 0xf201);
}

function testWorkerVideoMediaInfoPublishesOnlyAfterMSECompletion() {
    const success = makeWorkerHarness({isLive: false, currentTime: 12});
    success.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const operation = getLastVideoSwitchOperation(success);
    const mediaInfo = {duration: 123000, marker: 'video-B'};
    success.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_INFO, mediaInfo);
    assert.strictEqual(success.stateMachine.operations.some((item) =>
        item.type === 'media_info' && item.mediaInfo.marker === 'video-B'
    ), false);
    assert.strictEqual(success.posted.some((message) =>
        message.msg === 'transmuxing_event' &&
        message.event === TRANSMUXING_EVENTS.MEDIA_INFO && message.info.marker === 'video-B'
    ), false);
    submitWorkerVideoSwitchData(success, operation, 0xf201);
    assert.strictEqual(success.stateMachine.operations.some((item) =>
        item.type === 'media_info' && item.mediaInfo.marker === 'video-B'
    ), false);
    success.stateMachine.output.onVideoTrackSwitchComplete(operation);
    assert.strictEqual(success.stateMachine.operations.filter((item) =>
        item.type === 'media_info' && item.mediaInfo.marker === 'video-B'
    ).length, 1);
    assert.strictEqual(success.posted.filter((message) =>
        message.msg === 'transmuxing_event' &&
        message.event === TRANSMUXING_EVENTS.MEDIA_INFO && message.info.marker === 'video-B'
    ).length, 1);
    assert.deepStrictEqual(success.mseControllers[0].durations.slice(-1), [123]);

    const failure = makeWorkerHarness({isLive: false, currentTime: 12});
    failure.dispatch({cmd: 'select_video_track', packet_id: 0xf201});
    const failedOperation = getLastVideoSwitchOperation(failure);
    const failedMediaInfo = {duration: 456000, marker: 'failed-video-B'};
    failure.transmuxer.emit(TRANSMUXING_EVENTS.MEDIA_INFO, failedMediaInfo);
    failure.stateMachine.output.onVideoTrackSwitchFailed({
        kind: 'video-switch',
        operation: failedOperation,
        phase: 'append-media',
        error: new Error('append failed'),
    });
    failure.stateMachine.output.onVideoTrackSwitchFailed({
        kind: 'video-switch',
        operation: failedOperation,
        phase: 'append-media',
        error: new Error('duplicate append failure'),
    });
    assert.strictEqual(failure.stateMachine.operations.some((item) =>
        item.type === 'media_info' && item.mediaInfo.marker === 'failed-video-B'
    ), false);
    assert.strictEqual(failure.posted.some((message) =>
        message.msg === 'transmuxing_event' &&
        message.event === TRANSMUXING_EVENTS.MEDIA_INFO &&
        message.info.marker === 'failed-video-B'
    ), false);
    assert.strictEqual(failure.mseControllers[0].durations.includes(456), false);
    assert.strictEqual(failure.stateMachine.operations.filter((item) =>
        item.type === 'video_switch_cancel' &&
        item.transactionId === failedOperation.transactionId
    ).length, 1);
}

function loadDedicatedThread() {
    const emptyClass = class {};
    const playerEvents = new Proxy({}, {
        get(_target, property) { return String(property).toLowerCase(); },
    });
    const logger = {v() {}, w() {}, e() {}, emitter: new EventEmitter()};
    const requireMap = {
        events: EventEmitter,
        '../utils/webworkify-webpack': {},
        '../utils/logger': {__esModule: true, default: logger},
        '../utils/logging-control.js': {
            __esModule: true,
            default: {registerListener() {}, removeListener() {}, getConfig() { return {}; }},
        },
        '../config': {applyMediaDataSourceConfig() {}, createDefaultConfig() { return {}; }},
        '../core/media-info': {__esModule: true, default: emptyClass},
        '../core/mse-events': {__esModule: true, default: {}},
        './player-events': {__esModule: true, default: playerEvents},
        '../core/transmuxing-events': {__esModule: true, default: TRANSMUXING_EVENTS},
        './seeking-handler': {__esModule: true, default: emptyClass},
        './loading-controller': {__esModule: true, default: emptyClass},
        './startup-buffer-gate': {__esModule: true, default: emptyClass},
        './startup-stall-jumper': {__esModule: true, default: emptyClass},
        './live-latency-chaser': {__esModule: true, default: emptyClass},
        './live-latency-synchronizer': {__esModule: true, default: emptyClass},
        '../utils/mmts-demuxer-utils': {
            findPreferredAudioTrack(tracks) {
                return tracks.find((track) => track.mainComponent) || tracks[0];
            },
            isMMTSAudioTrackSelectable(track) { return !!track && track.selectable !== false; },
        },
        './player-engine-worker-cmd-def.js': {},
        './player-engine-worker-msg-def.js': {},
        '../core/playback-operation': playbackOperationModule,
        './playback-operation-result': playbackOperationResultModule,
        './playback-operation-scheduler': playbackOperationSchedulerModule,
    };
    const exports = compileModule('src/player/player-engine-dedicated-thread.ts', requireMap, {
        self: {},
        HTMLVideoElement: class {},
    });
    return exports.default;
}

function initializeDedicatedOperationState(engine) {
    engine._playback_scope_id = `dedicated-thread-test-${Date.now()}-${Math.random()}`;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;
    engine._operation_results = new playbackOperationResultModule.default(() => {});
    engine._operation_scheduler = new playbackOperationSchedulerModule.default();
    engine._pending_mmts_seek = null;
    engine._pending_mmts_seek_timer = null;
    engine._reserved_audio_playback_operations = new Map();
    engine._reserved_video_playback_operations = new Map();
    engine._mmts_audio_tracks = makeAudioTracks(0xf110);
    engine._selected_mmts_audio_packet_id = 0xf110;
    engine._mmts_video_tracks = [];
    engine._selected_mmts_video_packet_id = 0xf200;
}

function flushDedicatedSeek(engine) {
    const pending = engine._pending_mmts_seek;
    engine._pending_mmts_seek = null;
    if (!pending) return;
    engine._scheduleInteractiveOperation({
        operation: pending.operation,
        payload: {
            type: 'seek',
            targetSeconds: pending.targetSeconds,
            source: pending.source,
            command: pending.command,
        },
    }, true);
}

function testDedicatedThreadRestoresOnlyPreviouslyPlayingMedia() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    for (const wasPaused of [false, true]) {
        const engine = Object.create(PlayerEngineDedicatedThread.prototype);
        initializeDedicatedOperationState(engine);
        const seeks = [];
        let playCount = 0;
        const mediaElement = {
            paused: wasPaused,
            ended: false,
            srcObject: {id: 'old'},
            play() {
                playCount++;
                return Promise.resolve();
            },
        };
        engine._worker_destroying = false;
        engine._config = {isMMTS: true};
        engine._active_playback_operation = playbackOperationModule.createPlaybackOperation({
            scopeId: engine._playback_scope_id,
            timelineGeneration: 1,
            kind: 'startup',
            transactionId: 1,
            phase: 'loading',
            requestedTimeMilliseconds: 0,
        });
        engine._media_element = mediaElement;
        engine._seeking_handler = {directSeek(time) { seeks.push(time); }};
        engine._resume_after_audio_track_switch_rebuild = null;

        const replacementHandle = {id: wasPaused ? 'paused' : 'playing'};
        engine._onWorkerMessage({data: {
            msg: 'mse_init',
            handle: replacementHandle,
            rebuild: true,
            playback_operation: engine._active_playback_operation,
        }});
        assert.strictEqual(mediaElement.srcObject, replacementHandle);
        engine._onWorkerMessage({data: {
            msg: 'controlled_seek',
            target_time: 10.5,
            reason: 'AUDIO_TRACK_SWITCH_REBUILD',
            playback_operation: engine._active_playback_operation,
        }});

        assert.deepStrictEqual(seeks, [10.5]);
        assert.strictEqual(playCount, wasPaused ? 0 : 1);
        assert.strictEqual(engine._resume_after_audio_track_switch_rebuild, null);
    }
}

function testDedicatedThreadUserSeekClearsPendingResume() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    const messages = [];
    engine._config = {isMMTS: true, isLive: false};
    engine._worker = {
        postMessage(message) {
            messages.push(message);
        },
    };
    engine._resume_after_audio_track_switch_rebuild = true;
    engine._playback_timeline_generation = 0;
    engine._playback_transaction_id = 0;
    engine._active_playback_operation = null;

    assert.strictEqual(engine._onControlledSeekRequest(220, 'user'), true);
    flushDedicatedSeek(engine);
    assert.strictEqual(engine._resume_after_audio_track_switch_rebuild, null);
    assert.strictEqual(messages[0].cmd, 'user_seek');
    assert.strictEqual(messages[0].target_time, 220);
    assert.strictEqual(messages[0].source, 'user');
    assert.strictEqual(messages[0].playback_operation.requestedTimeMilliseconds, 220000);

    engine._resume_after_audio_track_switch_rebuild = true;
    engine._onRequiredUnbufferedSeek(221000);
    flushDedicatedSeek(engine);
    assert.strictEqual(engine._resume_after_audio_track_switch_rebuild, null);
    assert.strictEqual(messages[1].cmd, 'unbuffered_seek');
    assert.strictEqual(messages[1].milliseconds, 221000);
    assert.strictEqual(messages[1].playback_operation.requestedTimeMilliseconds, 221000);
}

function testDedicatedThreadRejectsQueuedPublicPacketFromOldSeek() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    const seekA = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 1,
        kind: 'seek',
        transactionId: 1,
        phase: 'requested',
        requestedTimeMilliseconds: 1000,
    });
    const seekB = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 2,
        kind: 'seek',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 2000,
    });
    const emitted = [];
    engine._config = {isMMTS: true};
    engine._active_playback_operation = seekB;
    engine._worker_destroying = false;
    engine._media_info = null;
    engine._emitter = {emit(...args) { emitted.push(args); }};

    engine._onWorkerMessage({data: {
        msg: 'transmuxing_event',
        event: TRANSMUXING_EVENTS.MEDIA_INFO,
        info: {duration: 1000},
        playback_operation: seekA,
    }});
    assert.strictEqual(engine._media_info, null);
    assert.strictEqual(emitted.length, 0);

    const mediaInfoB = {duration: 2000};
    engine._onWorkerMessage({data: {
        msg: 'transmuxing_event',
        event: TRANSMUXING_EVENTS.MEDIA_INFO,
        info: mediaInfoB,
        playback_operation: seekB,
    }});
    assert.strictEqual(engine._media_info, mediaInfoB);
    assert.strictEqual(emitted.length, 1);
}

function testDedicatedThreadRejectsLateMessagesAfterDetach() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    const operation = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 1,
        kind: 'startup',
        transactionId: 1,
        phase: 'loading',
        requestedTimeMilliseconds: 0,
    });
    const workerMessages = [];
    const seeks = [];
    const mediaElement = {
        src: 'old',
        srcObject: {id: 'old'},
        addEventListener() {},
        removeEventListener() {},
        removeAttribute() {},
        load() {},
    };
    engine._config = {isMMTS: true};
    engine._worker = {postMessage(message) { workerMessages.push(message); }};
    engine._worker_destroying = false;
    engine._media_element = mediaElement;
    engine._active_playback_operation = operation;
    engine._resume_after_audio_track_switch_rebuild = true;
    engine._seeking_handler = {directSeek(time) { seeks.push(time); }};
    engine.e = {
        onMediaLoadedMetadata() {},
        onMediaTimeUpdate() {},
        onMediaReadyStateChanged() {},
    };

    engine.detachMediaElement();
    assert.strictEqual(engine._active_playback_operation, null);
    assert.strictEqual(engine._resume_after_audio_track_switch_rebuild, null);
    assert.strictEqual(engine._media_element, null);
    assert.strictEqual(workerMessages.length, 1);
    assert.strictEqual(workerMessages[0].cmd, 'shutdown_mse');

    engine._onWorkerMessage({data: {
        msg: 'mse_init',
        handle: {id: 'late'},
        rebuild: false,
        playback_operation: operation,
    }});
    engine._onWorkerMessage({data: {
        msg: 'controlled_seek',
        target_time: 10,
        reason: 'STARTUP_GROUP',
        playback_operation: operation,
    }});
    assert.strictEqual(engine._media_element, null);
    assert.strictEqual(seeks.length, 0);
}

function testDedicatedThreadRejectsMismatchedSameAttemptMessages() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    const attempt0 = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 5,
        kind: 'seek',
        transactionId: 5,
        requestedTimeMilliseconds: 5000,
    });
    const operation = playbackOperationModule.createNextPlaybackAttempt(attempt0, {
        phase: 'adaptive-retry',
    });
    const seeks = [];
    const originalHandle = {id: 'original'};
    engine._config = {isMMTS: true};
    engine._worker_destroying = false;
    engine._active_playback_operation = operation;
    engine._media_element = {
        srcObject: originalHandle,
        paused: true,
        ended: false,
    };
    engine._seeking_handler = {directSeek(time) { seeks.push(time); }};
    engine._resume_after_audio_track_switch_rebuild = null;

    const phaseUpdateHandle = {id: 'phase-update'};
    engine._onWorkerMessage({data: {
        msg: 'mse_init',
        handle: phaseUpdateHandle,
        rebuild: false,
        playback_operation: playbackOperationModule.withPlaybackOperationPhase(
            operation,
            'requested'
        ),
    }});
    engine._onWorkerMessage({data: {
        msg: 'controlled_seek',
        target_time: 6,
        reason: 'STARTUP_GROUP',
        playback_operation: Object.assign({}, operation, {
            requestedTimeMilliseconds: 6000,
            packetId: 0xf201,
        }),
    }});
    assert.strictEqual(engine._media_element.srcObject, phaseUpdateHandle);
    assert.deepStrictEqual(seeks, []);

    const currentHandle = {id: 'current'};
    engine._onWorkerMessage({data: {
        msg: 'mse_init',
        handle: currentHandle,
        rebuild: false,
        playback_operation: operation,
    }});
    engine._onWorkerMessage({data: {
        msg: 'controlled_seek',
        target_time: 5,
        reason: 'STARTUP_GROUP',
        playback_operation: operation,
    }});
    assert.strictEqual(engine._media_element.srcObject, currentHandle);
    assert.deepStrictEqual(seeks, [5]);
}

function testDedicatedReservationReleaseIsWireCompatibleAndStartUsesFullKey() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    engine._config = {isMMTS: true, isLive: false};
    engine._worker_destroying = false;
    engine._active_playback_operation = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 1,
        kind: 'startup',
        transactionId: 1,
        phase: 'loading',
        requestedTimeMilliseconds: 0,
    });
    const requested = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 2,
        kind: 'audio-switch',
        transactionId: 2,
        phase: 'requested',
        requestedTimeMilliseconds: 10000,
        packetId: 0xf111,
    });
    const recovery = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 3,
        kind: 'audio-switch',
        transactionId: 3,
        phase: 'recovery-reserved',
        requestedTimeMilliseconds: 10000,
        packetId: 0xf110,
    });
    engine._operation_scheduler.request({
        operation: requested,
        payload: {type: 'audio-switch', recoveryOperation: recovery},
    });
    engine._onWorkerMessage({data: {
        msg: 'audio_switch_reservations_released',
        transaction_keys: [requested.transactionKey, recovery.transactionKey],
    }});
    assert.strictEqual(engine._active_playback_operation.kind, 'startup');
    engine._onWorkerMessage({data: {
        msg: 'playback_operation_started',
        playback_operation: requested,
    }});
    assert.strictEqual(engine._active_playback_operation.kind, 'audio-switch');
    assert.strictEqual(engine._active_playback_operation.transactionKey, requested.transactionKey);
}

function testDedicatedAdoptsReservedRebasedRecovery() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    engine._config = {isMMTS: true, isLive: false};
    engine._worker_destroying = false;
    engine._emitter = new EventEmitter();
    engine._active_playback_operation = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 1,
        kind: 'audio-switch',
        transactionId: 1,
        phase: 'requested',
        requestedTimeMilliseconds: 10000,
        packetId: 0xf111,
    });
    const reserved = playbackOperationModule.createPlaybackOperation({
        scopeId: engine._playback_scope_id,
        timelineGeneration: 3,
        kind: 'audio-switch',
        transactionId: 3,
        phase: 'recovery-reserved',
        requestedTimeMilliseconds: 10000,
        packetId: 0xf110,
    });
    engine._operation_scheduler.request({
        operation: engine._active_playback_operation,
        payload: {type: 'audio-switch', recoveryOperation: reserved},
    });
    engine._onWorkerMessage({data: {
        msg: 'player_event',
        event: TRANSMUXING_EVENTS.MMTS_AUDIO_TRACKS,
        playback_operation: engine._active_playback_operation,
        extraData: {
            tracks: makeAudioTracks(0xf111),
            selectedPacketId: 0xf111,
        },
    }});
    assert.strictEqual(engine._selected_mmts_audio_packet_id, 0xf111);
    const activated = playbackOperationModule.rebindReservedPlaybackOperation(reserved, {
        phase: 'recovery',
        requestedTimeMilliseconds: 12500,
        packetId: 0xf111,
    });
    engine._onWorkerMessage({data: {
        msg: 'playback_operation_started',
        playback_operation: activated,
    }});
    assert.strictEqual(engine._active_playback_operation.transactionId, 3);
    assert.strictEqual(engine._active_playback_operation.requestedTimeMilliseconds, 12500);
    assert.strictEqual(engine._reserved_audio_playback_operations.size, 0);
}

function testDedicatedInvalidAudioTargetDoesNotReserve() {
    const PlayerEngineDedicatedThread = loadDedicatedThread();
    const engine = Object.create(PlayerEngineDedicatedThread.prototype);
    initializeDedicatedOperationState(engine);
    const messages = [];
    engine._config = {isMMTS: true, isLive: false};
    engine._media_element = {currentTime: 10};
    engine._worker = {postMessage(message) { messages.push(message); }};
    engine.selectAudioTrack(0xf199);
    engine._mmts_audio_tracks.push({packetId: 0xf112, selectable: false});
    engine.selectAudioTrack(0xf112);
    assert.strictEqual(messages.length, 0);
    assert.strictEqual(engine._reserved_audio_playback_operations.size, 0);
}

function testWorkerMSESubmissionFailureUsesReservedRollback() {
    const harness = makeWorkerHarness({isLive: false, currentTime: 100});
    harness.stateMachine.onAudioTrackSwitch = function(request) {
        this.operations.push({type: 'audio_switch', request});
        return false;
    };
    harness.dispatch({
        cmd: 'select_audio_track',
        packet_id: 0xf111,
        timeline_seed: 100000,
        rebuild_from_seek: true,
    });
    const firstIdentity = getLastAudioSwitchIdentity(harness);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', Object.assign({}, firstIdentity, {
            packetId: 0xf111,
            requestedStart: 100,
            requestedStartMicroseconds: 100000000,
        })),
        videoMediaSegment: makeVideoSegment(99.9, 100.3),
        audioMediaSegment: makeAudioSegment(99.9, 100.3, Object.assign({}, firstIdentity, {
            packetId: 0xf111,
            requestedStart: 100,
            requestedStartMicroseconds: 100000000,
        })),
        startupTime: 99.9,
        playableStart: 99.9,
        playableEnd: 100.3,
        hasVideo: true,
        hasAudio: true,
    });
    const releaseIndex = harness.posted.findIndex((message) =>
        message.msg === 'audio_switch_reservations_released' &&
        message.transaction_keys.includes(firstIdentity.transactionKey) &&
        message.transaction_keys.length === 1
    );
    const recoveryStartIndex = harness.posted.findIndex((message) =>
        message.msg === 'playback_operation_started' &&
        message.playback_operation.transactionId === 3
    );
    assert(releaseIndex >= 0 && recoveryStartIndex > releaseIndex);
    const recoveryIdentity = getLastAudioSwitchIdentity(harness);
    assert.strictEqual(recoveryIdentity.id, 3);
    harness.transmuxer.emit(TRANSMUXING_EVENTS.STARTUP_GROUP, {
        videoInitSegment: makeInitSegment('video'),
        audioInitSegment: makeInitSegment('audio', Object.assign({}, recoveryIdentity, {
            packetId: 0xf110,
            requestedStart: 100,
            requestedStartMicroseconds: 100000000,
        })),
        videoMediaSegment: makeVideoSegment(99.9, 100.3),
        audioMediaSegment: makeAudioSegment(99.9, 100.3, Object.assign({}, recoveryIdentity, {
            packetId: 0xf110,
            requestedStart: 100,
            requestedStartMicroseconds: 100000000,
        })),
        startupTime: 99.9,
        playableStart: 99.9,
        playableEnd: 100.3,
        hasVideo: true,
        hasAudio: true,
    });
    assert.strictEqual(
        harness.posted.filter((message) => message.msg === 'player_event' &&
            message.event === 'error').length,
        0
    );
}

function testWorkerRapidQueueReplacementReleasesDiscardedReservations() {
    const harness = makeWorkerHarness({isLive: true, currentTime: 10});
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10500});
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf110, timeline_seed: 10600});
    harness.dispatch({cmd: 'select_audio_track', packet_id: 0xf111, timeline_seed: 10700});
    const released = harness.posted.filter((message) =>
        message.msg === 'audio_switch_reservations_released'
    ).flatMap((message) => message.transaction_keys);
    const releasedIds = released.map((key) => Number(key.split(':').pop()));
    assert.deepStrictEqual(
        releasedIds.filter((id) => [4, 5, 6, 7].includes(id)).sort(),
        [4, 5, 6, 7]
    );
    assert.strictEqual(harness.posted.some((message) =>
        message.msg === 'playback_operation_started' &&
        [4, 5, 6, 7].includes(message.playback_operation.transactionId)
    ), false);
}

testLiveSwitchBuildsSynchronizedPlanWithoutSeek();
testLiveSwitchBuildsSynchronizedPlanWithoutSeek({chrome: true}, false);
testLiveSwitchBuildsSynchronizedPlanWithoutSeek({firefox: true}, true);
testLiveCRAPresentationWindowSubmitsWithoutDTSCoverage();
testWorkerVodSwitchPreservesFractionalMillisecondContract();
testVodSwitchSeeksThenBuildsFreshStartupPlanAndRestoresDuration();
testVodSwitchSeeksThenBuildsFreshStartupPlanAndRestoresDuration({firefox: true}, true);
testChromiumVodSwitchUsesDedicatedAudioOnlyPlan();
testInvalidVodStartupGroupStartsAtomicRecovery();
testVodCRAPresentationWindowIsAcceptedBeyondDTSRange();
testDedicatedVodSwitchQueuesAndCompletesRepeatedTargets();
testDedicatedVodPostConfirmationTimeoutRetriesThenCleansUp();
testDedicatedTimeoutForcesQueuedCommittedTargetRecovery();
testWorkerLiveTimeoutRollsBackBeforePromotingQueuedTarget();
testWorkerLiveInvalidGapAndOverflowFailImmediatelyOnce();
testWorkerLiveWatchdogsRecoverMissingAckInitAndMedia();
testWorkerRebasesStaleOuterRecoveryPacketToCommittedTrack();
testWorkerRejectsMissingRecoveryPacketAtomically();
testWorkerSeekCancelsOldTrackSwitchBeforeAdvancingOperation();
testDedicatedUserSeekDuringSelectingTransfersTarget();
testDedicatedUserSeekBeforeSelectionKeepsCommittedTarget();
testWorkerUserSeekTransfersOnlyAcknowledgedTrackSelections();
testVodRebuildCollectsMoreThanThirtyTwoSegments();
testVodUserSeekCancelsRebuildAndAllowsPrimarySwitch();
testMpegTsSwitchKeepsExistingRequestPath();
testWorkerRejectsStalePlaybackCommandsAtomically();
testWorkerAdaptiveSeekAttemptSynchronizesMSEAndFencesStaleOutput();
testWorkerStartupGroupFailureRoutingIsExactAndRecoversAudioSwitch();
testWorkerTrackSwitchesAreMutuallyExclusiveAcrossTypes();
testWorkerFatalReportingDoesNotReenterStateOrDuplicate();
testWorkerVideoSwitchFencesOutOfOrderDataAndCommitsAfterMSE();
testWorkerVideoSwitchUsesLWWAndDropsSupersededContracts();
testWorkerVideoAlreadySelectedAckStillRequiresMSECompletion();
testWorkerVideoMediaInfoPublishesOnlyAfterMSECompletion();
testDedicatedThreadRestoresOnlyPreviouslyPlayingMedia();
testDedicatedThreadUserSeekClearsPendingResume();
testDedicatedThreadRejectsQueuedPublicPacketFromOldSeek();
testDedicatedThreadRejectsLateMessagesAfterDetach();
testDedicatedThreadRejectsMismatchedSameAttemptMessages();
testDedicatedReservationReleaseIsWireCompatibleAndStartUsesFullKey();
testDedicatedAdoptsReservedRebasedRecovery();
testDedicatedInvalidAudioTargetDoesNotReserve();
testWorkerMSESubmissionFailureUsesReservedRollback();
testWorkerRapidQueueReplacementReleasesDiscardedReservations();

console.log('dedicated MMTS audio track rebuild tests passed');

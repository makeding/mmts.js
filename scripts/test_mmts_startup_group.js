#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function createFakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const callbacks = new Map();
    const self = {
        performance: {now: () => now},
        setTimeout(callback, delay) {
            const id = nextId++;
            const timer = {callback, deadline: now + Math.max(0, delay)};
            timers.set(id, timer);
            callbacks.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        setInterval() {
            return nextId++;
        },
        clearInterval() {},
    };
    return {
        self,
        advance(milliseconds) {
            const target = now + milliseconds;
            for (;;) {
                let selectedId = null;
                let selected = null;
                for (const [id, timer] of timers) {
                    if (timer.deadline <= target &&
                        (!selected || timer.deadline < selected.deadline)) {
                        selectedId = id;
                        selected = timer;
                    }
                }
                if (!selected) {
                    break;
                }
                now = selected.deadline;
                timers.delete(selectedId);
                selected.callback();
            }
            now = target;
        },
        callback(id) {
            return callbacks.get(id);
        },
        pendingTimeouts() {
            return timers.size;
        },
    };
}

function loadController() {
    const sourcePath = path.resolve(__dirname, '../src/core/transmuxing-controller.js');
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
    const MMTSDemuxer = class {};
    class FakeIOController {
        constructor(_dataSource, _config, extraData) {
            this.extraData = extraData;
            FakeIOController.instances.push(this);
        }
        open() {}
        destroy() { this.destroyed = true; }
    }
    FakeIOController.instances = [];
    const lifecycle = loadStartupGroupLifecycle();
    const clock = createFakeClock();
    const requireMap = {
        '../utils/logger.js': {__esModule: true, default: {e() {}, v() {}, w() {}}},
        '../utils/browser.js': {__esModule: true, default: {safari: false}},
        './media-info.js': {__esModule: true, default: emptyClass},
        '../demux/flv-demuxer.js': {__esModule: true, default: emptyClass},
        '../demux/ts-demuxer': {__esModule: true, default: emptyClass},
        '../demux/mmts-demuxer': {__esModule: true, default: MMTSDemuxer},
        '../remux/mp4-remuxer.js': {__esModule: true, default: emptyClass},
        '../demux/demux-errors.js': {__esModule: true, default: {}},
        '../io/io-controller.js': {__esModule: true, default: FakeIOController},
        './transmuxing-events': {
            __esModule: true,
            default: {
                STARTUP_GROUP: 'startup_group',
                STARTUP_GROUP_FAILED: 'startup_group_failed',
                INIT_SEGMENT: 'init_segment',
                MEDIA_SEGMENT: 'media_segment',
                LOADING_COMPLETE: 'loading_complete',
                IO_ERROR: 'io_error',
                DEMUX_ERROR: 'demux_error',
                MEDIA_INFO: 'media_info',
                MMTS_VIDEO_TRACK_SELECTION_RESULT: 'mmts_video_track_selection_result',
                MMTS_SUBTITLE_DATA_ARRIVED: 'mmts_subtitle_data_arrived',
                PLAYBACK_OPERATION_RETRY_REQUIRED: 'playback_operation_retry_required',
                RECOMMEND_SEEKPOINT: 'recommend_seekpoint',
            }
        },
        '../io/loader.js': {LoaderStatus: {}, LoaderErrors: {}},
        './playback-operation': Object.assign({__esModule: true}, operationContract),
        './mmts-startup-group-lifecycle': lifecycle,
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        self: clock.self,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return {
        TransmuxingController: moduleObject.exports.default,
        MMTSDemuxer,
        FakeIOController,
        clock,
    };
}

function loadPlaybackOperation() {
    const sourcePath = path.resolve(__dirname, '../src/core/playback-operation.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        module: moduleObject,
        exports: moduleObject.exports,
        Number,
        isFinite,
        Object,
        TypeError,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

const operationContract = loadPlaybackOperation();
const playbackScopeId = 'mmts-startup-group-test';

function makePlaybackOperation(
    kind,
    transactionId,
    requestedTimeMilliseconds = 0,
    packetId,
    phase = 'requested',
    timelineGeneration = transactionId,
    attempt = 0
) {
    let operation = operationContract.createPlaybackOperation({
        scopeId: playbackScopeId,
        timelineGeneration,
        kind,
        transactionId,
        requestedTimeMilliseconds,
        packetId,
        phase: attempt === 0 ? phase : 'requested',
    });
    for (let index = 0; index < attempt; index++) {
        operation = operationContract.createNextPlaybackAttempt(operation, {
            requestedTimeMilliseconds,
            phase: index === attempt - 1 ? phase : 'retrying',
        });
    }
    return operation;
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

function loadStartupGroupLifecycle() {
    const sourcePath = path.resolve(__dirname, '../src/core/mmts-startup-group-lifecycle.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require: (id) => id === './playback-operation' ? loadPlaybackOperation() : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        Number,
        isFinite,
        Object,
        TypeError,
    }, {filename: sourcePath});
    return moduleObject.exports;
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
    const events = {
        PLAYBACK_OPERATION_RETRY_REJECTED: 'playback_operation_retry_rejected',
        PLAYBACK_OPERATION_RETRY_REQUIRED: 'playback_operation_retry_required',
        STARTUP_GROUP_FAILED: 'startup_group_failed',
    };
    const requireMap = {
        '../utils/webworkify-webpack': {__esModule: true, default: () => null},
        '../utils/logger.js': {__esModule: true, default: {e() {}}},
        '../utils/logging-control.js': {__esModule: true, default: {}},
        './transmuxing-controller.js': {__esModule: true, default: emptyClass},
        './transmuxing-events': {__esModule: true, default: events},
        './transmuxing-worker.js': {__esModule: true, default: () => {}},
        './media-info.js': {__esModule: true, default: emptyClass},
        '../demux/ts-demuxer.ts': {__esModule: true, default: emptyClass},
        '../demux/mmts-demuxer.ts': {__esModule: true, default: emptyClass},
        './playback-operation': loadPlaybackOperation(),
        './mmts-startup-group-lifecycle': loadStartupGroupLifecycle(),
    };
    vm.runInNewContext(compiled, {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ?
            requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        Promise,
        Object,
        isFinite,
    }, {filename: sourcePath});
    return {Transmuxer: moduleObject.exports.default, events};
}

function testPlaybackOperationValidationAndMonotonicAdvance() {
    const seekA = makePlaybackOperation('seek', 1, 1000);
    assert.strictEqual(operationContract.isPlaybackOperation(seekA), true);
    assert.strictEqual(operationContract.isPlaybackOperation(Object.assign({}, seekA, {
        requestedTime: 1,
    })), false);
    const seekRetry = operationContract.createNextPlaybackAttempt(seekA, {
        phase: 'adaptive-retry',
    });
    assert.strictEqual(operationContract.canAdvancePlaybackOperation(seekA, seekRetry), true);
    assert.strictEqual(operationContract.canAdvancePlaybackOperation(seekA, Object.assign({}, seekA, {
        transactionId: 2,
    })), false);
    const seekB = makePlaybackOperation('seek', 2, 2000);
    assert.strictEqual(operationContract.canAdvancePlaybackOperation(seekB, seekA), false);
    assert.strictEqual(operationContract.canAdvancePlaybackOperation(seekA, Object.assign({}, seekA, {
        timelineGeneration: 2,
    })), false);
    const seekBRetry = operationContract.createNextPlaybackAttempt(seekB);
    assert.strictEqual(
        operationContract.canAdvancePlaybackOperation(seekA, seekBRetry),
        false
    );
    assert.strictEqual(operationContract.canAdvancePlaybackOperation(null, seekRetry), false);
    assert.strictEqual(
        operationContract.isSamePlaybackOperation(
            seekA,
            operationContract.withPlaybackOperationPhase(seekA, 'collecting')
        ),
        true
    );
}

function makeHarness() {
    const {TransmuxingController, MMTSDemuxer} = loadController();
    const events = [];
    const controller = Object.create(TransmuxingController.prototype);
    controller._config = {isMMTS: true};
    controller._emitter = {
        emit(event, ...values) {
            events.push([event, ...values]);
        }
    };
    const operation = makePlaybackOperation('startup', 1, 0, undefined, 'collecting');
    controller._playbackOperation = Object.assign({}, operation);
    controller._producerPlaybackOperation = Object.assign({}, operation);
    controller._mmtsStartupGroup = controller._createMMTSStartupGroupState(operation);
    controller._pendingMMTSVodSeek = null;
    controller._pendingMMTSVodSeekRetry = null;
    controller._pendingMMTSVodSeekAudioSegments = [];
    controller._pendingMMTSVodSeekAudioOperation = null;
    controller._pendingResolveSeekPoint = null;
    controller._pendingPlaybackOperationRetry = null;
    controller._playbackOperationRetrySequence = 0;
    return {controller, events, MMTSDemuxer};
}

function makeSeekableSegmentInfo(times, filepositions, duration) {
    return {
        duration,
        keyframesIndex: {times, filepositions},
        isSeekable() {
            return true;
        },
        getNearestKeyframe(milliseconds) {
            let index = 0;
            for (let i = 1; i < times.length && times[i] <= milliseconds; i++) {
                index = i;
            }
            return {
                index,
                milliseconds: times[index],
                fileposition: filepositions[index],
            };
        },
    };
}

function makeVideoSegment(playableStart = 1.04, playableEnd = 2) {
    return {
        type: 'video',
        mmtsRandomAccessSafe: true,
        firstPlayableWindow: {
            decodeStart: playableStart - 0.04,
            compositionStart: playableStart - 0.02,
            syncPoint: playableStart,
            playableStart,
            playableEnd,
        },
        info: {
            beginDts: (playableStart - 0.04) * 1000,
            endDts: playableEnd * 1000,
            endPts: playableEnd * 1000,
            firstSample: {isSyncPoint: true},
        },
    };
}

function testIOProducerOperationIsImmutableAndLateCallbacksAreInert() {
    const {TransmuxingController, FakeIOController} = loadController();
    const controller = new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const outputs = [];
    let parseCount = 0;
    controller._demuxer = {
        bindDataSource(loader) {
            loader.onDataArrival = this.parseChunks.bind(this);
            return this;
        },
        parseChunks() {
            parseCount++;
            controller._emitter.emit('producer_output', parseCount);
            return 1;
        },
    };
    controller.on('producer_output', (value, operation) => {
        outputs.push({value, operation});
    });
    const seekA = makePlaybackOperation('seek', 1, 1000);
    const seekB = makePlaybackOperation('seek', 2, 2000);

    controller.setPlaybackOperation(seekA);
    controller._loadSegment(0, 0);
    const ioA = FakeIOController.instances[0];
    assert.strictEqual(ioA.onDataArrival(new ArrayBuffer(1), 0), 1);
    assert.strictEqual(outputs[0].operation.timelineGeneration, 1);
    const staleDataArrival = ioA.onDataArrival;
    const staleError = ioA.onError;
    const staleComplete = ioA.onComplete;

    controller.setPlaybackOperation(seekB);
    const activeProducer = controller._activeIOProducer;
    assert.strictEqual(activeProducer.ioctl, ioA);
    assert.strictEqual(activeProducer.operation.timelineGeneration, 2);
    assert.strictEqual(staleDataArrival(new ArrayBuffer(1), 1), 0);
    staleError('late', {code: -1, msg: 'late A'});
    staleComplete(0);
    assert.strictEqual(parseCount, 1);
    assert.strictEqual(controller._activeIOProducer, activeProducer);
    assert.strictEqual(outputs.length, 1);

    assert.strictEqual(ioA.onDataArrival(new ArrayBuffer(1), 2), 1);
    assert.strictEqual(outputs.length, 2);
    assert.strictEqual(outputs[1].operation.timelineGeneration, 2);
    assert.strictEqual(outputs[1].operation.transactionId, 2);
}

function testAudioStartupGroupMovesToLaterRapWindow() {
    const h = makeHarness();
    const videoInit = {type: 'video'};
    const audioInit = {type: 'audio'};
    h.controller._collectMMTSStartupInitSegment('video', videoInit);
    h.controller._collectMMTSStartupMediaSegment('video', makeVideoSegment());
    h.controller._collectMMTSStartupMediaSegment('video', {
        type: 'video',
        info: {beginDts: 1080, endDts: 1180},
    });
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    h.controller._collectMMTSStartupInitSegment('audio', audioInit);
    h.controller._collectMMTSStartupMediaSegment('audio', {info: {beginDts: 1100, endDts: 2000}});
    assert.strictEqual(h.events.length, 0);

    const laterVideoMedia = makeVideoSegment(1.2, 2.2);
    h.controller._collectMMTSStartupMediaSegment('video', laterVideoMedia);
    assert.strictEqual(h.events.length, 1);
    const group = h.events[0][1];
    assert.strictEqual(h.events[0][0], 'startup_group');
    assert.strictEqual(group.videoInitSegment, videoInit);
    assert.strictEqual(group.audioInitSegment, audioInit);
    assert.strictEqual(group.videoMediaSegment, laterVideoMedia);
    assert.strictEqual(group.startupTime, 1.2);
    assert.strictEqual(group.audioStart, 1.1);
    assert.strictEqual(group.audioEnd, 2);
    assert.strictEqual(group.playableEnd, 2);
    assert.strictEqual(group.hasAudio, true);
    assert.strictEqual(group.hasVideo, true);
}

function testVideoOnlyStartupGroupDeclaresAudioUnavailable() {
    const h = makeHarness();
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    h.controller._collectMMTSStartupMediaSegment('video', makeVideoSegment());
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: false});
    assert.strictEqual(h.events.length, 1);
    const group = h.events[0][1];
    assert.strictEqual(group.hasAudio, false);
    assert.strictEqual(group.audioInitSegment, null);
    assert.strictEqual(group.audioMediaSegment, null);
    assert.strictEqual(group.audioStart, undefined);
    assert.strictEqual(group.audioEnd, undefined);
}

function testStartupGroupReplaysCollectedVideoContinuations() {
    const h = makeHarness();
    const video = makeVideoSegment(1.2, 1.4);
    const continuation = {
        type: 'video',
        info: {beginDts: 1400, endDts: 1600},
    };
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    h.controller._collectMMTSStartupInitSegment('audio', {type: 'audio'});
    h.controller._collectMMTSStartupMediaSegment('video', video);
    h.controller._collectMMTSStartupMediaSegment('video', continuation);
    assert.strictEqual(h.events.length, 0);

    h.controller._collectMMTSStartupMediaSegment('audio', {
        type: 'audio',
        info: {beginDts: 1100, endDts: 1500},
    });

    assert.strictEqual(h.events.length, 2);
    assert.strictEqual(h.events[0][0], 'startup_group');
    assert.strictEqual(h.events[0][1].videoMediaSegment, video);
    assert.strictEqual(h.events[1][0], 'media_segment');
    assert.strictEqual(h.events[1][1], 'video');
    assert.strictEqual(h.events[1][2], continuation);
    assert.strictEqual(
        continuation.playbackOperation.timelineGeneration,
        h.events[0][1].playbackOperation.timelineGeneration
    );
}

function testStartupGroupReplaysCollectedAudioContinuations() {
    const h = makeHarness();
    const audio = {
        type: 'audio',
        info: {beginDts: 1100, endDts: 1500},
    };
    const continuation = {
        type: 'audio',
        info: {beginDts: 1500, endDts: 1800},
    };
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    h.controller._collectMMTSStartupInitSegment('audio', {type: 'audio'});
    h.controller._collectMMTSStartupMediaSegment('audio', audio);
    h.controller._collectMMTSStartupMediaSegment('audio', continuation);
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    assert.strictEqual(h.events.length, 0);

    const video = makeVideoSegment(1.2, 1.4);
    h.controller._collectMMTSStartupMediaSegment('video', video);

    assert.strictEqual(h.events.length, 2);
    assert.strictEqual(h.events[0][0], 'startup_group');
    assert.strictEqual(h.events[0][1].audioMediaSegment, audio);
    assert.strictEqual(h.events[1][0], 'media_segment');
    assert.strictEqual(h.events[1][1], 'audio');
    assert.strictEqual(h.events[1][2], continuation);
}

async function testVodSeekRetriesWhenEstimatedRangeStartsAfterTarget() {
    const h = makeHarness();
    const pending = {
        milliseconds: 237682,
        segmentIndex: 0,
        lookback: 32 * 1024 * 1024,
        fileposition: 2220983628,
    };
    h.controller._playbackOperation = makePlaybackOperation(
        'seek', 1, pending.milliseconds
    );
    pending.operation = Object.assign({}, h.controller._playbackOperation);
    h.controller._pendingMMTSVodSeek = pending;
    h.controller._activeIOProducer = {
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    let retries = 0;
    h.controller._retryPendingMMTSVodSeekIfNeeded = (segmentIndex) => {
        assert.strictEqual(segmentIndex, 0);
        retries++;
        return true;
    };

    assert.strictEqual(
        h.controller._schedulePendingMMTSVodSeekRetryIfNeeded(0, 243444),
        true
    );
    assert.strictEqual(h.controller._pendingMMTSVodSeekRetry, pending);
    await Promise.resolve();
    assert.strictEqual(retries, 1);
    assert.strictEqual(h.controller._pendingMMTSVodSeekRetry, null);
}

async function testVodSeekRetriesWhenIndexedRangeStartsAfterTarget() {
    const h = makeHarness();
    const targetMilliseconds = 49188.836;
    const operation = makePlaybackOperation('seek', 2, targetMilliseconds);
    h.controller._playbackOperation = Object.assign({}, operation);
    h.controller._producerPlaybackOperation = Object.assign({}, operation);
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {
        isMMTS: true,
        mmtsVodSeekLookbackBytes: 32 * 1024 * 1024,
        mmtsVodSeekMaxLookbackBytes: 256 * 1024 * 1024,
    };
    const segmentInfo = makeSeekableSegmentInfo(
        [48000, 125000],
        [430000000, 1100000000],
        459926
    );
    const segment = {filesize: 4360105984};
    const indexedPoint = {
        index: 0,
        milliseconds: 48000,
        fileposition: 430000000,
    };

    h.controller._setPendingSeekPoint(
        indexedPoint,
        0,
        segmentInfo,
        segment,
        targetMilliseconds
    );
    assert(h.controller._pendingMMTSVodSeek);
    assert.strictEqual(
        h.controller._pendingMMTSVodSeek.milliseconds,
        targetMilliseconds
    );
    h.controller._activeIOProducer = {
        operation: Object.assign({}, operation),
    };
    let retries = 0;
    h.controller._retryPendingMMTSVodSeekIfNeeded = (segmentIndex) => {
        assert.strictEqual(segmentIndex, 0);
        retries++;
        return true;
    };
    const video = makeVideoSegment(125.625, 126.2);
    video.info.syncPoints = [{
        originalDts: 125625,
        dts: 125625,
        pts: 125625,
    }];

    h.controller._onRemuxerMediaSegmentArrival('video', video);
    assert.strictEqual(
        h.events.some((event) => event[0] === 'media_segment'),
        false
    );
    await Promise.resolve();
    assert.strictEqual(retries, 1);
}

function testVodIndexedSeekRetryMovesBeforeRejectedIndex() {
    const h = makeHarness();
    const targetMilliseconds = 49188.836;
    const operation = makePlaybackOperation('seek', 2, targetMilliseconds);
    h.controller._playbackOperation = Object.assign({}, operation);
    h.controller._producerPlaybackOperation = Object.assign({}, operation);
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {
        isMMTS: true,
        mmtsVodSeekLookbackBytes: 32 * 1024 * 1024,
        mmtsVodSeekMaxLookbackBytes: 256 * 1024 * 1024,
    };
    const segmentInfo = makeSeekableSegmentInfo(
        [48000, 125000],
        [430000000, 1100000000],
        459926
    );
    const segment = {filesize: 4360105984};
    h.controller._setPendingSeekPoint({
        index: 0,
        milliseconds: 48000,
        fileposition: 430000000,
    }, 0, segmentInfo, segment, targetMilliseconds);
    h.controller._internalAbort = () => {};

    assert.strictEqual(h.controller._retryPendingMMTSVodSeekIfNeeded(0), true);
    const retryEvent = h.events.find((entry) =>
        entry[0] === 'playback_operation_retry_required'
    );
    assert(retryEvent);
    assert.strictEqual(
        retryEvent[1].filePosition,
        430000000 - 32 * 1024 * 1024
    );
    assert.strictEqual(retryEvent[1].estimatedPosition, 430000000);
    assert.strictEqual(retryEvent[1].lookbackBytes, 32 * 1024 * 1024);
    assert.strictEqual(
        h.controller._pendingPlaybackOperationRetry.keyframe.ignoreKeyframeIndex,
        true
    );
}

async function testVodSeekAtMaxLookbackFallsBackToSegmentStart() {
    const h = makeHarness();
    const targetMilliseconds = 49188.836;
    const operation = makePlaybackOperation('seek', 3, targetMilliseconds);
    h.controller._playbackOperation = Object.assign({}, operation);
    h.controller._producerPlaybackOperation = Object.assign({}, operation);
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {
        isMMTS: true,
        mmtsVodSeekLookbackBytes: 32 * 1024 * 1024,
        mmtsVodSeekMaxLookbackBytes: 32 * 1024 * 1024,
    };
    const estimatedPosition = 430000000;
    h.controller._pendingMMTSVodSeek = {
        milliseconds: targetMilliseconds,
        segmentIndex: 0,
        segmentInfo: {duration: 459926},
        segment: {filesize: 4360105984},
        estimatedPosition,
        lookback: 32 * 1024 * 1024,
        fileposition: estimatedPosition - 32 * 1024 * 1024,
        estimated: true,
        ignoreKeyframeIndex: true,
        operation: Object.assign({}, operation),
    };
    h.controller._internalAbort = () => {};
    h.controller._activeIOProducer = {
        operation: Object.assign({}, operation),
    };

    assert.strictEqual(
        h.controller._schedulePendingMMTSVodSeekRetryIfNeeded(0, 125625),
        true
    );
    await Promise.resolve();
    const retryEvent = h.events.find((entry) =>
        entry[0] === 'playback_operation_retry_required'
    );
    assert(retryEvent);
    assert.strictEqual(retryEvent[1].filePosition, 0);
}

function testVodAudioSwitchIntentIsReappliedAcrossAdaptiveSeekRetry() {
    const h = makeHarness();
    const initialOperation = makePlaybackOperation(
        'audio-switch', 77, 20821, 0xf111, 'requested', 4
    );
    h.controller._playbackOperation = initialOperation;
    const demuxer = new h.MMTSDemuxer();
    const operations = [];
    demuxer.seek = (milliseconds) => {
        operations.push({type: 'demux_seek', milliseconds});
    };
    demuxer.selectAudioTrack = (packetId, timelineSeed, onBoundary, rebuildFromSeek, identity) => {
        operations.push({type: 'select', packetId, timelineSeed, rebuildFromSeek, identity});
        onBoundary();
        return true;
    };
    h.controller._demuxer = demuxer;
    h.controller._config = {
        isMMTS: true,
        mmtsVodSeekLookbackBytes: 32 * 1024 * 1024,
        mmtsVodSeekMaxLookbackBytes: 128 * 1024 * 1024,
    };
    h.controller._mediaInfo = {hasVideo: true, hasAudio: true};
    h.controller._pendingMMTSVodAudioSwitchIntent = Object.assign(
        operationContract.createPlaybackSwitchIdentity(initialOperation),
        {
        packetId: 0xf111,
        requestedStart: 20.821,
        requestedStartMicroseconds: 20821000,
        }
    );
    const segmentInfo = {duration: 459659};
    const segment = {filesize: 4100000000};
    h.controller._pendingMMTSVodSeek = {
        milliseconds: 20821,
        segmentIndex: 0,
        segmentInfo,
        segment,
        estimatedPosition: 197498072,
        lookback: 32 * 1024 * 1024,
        fileposition: 163943640,
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    h.controller._resolveSeekPoint = (_info, _segment, milliseconds, lookback) => {
        assert.strictEqual(milliseconds, 20821);
        assert.strictEqual(lookback, 64 * 1024 * 1024);
        return {
            milliseconds,
            fileposition: 130389208,
            estimatedPosition: 197498072,
            lookback,
            estimated: true,
        };
    };
    h.controller._internalAbort = () => operations.push({type: 'abort'});
    h.controller._remuxer = {
        seek(milliseconds) { operations.push({type: 'remux_seek', milliseconds}); },
        insertDiscontinuity() { operations.push({type: 'discontinuity'}); },
        resetAudioState() { operations.push({type: 'reset_audio'}); },
    };
    h.controller._loadSegment = (index, fileposition) => {
        operations.push({type: 'load', index, fileposition});
    };
    h.controller._enableStatisticsReporter = () => {
        operations.push({type: 'statistics'});
    };

    assert.strictEqual(h.controller._retryPendingMMTSVodSeekIfNeeded(0), true);
    assert.strictEqual(h.controller._playbackOperation.attempt, 0);
    assert.strictEqual(operations.filter((operation) => operation.type === 'select').length, 0);
    assert.strictEqual(operations.filter((operation) => operation.type === 'load').length, 0);
    const retryEvent = h.events.find((entry) =>
        entry[0] === 'playback_operation_retry_required'
    );
    assert(retryEvent);
    const request = retryEvent[1];
    const sourceOperation = retryEvent[2];
    assert.strictEqual(
        operationContract.isPlaybackOperationRetryRequest(request, sourceOperation),
        true
    );
    assert.strictEqual(
        operationContract.isSamePlaybackOperation(sourceOperation, initialOperation),
        true
    );
    const retryOperation = operationContract.createNextPlaybackAttempt(sourceOperation, {
        phase: 'adaptive-retry',
        requestedTimeMilliseconds: request.requestedTimeMilliseconds,
    });
    assert.strictEqual(
        h.controller.canContinuePlaybackOperationRetry(retryOperation, request),
        true
    );
    assert.strictEqual(
        h.controller.continuePlaybackOperationRetry(retryOperation, request),
        true
    );
    assert.strictEqual(h.controller._playbackOperation.timelineGeneration, 4);
    assert.strictEqual(h.controller._playbackOperation.transactionId, 77);
    assert.strictEqual(h.controller._playbackOperation.attempt, 1);
    assert.strictEqual(h.controller._playbackOperation.phase, 'adaptive-retry');
    const selection = operations.find((operation) => operation.type === 'select');
    assert.strictEqual(selection.type, 'select');
    assert.strictEqual(selection.packetId, 0xf111);
    assert.strictEqual(selection.timelineSeed, 20821);
    assert.strictEqual(selection.rebuildFromSeek, true);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selection.identity)),
        JSON.parse(JSON.stringify(
            operationContract.createPlaybackSwitchIdentity(h.controller._playbackOperation)
        ))
    );
    assert.strictEqual(h.controller._pendingMMTSVodAudioSwitchIntent.id, 77);
    assert.strictEqual(h.controller._pendingMMTSVodAudioSwitchIntent.attempt, 1);
    assert.deepStrictEqual(operations.find((operation) => operation.type === 'load'), {
        type: 'load', index: 0, fileposition: 130389208,
    });
    h.controller._producerPlaybackOperation = Object.assign({}, h.controller._playbackOperation);
    const staleIdentity = Object.assign(
        operationContract.createPlaybackSwitchIdentity(initialOperation),
        {
            packetId: 0xf111,
            requestedStart: 20.821,
            requestedStartMicroseconds: 20821000,
        }
    );
    h.controller._collectMMTSStartupInitSegment('audio', {
        mmtsAudioTrackSwitch: staleIdentity,
    });
    assert.strictEqual(h.controller._mmtsStartupGroup.audioInitSegment, null);
    const currentIdentity = Object.assign(
        operationContract.createPlaybackSwitchIdentity(h.controller._playbackOperation),
        {
            packetId: 0xf111,
            requestedStart: 20.821,
            requestedStartMicroseconds: 20821000,
        }
    );
    const freshInit = {
        mmtsAudioTrackSwitch: currentIdentity,
    };
    h.controller._collectMMTSStartupInitSegment('audio', freshInit);
    assert.strictEqual(h.controller._mmtsStartupGroup.audioInitSegment, freshInit);
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    const freshAudioMedia = {
        info: {beginDts: 20700, endDts: 21200},
        mmtsAudioTrackSwitch: currentIdentity,
    };
    h.controller._onRemuxerMediaSegmentArrival('audio', freshAudioMedia);
    assert.strictEqual(h.controller._pendingMMTSVodSeekAudioSegments[0], freshAudioMedia);
    const freshVideoMedia = makeVideoSegment(20.821, 21.2);
    freshVideoMedia.info.syncPoints = [{originalDts: 17785, dts: 17785, pts: 17785}];
    h.controller._onRemuxerMediaSegmentArrival('video', freshVideoMedia);
    const startup = h.events.find((event) => event[0] === 'startup_group');
    assert(startup);
    assert.strictEqual(startup[1].audioInitSegment, freshInit);
    assert.strictEqual(startup[1].audioMediaSegment, freshAudioMedia);
    assert.strictEqual(h.controller._pendingMMTSVodAudioSwitchIntent.id, 77);
    assert.strictEqual(
        h.controller.acknowledgeMMTSVodAudioTrackStartup(
            operationContract.createPlaybackSwitchIdentity(initialOperation)
        ),
        false
    );
    assert.strictEqual(h.controller._pendingMMTSVodAudioSwitchIntent.id, 77);
    assert.strictEqual(
        h.controller.acknowledgeMMTSVodAudioTrackStartup(
            operationContract.createPlaybackSwitchIdentity(h.controller._playbackOperation)
        ),
        true
    );
    assert.strictEqual(h.controller._pendingMMTSVodAudioSwitchIntent, null);
}

function testVodVideoSwitchIntentIsReappliedAcrossAdaptiveSeekRetry() {
    const h = makeHarness();
    const initialOperation = makePlaybackOperation(
        'video-switch', 78, 20821, 0xf201, 'requested', 5
    );
    h.controller._playbackOperation = operationContract.createNextPlaybackAttempt(
        initialOperation,
        {
        phase: 'adaptive-retry',
        }
    );
    const demuxer = new h.MMTSDemuxer();
    const selections = [];
    demuxer.selectVideoTrack = (packetId, identity) => {
        selections.push({packetId, identity});
        return {
            accepted: true,
            changed: true,
            requestedPacketId: packetId,
            selectedPacketId: packetId,
            reason: 'selected',
            transactionId: identity.id,
            attempt: identity.attempt,
        };
    };
    h.controller._demuxer = demuxer;
    h.controller._pendingMMTSVodVideoSwitchIntent = Object.assign(
        operationContract.createPlaybackSwitchIdentity(initialOperation),
        {
        packetId: 0xf201,
        }
    );

    const result = h.controller._reapplyMMTSVodVideoSwitchIntent();
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(selections.length, 1);
    assert.strictEqual(selections[0].packetId, 0xf201);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(selections[0].identity)),
        JSON.parse(JSON.stringify(
            operationContract.createPlaybackSwitchIdentity(h.controller._playbackOperation)
        ))
    );
    assert.strictEqual(h.controller._pendingMMTSVodVideoSwitchIntent.id, 78);
    assert.strictEqual(h.controller._pendingMMTSVodVideoSwitchIntent.attempt, 1);
}

function testVodAudioSwitchAudioFirstSegmentUsesStartupCollector() {
    const h = makeHarness();
    const operation = makePlaybackOperation(
        'audio-switch', 55, 10500, 0xf111, 'requested'
    );
    assert.strictEqual(h.controller.setPlaybackOperation(operation), true);
    assert.strictEqual(h.controller.resetMMTSStartupGroup(), true);
    h.controller._producerPlaybackOperation = Object.assign({}, operation);
    const identity = Object.assign(
        operationContract.createPlaybackSwitchIdentity(operation),
        {
            packetId: 0xf111,
            requestedStart: 10.5,
            requestedStartMicroseconds: 10500000,
        }
    );
    h.controller._pendingMMTSVodAudioSwitchIntent = Object.assign({}, identity);
    h.controller._pendingMMTSVodSeek = {
        milliseconds: 10500,
        segmentIndex: 0,
        lookback: 32 * 1024 * 1024,
        fileposition: 100,
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    h.controller._pendingResolveSeekPoint = {
        milliseconds: 10500,
        useFirstSyncPoint: true,
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    h.controller._collectMMTSStartupInitSegment('audio', {mmtsAudioTrackSwitch: identity});
    const audio = {
        info: {beginDts: 10400, endDts: 11200},
        mmtsAudioTrackSwitch: identity,
    };
    h.controller._onRemuxerMediaSegmentArrival('audio', audio);
    assert.strictEqual(h.controller._pendingMMTSVodSeekAudioSegments[0], audio);
    const video = makeVideoSegment(10.5, 11.2);
    video.info.syncPoints = [{originalDts: 10400, dts: 10400, pts: 10400}];
    h.controller._onRemuxerMediaSegmentArrival('video', video);
    const startup = h.events.find((event) => event[0] === 'startup_group');
    assert(startup);
    assert.strictEqual(startup[1].audioMediaSegment, audio);
}

function testVodAudioSwitchStartupUsesOperationIdentityAndSafeVideoPreroll() {
    const h = makeHarness();
    const operation = makePlaybackOperation(
        'audio-switch', 56, 4577.416, 0xf111, 'requested'
    );
    assert.strictEqual(h.controller.setPlaybackOperation(operation), true);
    assert.strictEqual(h.controller.resetMMTSStartupGroup(), true);
    h.controller._producerPlaybackOperation = Object.assign({}, operation);
    h.controller._pendingMMTSVodAudioSwitchIntent = null;
    h.controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    h.controller._collectMMTSStartupInitSegment('video', {type: 'video'});
    h.controller._collectMMTSStartupInitSegment('audio', {type: 'audio'});
    h.controller._collectMMTSStartupMediaSegment('audio', {
        type: 'audio',
        info: {beginDts: 1677, endDts: 1996},
    });
    assert.strictEqual(h.controller._mmtsStartupGroup.audioInitSegment, null);
    assert.strictEqual(h.controller._mmtsStartupGroup.audioMediaSegments.length, 0);

    const identity = Object.assign(
        operationContract.createPlaybackSwitchIdentity(operation),
        {
            packetId: 0xf111,
            requestedStart: 4.577416,
            requestedStartMicroseconds: 4577416,
        }
    );
    const audioInit = {type: 'audio', mmtsAudioTrackSwitch: identity};
    const audioMedia = {
        type: 'audio',
        info: {beginDts: 1677, endDts: 1996},
        mmtsAudioTrackSwitch: identity,
    };
    const audioContinuation = {
        type: 'audio',
        info: {beginDts: 1996, endDts: 2300},
    };
    const videoRoot = makeVideoSegment(1.234, 1.384);
    const videoContinuation = {
        type: 'video',
        info: {
            beginDts: 1384,
            endDts: 1800,
            endPts: 1800,
            firstSample: {isSyncPoint: false},
            lastSample: {pts: 1783, duration: 17},
        },
    };
    h.controller._collectMMTSStartupInitSegment('audio', audioInit);
    h.controller._collectMMTSStartupMediaSegment('video', videoRoot);
    h.controller._collectMMTSStartupMediaSegment('audio', audioMedia);
    h.controller._collectMMTSStartupMediaSegment('audio', audioContinuation);
    assert.strictEqual(
        h.events.some((event) => event[0] === 'startup_group'),
        false
    );
    h.controller._collectMMTSStartupMediaSegment('video', videoContinuation);

    const startup = h.events.find((event) => event[0] === 'startup_group');
    assert(startup);
    assert.strictEqual(startup[1].videoMediaSegment, videoRoot);
    assert.strictEqual(startup[1].videoMediaSegment.mmtsRandomAccessSafe, true);
    assert.strictEqual(startup[1].audioInitSegment, audioInit);
    assert.strictEqual(startup[1].audioMediaSegment, audioMedia);
    assert.strictEqual(startup[1].playableStart, 1.677);
    assert(h.events.some((event) =>
        event[0] === 'media_segment' && event[1] === 'audio' &&
        event[2] === audioContinuation
    ));
}

function testVodSeekRecommendsRequestedTimeAfterFindingEarlierRap() {
    const h = makeHarness();
    h.controller._pendingMMTSVodSeek = {
        milliseconds: 237682,
        segmentIndex: 0,
        lookback: 128 * 1024 * 1024,
        fileposition: 2120320332,
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    h.controller._pendingResolveSeekPoint = {
        milliseconds: 237682,
        useFirstSyncPoint: true,
        operation: Object.assign({}, h.controller._playbackOperation),
    };
    const audioSegment = {type: 'audio'};
    const videoSegment = {
        type: 'video',
        info: {
            syncPoints: [{originalDts: 228896, dts: 228896, pts: 229062}],
        },
    };
    h.controller._pendingMMTSVodSeekAudioSegments.push(audioSegment);
    h.controller._pendingMMTSVodSeekAudioOperation = Object.assign(
        {},
        h.controller._playbackOperation
    );
    h.controller._emitRemuxerMediaSegment = (type, segment) => {
        h.events.push(['media_segment', type, segment]);
        return false;
    };

    h.controller._onRemuxerMediaSegmentArrival('video', videoSegment);

    assert.deepStrictEqual(h.events[0], ['media_segment', 'video', videoSegment]);
    assert.deepStrictEqual(h.events[1], ['media_segment', 'audio', audioSegment]);
    assert.deepStrictEqual(h.events[2], ['recommend_seekpoint', 237682]);
    assert.strictEqual(h.controller._pendingMMTSVodSeek, null);
}

function testVodSeekRejectsDistantSparseKeyframe() {
    const h = makeHarness();
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {isMMTS: true, mmtsVodSeekLookbackBytes: 32 * 1024 * 1024};
    const segment = {filesize: 4100000000};
    const segmentInfo = makeSeekableSegmentInfo(
        [25000, 246000],
        [220000000, 2190000000],
        459659
    );

    const seekPoint = h.controller._resolveSeekPoint(segmentInfo, segment, 187000);
    const estimatedPosition = Math.floor(187000 * segment.filesize / segmentInfo.duration);
    assert.strictEqual(seekPoint.estimated, true);
    assert.strictEqual(seekPoint.milliseconds, 187000);
    assert.strictEqual(seekPoint.estimatedPosition, estimatedPosition);
    assert.strictEqual(seekPoint.fileposition, estimatedPosition - 32 * 1024 * 1024);
    assert.notStrictEqual(seekPoint.fileposition, 220000000);
}

function testVodSeekUsesNearbyKnownKeyframe() {
    const h = makeHarness();
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {isMMTS: true, mmtsVodSeekLookbackBytes: 32 * 1024 * 1024};
    const segment = {filesize: 4100000000};
    const segmentInfo = makeSeekableSegmentInfo(
        [25000, 246000],
        [220000000, 2190000000],
        459659
    );

    const seekPoint = h.controller._resolveSeekPoint(segmentInfo, segment, 27000);
    assert.strictEqual(seekPoint.estimated, undefined);
    assert.strictEqual(seekPoint.milliseconds, 25000);
    assert.strictEqual(seekPoint.fileposition, 220000000);
}

function testVodSeekUsesObservedNearbyKeyframeSpanWithIncompleteDuration() {
    const h = makeHarness();
    h.controller._demuxer = new h.MMTSDemuxer();
    h.controller._config = {isMMTS: true, mmtsVodSeekLookbackBytes: 32 * 1024 * 1024};
    const segment = {filesize: 4360105984};
    const segmentInfo = makeSeekableSegmentInfo(
        [4000, 4500, 26000],
        [37000000, 42000000, 250000000],
        26000
    );

    const seekPoint = h.controller._resolveSeekPoint(segmentInfo, segment, 4384.25);
    assert.strictEqual(seekPoint.estimated, undefined);
    assert.strictEqual(seekPoint.milliseconds, 4000);
    assert.strictEqual(seekPoint.fileposition, 37000000);
}

function testLateSeekOutputsNeverAcquireNewOperationIdentity() {
    const {TransmuxingController, FakeIOController, MMTSDemuxer} = loadController();
    const controller = new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const events = [];
    const segments = [];
    controller.on('io_error', (...args) => events.push(['io_error', args[args.length - 1]]));
    controller.on('demux_error', (...args) => events.push(['demux_error', args[args.length - 1]]));
    controller.on('loading_complete', (operation) => events.push(['loading_complete', operation]));
    controller.on('recommend_seekpoint', (_time, operation) => {
        events.push(['recommend_seekpoint', operation]);
    });
    controller.on('mmts_subtitle_data_arrived', (_data, operation) => {
        events.push(['subtitle', operation]);
    });
    controller.on('media_segment', (_type, segment, operation) => {
        segments.push({segment, operation});
    });
    const demuxer = new MMTSDemuxer();
    demuxer.bindDataSource = function (loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    };
    demuxer.parseChunks = () => 1;
    controller._demuxer = demuxer;
    controller._remuxer = {flushStashedSamples() {}};
    const seekA = makePlaybackOperation('seek', 10, 1000);
    const seekB = makePlaybackOperation('seek', 11, 2000);

    controller.setPlaybackOperation(seekA);
    controller._loadSegment(0, 0);
    const io = FakeIOController.instances[0];
    const staleError = io.onError;
    const staleComplete = io.onComplete;
    const staleDemuxError = demuxer.onError;
    const staleSubtitle = demuxer.onMMTSSubtitleData;
    const staleRemuxMedia = controller._remuxer.onMediaSegment;
    controller.setPlaybackOperation(seekB);

    staleError('late-io', {code: -1, msg: 'seek A'});
    staleComplete(0);
    staleDemuxError('late-demux-callback', 'seek A');
    staleSubtitle({text: 'seek A'});
    staleRemuxMedia('video', makeVideoSegment());
    controller._withProducerPlaybackOperation(seekA, () => {
        controller._onDemuxException('late-demux', 'seek A');
        controller._emitter.emit('recommend_seekpoint', 1000);
        controller._onRemuxerMediaSegmentArrival('video', makeVideoSegment());
    });
    controller._onDemuxException('missing-producer', 'late callback');

    assert.strictEqual(segments.length, 0);
    assert.strictEqual(events.some((event) => event[0] === 'io_error'), false);
    assert.strictEqual(events.some((event) => event[0] === 'loading_complete'), false);
    assert.strictEqual(events.some((event) => {
        const operation = event[1];
        return operation && operation.timelineGeneration === seekB.timelineGeneration;
    }), false);
    assert(events.some((event) => event[1] && event[1].timelineGeneration === seekA.timelineGeneration));
    assert.strictEqual(events.some((event) => event[1] === null), false);
}

function testSeekRebuildsStartupCollectorWithoutMixingOperations() {
    const {TransmuxingController} = loadController();
    const controller = new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const groups = [];
    controller.on('startup_group', (group, operation) => groups.push({group, operation}));
    const seekA = makePlaybackOperation('seek', 20, 1000, undefined, 'collecting');
    const seekB = makePlaybackOperation('seek', 21, 2000, undefined, 'collecting');
    const videoInitA = {type: 'video-a'};
    const videoMediaA = makeVideoSegment(1, 2);

    controller.setPlaybackOperation(seekA);
    controller._withProducerPlaybackOperation(seekA, () => {
        controller._collectMMTSStartupInitSegment('video', videoInitA);
        controller._collectMMTSStartupMediaSegment('video', videoMediaA);
        controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    });
    controller.setPlaybackOperation(seekB);
    controller._withProducerPlaybackOperation(seekA, () => {
        controller._collectMMTSStartupInitSegment('audio', {type: 'audio-a'});
        controller._collectMMTSStartupMediaSegment('audio', {
            info: {beginDts: 900, endDts: 2100},
        });
    });
    controller._withProducerPlaybackOperation(seekB, () => {
        controller._collectMMTSStartupInitSegment('audio', {type: 'audio-b'});
        controller._collectMMTSStartupMediaSegment('audio', {
            info: {beginDts: 1900, endDts: 3100},
        });
        controller._setMMTSStartupGroupMediaInfo({hasVideo: true, hasAudio: true});
    });
    assert.strictEqual(groups.length, 0);

    controller._withProducerPlaybackOperation(seekB, () => {
        controller._collectMMTSStartupInitSegment('video', {type: 'video-b'});
        controller._collectMMTSStartupMediaSegment('video', makeVideoSegment(2, 3));
    });
    assert.strictEqual(groups.length, 1);
    const output = groups[0];
    assert.strictEqual(output.group.videoInitSegment.type, 'video-b');
    assert.strictEqual(output.group.audioInitSegment.type, 'audio-b');
    assert.notStrictEqual(output.group.videoMediaSegment, videoMediaA);
    assert.strictEqual(output.operation.timelineGeneration, seekB.timelineGeneration);
    assert.strictEqual(output.group.playbackOperation.timelineGeneration, seekB.timelineGeneration);
    [
        output.group.videoInitSegment,
        output.group.audioInitSegment,
        output.group.videoMediaSegment,
        output.group.audioMediaSegment,
    ].forEach((segment) => {
        assert.strictEqual(segment.playbackOperation.timelineGeneration, seekB.timelineGeneration);
        assert.strictEqual(segment.playbackOperation.transactionId, seekB.transactionId);
        assert.strictEqual(segment.mseBufferGeneration, seekB.timelineGeneration);
    });
}

function testMMTSSegmentsCarryUpstreamGenerationAndRejectOldAttempt() {
    const {TransmuxingController} = loadController();
    const controller = new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const outputs = [];
    controller.on('init_segment', (type, segment, operation) => {
        outputs.push({type, segment, operation});
    });
    const attempt0 = makePlaybackOperation('seek', 30, 3000);
    const attempt1 = operationContract.createNextPlaybackAttempt(attempt0, {
        phase: 'adaptive-retry',
    });

    controller.setPlaybackOperation(attempt0);
    controller._mmtsStartupGroup.emitted = true;
    controller._withProducerPlaybackOperation(attempt0, () => {
        controller._onRemuxerInitSegmentArrival('video', {type: 'attempt-0'});
    });
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].segment.mseBufferGeneration, 30);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(outputs[0].segment.playbackOperation)),
        JSON.parse(JSON.stringify(attempt0))
    );
    assert.notStrictEqual(outputs[0].segment.playbackOperation, controller._playbackOperation);

    controller.setPlaybackOperation(attempt1);
    controller._mmtsStartupGroup.emitted = true;
    controller._withProducerPlaybackOperation(attempt0, () => {
        controller._onRemuxerInitSegmentArrival('video', {type: 'stale-attempt-0'});
    });
    assert.strictEqual(outputs.length, 1);
    controller._withProducerPlaybackOperation(attempt1, () => {
        controller._onRemuxerInitSegmentArrival('video', {type: 'attempt-1'});
    });
    assert.strictEqual(outputs.length, 2);
    assert.strictEqual(outputs[1].segment.playbackOperation.attempt, 1);
    assert.strictEqual(outputs[1].segment.mseBufferGeneration, 30);
}

function testControllerEmitsVideoSelectionAcknowledgementWithOperation() {
    const {TransmuxingController, MMTSDemuxer} = loadController();
    const controller = new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {isMMTS: true});
    const operation = makePlaybackOperation(
        'video-switch', 40, 0, 0xf201, 'selecting'
    );
    const acknowledgements = [];
    let demuxCalls = 0;
    const demuxer = new MMTSDemuxer();
    demuxer.selectVideoTrack = (packetId, identity) => {
        demuxCalls++;
        return {
            accepted: true,
            changed: true,
            requestedPacketId: packetId,
            selectedPacketId: packetId,
            reason: 'selected',
            transactionId: identity.id,
            attempt: identity.attempt,
        };
    };
    controller._demuxer = demuxer;
    controller.on('mmts_video_track_selection_result', (result, sourceOperation) => {
        acknowledgements.push({result, sourceOperation});
    });
    controller.setPlaybackOperation(operation);

    const acceptedIdentity = operationContract.createPlaybackSwitchIdentity(operation);
    const accepted = controller.selectVideoTrack(0xf201, acceptedIdentity);
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(demuxCalls, 1);
    assert.strictEqual(acknowledgements[0].result.transactionId, 40);
    assert.strictEqual(acknowledgements[0].sourceOperation.kind, 'video-switch');
    const rejectedIdentity = operationContract.createPlaybackSwitchIdentity(
        makePlaybackOperation('video-switch', 41, 0, 0xf201, 'selecting', 41)
    );
    const rejected = controller.selectVideoTrack(0xf201, rejectedIdentity);
    assert.strictEqual(rejected.accepted, false);
    assert.strictEqual(rejected.reason, 'invalid-identity');
    assert.strictEqual(demuxCalls, 1);
    assert.strictEqual(acknowledgements[1].result.transactionId, 41);
}

function makeLifecycleHarness(timeout = 100, segmentCount = 1) {
    const {TransmuxingController, clock, FakeIOController} = loadController();
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
        segments.push({duration: 1000});
    }
    const controller = new TransmuxingController({
        segments,
        duration: segmentCount * 1000,
    }, {
        isMMTS: true,
        mmtsStartupGroupTimeout: timeout,
        statisticsInfoReportInterval: 1000,
    });
    const operation = makePlaybackOperation('startup', 50, 0, undefined, 'collecting');
    const events = [];
    controller.on('startup_group', (group, sourceOperation) => {
        events.push({type: 'startup-group', group, operation: sourceOperation});
    });
    controller.on('startup_group_failed', (failure, sourceOperation) => {
        events.push({type: 'startup-group-failed', failure, operation: sourceOperation});
    });
    controller.on('loading_complete', (sourceOperation) => {
        events.push({type: 'loading-complete', operation: sourceOperation});
    });
    controller.on('init_segment', (type, segment, sourceOperation) => {
        events.push({type: 'init-segment', mediaType: type, segment, operation: sourceOperation});
    });
    controller.on('media_segment', (type, segment, sourceOperation) => {
        events.push({type: 'media-segment', mediaType: type, segment, operation: sourceOperation});
    });
    controller.setPlaybackOperation(operation);
    return {controller, clock, operation, events, FakeIOController};
}

function collectStartupParts(controller, operation, parts) {
    controller._withProducerPlaybackOperation(operation, () => {
        if (parts.mediaInfo) {
            controller._setMMTSStartupGroupMediaInfo(parts.mediaInfo);
        }
        if (parts.videoInit) {
            controller._collectMMTSStartupInitSegment('video', parts.videoInit);
        }
        if (parts.audioInit) {
            controller._collectMMTSStartupInitSegment('audio', parts.audioInit);
        }
        if (parts.videoMedia) {
            controller._collectMMTSStartupMediaSegment('video', parts.videoMedia);
        }
        if (parts.audioMedia) {
            controller._collectMMTSStartupMediaSegment('audio', parts.audioMedia);
        }
    });
}

function collectCompleteStartupGroup(controller, operation) {
    collectStartupParts(controller, operation, {
        mediaInfo: {hasVideo: true, hasAudio: true},
        videoInit: {type: 'video'},
        audioInit: {type: 'audio'},
        videoMedia: makeVideoSegment(1, 2),
        audioMedia: {info: {beginDts: 900, endDts: 2100}},
    });
}

function testStartupGroupTimeoutConfigurationIsStrict() {
    const lifecycle = loadStartupGroupLifecycle();
    assert.strictEqual(lifecycle.DEFAULT_MMTS_STARTUP_GROUP_TIMEOUT, 45000);
    assert.strictEqual(lifecycle.resolveMMTSStartupGroupTimeout({}), 45000);
    assert.strictEqual(lifecycle.resolveMMTSStartupGroupTimeout({
        mmtsStartupGroupTimeout: 25,
    }), 25);
    [0, -1, Infinity, NaN, '25', null, undefined].forEach((value) => {
        assert.throws(() => lifecycle.resolveMMTSStartupGroupTimeout({
            mmtsStartupGroupTimeout: value,
        }), TypeError);
    });
    const {TransmuxingController} = loadController();
    assert.throws(() => new TransmuxingController({
        segments: [{duration: 1000}],
        duration: 1000,
    }, {
        isMMTS: true,
        mmtsStartupGroupTimeout: 0,
    }), TypeError);
    const configSource = fs.readFileSync(path.resolve(__dirname, '../src/config.js'), 'utf8');
    assert(/mmtsStartupGroupTimeout:\s*45000/.test(configSource));

    const operation = makePlaybackOperation('seek', 1, 0, undefined, 'collecting');
    const error = {code: 'append'};
    const failure = lifecycle.createMMTSStartupGroupFailure(
        operation,
        'appending',
        'append-media',
        ['audioMediaSegment'],
        error
    );
    assert.strictEqual(failure.error, error);
    assert.strictEqual(lifecycle.isMMTSStartupGroupFailure(failure, operation), true);
    assert.strictEqual(lifecycle.isMMTSStartupGroupFailure(Object.assign({}, failure, {
        transactionId: 2,
    }), operation), false);
}

function testMissingAudioTimesOutOnceAndFencesLateData() {
    const h = makeLifecycleHarness();
    collectStartupParts(h.controller, h.operation, {
        mediaInfo: {hasVideo: true, hasAudio: true},
        videoInit: {type: 'video'},
        videoMedia: makeVideoSegment(1, 2),
    });
    h.clock.advance(100);
    const failures = h.events.filter((event) => event.type === 'startup-group-failed');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].failure.reason, 'timeout');
    assert.strictEqual(failures[0].failure.phase, 'collecting');
    assert(failures[0].failure.missing.includes('audio-init'));
    assert(failures[0].failure.missing.includes('audio-media-overlap'));
    assert.strictEqual(failures[0].failure.transactionId, h.operation.transactionId);
    assert.strictEqual(failures[0].failure.mseBufferGeneration, h.operation.timelineGeneration);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(failures[0].operation)),
        JSON.parse(JSON.stringify(h.operation))
    );
    h.clock.advance(1000);
    assert.strictEqual(
        h.events.filter((event) => event.type === 'startup-group-failed').length,
        1
    );

    h.controller._withProducerPlaybackOperation(h.operation, () => {
        h.controller._onRemuxerInitSegmentArrival('audio', {type: 'late-audio'});
        h.controller._onRemuxerMediaSegmentArrival('audio', {
            info: {beginDts: 900, endDts: 2100},
        });
    });
    assert.strictEqual(h.events.some((event) => event.type === 'init-segment'), false);
    assert.strictEqual(h.events.some((event) => event.type === 'media-segment'), false);
    assert.strictEqual(h.events.some((event) => event.type === 'startup-group'), false);

    const nextOperation = makePlaybackOperation(
        h.operation.kind,
        51,
        h.operation.requestedTimeMilliseconds,
        h.operation.packetId,
        h.operation.phase
    );
    assert.strictEqual(h.controller.setPlaybackOperation(nextOperation), true);
    collectCompleteStartupGroup(h.controller, nextOperation);
    const groups = h.events.filter((event) => event.type === 'startup-group');
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].operation.timelineGeneration, 51);
}

function testPartialStartupDataDoesNotRenewDeadlineAndSuccessClearsTimer() {
    const partial = makeLifecycleHarness();
    const deadline = partial.controller._mmtsStartupGroup.deadline;
    partial.clock.advance(60);
    collectStartupParts(partial.controller, partial.operation, {
        mediaInfo: {hasVideo: true, hasAudio: true},
        videoInit: {type: 'video'},
    });
    assert.strictEqual(partial.controller._mmtsStartupGroup.deadline, deadline);
    partial.clock.advance(40);
    assert.strictEqual(
        partial.events.filter((event) => event.type === 'startup-group-failed').length,
        1
    );

    const complete = makeLifecycleHarness();
    complete.clock.advance(50);
    collectCompleteStartupGroup(complete.controller, complete.operation);
    assert.strictEqual(
        complete.events.filter((event) => event.type === 'startup-group').length,
        1
    );
    assert.strictEqual(complete.clock.pendingTimeouts(), 0);
    complete.clock.advance(1000);
    assert.strictEqual(
        complete.events.filter((event) => event.type === 'startup-group-failed').length,
        0
    );
}

function testReplacedStartupWatchdogsAreInert() {
    const h = makeLifecycleHarness();
    const generationTimer = h.controller._mmtsStartupGroup.watchdogTimer;
    const generationCallback = h.clock.callback(generationTimer);
    const seekOperation = makePlaybackOperation(
        'seek', 51, 2000, undefined, 'collecting'
    );
    h.controller.setPlaybackOperation(seekOperation);
    generationCallback();
    assert.strictEqual(h.events.length, 0);

    const attemptTimer = h.controller._mmtsStartupGroup.watchdogTimer;
    const attemptCallback = h.clock.callback(attemptTimer);
    const retryOperation = operationContract.createNextPlaybackAttempt(seekOperation, {
        phase: 'adaptive-retry',
    });
    h.controller.setPlaybackOperation(retryOperation);
    attemptCallback();
    assert.strictEqual(h.events.length, 0);
    h.clock.advance(100);
    const failure = h.events.find((event) => event.type === 'startup-group-failed');
    assert(failure);
    assert.strictEqual(failure.operation.attempt, 1);
    assert.strictEqual(failure.operation.phase, 'adaptive-retry');
}

function testStopClearsAndStartRearmsAbsoluteDeadline() {
    const h = makeLifecycleHarness();
    h.clock.advance(40);
    h.controller.stop();
    assert.strictEqual(h.clock.pendingTimeouts(), 0);
    h.clock.advance(60);
    assert.strictEqual(h.events.length, 0);
    h.controller.start();
    h.clock.advance(0);
    assert.strictEqual(
        h.events.filter((event) => event.type === 'startup-group-failed').length,
        1
    );
}

function testFinalLoadingCompleteFailsCollectorWithoutEOS() {
    const h = makeLifecycleHarness(1000, 2);
    h.controller._remuxer = {flushStashedSamples() {}};
    collectStartupParts(h.controller, h.operation, {
        mediaInfo: {hasVideo: true, hasAudio: true},
        videoInit: {type: 'video'},
        videoMedia: makeVideoSegment(1, 2),
    });
    const timer = h.controller._mmtsStartupGroup.watchdogTimer;
    h.controller._withProducerPlaybackOperation(h.operation, () => {
        h.controller._onIOComplete(0);
    });
    assert.strictEqual(
        h.events.filter((event) => event.type === 'startup-group-failed').length,
        0
    );
    assert.strictEqual(h.controller._mmtsStartupGroup.watchdogTimer, timer);

    const secondIO = h.FakeIOController.instances[h.FakeIOController.instances.length - 1];
    secondIO.onComplete(1);
    const failure = h.events.find((event) => event.type === 'startup-group-failed');
    assert(failure);
    assert.strictEqual(failure.failure.reason, 'loading-complete');
    assert(failure.failure.missing.includes('audio-init'));
    assert.strictEqual(
        h.events.some((event) => event.type === 'loading-complete'),
        false
    );
    assert.strictEqual(h.clock.pendingTimeouts(), 0);
}

function testTerminalErrorClearsStartupWatchdog() {
    const h = makeLifecycleHarness();
    h.controller._withProducerPlaybackOperation(h.operation, () => {
        h.controller._onIOException('network', {code: -1, msg: 'closed'});
        h.controller._onRemuxerInitSegmentArrival('video', {type: 'late-video'});
        h.controller._onRemuxerMediaSegmentArrival('video', makeVideoSegment(1, 2));
    });
    assert.strictEqual(h.clock.pendingTimeouts(), 0);
    h.clock.advance(1000);
    assert.strictEqual(
        h.events.some((event) => event.type === 'startup-group-failed'),
        false
    );
    assert.strictEqual(h.events.some((event) => event.type === 'init-segment'), false);
    assert.strictEqual(h.events.some((event) => event.type === 'media-segment'), false);
}

async function testInlineAndWorkerStartupFailureFencing() {
    const {Transmuxer} = loadTransmuxer();
    const EventEmitter = require('events');
    const lifecycle = loadStartupGroupLifecycle();
    const operationA = makePlaybackOperation('seek', 60, 1000, undefined, 'collecting');
    const operationB = makePlaybackOperation('seek', 61, 2000, undefined, 'collecting');
    const transmuxer = Object.create(Transmuxer.prototype);
    transmuxer._isMMTS = true;
    transmuxer._playbackOperation = Object.assign({}, operationB);
    transmuxer._mmtsVodAudioTrackRebuildEpoch = 4;
    transmuxer._mmtsVodAudioTrackRebuildPending = false;
    transmuxer._workerDestroying = false;
    transmuxer._emitter = new EventEmitter();
    const outputs = [];
    transmuxer.on('startup_group_failed', (failure, operation) => {
        outputs.push({failure, operation});
    });
    const failureA = lifecycle.createMMTSStartupGroupFailure(
        operationA, 'collecting', 'timeout', ['audio-init']
    );
    const failureB = lifecycle.createMMTSStartupGroupFailure(
        operationB, 'collecting', 'timeout', ['audio-init']
    );

    transmuxer._onStartupGroupFailed(failureA, operationA);
    await Promise.resolve();
    assert.strictEqual(outputs.length, 0);
    transmuxer._onStartupGroupFailed(failureB, operationB);
    transmuxer._mmtsVodAudioTrackRebuildEpoch++;
    await Promise.resolve();
    assert.strictEqual(outputs.length, 0);
    transmuxer._onStartupGroupFailed(failureB, operationB);
    await Promise.resolve();
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].operation.timelineGeneration, 61);

    transmuxer._onWorkerMessage({data: {
        msg: 'startup_group_failed',
        playback_operation: operationB,
        mmts_vod_audio_track_rebuild_epoch: 4,
        data: failureB,
    }});
    assert.strictEqual(outputs.length, 1);
    transmuxer._onWorkerMessage({data: {
        msg: 'startup_group_failed',
        playback_operation: operationA,
        mmts_vod_audio_track_rebuild_epoch: 5,
        data: failureA,
    }});
    assert.strictEqual(outputs.length, 1);
    transmuxer._onWorkerMessage({data: {
        msg: 'startup_group_failed',
        playback_operation: operationB,
        mmts_vod_audio_track_rebuild_epoch: 5,
        data: failureB,
    }});
    assert.strictEqual(outputs.length, 2);

    const retryOperation = operationContract.createNextPlaybackAttempt(operationB, {
        phase: 'adaptive-retry',
    });
    const retryFailure = lifecycle.createMMTSStartupGroupFailure(
        retryOperation, 'collecting', 'timeout', ['audio-media-overlap']
    );
    const retryRequest = makePlaybackRetryRequest(operationB);
    const workerMessages = [];
    transmuxer._worker = {postMessage(message) { workerMessages.push(message); }};
    transmuxer._pendingPlaybackOperationRetry = {
        request: retryRequest,
        sourceOperation: Object.assign({}, operationB),
    };
    assert.strictEqual(
        transmuxer.continuePlaybackOperationRetry(retryOperation, retryRequest),
        true
    );
    assert.strictEqual(workerMessages.length, 1);
    assert.strictEqual(workerMessages[0].cmd, 'continue_playback_operation_retry');
    transmuxer._onWorkerMessage({data: {
        msg: 'playback_operation_retry_continued',
        playback_operation: retryOperation,
        retry_operation: retryOperation,
        data: retryRequest,
    }});
    assert.strictEqual(transmuxer._pendingPlaybackOperationRetry, null);
    transmuxer._onWorkerMessage({data: {
        msg: 'startup_group_failed',
        playback_operation: retryOperation,
        mmts_vod_audio_track_rebuild_epoch: 5,
        data: retryFailure,
    }});
    assert.strictEqual(outputs.length, 3);
    assert.strictEqual(outputs[2].operation.attempt, 1);
    assert.strictEqual(transmuxer._playbackOperation.attempt, 1);
    transmuxer._onWorkerMessage({data: {
        msg: 'startup_group_failed',
        playback_operation: operationB,
        mmts_vod_audio_track_rebuild_epoch: 5,
        data: failureB,
    }});
    assert.strictEqual(outputs.length, 3);

    const rejectedRetryOperation = operationContract.createNextPlaybackAttempt(
        retryOperation,
        {phase: 'adaptive-retry'}
    );
    const rejectedRetryRequest = makePlaybackRetryRequest(retryOperation);
    const rejectedRetries = [];
    transmuxer.on('playback_operation_retry_rejected', (
        request,
        nextOperation,
        sourceOperation
    ) => {
        rejectedRetries.push({request, nextOperation, sourceOperation});
    });
    transmuxer._pendingPlaybackOperationRetry = {
        request: rejectedRetryRequest,
        sourceOperation: Object.assign({}, retryOperation),
    };
    assert.strictEqual(
        transmuxer.continuePlaybackOperationRetry(
            rejectedRetryOperation,
            rejectedRetryRequest
        ),
        true
    );
    transmuxer._onWorkerMessage({data: {
        msg: 'playback_operation_retry_rejected',
        playback_operation: retryOperation,
        retry_operation: rejectedRetryOperation,
        data: rejectedRetryRequest,
    }});
    assert.strictEqual(transmuxer._pendingPlaybackOperationRetry, null);
    assert.strictEqual(rejectedRetries.length, 1);
    assert.strictEqual(
        rejectedRetries[0].request.requestId,
        rejectedRetryRequest.requestId
    );
    assert.strictEqual(rejectedRetries[0].nextOperation.attempt, 2);
    assert.strictEqual(rejectedRetries[0].sourceOperation.attempt, 1);
}

async function main() {
    testPlaybackOperationValidationAndMonotonicAdvance();
    testIOProducerOperationIsImmutableAndLateCallbacksAreInert();
    testAudioStartupGroupMovesToLaterRapWindow();
    testVideoOnlyStartupGroupDeclaresAudioUnavailable();
    testStartupGroupReplaysCollectedVideoContinuations();
    testStartupGroupReplaysCollectedAudioContinuations();
    await testVodSeekRetriesWhenEstimatedRangeStartsAfterTarget();
    await testVodSeekRetriesWhenIndexedRangeStartsAfterTarget();
    testVodIndexedSeekRetryMovesBeforeRejectedIndex();
    await testVodSeekAtMaxLookbackFallsBackToSegmentStart();
    testVodAudioSwitchIntentIsReappliedAcrossAdaptiveSeekRetry();
    testVodVideoSwitchIntentIsReappliedAcrossAdaptiveSeekRetry();
    testVodAudioSwitchAudioFirstSegmentUsesStartupCollector();
    testVodAudioSwitchStartupUsesOperationIdentityAndSafeVideoPreroll();
    testVodSeekRecommendsRequestedTimeAfterFindingEarlierRap();
    testVodSeekRejectsDistantSparseKeyframe();
    testVodSeekUsesNearbyKnownKeyframe();
    testVodSeekUsesObservedNearbyKeyframeSpanWithIncompleteDuration();
    testLateSeekOutputsNeverAcquireNewOperationIdentity();
    testSeekRebuildsStartupCollectorWithoutMixingOperations();
    testMMTSSegmentsCarryUpstreamGenerationAndRejectOldAttempt();
    testControllerEmitsVideoSelectionAcknowledgementWithOperation();
    testStartupGroupTimeoutConfigurationIsStrict();
    testMissingAudioTimesOutOnceAndFencesLateData();
    testPartialStartupDataDoesNotRenewDeadlineAndSuccessClearsTimer();
    testReplacedStartupWatchdogsAreInert();
    testStopClearsAndStartRearmsAbsoluteDeadline();
    testFinalLoadingCompleteFailsCollectorWithoutEOS();
    testTerminalErrorClearsStartupWatchdog();
    await testInlineAndWorkerStartupFailureFencing();
    console.log('mmts startup-group tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

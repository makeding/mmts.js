#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

let nextTimerId = 1;
const pendingTimers = new Map();

function fakeSetTimeout(callback, delay) {
    const id = nextTimerId++;
    pendingTimers.set(id, {callback, delay});
    return id;
}

function fakeClearTimeout(id) {
    pendingTimers.delete(id);
}

function resetTimers() {
    pendingTimers.clear();
}

function fireTimer(id) {
    const timer = pendingTimers.get(id);
    assert.ok(timer, `Missing timer ${id}`);
    pendingTimers.delete(id);
    timer.callback();
}

function compile(relativePath, requireMap = {}) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require(id) {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
            if (id === '../utils/logger') {
                return {__esModule: true, default: {e() {}, v() {}, w() {}}};
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        Set,
        Object,
        Number,
        ArrayBuffer,
        Uint8Array,
        isFinite,
        setTimeout: fakeSetTimeout,
        clearTimeout: fakeClearTimeout,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

const playbackOperationModule = compile('src/core/playback-operation.ts');
const startupGroupLifecycleModule = compile('src/core/mmts-startup-group-lifecycle.ts', {
    './playback-operation': playbackOperationModule,
});
const trackSwitchWindowModule = compile('src/player/mmts-track-switch-window.ts');
const MSEBufferStateMachine = compile('src/player/mse-buffer-state-machine.ts', {
    '../core/playback-operation': playbackOperationModule,
    '../core/mmts-startup-group-lifecycle': startupGroupLifecycleModule,
    './mmts-track-switch-window': trackSwitchWindowModule,
}).default;

const MiB = 1024 * 1024;

const playbackScopeId = 'mse-buffer-state-machine-test';
const defaultPlaybackOperation = Object.freeze(
    playbackOperationModule.createPlaybackOperation({
        scopeId: playbackScopeId,
        timelineGeneration: 0,
        kind: 'startup',
        transactionId: 0,
        phase: 'loading',
        requestedTimeMilliseconds: 0,
    })
);

function attachPlaybackOperation(value, operation = defaultPlaybackOperation) {
    value.playbackOperation = Object.assign({}, operation);
    value.mseBufferGeneration = operation.timelineGeneration;
    return value;
}

function attachStartupGroupOperation(group, operation = defaultPlaybackOperation) {
    attachPlaybackOperation(group, operation);
    attachPlaybackOperation(group.videoInitSegment, operation);
    attachPlaybackOperation(group.videoMediaSegment, operation);
    if (group.hasAudio) {
        if (group.audioInitSegment) attachPlaybackOperation(group.audioInitSegment, operation);
        if (group.audioMediaSegment) attachPlaybackOperation(group.audioMediaSegment, operation);
    }
    return group;
}

function makeStartupGroup(operation = defaultPlaybackOperation, hasAudio = true) {
    const group = {
        videoInitSegment: makeInit('video'),
        videoMediaSegment: makeSegment('video', 10, 12, 1024),
        startupTime: 10,
        videoDecodeStart: 10,
        videoCompositionStart: 10,
        syncPoint: 10,
        playableStart: 10,
        playableEnd: 12,
        hasAudio,
        hasVideo: true,
    };
    if (hasAudio) {
        group.audioInitSegment = makeInit('audio');
        group.audioMediaSegment = makeSegment('audio', 9.9, 12.1, 1024);
        group.audioStart = 9.9;
        group.audioEnd = 12.1;
    }
    return attachStartupGroupOperation(group, operation);
}

function makePlaybackOperation(
    kind,
    transactionId,
    packetId,
    attempt = 0,
    phase = 'requested',
    requestedTimeMilliseconds = 0
) {
    let operation = playbackOperationModule.createPlaybackOperation({
        scopeId: playbackScopeId,
        timelineGeneration: transactionId,
        kind,
        transactionId,
        phase: attempt === 0 ? phase : 'requested',
        requestedTimeMilliseconds,
        packetId,
    });
    for (let index = 0; index < attempt; index++) {
        operation = playbackOperationModule.createNextPlaybackAttempt(operation, {
            phase: index === attempt - 1 ? phase : 'retrying',
            requestedTimeMilliseconds,
        });
    }
    return operation;
}

function makeSegment(type, begin, end, bytes, sourceInfo) {
    const segment = attachPlaybackOperation({
        type,
        data: {byteLength: bytes || 1024},
        info: {
            beginDts: begin * 1000,
            beginPts: begin * 1000,
            endDts: end * 1000,
            endPts: end * 1000,
            firstSample: {dts: begin * 1000, pts: begin * 1000, isSyncPoint: true},
            lastSample: {dts: begin * 1000, pts: begin * 1000, duration: (end - begin) * 1000}
        }
    });
    if (sourceInfo) {
        segment.mmtsSourceInfo = sourceInfo;
    }
    return segment;
}

function makeMMTSSource(first, last) {
    const firstSample = Object.assign({
        packetId: 0x100,
        mpuSequenceNumber: 1,
        sampleNumber: 1,
        filePosition: 1000,
        rawDts: 0,
        rawPts: 0,
        dts: 0,
        pts: 0,
    }, first);
    const lastSample = Object.assign({}, firstSample, last || firstSample);
    return Object.assign({}, firstSample, {firstSample, lastSample});
}

function makeInit(type, codec) {
    return attachPlaybackOperation({
        type,
        container: type === 'video' ? 'video/mp4' : 'audio/mp4',
        codec: codec || (type === 'video' ? 'avc1.640028' : 'mp4a.40.2'),
        data: {byteLength: 256}
    });
}

function makeAudioTrackSwitch(start, end) {
    const operation = makePlaybackOperation(
        'audio-switch', 1, 0xf111, 0, 'requested', start * 1000
    );
    return Object.assign(playbackOperationModule.createPlaybackSwitchIdentity(operation), {
        packetId: 0xf111,
        requestedStart: start,
        requestedStartMicroseconds: Math.round(start * 1000000),
        audioDecodeStart: start,
        audioStart: start,
        audioEnd: end,
    });
}

function makeVideoTrackSwitch(start, end, id = 2, attempt = 0, packetId = 0xf201) {
    const operation = makePlaybackOperation('video-switch', id, packetId, attempt);
    return Object.assign(playbackOperationModule.createPlaybackSwitchIdentity(operation), {
        packetId,
        videoDecodeStart: start,
        videoCompositionStart: start,
        syncPoint: start,
        playableStart: start,
        playableEnd: end,
    });
}

function makeVideoTrackSwitchIdentity(videoSwitch) {
    return {
        scopeId: videoSwitch.scopeId,
        transactionKey: videoSwitch.transactionKey,
        attemptKey: videoSwitch.attemptKey,
        kind: videoSwitch.kind,
        id: videoSwitch.id,
        transactionId: videoSwitch.transactionId,
        attempt: videoSwitch.attempt,
        packetId: videoSwitch.packetId,
    };
}

function markRandomAccessSafeVideoSegment(segment, window) {
    segment.mmtsRandomAccessSafe = true;
    segment.firstPlayableWindow = {
        decodeStart: window.videoDecodeStart,
        compositionStart: window.videoCompositionStart,
        syncPoint: window.syncPoint,
        playableStart: window.playableStart,
        playableEnd: window.playableEnd,
    };
    return segment;
}

function makeHarness(overrides) {
    const log = [];
    const appendedSegments = [];
    const appendedInitSegments = [];
    const rebuildPlans = [];
    const sourceBuffers = {
        video: {exists: false, updating: false},
        audio: {exists: false, updating: false},
    };
    const ranges = {
        video: [],
        audio: [],
    };
    let forwardInfo = {
        currentTime: 0,
        forwardBytes: 0,
        videoForwardBytes: 0,
        audioForwardBytes: 0,
        videoForwardDuration: 0,
        audioForwardDuration: 0,
    };
    let quotaOnce = null;
    let initQuotaOnce = null;
    let rebuildSucceeds = true;
    let mediaSourceReadyState = 'open';

    const output = {
        appendInit(type, segment) {
            log.push(['appendInit', type]);
            appendedInitSegments.push(segment);
            if (initQuotaOnce === type) {
                initQuotaOnce = null;
                return {ok: false, quota: true};
            }
            sourceBuffers[type].exists = true;
            sourceBuffers[type].updating = true;
            return {ok: true};
        },
        appendMedia(type, segment) {
            log.push(['appendMedia', type, segment.info.beginDts / 1000]);
            appendedSegments.push(segment);
            if (quotaOnce === type) {
                quotaOnce = null;
                return {ok: false, quota: true};
            }
            sourceBuffers[type].updating = true;
            return {ok: true};
        },
        removeRange(type, start, end) {
            log.push(['removeRange', type, start, end]);
            sourceBuffers[type].updating = true;
            return {ok: true};
        },
        resetParserState(type, mimeType) {
            log.push(['resetParserState', type, mimeType]);
            return {ok: true};
        },
        rebuildMediaSource(plan) {
            log.push(['rebuildMediaSource', plan]);
            rebuildPlans.push(plan);
            if (!rebuildSucceeds) {
                return false;
            }
            sourceBuffers.video.exists = false;
            sourceBuffers.video.updating = false;
            sourceBuffers.audio.exists = false;
            sourceBuffers.audio.updating = false;
            ranges.video.splice(0, ranges.video.length);
            ranges.audio.splice(0, ranges.audio.length);
            return true;
        },
        pauseTransmuxer(reason) {
            log.push(['pauseTransmuxer', reason]);
        },
        resumeTransmuxer(reason) {
            log.push(['resumeTransmuxer', reason]);
        },
        flushPending(type) {
            log.push(['flushPending', type || 'all']);
        },
        emitFatal(error) {
            log.push(['fatal', error && error.msg, error]);
        },
        onStartupGroupAppended(startupGroup) {
            log.push(['startupGroupAppended', startupGroup]);
        },
        onPlaybackOperationComplete(operation, result) {
            log.push(['playbackOperationComplete', operation, result]);
        },
        onAudioTrackSwitchRebuildComplete(operation) {
            log.push(['audioTrackSwitchRebuildComplete', operation]);
        },
        onVideoTrackSwitchComplete(operation) {
            log.push(['videoTrackSwitchComplete', operation]);
        },
        seekMedia(targetTime, reason) {
            log.push(['seekMedia', targetTime, reason]);
        },
        seekTransmuxer(milliseconds, reason) {
            log.push(['seekTransmuxer', milliseconds, reason]);
        },
        endOfStream() {
            log.push(['endOfStream']);
            return {ok: true};
        },
        getMediaSourceState() {
            return {
                readyState: mediaSourceReadyState,
                streaming: true,
                hasFatalMediaError: false,
                sourceBuffers,
            };
        },
        getForwardBufferInfo(currentTime) {
            return Object.assign({}, forwardInfo, {currentTime});
        },
        getBufferedRanges(type) {
            return ranges[type].slice();
        },
    };
    if (overrides && overrides.output) {
        Object.assign(output, overrides.output);
    }
    if (overrides && overrides.prepareSourceBuffers) {
        output.ensureSourceBuffer = (type) => {
            log.push(['ensureSourceBuffer', type]);
            sourceBuffers[type].exists = true;
            return {ok: true, empty: true};
        };
    }

    const config = Object.assign({
        isLive: false,
        mseAppendTrackLeadLimit: 2,
        mseBufferVideoSoftLimitBytes: 120 * MiB,
        mseBufferVideoHardLimitBytes: 145 * MiB,
        mseBufferAudioHardLimitBytes: 18 * MiB,
        lazyLoadRecoverBytes: 64 * MiB,
    }, overrides && overrides.config);

    const sm = new MSEBufferStateMachine(config, output);
    if (config.isMMTS === true) {
        assert.strictEqual(sm.setPlaybackOperation(defaultPlaybackOperation), true);
    }
    sm.onSourceOpen();

    return {
        sm,
        log,
        appendedSegments,
        appendedInitSegments,
        rebuildPlans,
        sourceBuffers,
        ranges,
        setForwardInfo(info) {
            forwardInfo = Object.assign({}, forwardInfo, info);
        },
        quotaNext(type) {
            quotaOnce = type;
        },
        quotaNextInit(type) {
            initQuotaOnce = type;
        },
        failRebuild() {
            rebuildSucceeds = false;
        },
        setMediaSourceReadyState(readyState) {
            mediaSourceReadyState = readyState;
        },
        updateEnd(type) {
            sourceBuffers[type].updating = false;
            sm.onUpdateEnd(type);
        },
    };
}

function testQueuedMediaSegmentsAreBatchedForMSEAppend() {
    const h = makeHarness({config: {mseAppendBatchDuration: 0.5}});
    h.sourceBuffers.video.exists = true;
    const initial = makeSegment('video', 0, 0.1, 16);
    initial.data = new Uint8Array(16).buffer;
    h.sm.onMediaSegment('video', initial);

    for (let i = 0; i < 3; i++) {
        const segment = makeSegment('video', 0.1 + i * 0.1, 0.2 + i * 0.1, 32);
        segment.data = new Uint8Array(32).fill(i + 1).buffer;
        segment.sampleCount = 2;
        h.sm.onMediaSegment('video', segment);
    }

    h.updateEnd('video');
    assert.strictEqual(h.appendedSegments.length, 2);
    const batch = h.appendedSegments[1];
    assert.strictEqual(batch.data.byteLength, 96);
    assert.strictEqual(batch.sampleCount, 6);
    assert.strictEqual(batch.info.beginDts, 100);
    assert.strictEqual(batch.info.endDts, 400);
    const bytes = new Uint8Array(batch.data);
    assert.strictEqual(bytes[0], 1);
    assert.strictEqual(bytes[32], 2);
    assert.strictEqual(bytes[64], 3);
}

function testAppendPriorityAndAsyncGate() {
    const h = makeHarness();
    h.sm.onInitSegment('video', makeInit('video'));
    assert.deepStrictEqual(h.log[0], ['appendInit', 'video']);
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendMedia').length, 0);
    h.updateEnd('video');
    assert.deepStrictEqual(h.log[h.log.length - 1], ['appendMedia', 'video', 0]);
}

function testInitialSourceBuffersArePreparedBeforeAppendingInit() {
    const h = makeHarness({prepareSourceBuffers: true});
    h.sm.onInitSegment('video', makeInit('video'));
    assert.deepStrictEqual(h.log, [['ensureSourceBuffer', 'video']]);

    h.sm.onInitSegment('audio', makeInit('audio'));
    assert.deepStrictEqual(h.log, [
        ['ensureSourceBuffer', 'video'],
        ['ensureSourceBuffer', 'audio'],
    ]);

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    assert.deepStrictEqual(h.log[2], ['appendInit', 'video']);
    assert.strictEqual(h.sourceBuffers.video.updating, true);
    assert.strictEqual(h.sourceBuffers.audio.exists, true);
}

function testUntypedUpdateEndInfersCompletedTrackDuringParallelAppends() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({videoForwardDuration: 1});
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    h.sm.onMediaSegment('audio', makeSegment('audio', 0, 1, 1024));
    assert.strictEqual(h.sourceBuffers.video.updating, true);
    assert.strictEqual(h.sourceBuffers.audio.updating, true);

    h.sourceBuffers.audio.updating = false;
    h.sm.onUpdateEnd();
    assert.strictEqual(h.sm._inflight_operations.audio, null);
    assert.strictEqual(h.sm._inflight_operations.video.kind, 'media');
    assert.strictEqual(h.sm._track_state.audio, 'READY');
    assert.strictEqual(h.sm._track_state.video, 'APPENDING');

    h.sourceBuffers.video.updating = false;
    h.sm.onUpdateEnd();
    assert.strictEqual(h.sm._inflight_operations.video, null);
    assert.strictEqual(h.sm._track_state.video, 'READY');
}

function testSameTrackInflightIdentityCannotBeOverwritten() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.setForwardInfo({videoForwardDuration: 1});
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    const firstInflight = h.sm._inflight_operations.video.segment;

    h.sourceBuffers.video.updating = false;
    h.sm.onMediaSegment('video', makeSegment('video', 1, 2, 1024));
    assert.strictEqual(
        h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length,
        1
    );
    assert.strictEqual(h.sm._inflight_operations.video.segment, firstInflight);
    assert.strictEqual(h.sm._pending_media_segments.video.length, 1);

    h.updateEnd('video');
    assert.strictEqual(
        h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length,
        2
    );
}

function testRemoveBeforeAppendUnderBudgetPressure() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 0, end: 30});
    h.setForwardInfo({
        videoForwardBytes: 144 * MiB,
        forwardBytes: 144 * MiB,
        videoForwardDuration: 20,
    });
    h.sm.onMediaState(20, 4, 'timeupdate');
    h.sm.onMediaSegment('video', makeSegment('video', 30, 31, 2 * MiB));
    const firstOperation = h.log.find((entry) => entry[0] === 'removeRange' || entry[0] === 'appendMedia');
    assert.strictEqual(firstOperation[0], 'removeRange');
    assert.strictEqual(firstOperation[1], 'video');
    assert.strictEqual(firstOperation[2], 0);
    assert.strictEqual(firstOperation[3], 8);
}

function testPressureDoesNotDeleteFutureRanges() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20}, {start: 40, end: 70});
    h.ranges.audio.push({start: 0, end: 20}, {start: 40, end: 70});
    h.setForwardInfo({
        videoForwardBytes: 144 * MiB,
        forwardBytes: 146 * MiB,
        videoForwardDuration: 65,
        audioForwardDuration: 65,
        audioForwardBytes: 2 * MiB,
    });
    h.sm.onMediaState(0, 4, 'timeupdate');
    h.sm.onMediaSegment('video', makeSegment('video', 70, 71, 2 * MiB));
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'removeRange'),
        false
    );
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testPressureCleanupOnlyRemovesPlayedData() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 120});
    h.ranges.audio.push({start: 0, end: 120});
    h.setForwardInfo({
        videoForwardBytes: 144 * MiB,
        forwardBytes: 146 * MiB,
        videoForwardDuration: 110,
        audioForwardDuration: 110,
        audioForwardBytes: 2 * MiB,
    });
    h.sm.onMediaState(10, 4, 'timeupdate');
    h.sm.onMediaSegment('video', makeSegment('video', 120, 121, 2 * MiB));
    h.updateEnd('video');
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'removeRange' && entry[1] === 'video' && entry[2] === 0 && entry[3] === 8
        ),
        true
    );
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'removeRange' && entry[3] > 10),
        false
    );
}

function testVideoCleanupRetainsDecoderRoot() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 380, end: 450});
    h.sm._current_time = 403;
    h.sm._video_random_access_points.push({dts: 390000, pts: 390000});

    h.sm._scheduleBackwardCleanup('video', 2);
    assert.strictEqual(h.sm._pending_remove_ranges.video.length, 1);
    assert.strictEqual(h.sm._pending_remove_ranges.video[0].start, 380);
    assert.strictEqual(h.sm._pending_remove_ranges.video[0].end, 390);
}

function testVodAudioTrackSwitchPreparationCanBeCancelledWithoutLeavingPause() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    const operation = makePlaybackOperation(
        'audio-switch', 1, 0xf111, 0, 'requested', 20000
    );
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.video.updating = true;
    assert.strictEqual(h.sm.onMMTSVodAudioTrackRebuild(20, operation, 1), true);
    assert.strictEqual(h.sm._transmuxer_paused, true);
    assert.strictEqual(h.sm._pending_transmuxer_seek_milliseconds, 20000);
    assert.strictEqual(h.sm._pending_transmuxer_seek_reason, 'MMTS_VOD_AUDIO_TRACK_REBUILD');
    h.sm.cancelMMTSVodAudioTrackRebuild();

    assert.strictEqual(h.sm._pending_transmuxer_seek_milliseconds, null);
    assert.strictEqual(h.sm._pending_transmuxer_seek_reason, null);
    assert.strictEqual(h.sm._pending_media_seek_target, null);
    assert.strictEqual(h.sm._main_state, 'STEADY');
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'resumeTransmuxer' &&
        entry[1] === 'MMTS_VOD_AUDIO_TRACK_REBUILD_CANCELLED'
    ), true);
}

function testVodAudioTrackRebuildStartsTransmuxerSeekFromEndedMediaSource() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    const operation = makePlaybackOperation(
        'audio-switch', 1, 0xf111, 0, 'requested', 5111.916
    );
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setMediaSourceReadyState('ended');

    assert.strictEqual(h.sm.onMMTSVodAudioTrackRebuild(5.111916, operation, 1), true);
    assert.strictEqual(h.sm._pending_transmuxer_seek_milliseconds, null);
    assert.strictEqual(h.sm._pending_transmuxer_seek_reason, null);
    assert.strictEqual(h.log.filter((entry) =>
        entry[0] === 'seekTransmuxer' &&
        entry[1] === 5111.916 &&
        entry[2] === 'MMTS_VOD_AUDIO_TRACK_REBUILD'
    ).length, 1);
}

function testVodAudioTrackSwitchCollectsThroughExistingBackpressure() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 30});
    h.ranges.audio.push({start: 0, end: 30});
    h.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 22,
        audioForwardBytes: 2 * MiB,
        audioForwardDuration: 22,
    });

    h.sm.onMediaState(8, 4, 'timeupdate');
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');

    const operation = makePlaybackOperation(
        'audio-switch', 1, 0xf111, 0, 'requested', 8000
    );
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onMMTSVodAudioTrackRebuild(8, operation, 1), true);
    assert.strictEqual(h.sm._mmts_vod_audio_track_rebuild_active, true);
    assert.strictEqual(h.sm._transmuxer_paused, false);

    const pauseCount = h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length;
    h.sm.onMediaState(8.1, 4, 'timeupdate');
    h.sm.onMediaState(8.2, 4, 'timeupdate');
    assert.strictEqual(h.sm._main_state, 'STEADY');
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount);

    h.sm.cancelMMTSVodAudioTrackRebuild();
    assert.strictEqual(h.sm._mmts_vod_audio_track_rebuild_active, false);
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount + 1);
}

function testHardBudgetCountsBackwardBytesAndOverridesLongEmergencyRetention() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            isLive: true,
            mseBufferVideoSoftLimitBytes: 64 * MiB,
            mseBufferVideoHardLimitBytes: 96 * MiB,
            autoCleanupMinBackwardDuration: 45,
        }
    });
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.setForwardInfo({
        videoForwardBytes: 40 * MiB,
        videoBufferedBytes: 95 * MiB,
        forwardBytes: 40 * MiB,
        videoForwardDuration: 10,
    });
    h.sm.onMediaState(10, 4, 'timeupdate');
    h.sm.onMediaSegment('video', makeSegment('video', 20, 21, 2 * MiB));

    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'removeRange' && entry[1] === 'video' && entry[2] === 0 && entry[3] === 6
        ),
        true
    );
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
}

function testAudioLeadBlocksUntilVideoCatchesUp() {
    const h = makeHarness();
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.exists = true;
    h.setForwardInfo({
        videoForwardDuration: 5,
        audioForwardDuration: 0,
        videoForwardBytes: 1024,
        audioForwardBytes: 0,
    });
    h.sm.onMediaState(0, 4, 'timeupdate');
    h.sm.onMediaSegment('audio', makeSegment('audio', 6, 8.5, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'), false);
    h.setForwardInfo({videoForwardDuration: 8, videoForwardBytes: 2048});
    h.sm.onMediaState(0, 4, 'progress');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'), true);
}

function testVideoLeadYieldsToPendingAudio() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.exists = true;
    h.setForwardInfo({
        videoForwardDuration: 5,
        audioForwardDuration: 2,
        videoForwardBytes: 4096,
        audioForwardBytes: 1024,
    });

    h.sm.onMediaSegment('video', makeSegment('video', 6, 8, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'video'), false);

    h.sm.onMediaSegment('audio', makeSegment('audio', 2, 4, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'), true);
}

function testAudioOnlyMediaDoesNotWaitForVideo() {
    const h = makeHarness();
    h.sm.onMediaInfo({hasAudio: true, hasVideo: false});
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        audioForwardDuration: 5,
        audioForwardBytes: 1024,
        videoForwardDuration: 0,
        videoForwardBytes: 0,
    });
    h.sm.onMediaState(0, 4, 'timeupdate');
    h.sm.onMediaSegment('audio', makeSegment('audio', 3, 4, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'), true);
}

function testAudioOnlyUserSeekFlushesBufferedRange() {
    const h = makeHarness();
    h.sm.onMediaInfo({hasAudio: true, hasVideo: false});
    h.sourceBuffers.audio.exists = true;
    h.ranges.audio.push({start: 10, end: 15});

    h.sm.onUserSeek(12);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange' && entry[1] === 'audio'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer'), false);
    h.updateEnd('audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer' && entry[1] === 12000), true);
}

function testQuotaWaitsForCleanupOrProgress() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.quotaNext('video');
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    const appendCountAfterQuota = h.log.filter((entry) => entry[0] === 'appendMedia').length;
    assert.strictEqual(appendCountAfterQuota, 1);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'QUOTA'), true);

    h.ranges.video.push({start: 0, end: 20});
    h.sm.onMediaState(12, 4, 'timeupdate');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange' && entry[1] === 'video'), true);
    h.updateEnd('video');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'QUOTA_RECOVERED'),
        true
    );
    h.updateEnd('video');
    h.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 20,
    });
    h.sm.onMediaState(12, 4, 'progress');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testAudioQuotaCanEvictPlayedVideoData() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.setForwardInfo({
        videoForwardBytes: 1024,
        videoForwardDuration: 5,
        audioForwardBytes: 1024,
        audioForwardDuration: 5,
    });
    h.sm.onMediaState(10, 4, 'timeupdate');
    h.quotaNext('audio');
    h.sm.onMediaSegment('audio', makeSegment('audio', 10, 11, 1024));

    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'removeRange' && entry[1] === 'video' && entry[2] === 0 && entry[3] === 8
        ),
        true
    );
}

function testInitQuotaDoesNotRequeueAsMedia() {
    const h = makeHarness();
    h.quotaNextInit('video');
    h.sm.onInitSegment('video', makeInit('video'));
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendInit').length, 1);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
    h.sm.tick('retry');
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendInit').length, 2);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
}

function testMissingAudioSourceBufferWaitsForVideoInitUpdateEnd() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.video.updating = true;

    h.sm.onInitSegment('audio', makeInit('audio'));
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'audio'),
        false
    );

    h.updateEnd('video');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'audio'),
        true
    );
}

function testSeekFlushesBeforeNewTimelineAppend() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.sm.onMediaSegment('video', makeSegment('video', 18, 19, 1024));
    h.updateEnd('video');
    h.sm.onSeek(30);
    h.sm.onMediaSegment('video', makeSegment('video', 30, 31, 1024));
    const operations = h.log.filter((entry) => entry[0] === 'removeRange' || entry[0] === 'appendMedia');
    const lastRemove = operations.map((entry) => entry[0]).lastIndexOf('removeRange');
    const lastAppend = operations.map((entry) => entry[0]).lastIndexOf('appendMedia');
    assert(lastRemove >= 0);
    assert(lastAppend < lastRemove);
    h.updateEnd('video');
    const operationsAfterRemove = h.log.filter((entry) => entry[0] === 'removeRange' || entry[0] === 'appendMedia');
    const finalRemove = operationsAfterRemove.map((entry) => entry[0]).lastIndexOf('removeRange');
    const finalAppend = operationsAfterRemove.map((entry) => entry[0]).lastIndexOf('appendMedia');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer' && entry[1] === 30000), true);
    assert(finalAppend < finalRemove);
    h.sm.tick('after_seek_transmuxer');
    const operationsAfterSeek = h.log.filter((entry) => entry[0] === 'removeRange' || entry[0] === 'appendMedia');
    const appendAfterSeek = operationsAfterSeek.map((entry) => entry[0]).lastIndexOf('appendMedia');
    const removeBeforeSeek = operationsAfterSeek.map((entry) => entry[0]).lastIndexOf('removeRange');
    assert(appendAfterSeek > removeBeforeSeek);
}

function testConfiguredSeekRebuildsMediaSourceInsteadOfFlushingOldRanges() {
    const h = makeHarness({
        config: {isMMTS: true, mseRebuildMediaSourceOnSeek: true},
    });
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 600, end: 690});
    h.ranges.audio.push({start: 600, end: 690});

    h.sm.onUserSeek(100);

    const rebuild = h.log.find((entry) => entry[0] === 'rebuildMediaSource');
    assert(rebuild);
    assert.strictEqual(rebuild[1].kind, 'seek');
    assert.strictEqual(rebuild[1].targetTime, 100);
    assert.strictEqual(rebuild[1].resumePlayback, true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.sm._pending_full_track_flush.video, false);
    assert.strictEqual(h.sm._pending_full_track_flush.audio, false);
    assert.strictEqual(h.sm._track_state.video, 'NO_SOURCEBUFFER');
    assert.strictEqual(h.sm._track_state.audio, 'NO_SOURCEBUFFER');
}

function testSeekDropsOldTimelineSegmentsBeforeTargetWindow() {
    const h = makeHarness({config: {isMMTS: true, mseSeekPrerollKeepDuration: 4}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;

    h.sm.onSeek(30);
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    h.sm.onMediaSegment('audio', makeSegment('audio', 0, 1, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);

    h.sm.onMediaSegment('video', makeSegment('video', 27, 31, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'video'), true);
}

function testRecommendedSeekPointKeepsEarlierPrerollSegments() {
    const h = makeHarness({config: {isMMTS: true, mseSeekPrerollKeepDuration: 4}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;

    h.sm.onUserSeek(34);
    h.sm.onRecommendedSeekPoint(28);
    h.sm.onMediaSegment('video', makeSegment('video', 23.9, 24.1, 1024));
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'video' && entry[2] === 23.9),
        true
    );
}

function testInvalidTimestampFailsExplicitly() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.sm.onMediaSegment('video', {
        type: 'video',
        data: {byteLength: 1024},
    });
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal' && /Invalid video/.test(entry[1])), true);
}

function testEndOfStreamWaitsForQueuesAndUpdateEnd() {
    const h = makeHarness();
    h.sourceBuffers.video.exists = true;
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    h.sm.onEndOfStream();
    assert.strictEqual(h.log.some((entry) => entry[0] === 'endOfStream'), false);
    h.updateEnd('video');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'endOfStream'), true);
}

function testAudioTrackSwitchRequestDropsQueuedOldInit() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.audio.updating = true;
    const staleInit = Object.assign(makeInit('audio'), {epoch: 'stale'});
    const operation = makePlaybackOperation('audio-switch', 1, 0xf111);

    h.sm.onInitSegment('audio', staleInit);
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onAudioTrackSwitch({stage: 'request', operation, transactionId: 1});
    h.updateEnd('audio');

    assert.strictEqual(h.appendedInitSegments.length, 0);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit'), false);
}

function testLiveAudioTrackSwitchCollectsThroughExistingBackpressure() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 30,
        audioForwardBytes: 2 * MiB,
        audioForwardDuration: 30,
    });

    h.sm.onMediaState(8, 4, 'timeupdate');
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');

    const operation = makePlaybackOperation('audio-switch', 1, 0xf111);
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onAudioTrackSwitch({stage: 'request', mode: 'live', operation, transactionId: 1});
    assert.strictEqual(h.sm._main_state, 'TRACK_SWITCHING');
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, true);
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'resumeTransmuxer' && entry[1] === 'TRACK_SWITCHING_DATA_REQUEST'
        ),
        true
    );

    const pauseCount = h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length;
    h.sm.onMediaState(8.1, 4, 'timeupdate');
    h.sm.onMediaState(8.2, 2, 'waiting');
    assert.strictEqual(h.sm._main_state, 'TRACK_SWITCHING');
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount);

    h.sm.cancelMMTSVodAudioTrackRebuild();
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, false);
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount + 1);
}

function makeAudioTrackSwitchRebuildRequest(start = 12, end = 13, transactionId = 7) {
    const operation = makePlaybackOperation('audio-switch', transactionId, 0xf111);
    const videoSegment = makeSegment('video', start, end, 4096);
    videoSegment.mmtsRandomAccessSafe = true;
    videoSegment.firstPlayableWindow = {
        decodeStart: start,
        compositionStart: start,
        syncPoint: start,
        playableStart: start,
        playableEnd: end,
    };
    return {
        stage: 'rebuild_ready',
        operation,
        replaceMediaSource: true,
        switchTime: start,
        seekTime: start + 0.05,
        resumePlayback: true,
        videoInitSegment: attachPlaybackOperation(makeInit('video'), operation),
        audioInitSegment: attachPlaybackOperation(makeInit('audio', 'mp4a.40.5'), operation),
        videoSegments: [attachPlaybackOperation(videoSegment, operation)],
        audioSegments: [attachPlaybackOperation(makeSegment('audio', start, end, 1024), operation)],
        transactionId,
    };
}

function submitAudioTrackSwitchRebuild(h, request, mode = 'live') {
    assert.strictEqual(h.sm.setPlaybackOperation(request.operation), true);
    assert.strictEqual(h.sm.onAudioTrackSwitch({
        stage: 'request',
        mode,
        operation: request.operation,
        transactionId: request.transactionId,
    }), true);
    return h.sm.onAudioTrackSwitch(request);
}

function testAudioTrackSwitchCancelIsExactAndAllowsImmediateSuccessor() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.audio.updating = true;
    const operation = makePlaybackOperation('audio-switch', 1, 0xf111);
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onAudioTrackSwitch({
        stage: 'request',
        mode: 'live',
        operation,
        transactionId: 1,
    }), true);
    h.sm.onEndOfStream(operation);
    assert.strictEqual(h.sm._pending_eos, true);

    const otherOperation = makePlaybackOperation('seek', 90);
    const otherInit = attachPlaybackOperation(makeInit('audio'), otherOperation);
    const otherMedia = attachPlaybackOperation(
        makeSegment('video', 20, 21, 1024),
        otherOperation
    );
    const sameTransactionInit = attachPlaybackOperation(
        makeInit('video'),
        Object.assign({}, operation, {phase: 'collecting'})
    );
    h.sm._pending_init_segments.audio.push(otherInit);
    h.sm._pending_init_segments.video.push(sameTransactionInit);
    h.sm._pending_media_segments.video.push(otherMedia);
    const stateBefore = {
        context: h.sm._track_switch_transaction,
        mainState: h.sm._main_state,
        needsData: h.sm._track_switch_needs_data,
        hold: h.sm._live_audio_track_switch_collection_hold,
        paused: h.sm._transmuxer_paused,
        pauseReason: h.sm._transmuxer_pause_reason,
        pendingEos: h.sm._pending_eos,
        logLength: h.log.length,
    };
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(
        makePlaybackOperation('audio-switch', 2, 0xf110)
    ), false);
    assert.strictEqual(h.sm._track_switch_transaction, stateBefore.context);
    assert.strictEqual(h.sm._main_state, stateBefore.mainState);
    assert.strictEqual(h.sm._track_switch_needs_data, stateBefore.needsData);
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, stateBefore.hold);
    assert.strictEqual(h.sm._transmuxer_paused, stateBefore.paused);
    assert.strictEqual(h.sm._transmuxer_pause_reason, stateBefore.pauseReason);
    assert.strictEqual(h.sm._pending_eos, stateBefore.pendingEos);
    assert.strictEqual(h.log.length, stateBefore.logLength);
    assert.strictEqual(h.sm._pending_init_segments.audio.includes(otherInit), true);
    assert.strictEqual(h.sm._pending_init_segments.video.includes(sameTransactionInit), true);
    assert.strictEqual(h.sm._pending_media_segments.video.includes(otherMedia), true);

    const resumeCount = h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length;
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(operation), true);
    assert.strictEqual(h.sm._track_switch_transaction, null);
    assert.strictEqual(h.sm._track_switch_needs_data, false);
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, false);
    assert.strictEqual(h.sm._pending_eos, false);
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length, resumeCount + 1);
    assert.strictEqual(h.sm._pending_init_segments.audio.includes(otherInit), true);
    assert.strictEqual(h.sm._pending_init_segments.video.includes(sameTransactionInit), false);
    assert.strictEqual(h.sm._pending_media_segments.video.includes(otherMedia), true);
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(operation), false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length, resumeCount + 1);

    const successor = makePlaybackOperation('audio-switch', 2, 0xf110);
    assert.strictEqual(h.sm.setPlaybackOperation(successor), true);
    assert.strictEqual(h.sm.onAudioTrackSwitch({
        stage: 'request',
        mode: 'live',
        operation: successor,
        transactionId: 2,
    }), true);
    assert.strictEqual(h.sm._track_switch_transaction.transactionId, 2);
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(successor), true);
}

function testAudioTrackSwitchCancelRejectsStaleAttemptWithinTransaction() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    const attempt0 = makePlaybackOperation(
        'audio-switch', 11, 0xf111, 0, 'selecting', 12000
    );
    assert.strictEqual(h.sm.setPlaybackOperation(attempt0), true);
    assert.strictEqual(h.sm.onAudioTrackSwitch({
        stage: 'request',
        mode: 'live',
        operation: attempt0,
        transactionId: 11,
    }), true);

    const attempt1 = playbackOperationModule.createNextPlaybackAttempt(attempt0, {
        phase: 'collecting',
    });
    assert.strictEqual(h.sm.setPlaybackOperation(attempt1), true);
    assert.strictEqual(h.sm._track_switch_transaction.operation.attempt, 1);
    assert.strictEqual(h.sm._track_switch_transaction.operation.phase, 'collecting');

    const stateBefore = {
        context: h.sm._track_switch_transaction,
        mainState: h.sm._main_state,
        needsData: h.sm._track_switch_needs_data,
        hold: h.sm._live_audio_track_switch_collection_hold,
        paused: h.sm._transmuxer_paused,
        pauseReason: h.sm._transmuxer_pause_reason,
        pendingEos: h.sm._pending_eos,
        logLength: h.log.length,
    };
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(attempt0), false);
    assert.strictEqual(h.sm._track_switch_transaction, stateBefore.context);
    assert.strictEqual(h.sm._main_state, stateBefore.mainState);
    assert.strictEqual(h.sm._track_switch_needs_data, stateBefore.needsData);
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, stateBefore.hold);
    assert.strictEqual(h.sm._transmuxer_paused, stateBefore.paused);
    assert.strictEqual(h.sm._transmuxer_pause_reason, stateBefore.pauseReason);
    assert.strictEqual(h.sm._pending_eos, stateBefore.pendingEos);
    assert.strictEqual(h.log.length, stateBefore.logLength);

    assert.strictEqual(h.sm.cancelAudioTrackSwitch(attempt1), true);
    assert.strictEqual(h.sm._track_switch_transaction, null);
}

function testAudioTrackSwitchCancelDropsPendingPlanAndFencesLateRebuild() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.audio.updating = true;
    const request = makeAudioTrackSwitchRebuildRequest(12, 13, 21);
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    assert.strictEqual(h.sm._pending_audio_rebuild_plan.transactionId, 21);
    assert.strictEqual(h.rebuildPlans.length, 0);

    const resumeCount = h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length;
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(request.operation), true);
    assert.strictEqual(h.sm._pending_audio_rebuild_plan, null);
    assert.strictEqual(h.sm._pending_audio_rebuild_operation, null);
    assert.strictEqual(h.sm._track_switch_transaction, null);
    assert.strictEqual(h.sm._track_switch_needs_data, false);
    assert.strictEqual(h.sm._live_audio_track_switch_collection_hold, false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length, resumeCount + 1);

    h.updateEnd('video');
    h.updateEnd('audio');
    h.sm.onSourceOpen();
    assert.strictEqual(h.rebuildPlans.length, 0);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia' &&
        entry[2] === 'AUDIO_TRACK_SWITCH_REBUILD'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'audioTrackSwitchRebuildComplete'), false);
}

function testAudioTrackSwitchCancelDuringRebuildDropsQueuedDataAndLateCallbacks() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    const request = makeAudioTrackSwitchRebuildRequest(12, 13, 31);
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    assert.strictEqual(h.rebuildPlans.length, 1);
    assert.strictEqual(h.sm._track_switch_transaction.stage, 'rebuilding');
    assert.strictEqual(h.sm._pending_audio_rebuild_operation.transactionId, 31);
    assert.strictEqual(h.sm._pending_init_segments.video.length, 1);
    assert.strictEqual(h.sm._pending_media_segments.audio.length, 1);

    const resumeCount = h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length;
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(request.operation), true);
    assert.strictEqual(h.sm._pending_init_segments.video.length, 0);
    assert.strictEqual(h.sm._pending_init_segments.audio.length, 0);
    assert.strictEqual(h.sm._pending_media_segments.video.length, 0);
    assert.strictEqual(h.sm._pending_media_segments.audio.length, 0);
    assert.strictEqual(h.sm._pending_media_seek_target, null);
    assert.strictEqual(h.sm._pending_media_seek_reason, null);
    assert.strictEqual(h.sm._pending_audio_rebuild_operation, null);
    assert.strictEqual(h.sm._track_switch_transaction, null);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length, resumeCount + 1);

    const appendedInitCount = h.appendedInitSegments.length;
    h.sm.onSourceOpen();
    h.updateEnd('video');
    h.updateEnd('audio');
    assert.strictEqual(h.appendedInitSegments.length, appendedInitCount);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia' &&
        entry[2] === 'AUDIO_TRACK_SWITCH_REBUILD'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'audioTrackSwitchRebuildComplete'), false);

    const successor = makePlaybackOperation('audio-switch', 32, 0xf110);
    assert.strictEqual(h.sm.setPlaybackOperation(successor), true);
    assert.strictEqual(h.sm.onAudioTrackSwitch({
        stage: 'request',
        mode: 'live',
        operation: successor,
        transactionId: 32,
    }), true);
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(successor), true);
}

function testAudioTrackSwitchCancelWhileWaitingForPlayableIntersection() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    const request = makeAudioTrackSwitchRebuildRequest(12, 13, 41);
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    h.sm.onSourceOpen();
    h.updateEnd('video');
    h.updateEnd('audio');
    h.ranges.video.push({start: 12.2, end: 13});
    h.updateEnd('video');
    h.ranges.audio.push({start: 13.1, end: 14});
    h.updateEnd('audio');
    assert.strictEqual(h.sm._pending_media_seek_reason, 'AUDIO_TRACK_SWITCH_REBUILD');
    assert.strictEqual(h.sm._track_switch_transaction.stage, 'rebuilding');

    const resumeCount = h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length;
    const seekCount = h.log.filter((entry) => entry[0] === 'seekMedia').length;
    const completeCount = h.log.filter((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete'
    ).length;
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(request.operation), true);
    assert.strictEqual(h.sm._pending_media_seek_target, null);
    assert.strictEqual(h.sm._pending_media_seek_reason, null);
    assert.strictEqual(h.sm._pending_audio_rebuild_operation, null);
    assert.strictEqual(h.sm._track_switch_transaction, null);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'resumeTransmuxer').length, resumeCount + 1);

    h.ranges.audio.push({start: 12.2, end: 13});
    h.sm.onMediaState(12.2, 4, 'progress');
    h.updateEnd('audio');
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'seekMedia').length, seekCount);
    assert.strictEqual(h.log.filter((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete'
    ).length, completeCount);
}

function testLegacyAudioCancelDoesNotCancelActiveVideoTransaction() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.video.updating = true;
    const operation = makePlaybackOperation('video-switch', 51, 0xf201);
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onVideoTrackSwitch({
        stage: 'request',
        operation,
        transactionId: 51,
    }), true);
    h.sm._mmts_vod_audio_track_rebuild_active = true;
    const pauseReason = h.sm._transmuxer_pause_reason;
    const logLength = h.log.length;
    h.sm.cancelMMTSVodAudioTrackRebuild();
    assert.strictEqual(h.sm._track_switch_transaction.kind, 'video-switch');
    assert.strictEqual(h.sm._track_switch_transaction.transactionId, 51);
    assert.strictEqual(h.sm._mmts_vod_audio_track_rebuild_active, true);
    assert.strictEqual(h.sm._transmuxer_pause_reason, pauseReason);
    assert.strictEqual(h.log.length, logLength);
}

function testVodAudioTrackRebuildWaitsForIdleSeekWithoutRemovingBuffers() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    const operation = makePlaybackOperation(
        'audio-switch', 1, 0xf111, 0, 'requested', 195445
    );
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.updating = true;
    h.ranges.video.push({start: 190, end: 210});
    h.ranges.audio.push({start: 190, end: 210});
    h.sm.onInitSegment('audio', Object.assign(makeInit('audio'), {epoch: 'stale'}));
    h.sm.onEndOfStream();

    assert.strictEqual(h.sm.onMMTSVodAudioTrackRebuild(195.445, operation, 1), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer'), false);

    h.updateEnd('video');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer'), false);
    h.updateEnd('audio');

    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekTransmuxer' &&
            entry[1] === 195445 &&
            entry[2] === 'MMTS_VOD_AUDIO_TRACK_REBUILD'
        ),
        true
    );
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'resumeTransmuxer' &&
            entry[1] === 'MMTS_VOD_AUDIO_TRACK_REBUILD'
        ),
        true
    );
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'endOfStream'), false);
}

function testAudioTrackSwitchRebuildRejectsIncompleteOrMismatchedPlan() {
    const missingVideo = makeHarness({config: {isMMTS: true}});
    const incomplete = makeAudioTrackSwitchRebuildRequest();
    incomplete.videoSegments = [];
    assert.strictEqual(submitAudioTrackSwitchRebuild(missingVideo, incomplete), false);
    assert.strictEqual(missingVideo.log.some((entry) => entry[0] === 'fatal'), true);

    const noSync = makeHarness({config: {isMMTS: true}});
    const unsynchronized = makeAudioTrackSwitchRebuildRequest();
    unsynchronized.videoSegments[0].info.firstSample.isSyncPoint = false;
    assert.strictEqual(submitAudioTrackSwitchRebuild(noSync, unsynchronized), false);
    assert.strictEqual(noSync.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);

    const unsafeVideo = makeHarness({config: {isMMTS: true}});
    const unsafe = makeAudioTrackSwitchRebuildRequest();
    delete unsafe.videoSegments[0].mmtsRandomAccessSafe;
    assert.strictEqual(submitAudioTrackSwitchRebuild(unsafeVideo, unsafe), false);
    assert.strictEqual(unsafeVideo.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);

    const audioGap = makeHarness({config: {isMMTS: true}});
    const mismatched = makeAudioTrackSwitchRebuildRequest();
    mismatched.audioSegments = [attachPlaybackOperation(
        makeSegment('audio', 14, 15, 1024),
        mismatched.operation
    )];
    assert.strictEqual(submitAudioTrackSwitchRebuild(audioGap, mismatched), false);
    assert.strictEqual(audioGap.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);
}

function testAudioTrackSwitchRebuildAcceptsCRAPresentationWindow() {
    const h = makeHarness({config: {isMMTS: true}});
    const request = makeAudioTrackSwitchRebuildRequest(2.553, 2.987, 71);
    request.switchTime = 2.837;
    request.seekTime = 2.837;

    const videoSegment = attachPlaybackOperation(
        makeSegment('video', 2.553, 2.686, 4096),
        request.operation
    );
    videoSegment.firstPlayableWindow = {
        decodeStart: 2.553,
        compositionStart: 2.8,
        syncPoint: 2.837,
        playableStart: 2.837,
        playableEnd: 2.987,
    };
    videoSegment.mmtsRandomAccessSafe = true;
    request.videoSegments = [videoSegment];
    request.audioSegments = [attachPlaybackOperation(
        makeSegment('audio', 2.8, 2.95, 1024),
        request.operation
    )];

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    assert.strictEqual(h.rebuildPlans.length, 1);
    assert.strictEqual(h.rebuildPlans[0].seekTime, 2.837);
    assert.strictEqual(h.rebuildPlans[0].videoSegments[0].info.beginDts, 2553);
    assert.strictEqual(h.rebuildPlans[0].videoSegments[0].info.endDts, 2686);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
}

function testAudioTrackSwitchRebuildWaitsForIdleAndReplaysBothTracks() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.updating = true;

    const staleVideo = makeSegment('video', 0, 1, 512);
    const staleAudio = makeSegment('audio', 0, 1, 256);
    h.sm.onMediaSegment('video', staleVideo);
    h.sm.onMediaSegment('audio', staleAudio);

    const request = makeAudioTrackSwitchRebuildRequest();
    request.videoInitSegment.resetParserState = true;
    request.videoInitSegment.rebuildSourceBuffer = true;
    request.audioInitSegment.resetParserState = true;
    request.audioInitSegment.rebuildSourceBuffer = true;

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit'), false);

    h.updateEnd('video');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);
    h.updateEnd('audio');
    assert.strictEqual(h.rebuildPlans.length, 1);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit'), false);

    const plan = h.rebuildPlans[0];
    assert.strictEqual(plan.type, 'audio_track_switch');
    assert.strictEqual(plan.videoInitSegment.resetParserState, undefined);
    assert.strictEqual(plan.videoInitSegment.rebuildSourceBuffer, undefined);
    assert.strictEqual(plan.audioInitSegment.resetParserState, undefined);
    assert.strictEqual(plan.audioInitSegment.rebuildSourceBuffer, undefined);

    h.sm.onSourceOpen();
    assert.strictEqual(h.appendedInitSegments.length, 1);
    assert.strictEqual(h.appendedInitSegments[0].type, 'video');
    h.updateEnd('video');
    assert.strictEqual(h.appendedInitSegments.length, 2);
    assert.strictEqual(h.appendedInitSegments[1].type, 'audio');
    h.updateEnd('audio');
    assert.strictEqual(h.appendedSegments.length, 1);
    assert.strictEqual(h.appendedSegments[0].type, 'video');
    h.ranges.video.push({start: 12.2, end: 13});
    h.updateEnd('video');
    assert.strictEqual(h.appendedSegments.length, 2);
    assert.strictEqual(h.appendedSegments[1].type, 'audio');
    h.ranges.audio.push({start: 12.16, end: 13});
    h.updateEnd('audio');

    assert.strictEqual(h.appendedSegments.includes(staleVideo), false);
    assert.strictEqual(h.appendedSegments.includes(staleAudio), false);
    assert.strictEqual(h.appendedSegments[0].mseBufferGeneration, request.operation.timelineGeneration);
    assert.strictEqual(h.appendedSegments[1].mseBufferGeneration, request.operation.timelineGeneration);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'resetParserState'), false);
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' &&
            entry[1] === 12.2 &&
            entry[2] === 'AUDIO_TRACK_SWITCH_REBUILD'
        ),
        true
    );
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'resumeTransmuxer' &&
            entry[1] === 'TRACK_SWITCHING_REBUILD_COMPLETE'
        ),
        true
    );
    assert.strictEqual(h.sm._pending_media_seek_target, null);
    assert.strictEqual(h.sm._pending_media_seek_reason, null);
    const rebuildResumeIndex = h.log.findIndex((entry) =>
        entry[0] === 'resumeTransmuxer' && entry[1] === 'TRACK_SWITCHING_REBUILD_COMPLETE'
    );
    const rebuildCompleteIndex = h.log.findIndex((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete'
    );
    assert(rebuildResumeIndex >= 0 && rebuildCompleteIndex > rebuildResumeIndex);
    assert.strictEqual(h.log[rebuildCompleteIndex][1].transactionId, 7);
}

function testAudioTrackSwitchRebuildReusesExistingSourceBuffers() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    h.sm.onMediaState(12.05, 4, 'timeupdate');

    const request = makeAudioTrackSwitchRebuildRequest();
    request.replaceMediaSource = false;
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request, 'vod'), true);
    assert.strictEqual(h.rebuildPlans.length, 0);
    assert.deepStrictEqual(
        h.log.filter((entry) => entry[0] === 'removeRange')[0],
        ['removeRange', 'video', 0, 20]
    );

    h.ranges.video.splice(0, h.ranges.video.length);
    h.updateEnd('video');
    assert.deepStrictEqual(
        h.log.filter((entry) => entry[0] === 'removeRange')[1],
        ['removeRange', 'audio', 0, 20]
    );

    h.ranges.audio.splice(0, h.ranges.audio.length);
    h.updateEnd('audio');
    const resetIndex = h.log.findIndex((entry) => entry[0] === 'resetParserState');
    const videoInitIndex = h.log.findIndex((entry) =>
        entry[0] === 'appendInit' && entry[1] === 'video'
    );
    assert(resetIndex >= 0 && videoInitIndex > resetIndex);
    assert.deepStrictEqual(h.log[resetIndex], [
        'resetParserState',
        'audio',
        'audio/mp4;codecs=mp4a.40.5',
    ]);
    assert.strictEqual(h.sourceBuffers.video.exists, true);
    assert.strictEqual(h.sourceBuffers.audio.exists, true);

    h.updateEnd('video');
    assert.strictEqual(h.appendedInitSegments.length, 2);
    assert.strictEqual(h.appendedInitSegments[1].type, 'audio');
    h.updateEnd('audio');
    assert.strictEqual(h.appendedSegments.length, 1);
    assert.strictEqual(h.appendedSegments[0].type, 'video');
    h.ranges.video.push({start: 12, end: 13});
    h.updateEnd('video');
    assert.strictEqual(h.appendedSegments.length, 2);
    assert.strictEqual(h.appendedSegments[1].type, 'audio');
    h.ranges.audio.push({start: 12, end: 13});
    h.updateEnd('audio');

    assert.strictEqual(h.log.some((entry) => entry[0] === 'rebuildMediaSource'), false);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'seekMedia' && entry[1] === 12.05 &&
        entry[2] === 'AUDIO_TRACK_SWITCH_REBUILD'
    ), true);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete' && entry[1].transactionId === 7
    ), true);
}

function testVodForwardAudioTrackSwitchPreservesVideoBuffer() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    h.sm.onMediaState(12.05, 4, 'timeupdate');

    const request = makeAudioTrackSwitchRebuildRequest();
    request.replaceMediaSource = false;
    request.preserveVideoBuffer = true;
    request.videoInitSegment = null;
    request.videoSegments = [];
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request, 'vod-forward'), true);

    assert.strictEqual(h.rebuildPlans.length, 0);
    assert.deepStrictEqual(
        h.log.filter((entry) => entry[0] === 'removeRange'),
        []
    );
    assert.deepStrictEqual(h.ranges.video, [{start: 0, end: 20}]);

    assert.strictEqual(h.log.some((entry) => entry[0] === 'resetParserState' &&
        entry[1] === 'audio'), true);
    assert.strictEqual(h.appendedInitSegments.length, 1);
    assert.strictEqual(h.appendedInitSegments[0].type, 'audio');
    const audioResetIndex = h.log.findIndex((entry) =>
        entry[0] === 'resetParserState' && entry[1] === 'audio'
    );
    const audioInitIndex = h.log.findIndex((entry) =>
        entry[0] === 'appendInit' && entry[1] === 'audio'
    );
    assert(audioResetIndex >= 0 && audioInitIndex > audioResetIndex);

    h.updateEnd('audio');
    assert.strictEqual(h.appendedSegments.length, 1);
    assert.strictEqual(h.appendedSegments[0].type, 'audio');
    const audioMediaIndex = h.log.findIndex((entry) =>
        entry[0] === 'appendMedia' && entry[1] === 'audio'
    );
    assert(audioMediaIndex > audioInitIndex);
    h.updateEnd('audio');
    const audioTailRemoveIndex = h.log.findIndex((entry) =>
        entry[0] === 'removeRange' && entry[1] === 'audio' && entry[2] === 13 && entry[3] === 20
    );
    assert(audioTailRemoveIndex > audioMediaIndex);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete'
    ), false);
    h.ranges.audio.splice(0, h.ranges.audio.length, {start: 0, end: 13});
    h.updateEnd('audio');

    assert.strictEqual(h.appendedInitSegments.some((segment) => segment.type === 'video'), false);
    assert.strictEqual(h.appendedSegments.some((segment) => segment.type === 'video'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'audioTrackSwitchRebuildComplete' && entry[1].transactionId === 7
    ), true);
    assert.deepStrictEqual(h.ranges.video, [{start: 0, end: 20}]);
}

function testVodForwardAudioTrackSwitchAcceptsMultipleShortFragments() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    h.sm.onMediaState(12.05, 4, 'timeupdate');

    const request = makeAudioTrackSwitchRebuildRequest();
    request.replaceMediaSource = false;
    request.preserveVideoBuffer = true;
    request.videoInitSegment = null;
    request.videoSegments = [];
    request.audioSegments = [
        makeSegment('audio', 12, 12.12, 1024),
        makeSegment('audio', 12.12, 12.24, 1024),
        makeSegment('audio', 12.24, 12.36, 1024),
    ].map((segment) => attachPlaybackOperation(segment, request.operation));

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request, 'vod-forward'), true);
    assert.strictEqual(h.sm._main_state, 'TRACK_SWITCHING');
    assert.strictEqual(h.appendedInitSegments.length, 1);
    assert.strictEqual(h.appendedInitSegments[0].type, 'audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
}

function testInPlaceAudioTrackSwitchCancelDropsPendingFlushAndReplay() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    const request = makeAudioTrackSwitchRebuildRequest();
    request.replaceMediaSource = false;

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request, 'vod'), true);
    assert.strictEqual(h.sm.cancelAudioTrackSwitch(request.operation), true);
    assert.strictEqual(h.sm._pending_remove_ranges.video.length, 0);
    assert.strictEqual(h.sm._pending_remove_ranges.audio.length, 0);
    assert.strictEqual(h.sm._pending_full_track_flush.video, false);
    assert.strictEqual(h.sm._pending_full_track_flush.audio, false);

    h.ranges.video.splice(0, h.ranges.video.length);
    h.updateEnd('video');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'resetParserState'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
}

function testAudioTrackSwitchRebuildWaitsWithoutPlayableIntersection() {
    const h = makeHarness({config: {isMMTS: true, isLive: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, makeAudioTrackSwitchRebuildRequest()), true);
    assert.strictEqual(h.rebuildPlans.length, 1);

    h.sm.onSourceOpen();
    h.updateEnd('video');
    h.updateEnd('audio');
    h.ranges.video.push({start: 12.2, end: 13});
    h.updateEnd('video');
    h.ranges.audio.push({start: 13.1, end: 14});
    h.updateEnd('audio');

    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekMedia' && entry[2] === 'AUDIO_TRACK_SWITCH_REBUILD'),
        false
    );
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'resumeTransmuxer' &&
            entry[1] === 'TRACK_SWITCHING_REBUILD_COMPLETE'
        ),
        false
    );
    assert.strictEqual(h.sm._pending_media_seek_target, 12.05);
    assert.strictEqual(h.sm._pending_media_seek_reason, 'AUDIO_TRACK_SWITCH_REBUILD');
}

function testAudioTrackSwitchRebuildFailureIsFatalWithoutSingleBufferFallback() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.failRebuild();

    assert.strictEqual(submitAudioTrackSwitchRebuild(h, makeAudioTrackSwitchRebuildRequest()), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'rebuildMediaSource'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'resetParserState'), false);
}

function testAudioTrackSwitchRebuildFailureDefersToTransactionOwner() {
    let h;
    const failures = [];
    h = makeHarness({
        config: {isMMTS: true, isLive: true},
        output: {
            onAudioTrackSwitchRebuildFailed(failure) {
                failures.push(failure);
                h.sm.cancelMMTSVodAudioTrackRebuild();
            },
        },
    });
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.failRebuild();
    const request = makeAudioTrackSwitchRebuildRequest(12, 13, 41);
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].kind, 'audio-switch');
    assert.strictEqual(failures[0].transactionId, 41);
    assert.strictEqual(failures[0].phase, 'rebuild-media-source');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    assert.notStrictEqual(h.sm._main_state, 'TRACK_SWITCHING');
    assert.notStrictEqual(h.sm._main_state, 'FATAL');
    assert.strictEqual(h.sm._pending_audio_rebuild_plan, null);
    assert.strictEqual(h.sm._transmuxer_paused, false);
}

function testInvalidAudioRebuildPlanDefersToTransactionOwner() {
    const failures = [];
    const h = makeHarness({
        config: {isMMTS: true},
        output: {
            onAudioTrackSwitchRebuildFailed(failure) {
                failures.push(failure);
            },
        },
    });
    const request = makeAudioTrackSwitchRebuildRequest(12, 13, 42);
    request.videoSegments = [];
    assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), false);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].transactionId, 42);
    assert.strictEqual(failures[0].phase, 'plan-validation');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
}

function testBackpressurePausesSeekWithoutOverridingSeekState() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    h.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 30,
        audioForwardBytes: 2 * MiB,
        audioForwardDuration: 30,
    });
    h.sm.onSeek(30);
    h.sm._transmuxer_paused = false;
    h.sm._transmuxer_pause_reason = null;
    h.sm.tick('seek_preroll_buffered');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
    assert.strictEqual(h.sm._main_state, 'SEEKING');
}

function testSeekStateWaitsForMediaElementSeekedEvent() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 9, end: 12});
    h.ranges.audio.push({start: 9, end: 12});
    h.sm._main_state = 'SEEKING';
    assert.strictEqual(
        h.sm._requestMediaSeekWhenPlayable(10, 'RECOMMEND_SEEKPOINT', 0.05),
        true
    );
    h.sm.tick('seek_requested');
    assert.strictEqual(h.sm._main_state, 'SEEKING');
    assert.strictEqual(h.sm._awaiting_media_seek_completion, true);

    h.sm.onMediaState(10, 4, 'seeked');
    assert.strictEqual(h.sm._awaiting_media_seek_completion, false);
    assert.strictEqual(h.sm._main_state, 'STEADY');
}

function testVideoTrackSwitchConsumesRemuxedVideoWindowWithoutTimelineSeek() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 20});
    h.ranges.audio.push({start: 0, end: 20});
    h.setForwardInfo({
        videoForwardDuration: 20,
        videoForwardBytes: 4096,
        audioForwardDuration: 20,
        audioForwardBytes: 4096,
    });

    const operation = makePlaybackOperation('video-switch', 2, 0xf201);
    const videoSwitch = makeVideoTrackSwitch(12, 13);
    const videoInitSegment = attachPlaybackOperation(makeInit('video'), operation);
    videoInitSegment.mmtsVideoTrackSwitch = makeVideoTrackSwitchIdentity(videoSwitch);
    const videoMediaSegment = attachPlaybackOperation(
        makeSegment('video', 12, 13, 1024),
        operation
    );
    markRandomAccessSafeVideoSegment(videoMediaSegment, videoSwitch);
    videoMediaSegment.mmtsVideoTrackSwitch = videoSwitch;
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onVideoTrackSwitch({
        stage: 'request',
        operation,
        transactionId: 2,
    }), true);
    const accepted = h.sm.onVideoTrackSwitch({
        stage: 'commit_ready',
        operation,
        transactionId: 2,
        videoSwitch,
        videoInitSegment,
        videoMediaSegment,
    });
    assert.strictEqual(accepted, true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange' && entry[1] === 'audio'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
    const videoResetIndex = h.log.findIndex((entry) =>
        entry[0] === 'resetParserState' && entry[1] === 'video'
    );
    const videoInitIndex = h.log.findIndex((entry) =>
        entry[0] === 'appendInit' && entry[1] === 'video'
    );
    assert(videoResetIndex >= 0 && videoInitIndex > videoResetIndex);

    h.updateEnd('video');
    h.updateEnd('video');
    h.updateEnd('video');

    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'audio'), false);
    const appendedVideoInit = h.appendedInitSegments.find((segment) => segment.type === 'video');
    assert(appendedVideoInit);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(appendedVideoInit.mmtsVideoTrackSwitch)),
        makeVideoTrackSwitchIdentity(videoSwitch)
    );
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'video'), true);
    const videoMediaIndex = h.log.findIndex((entry) =>
        entry[0] === 'appendMedia' && entry[1] === 'video'
    );
    assert(videoMediaIndex > videoInitIndex);
    const videoTailRemoveIndex = h.log.findIndex((entry) =>
        entry[0] === 'removeRange' && entry[1] === 'video' && entry[2] === 13 && entry[3] === 20
    );
    assert(videoTailRemoveIndex > videoMediaIndex);
    const videoCompleteIndex = h.log.findIndex((entry) =>
        entry[0] === 'videoTrackSwitchComplete' && entry[1].transactionId === 2
    );
    assert(videoCompleteIndex > videoTailRemoveIndex);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'videoTrackSwitchComplete' && entry[1].transactionId === 2
    ), true);
}

function testVideoTrackSwitchRequestsAndCommitsFromEndedMediaSource() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setMediaSourceReadyState('ended');

    const operation = makePlaybackOperation('video-switch', 2, 0xf201);
    const videoSwitch = makeVideoTrackSwitch(12, 13);
    const videoInitSegment = attachPlaybackOperation(makeInit('video'), operation);
    videoInitSegment.mmtsVideoTrackSwitch = makeVideoTrackSwitchIdentity(videoSwitch);
    const videoMediaSegment = attachPlaybackOperation(
        makeSegment('video', 12, 13, 1024),
        operation
    );
    markRandomAccessSafeVideoSegment(videoMediaSegment, videoSwitch);
    videoMediaSegment.mmtsVideoTrackSwitch = videoSwitch;

    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onVideoTrackSwitch({
        stage: 'request',
        operation,
        transactionId: 2,
    }), true);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'resumeTransmuxer' && entry[1] === 'TRACK_SWITCHING_DATA_REQUEST'
    ), true);
    assert.strictEqual(h.sm.onVideoTrackSwitch({
        stage: 'commit_ready',
        operation,
        transactionId: 2,
        videoSwitch,
        videoInitSegment,
        videoMediaSegment,
    }), true);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'resetParserState' && entry[1] === 'video'
    ), true);
    assert.strictEqual(h.log.some((entry) =>
        entry[0] === 'appendInit' && entry[1] === 'video'
    ), true);
}

function testVideoTrackSwitchRejectsInvalidRemuxedWindow() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;

    const operation = makePlaybackOperation('video-switch', 2, 0xf201);
    const invalidSwitch = makeVideoTrackSwitch(13, 12);
    const initSegment = attachPlaybackOperation(makeInit('video'), operation);
    const mediaSegment = attachPlaybackOperation(makeSegment('video', 12, 13, 1024), operation);
    initSegment.mmtsVideoTrackSwitch = makeVideoTrackSwitchIdentity(invalidSwitch);
    mediaSegment.mmtsVideoTrackSwitch = invalidSwitch;
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(h.sm.onVideoTrackSwitch({
        stage: 'request',
        operation,
        transactionId: 2,
    }), true);
    const accepted = h.sm.onVideoTrackSwitch({
        stage: 'commit_ready',
        operation,
        transactionId: 2,
        videoSwitch: invalidSwitch,
        videoInitSegment: initSegment,
        videoMediaSegment: mediaSegment,
    });
    assert.strictEqual(accepted, false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), false);
}

function testHevcVideoInitWaitsForAudioInit() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mmtsDeferHevcVideoInitUntilAudio: true,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sm.onInitSegment('video', makeInit('video', 'hvc1.2.1.L183.B0'));
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), false);
    h.sm.onInitSegment('audio', makeInit('audio'));
    assert.deepStrictEqual(h.log[h.log.length - 1], ['appendInit', 'audio']);
    h.updateEnd('audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), true);
}

function testHev1VideoInitWaitsForAudioInit() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mmtsDeferHevcVideoInitUntilAudio: true,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sm.onInitSegment('video', makeInit('video', 'hev1.2.1.L183.B0'));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), false);
    h.sm.onInitSegment('audio', makeInit('audio'));
    h.updateEnd('audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), true);
}

function testMMTSVideoInitHonorsHevcDeferOptOut() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mmtsDeferHevcVideoInitUntilAudio: false,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sm.onInitSegment('video', makeInit('video', 'hvc1.2.1.L183.B0'));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), true);
}

function testNonHevcMMTSVideoInitDoesNotWaitForAudioInit() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mmtsDeferHevcVideoInitUntilAudio: true,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sm.onInitSegment('video', makeInit('video', 'avc1.640028'));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendInit' && entry[1] === 'video'), true);
}

function testPlayableForwardDurationRequiresAudioVideoIntersection() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.setForwardInfo({
        videoForwardDuration: 12,
        audioForwardDuration: 0,
        videoForwardBytes: 1024,
        audioForwardBytes: 0,
    });
    let info = h.sm.getForwardBufferInfo(0);
    assert.strictEqual(info.forwardDuration, 0);

    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardDuration: 12,
        audioForwardDuration: 5,
        videoForwardBytes: 1024,
        audioForwardBytes: 512,
    });
    info = h.sm.getForwardBufferInfo(0);
    assert.strictEqual(info.forwardDuration, 5);
}

function testPendingVideoBytesPauseEvenWhenAudioIsMissing() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1 * MiB));
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        false
    );
    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 130 * MiB));
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testBackpressureDoesNotRequireBothTrackData() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 8,
        audioForwardBytes: 0,
        audioForwardDuration: 0,
    });
    h.sm.onMediaState(0, 4, 'timeupdate');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );

    const both = makeHarness({config: {isMMTS: true}});
    both.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    both.sourceBuffers.video.exists = true;
    both.sourceBuffers.audio.exists = true;
    both.setForwardInfo({
        videoForwardBytes: 130 * MiB,
        videoForwardDuration: 0,
        audioForwardBytes: 512 * 1024,
        audioForwardDuration: 0,
    });
    both.sm.onMediaState(0, 4, 'progress');
    assert.strictEqual(
        both.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testSeekBackpressureCapsSingleTrackDuration() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sm._main_state = 'SEEKING';
    h.sm._timeline_seek_target_time = 400;
    h.setForwardInfo({
        videoForwardBytes: 1 * MiB,
        videoForwardDuration: 8,
        audioForwardBytes: 0,
        audioForwardDuration: 0,
    });

    h.sm.onMediaState(400, 1, 'progress');
    assert.strictEqual(h.sm._main_state, 'SEEKING');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testPendingQueuesTriggerBackpressureBeforeMSEAppend() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mseBufferVideoSoftLimitBytes: 64 * MiB,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.updating = true;

    h.sm.onMediaSegment('video', makeSegment('video', 0, 8, 65 * MiB));
    h.sm.onMediaSegment('audio', makeSegment('audio', 0, 8, 1024 * 1024));

    assert.strictEqual(h.log.some((entry) => entry[0] === 'appendMedia'), false);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testPendingTimelineDurationTriggersBackpressureAfterSeek() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mseBufferForwardTargetDuration: 90,
            mseBufferVideoSoftLimitBytes: 112 * MiB,
            mseBufferAudioSoftLimitBytes: 12 * MiB,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.updating = true;
    h.sm.onMediaState(440, 4, 'seeked');

    // A fast cached range response can queue 95 seconds while using far less
    // than the byte limits.  Duration backpressure must see that queued
    // timeline instead of waiting for SourceBuffer updateend to catch up.
    h.sm.onMediaSegment('video', makeSegment('video', 439.8, 535, 24 * MiB));
    h.sm.onMediaSegment('audio', makeSegment('audio', 439.8, 535, 2 * MiB));

    const info = h.sm.getForwardBufferInfo(440);
    assert.strictEqual(info.videoForwardDuration, 95);
    assert.strictEqual(info.audioForwardDuration, 95);
    assert.strictEqual(info.forwardDuration, 95);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );
}

function testAudioBytesTriggerBackpressureAndRecovery() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mseBufferAudioSoftLimitBytes: 8 * MiB,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardBytes: 1024,
        videoForwardDuration: 1,
        audioForwardBytes: 9 * MiB,
        audioForwardDuration: 1,
    });

    h.sm.onMediaState(0, 4, 'progress');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );

    h.setForwardInfo({audioForwardBytes: 5 * MiB});
    h.sm.onMediaState(0, 4, 'timeupdate');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'resumeTransmuxer'), false);

    h.setForwardInfo({audioForwardBytes: 4 * MiB});
    h.sm.onMediaState(0, 4, 'timeupdate');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'RECOVERED'),
        true
    );
}

function testFatalMediaElementStateStopsProducerAndDropsQueuedOutput() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sourceBuffers.video.updating = true;
    h.sourceBuffers.audio.updating = true;
    h.sm.onMediaSegment('video', makeSegment('video', 0, 2, 1024));
    h.sm.onMediaSegment('audio', makeSegment('audio', 0, 2, 512));
    assert.strictEqual(h.sm._pending_media_segments.video.length, 1);
    assert.strictEqual(h.sm._pending_media_segments.audio.length, 1);

    h.sm.onMediaElementError({code: 3, msg: 'decode failed'});

    assert.strictEqual(h.sm.isFatal, true);
    assert.strictEqual(h.sm._pending_media_segments.video.length, 0);
    assert.strictEqual(h.sm._pending_media_segments.audio.length, 0);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'FATAL'),
        true
    );
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'fatal').length, 1);

    h.sm.onMediaSegment('video', makeSegment('video', 2, 4, 1024));
    h.sm.onMediaSegment('audio', makeSegment('audio', 2, 4, 512));
    assert.strictEqual(h.sm._pending_media_segments.video.length, 0);
    assert.strictEqual(h.sm._pending_media_segments.audio.length, 0);
    h.sm.onMediaElementError({code: 3, msg: 'duplicate'});
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'fatal').length, 1);
}

function testForwardDurationCanTriggerBackpressureAndRecover() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            mseBufferForwardTargetDuration: 24,
            mseBufferRecoverForwardDuration: 12,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardBytes: 16 * MiB,
        videoForwardDuration: 25,
        audioForwardBytes: 1024 * 1024,
        audioForwardDuration: 25,
    });
    h.sm.onMediaState(0, 4, 'progress');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'BACKPRESSURE'),
        true
    );

    h.setForwardInfo({
        videoForwardBytes: 8 * MiB,
        videoForwardDuration: 10,
        audioForwardBytes: 512 * 1024,
        audioForwardDuration: 10,
    });
    h.sm.onMediaState(15, 4, 'timeupdate');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'RECOVERED'),
        true
    );
}

function testMMTSVodWaitingAtByteCapPrefetchesUntilPlaybackProgresses() {
    const h = makeHarness({
        config: {
            isMMTS: true,
            isLive: false,
            mseBufferVideoSoftLimitBytes: 112 * MiB,
            mseBufferVideoHardLimitBytes: 128 * MiB,
            mseBufferForwardTargetDuration: 90,
            mseBufferRecoverForwardDuration: 60,
            lazyLoadRecoverBytes: 96 * MiB,
        }
    });
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.setForwardInfo({
        videoForwardBytes: 112 * MiB,
        videoForwardDuration: 34,
        audioForwardBytes: 2 * MiB,
        audioForwardDuration: 34,
    });

    h.sm.onMediaState(145, 4, 'progress');
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');

    assert.strictEqual(h.sm.onContinuousBufferStall(), true);
    assert.strictEqual(h.sm._backpressure_stall_prefetch_active, true);
    assert.strictEqual(h.sm._main_state, 'STEADY');
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'RECOVERED'),
        true
    );

    const pauseCount = h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length;
    h.setForwardInfo({
        videoForwardBytes: 200 * MiB,
        videoForwardDuration: 60,
        audioForwardBytes: 3 * MiB,
        audioForwardDuration: 60,
    });
    h.sm.onMediaState(145, 4, 'progress');
    assert.strictEqual(h.sm._transmuxer_paused, false);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount);

    h.sm.onMediaState(145.6, 4, 'timeupdate');
    assert.strictEqual(h.sm._backpressure_stall_prefetch_active, false);
    assert.strictEqual(h.sm._main_state, 'BACKPRESSURE');
    assert.strictEqual(h.sm._transmuxer_pause_reason, 'BACKPRESSURE');
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'pauseTransmuxer').length, pauseCount + 1);
}

function testMMTSDirectSeekKeepsRequestedTimeWithBufferedVideoRandomAccessPreroll() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 8, end: 14});
    h.ranges.audio.push({start: 8, end: 14});
    const video = makeSegment('video', 8, 14, 1024);
    video.info.syncPoints = [
        {dts: 9800, pts: 10000},
        {dts: 10500, pts: 10667},
    ];
    h.sm.onMediaSegment('video', video);

    assert.strictEqual(h.sm.onDirectSeek(10.1), true);
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' && entry[1] === 10.1 && entry[2] === 'DIRECT_SEEK'
        ),
        true
    );
}

function testMMTSDirectSeekWaitsWithoutBufferedVideoRandomAccessPoint() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.ranges.video.push({start: 8, end: 14});
    h.ranges.audio.push({start: 8, end: 14});

    assert.strictEqual(h.sm.onDirectSeek(10.1), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
}

function testMMTSDirectSeekCrossesAudioOnlyGapWithContinuousVideoPreroll() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 165.098, end: 211.862});
    h.ranges.audio.push(
        {start: 165.009, end: 165.329},
        {start: 167.697, end: 212.411}
    );
    const video = makeSegment('video', 165.098, 211.862, 1024);
    video.info.syncPoints = [
        {dts: 167100, pts: 167200},
    ];
    h.sm.onMediaSegment('video', video);

    assert.strictEqual(h.sm.onDirectSeek(167.697), true);
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' && entry[1] === 167.697 && entry[2] === 'DIRECT_SEEK'
        ),
        true
    );
}

function testNonMMTSDirectSeekKeepsRequestedTime() {
    const h = makeHarness();
    assert.strictEqual(h.sm.onDirectSeek(2), true);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekMedia' && entry[1] === 2 && entry[2] === 'DIRECT_SEEK'),
        true
    );
}

function testStartupGroupAppendsCompleteAudioVideoBatchBeforeRelease() {
    const h = makeHarness({config: {isMMTS: true}});
    const startupGroup = attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        audioInitSegment: makeInit('audio'),
        videoMediaSegment: makeSegment('video', 10, 12, 1024),
        audioMediaSegment: makeSegment('audio', 9.9, 12.1, 1024),
        startupTime: 10,
        videoDecodeStart: 10,
        videoCompositionStart: 10,
        audioStart: 9.9,
        audioEnd: 12.1,
        syncPoint: 10,
        playableStart: 10,
        playableEnd: 12,
        hasAudio: true,
        hasVideo: true,
    });

    h.sm.onStartupGroup(startupGroup);
    assert.deepStrictEqual(h.log[0], ['appendInit', 'video']);
    h.updateEnd('video');
    assert.deepStrictEqual(h.log[1], ['appendInit', 'audio']);
    h.updateEnd('audio');
    assert.deepStrictEqual(h.log[2], ['appendMedia', 'video', 10]);
    h.updateEnd('video');
    assert.deepStrictEqual(h.log[3], ['appendMedia', 'audio', 9.9]);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
    h.updateEnd('audio');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekMedia'),
        false
    );
    assert.strictEqual(h.sm._pending_media_seek_target, 10);

    h.ranges.video.push({start: 10, end: 12});
    h.sm.tick('video_range_visible');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekMedia'),
        false
    );

    h.ranges.audio.push({start: 9.9, end: 12.1});
    h.sm.tick('audio_range_visible');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekMedia' && entry[1] === 10 && entry[2] === 'STARTUP_GROUP'),
        true
    );
    h.sm.tick('duplicate_startup_tick');
    assert.strictEqual(
        h.log.filter((entry) =>
            entry[0] === 'seekMedia' && entry[1] === 10 && entry[2] === 'STARTUP_GROUP'
        ).length,
        1
    );
}

function testSeekStartupGroupResetsBothSourceBufferParsers() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    const operation = makePlaybackOperation('seek', 101, undefined, 0, 'queued', 100000);
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onStartupGroup(attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        audioInitSegment: makeInit('audio'),
        videoMediaSegment: makeSegment('video', 100, 102, 1024),
        audioMediaSegment: makeSegment('audio', 99.9, 102.1, 1024),
        startupTime: 100,
        videoDecodeStart: 100,
        videoCompositionStart: 100,
        audioStart: 99.9,
        audioEnd: 102.1,
        syncPoint: 100,
        playableStart: 100,
        playableEnd: 102,
        hasAudio: true,
        hasVideo: true,
    }, operation));

    assert.deepStrictEqual(h.log.slice(0, 3).map((entry) => entry.slice(0, 2)), [
        ['resetParserState', 'audio'],
        ['resetParserState', 'video'],
        ['appendInit', 'video'],
    ]);
    h.updateEnd('video');
    assert.deepStrictEqual(h.log[3].slice(0, 2), ['appendInit', 'audio']);
}

function testOverlappingStartupAppendsKeepPerTrackCompletionIdentity() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    h.ranges.video.push({start: 10, end: 13});
    h.ranges.audio.push({start: 9.9, end: 12.1});
    h.sm.onStartupGroup(makeStartupGroup());

    h.updateEnd('video');
    h.updateEnd('audio');
    assert.deepStrictEqual(h.log[2], ['appendMedia', 'video', 10]);

    h.sm.tick('overlap_startup_audio');
    assert.deepStrictEqual(h.log[3], ['appendMedia', 'audio', 9.9]);
    assert.strictEqual(h.sourceBuffers.video.updating, true);
    assert.strictEqual(h.sourceBuffers.audio.updating, true);

    const normalVideo = attachPlaybackOperation(makeSegment('video', 12, 13, 1024));
    h.sm.onMediaSegment('video', normalVideo);

    h.updateEnd('video');
    assert.deepStrictEqual(h.log[4], ['appendMedia', 'video', 12]);
    assert.strictEqual(h.sm._pending_startup_group_media.video, false);
    assert.strictEqual(h.sm._pending_startup_group_media.audio, true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'startupGroupAppended'), false);

    h.updateEnd('audio');
    assert.strictEqual(h.sm._pending_startup_group, null);
    assert.strictEqual(h.sm._pending_startup_group_media.video, false);
    assert.strictEqual(h.sm._pending_startup_group_media.audio, false);
    assert.strictEqual(h.sm._inflight_operations.video.segment.info.beginDts, 12000);
    assert.strictEqual(
        h.log.filter((entry) =>
            entry[0] === 'seekMedia' && entry[1] === 10 && entry[2] === 'STARTUP_GROUP'
        ).length,
        1
    );
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'startupGroupAppended').length, 1);
    assert.strictEqual(pendingTimers.size, 0);
}

function testStartupGroupSeeksToFirstActualTrackIntersection() {
    const h = makeHarness({config: {isMMTS: true}});
    h.ranges.video.push({start: 0.701, end: 5});
    h.ranges.audio.push({start: 0.589, end: 5});
    h.sm.onStartupGroup(attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        audioInitSegment: makeInit('audio'),
        videoMediaSegment: makeSegment('video', 0, 1, 1024),
        audioMediaSegment: makeSegment('audio', 0, 1, 1024),
        startupTime: 0.167,
        videoDecodeStart: 0,
        videoCompositionStart: 0.167,
        audioStart: 0.141,
        audioEnd: 1,
        syncPoint: 0.167,
        playableStart: 0.167,
        playableEnd: 1,
        hasAudio: true,
        hasVideo: true,
    }));

    h.updateEnd('video');
    h.updateEnd('audio');
    h.updateEnd('video');
    h.updateEnd('audio');
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' && entry[1] === 0.701 && entry[2] === 'STARTUP_GROUP'
        ),
        true
    );
}

function testSeekStartupGroupPrerollsWithoutIntermediateRapSeek() {
    const h = makeHarness({config: {isMMTS: true}});
    const operation = makePlaybackOperation(
        'seek',
        2,
        undefined,
        0,
        'queued',
        49610.417
    );
    assert.strictEqual(h.sm.setPlaybackOperation(operation), true);
    h.sm.onRecommendedSeekPoint(49.610417);

    const startupGroup = attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        audioInitSegment: makeInit('audio'),
        videoMediaSegment: makeSegment('video', 49.282, 49.55, 1024),
        audioMediaSegment: makeSegment('audio', 49.25, 49.55, 1024),
        startupTime: 49.282,
        videoDecodeStart: 49.282,
        videoCompositionStart: 49.282,
        audioStart: 49.25,
        audioEnd: 49.55,
        syncPoint: 49.282,
        playableStart: 49.282,
        playableEnd: 49.55,
        hasAudio: true,
        hasVideo: true,
    }, operation);
    h.sm.onStartupGroup(startupGroup);
    h.updateEnd('video');
    h.updateEnd('audio');
    h.updateEnd('video');
    h.ranges.video.push({start: 49.282, end: 49.55});
    h.ranges.audio.push({start: 49.25, end: 49.55});
    h.updateEnd('audio');

    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' && entry[2] === 'STARTUP_GROUP'
        ),
        false
    );
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'playbackOperationComplete'),
        false
    );

    h.sm.onMediaSegment(
        'video',
        attachPlaybackOperation(makeSegment('video', 49.55, 50, 1024), operation)
    );
    h.sm.onMediaSegment(
        'audio',
        attachPlaybackOperation(makeSegment('audio', 49.55, 50, 1024), operation)
    );
    h.ranges.video[0].end = 50;
    h.updateEnd('video');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
    h.ranges.audio[0].end = 50;
    h.updateEnd('audio');

    const seeks = h.log.filter((entry) => entry[0] === 'seekMedia');
    assert.deepStrictEqual(seeks, [['seekMedia', 49.610417, 'RECOMMEND_SEEKPOINT']]);
    const completions = h.log.filter((entry) => entry[0] === 'playbackOperationComplete');
    assert.strictEqual(completions.length, 1);
    assert.strictEqual(completions[0][2].committedTimeMilliseconds, 49610.417);
}

function testStartupGroupRejectsMissingRequiredAudioSegment() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onStartupGroup(attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        audioInitSegment: makeInit('audio'),
        videoMediaSegment: makeSegment('video', 10, 12, 1024),
        audioMediaSegment: null,
        startupTime: 10,
        videoDecodeStart: 10,
        videoCompositionStart: 10,
        audioStart: undefined,
        audioEnd: undefined,
        syncPoint: 10,
        playableStart: 10,
        playableEnd: 12,
        hasAudio: true,
        hasVideo: true,
    }));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), true);
}

function testStartupGroupAppendWatchdogIsAbsoluteAndFencesLateUpdateEnd() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onStartupGroup(makeStartupGroup());
    assert.strictEqual(pendingTimers.size, 1);
    const timerId = Array.from(pendingTimers.keys())[0];
    assert.strictEqual(
        pendingTimers.get(timerId).delay,
        startupGroupLifecycleModule.DEFAULT_MMTS_STARTUP_GROUP_TIMEOUT
    );

    h.updateEnd('video');
    assert.deepStrictEqual(Array.from(pendingTimers.keys()), [timerId]);
    fireTimer(timerId);

    const failures = h.log.filter((entry) => entry[0] === 'fatal');
    assert.strictEqual(failures.length, 1);
    const failure = failures[0][2];
    assert.strictEqual(
        startupGroupLifecycleModule.isMMTSStartupGroupFailure(
            failure,
            defaultPlaybackOperation
        ),
        true
    );
    assert.strictEqual(failure.phase, 'appending');
    assert.strictEqual(failure.reason, 'append-timeout');

    h.updateEnd('audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'startupGroupAppended'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);
}

function testStartupGroupCompleteAppendClearsWatchdogBeforeRelease() {
    resetTimers();
    let released = false;
    const h = makeHarness({
        config: {isMMTS: true},
        output: {
            onStartupGroupAppended() {
                assert.strictEqual(pendingTimers.size, 0);
                released = true;
            },
        },
    });
    h.sm.onStartupGroup(makeStartupGroup());
    assert.strictEqual(pendingTimers.size, 1);
    h.updateEnd('video');
    h.updateEnd('audio');
    h.updateEnd('video');
    assert.strictEqual(pendingTimers.size, 1);
    assert.strictEqual(released, false);
    h.updateEnd('audio');
    assert.strictEqual(released, true);
    assert.strictEqual(pendingTimers.size, 0);
}

function testStaleStartupGroupWatchdogCannotFailNewOperation() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onStartupGroup(makeStartupGroup());
    const oldTimerId = Array.from(pendingTimers.keys())[0];
    const oldCallback = pendingTimers.get(oldTimerId).callback;

    const retryOperation = playbackOperationModule.createNextPlaybackAttempt(
        defaultPlaybackOperation,
        {
        phase: 'adaptive-retry',
        }
    );
    assert.strictEqual(h.sm.setPlaybackOperation(retryOperation), true);
    assert.strictEqual(pendingTimers.has(oldTimerId), false);
    h.updateEnd('video');
    h.sm.onStartupGroup(makeStartupGroup(retryOperation));
    const newTimerId = Array.from(pendingTimers.keys())[0];
    assert.notStrictEqual(newTimerId, oldTimerId);

    oldCallback();
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    assert.strictEqual(pendingTimers.has(newTimerId), true);

    h.updateEnd('video');
    h.updateEnd('audio');
    h.updateEnd('video');
    h.updateEnd('audio');
    assert.strictEqual(pendingTimers.size, 0);
}

function testInvalidStartupGroupContractEmitsStructuredFailureOnce() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    const invalid = makeStartupGroup();
    invalid.audioMediaSegment = null;
    invalid.audioEnd = undefined;
    h.sm.onStartupGroup(invalid);
    h.sm.onStartupGroup(invalid);

    const failures = h.log.filter((entry) => entry[0] === 'fatal');
    assert.strictEqual(failures.length, 1);
    const failure = failures[0][2];
    assert.strictEqual(failure.kind, 'startup-group');
    assert.strictEqual(failure.phase, 'appending');
    assert.strictEqual(failure.reason, 'invalid-contract');
    assert.strictEqual(failure.transactionId, defaultPlaybackOperation.transactionId);
    assert.strictEqual(failure.mseBufferGeneration, defaultPlaybackOperation.timelineGeneration);
    assert.strictEqual(failure.missing.includes('audio-media'), true);
    assert.strictEqual(pendingTimers.size, 0);
}

function testStartupGroupAppendFailuresKeepExactIdentityAndEmitOnce() {
    function assertFailure(h, reason, operation = defaultPlaybackOperation) {
        const failures = h.log.filter((entry) => entry[0] === 'fatal');
        assert.strictEqual(failures.length, 1);
        const failure = failures[0][2];
        assert.strictEqual(
            startupGroupLifecycleModule.isMMTSStartupGroupFailure(failure, operation),
            true
        );
        assert.strictEqual(failure.phase, 'appending');
        assert.strictEqual(failure.reason, reason);
        h.sm.onFatal({code: -1, msg: 'late duplicate'});
        assert.strictEqual(h.log.filter((entry) => entry[0] === 'fatal').length, 1);
    }

    resetTimers();
    const initFailure = makeHarness({
        config: {isMMTS: true},
        output: {
            appendInit() {
                return {ok: false, fatal: true, error: {code: -1, msg: 'init failed'}};
            },
        },
    });
    initFailure.sm.onStartupGroup(makeStartupGroup());
    assertFailure(initFailure, 'append-init');

    resetTimers();
    const parserFailure = makeHarness({
        config: {isMMTS: true},
        output: {
            resetParserState() {
                return {ok: false, fatal: true, error: {code: -1, msg: 'reset failed'}};
            },
        },
    });
    parserFailure.sourceBuffers.video.exists = true;
    const parserGroup = makeStartupGroup();
    parserGroup.videoInitSegment.resetParserState = true;
    parserFailure.sm.onStartupGroup(parserGroup);
    assertFailure(parserFailure, 'parser-reset');

    resetTimers();
    const mediaFailure = makeHarness({
        config: {isMMTS: true},
        output: {
            appendMedia(type) {
                if (type === 'video') {
                    return {ok: false, fatal: true, error: {code: -1, msg: 'media failed'}};
                }
                return {ok: true};
            },
        },
    });
    mediaFailure.sm.onStartupGroup(makeStartupGroup());
    mediaFailure.updateEnd('video');
    mediaFailure.updateEnd('audio');
    assertFailure(mediaFailure, 'append-media');
}

function testPendingStartupGroupExternalFatalIsStructured() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onStartupGroup(makeStartupGroup());
    const staleOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'stale-mse-buffer-state-machine-test',
        timelineGeneration: 0,
        kind: 'startup',
        transactionId: 0,
        phase: 'stale',
        requestedTimeMilliseconds: 0,
    });
    h.sm.onFatal(startupGroupLifecycleModule.createMMTSStartupGroupFailure(
        staleOperation,
        'appending',
        'append-timeout',
        ['video-media']
    ));
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    assert.strictEqual(pendingTimers.size, 1);
    h.sm.onExternalMSEError({
        code: -1,
        msg: 'stale external fatal',
        playbackOperation: staleOperation,
    });
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    assert.strictEqual(pendingTimers.size, 1);
    h.sm.onExternalMSEError({
        code: -1,
        msg: 'external fatal',
        playbackOperation: Object.assign({}, defaultPlaybackOperation),
    });
    const failures = h.log.filter((entry) => entry[0] === 'fatal');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0][2].phase, 'appending');
    assert.strictEqual(failures[0][2].reason, 'mse-fatal');
    assert.strictEqual(pendingTimers.size, 0);
}

function testStartupGroupFailureRequiresExactCurrentOperation() {
    resetTimers();
    const h = makeHarness({config: {isMMTS: true}});
    const staleOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'stale-mse-buffer-state-machine-test',
        timelineGeneration: 0,
        kind: 'startup',
        transactionId: 0,
        phase: 'stale',
        requestedTimeMilliseconds: 0,
    });
    const staleFailure = startupGroupLifecycleModule.createMMTSStartupGroupFailure(
        staleOperation,
        'collecting',
        'timeout',
        ['video-media']
    );
    h.sm.onStartupGroupFailure(staleFailure);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);

    const currentFailure = startupGroupLifecycleModule.createMMTSStartupGroupFailure(
        defaultPlaybackOperation,
        'collecting',
        'timeout',
        ['video-media']
    );
    h.sm.onStartupGroupFailure(currentFailure);
    assert.strictEqual(h.log.filter((entry) => entry[0] === 'fatal').length, 1);
}

function testRecommendedSeekPointWaitsForPlayableIntersection() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 28, end: 30});
    h.sm.onRecommendedSeekPoint(28);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekMedia'), false);

    h.sourceBuffers.audio.exists = true;
    h.ranges.audio.push({start: 28, end: 30});
    h.sm.onMediaState(0, 4, 'progress');
    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' &&
            entry[1] === 28 &&
            entry[2] === 'RECOMMEND_SEEKPOINT'
        ),
        true
    );
}

function testRecommendedSeekPointMovesToActualFutureIntersection() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sm.onUserSeek(237.682);
    h.sm.onRecommendedSeekPoint(243.444);

    h.ranges.video.push({start: 243.61, end: 245});
    h.ranges.audio.push({start: 243.576, end: 245});
    h.sm.onMediaState(237.682, 1, 'progress');

    assert.strictEqual(
        h.log.some((entry) =>
            entry[0] === 'seekMedia' &&
            entry[1] === 243.61 &&
            entry[2] === 'RECOMMEND_SEEKPOINT'
        ),
        true
    );
}

function testFutureSeekAudioUsesFutureVideoRangeForLeadControl() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.sm.onUserSeek(237.682);
    h.ranges.video.push({start: 243.61, end: 244.2});

    h.sm.onMediaSegment('audio', makeSegment('audio', 243.576, 243.896, 1024));

    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'audio'),
        true
    );
}

function testBufferedUserSeekStillFlushesAndSeeksTransmuxer() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 10, end: 15});
    h.ranges.audio.push({start: 10, end: 15});

    h.sm.onUserSeek(12);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'flushPending'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer'), false);
    h.updateEnd('video');
    h.updateEnd('audio');
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'seekTransmuxer' && entry[1] === 12000),
        true
    );
}

function testUnbufferedUserSeekFlushesAndSeeksTransmuxer() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: true, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.sourceBuffers.audio.exists = true;
    h.ranges.video.push({start: 0, end: 5});
    h.ranges.audio.push({start: 0, end: 5});

    h.sm.onUserSeek(30);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'flushPending'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'removeRange'), true);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'USER_SEEK'), false);
    h.updateEnd('video');
    h.updateEnd('audio');
    assert.strictEqual(h.log.some((entry) => entry[0] === 'seekTransmuxer' && entry[1] === 30000), true);
    const seekIndex = h.log.findIndex((entry) => entry[0] === 'seekTransmuxer' && entry[1] === 30000);
    const resumeIndex = h.log.findIndex((entry) => entry[0] === 'resumeTransmuxer' && entry[1] === 'USER_SEEK');
    assert(seekIndex >= 0);
    assert(resumeIndex > seekIndex);
}

function testMMTSSourceIdentityRejectsBackwardSourceOnForwardTimeline() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 1,
        filePosition: 100000,
        rawDts: 0,
        rawPts: 0,
        dts: 0,
        pts: 0,
    }, {
        sampleNumber: 8,
        filePosition: 110000,
        rawDts: 900,
        rawPts: 900,
        dts: 900,
        pts: 900,
    })));
    h.updateEnd('video');

    h.sm.onMediaSegment('video', makeSegment('video', 1, 2, 1024, makeMMTSSource({
        mpuSequenceNumber: 9,
        sampleNumber: 1,
        filePosition: 20000,
        rawDts: 0,
        rawPts: 0,
        dts: 1000,
        pts: 1000,
    })));

    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length, 1);
    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'pauseTransmuxer' && entry[1] === 'MMTS_SOURCE_IDENTITY'),
        true
    );
}

function testMMTSSourceIdentityAllowsNewSeekGeneration() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    h.ranges.video.push({start: 0, end: 1});

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 110000,
        rawDts: 900,
        rawPts: 900,
    })));
    h.updateEnd('video');

    h.sm.onSeek(30);
    h.updateEnd('video');
    h.sm.onMediaSegment('video', makeSegment('video', 30, 31, 1024, makeMMTSSource({
        mpuSequenceNumber: 3,
        sampleNumber: 1,
        filePosition: 20000,
        rawDts: 0,
        rawPts: 0,
        dts: 30000,
        pts: 30000,
    })));

    assert.strictEqual(
        h.log.some((entry) => entry[0] === 'appendMedia' && entry[1] === 'video' && entry[2] === 30),
        true
    );
}

function testMMTSSourceIdentityAllowsFilePositionReorderWithoutRawDtsRollback() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 110000,
        rawDts: 900,
        rawPts: 900,
    })));
    h.updateEnd('video');

    h.sm.onMediaSegment('video', makeSegment('video', 1, 2, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 9,
        filePosition: 90000,
        rawDts: 1000,
        rawPts: 1000,
        dts: 1000,
        pts: 1000,
    })));

    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length, 2);
}

function testMMTSSourceIdentityAllowsSameMpuSampleReorderWithoutSourceRollback() {
    const h = makeHarness({config: {isMMTS: true, isLive: false}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 100000,
        rawDts: 900,
        rawPts: 900,
    })));
    h.updateEnd('video');

    h.sm.onMediaSegment('video', makeSegment('video', 1, 2, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 112000,
        rawDts: 1000,
        rawPts: 1000,
        dts: 1000,
        pts: 1000,
    })));

    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length, 2);
}

function testNonMMTSSourceIdentityDoesNotBlockAppend() {
    const h = makeHarness({config: {isMMTS: false, isLive: false}});
    h.sourceBuffers.video.exists = true;

    h.sm.onMediaSegment('video', makeSegment('video', 0, 1, 1024, makeMMTSSource({
        mpuSequenceNumber: 10,
        sampleNumber: 8,
        filePosition: 110000,
        rawDts: 900,
        rawPts: 900,
    })));
    h.updateEnd('video');
    h.sm.onMediaSegment('video', makeSegment('video', 1, 2, 1024, makeMMTSSource({
        mpuSequenceNumber: 9,
        sampleNumber: 1,
        filePosition: 20000,
        rawDts: 0,
        rawPts: 0,
        dts: 1000,
        pts: 1000,
    })));

    assert.strictEqual(h.log.filter((entry) => entry[0] === 'appendMedia' && entry[1] === 'video').length, 2);
}

function testMMTSPlaybackOperationFencesStaleAndMissingInput() {
    const h = makeHarness({config: {isMMTS: true}});
    h.sm.onMediaInfo({hasAudio: false, hasVideo: true});
    h.sourceBuffers.video.exists = true;
    const seekOperation = makePlaybackOperation(
        'seek', 10, undefined, 0, 'requested', 10000
    );
    assert.strictEqual(h.sm.setPlaybackOperation(seekOperation), true);
    h.sm.onSeek(10);

    const baselineAppends = h.log.filter((entry) =>
        entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ).length;
    h.sm.onInitSegment('video', makeInit('video'));
    h.sm.onMediaSegment('video', makeSegment('video', 10, 11, 1024));

    const missingInit = makeInit('video');
    delete missingInit.playbackOperation;
    delete missingInit.mseBufferGeneration;
    const missingMedia = makeSegment('video', 10, 11, 1024);
    delete missingMedia.playbackOperation;
    delete missingMedia.mseBufferGeneration;
    h.sm.onInitSegment('video', missingInit);
    h.sm.onMediaSegment('video', missingMedia);

    const wrongGeneration = attachPlaybackOperation(
        makeSegment('video', 10, 11, 1024),
        seekOperation
    );
    wrongGeneration.mseBufferGeneration = seekOperation.timelineGeneration - 1;
    h.sm.onMediaSegment('video', wrongGeneration);

    const staleGroup = attachStartupGroupOperation({
        videoInitSegment: makeInit('video'),
        videoMediaSegment: makeSegment('video', 10, 11, 1024),
        startupTime: 10,
        videoDecodeStart: 10,
        videoCompositionStart: 10,
        syncPoint: 10,
        playableStart: 10,
        playableEnd: 11,
        hasAudio: false,
        hasVideo: true,
    });
    h.sm.onStartupGroup(staleGroup);
    const missingGroup = Object.assign({}, staleGroup);
    delete missingGroup.playbackOperation;
    delete missingGroup.mseBufferGeneration;
    h.sm.onStartupGroup(missingGroup);
    h.sm.onEndOfStream(defaultPlaybackOperation);

    assert.strictEqual(h.log.filter((entry) =>
        entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ).length, baselineAppends);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    assert.strictEqual(h.log.some((entry) => entry[0] === 'endOfStream'), false);

    const fresh = attachPlaybackOperation(
        makeSegment('video', 10, 11, 1024),
        seekOperation
    );
    h.sm.onMediaSegment('video', fresh);
    assert.strictEqual(h.appendedSegments[h.appendedSegments.length - 1], fresh);
    assert.strictEqual(fresh.mseBufferGeneration, 10);
    assert.strictEqual(fresh.playbackOperation.timelineGeneration, 10);
}

function testAudioTrackSwitchFailurePhasesAreReportedOnce() {
    function run(phase, transactionId) {
        const failures = [];
        const output = {
            onAudioTrackSwitchRebuildFailed(failure) {
                failures.push(failure);
            },
        };
        if (phase === 'append-init') {
            output.appendInit = () => ({ok: false, error: {msg: 'append init failed'}});
        } else if (phase === 'append-media') {
            output.appendMedia = () => ({ok: false, error: {msg: 'append media failed'}});
        } else if (phase === 'reset-parser-state') {
            output.resetParserState = () => ({ok: false, error: {msg: 'reset failed'}});
        }
        const h = makeHarness({config: {isMMTS: true, isLive: true}, output});
        const request = makeAudioTrackSwitchRebuildRequest(12, 13, transactionId);

        if (phase === 'plan-validation') {
            request.videoSegments = [];
            assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), false);
        } else if (phase === 'rebuild-media-source') {
            h.failRebuild();
            assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
        } else if (phase === 'append-init') {
            assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
            h.sm.onSourceOpen();
        } else if (phase === 'append-media') {
            assert.strictEqual(submitAudioTrackSwitchRebuild(h, request), true);
            h.sm.onSourceOpen();
            h.updateEnd('video');
            h.updateEnd('audio');
        } else if (phase === 'reset-parser-state') {
            assert.strictEqual(h.sm.setPlaybackOperation(request.operation), true);
            assert.strictEqual(h.sm.onAudioTrackSwitch({
                stage: 'request',
                mode: 'live',
                operation: request.operation,
                transactionId,
            }), true);
            h.sourceBuffers.audio.exists = true;
            const resetInit = attachPlaybackOperation(makeInit('audio'), request.operation);
            resetInit.resetParserState = true;
            h.sm.onInitSegment('audio', resetInit);
        } else {
            assert.strictEqual(h.sm.setPlaybackOperation(request.operation), true);
            assert.strictEqual(h.sm.onAudioTrackSwitch({
                stage: 'request',
                mode: 'live',
                operation: request.operation,
                transactionId,
            }), true);
            h.sm.onExternalMSEError({
                kind: 'audio-switch',
                transactionId,
                playbackOperation: request.operation,
                msg: 'external fatal',
            });
        }

        assert.strictEqual(failures.length, 1, `${phase} should fail once`);
        assert.strictEqual(failures[0].kind, 'audio-switch');
        assert.strictEqual(failures[0].transactionId, transactionId);
        assert.strictEqual(failures[0].phase, phase === 'external' ? 'mse-fatal' : phase);
        h.sm.onExternalMSEError({
            kind: 'audio-switch',
            transactionId,
            playbackOperation: request.operation,
            msg: 'stale repeated fatal',
        });
        assert.strictEqual(failures.length, 1, `${phase} repeated failure must be ignored`);
        assert.strictEqual(h.log.some((entry) => entry[0] === 'fatal'), false);
    }

    run('plan-validation', 51);
    run('rebuild-media-source', 52);
    run('append-init', 53);
    run('append-media', 54);
    run('reset-parser-state', 55);
    run('external', 56);
}

function testVideoTrackSwitchRejectsMissingInitWrongAttemptAndStaleTransactionAtomically() {
    function makeVideoCommit(operation, videoSwitch, overrides = {}) {
        const initSegment = attachPlaybackOperation(makeInit('video'), operation);
        const mediaSegment = attachPlaybackOperation(
            makeSegment('video', videoSwitch.playableStart, videoSwitch.playableEnd, 1024),
            operation
        );
        initSegment.mmtsVideoTrackSwitch = makeVideoTrackSwitchIdentity(videoSwitch);
        markRandomAccessSafeVideoSegment(mediaSegment, videoSwitch);
        mediaSegment.mmtsVideoTrackSwitch = videoSwitch;
        return Object.assign({
            stage: 'commit_ready',
            operation,
            transactionId: operation.transactionId,
            videoSwitch,
            videoInitSegment: initSegment,
            videoMediaSegment: mediaSegment,
        }, overrides);
    }

    const missingFailures = [];
    const missing = makeHarness({
        config: {isMMTS: true},
        output: {onVideoTrackSwitchFailed(failure) { missingFailures.push(failure); }},
    });
    missing.sourceBuffers.video.exists = true;
    const operation = makePlaybackOperation('video-switch', 61, 0xf201);
    const videoSwitch = makeVideoTrackSwitch(12, 13, 61);
    assert.strictEqual(missing.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(missing.sm.onVideoTrackSwitch({
        stage: 'request', operation, transactionId: 61,
    }), true);
    assert.strictEqual(missing.sm.onVideoTrackSwitch(
        makeVideoCommit(operation, videoSwitch, {videoInitSegment: undefined})
    ), false);
    assert.strictEqual(missingFailures.length, 1);
    assert.strictEqual(missingFailures[0].phase, 'plan-validation');
    assert.strictEqual(missing.log.some((entry) =>
        entry[0] === 'resetParserState' || entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ), false);

    const identityFailures = [];
    const wrongIdentity = makeHarness({
        config: {isMMTS: true},
        output: {onVideoTrackSwitchFailed(failure) { identityFailures.push(failure); }},
    });
    wrongIdentity.sourceBuffers.video.exists = true;
    const identityOperation = makePlaybackOperation('video-switch', 63, 0xf201);
    const identitySwitch = makeVideoTrackSwitch(12, 13, 63);
    assert.strictEqual(wrongIdentity.sm.setPlaybackOperation(identityOperation), true);
    assert.strictEqual(wrongIdentity.sm.onVideoTrackSwitch({
        stage: 'request', operation: identityOperation, transactionId: 63,
    }), true);
    const identityCommit = makeVideoCommit(identityOperation, identitySwitch);
    identityCommit.videoInitSegment.mmtsVideoTrackSwitch.packetId = 0xf202;
    assert.strictEqual(wrongIdentity.sm.onVideoTrackSwitch(identityCommit), false);
    assert.strictEqual(identityFailures.length, 1);
    assert.strictEqual(identityFailures[0].phase, 'plan-validation');
    assert.strictEqual(wrongIdentity.log.some((entry) =>
        entry[0] === 'resetParserState' || entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ), false);

    const wrongAttempt = makeHarness({
        config: {isMMTS: true},
        output: {onVideoTrackSwitchFailed() {}},
    });
    wrongAttempt.sourceBuffers.video.exists = true;
    assert.strictEqual(wrongAttempt.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(wrongAttempt.sm.onVideoTrackSwitch({
        stage: 'request', operation, transactionId: 61,
    }), true);
    const wrongOperation = Object.assign({}, operation, {attempt: 1});
    const wrongCommit = makeVideoCommit(operation, videoSwitch);
    attachPlaybackOperation(wrongCommit.videoInitSegment, wrongOperation);
    attachPlaybackOperation(wrongCommit.videoMediaSegment, wrongOperation);
    assert.strictEqual(wrongAttempt.sm.onVideoTrackSwitch(wrongCommit), false);
    assert.strictEqual(wrongAttempt.log.some((entry) =>
        entry[0] === 'resetParserState' || entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ), false);

    const stale = makeHarness({config: {isMMTS: true}});
    stale.sourceBuffers.video.exists = true;
    assert.strictEqual(stale.sm.setPlaybackOperation(operation), true);
    assert.strictEqual(stale.sm.onVideoTrackSwitch({
        stage: 'request', operation, transactionId: 61,
    }), true);
    const newOperation = makePlaybackOperation('video-switch', 62, 0xf202);
    assert.strictEqual(stale.sm.setPlaybackOperation(newOperation), true);
    assert.strictEqual(stale.sm.onVideoTrackSwitch({
        stage: 'request', operation: newOperation, transactionId: 62,
    }), true);
    assert.strictEqual(stale.sm.onVideoTrackSwitch(makeVideoCommit(operation, videoSwitch)), false);
    assert.strictEqual(stale.sm._track_switch_transaction.transactionId, 62);
    assert.strictEqual(stale.sm.cancelVideoTrackSwitch(operation), false);
    assert.strictEqual(stale.sm.cancelVideoTrackSwitch(newOperation), true);
    assert.strictEqual(stale.log.some((entry) =>
        entry[0] === 'resetParserState' || entry[0] === 'appendInit' || entry[0] === 'appendMedia'
    ), false);
}

testAppendPriorityAndAsyncGate();
testInitialSourceBuffersArePreparedBeforeAppendingInit();
testUntypedUpdateEndInfersCompletedTrackDuringParallelAppends();
testSameTrackInflightIdentityCannotBeOverwritten();
testQueuedMediaSegmentsAreBatchedForMSEAppend();
testRemoveBeforeAppendUnderBudgetPressure();
testPressureDoesNotDeleteFutureRanges();
testPressureCleanupOnlyRemovesPlayedData();
testVideoCleanupRetainsDecoderRoot();
testHardBudgetCountsBackwardBytesAndOverridesLongEmergencyRetention();
testAudioLeadBlocksUntilVideoCatchesUp();
testVideoLeadYieldsToPendingAudio();
testAudioOnlyMediaDoesNotWaitForVideo();
testAudioOnlyUserSeekFlushesBufferedRange();
testQuotaWaitsForCleanupOrProgress();
testAudioQuotaCanEvictPlayedVideoData();
testInitQuotaDoesNotRequeueAsMedia();
testMissingAudioSourceBufferWaitsForVideoInitUpdateEnd();
testSeekFlushesBeforeNewTimelineAppend();
testConfiguredSeekRebuildsMediaSourceInsteadOfFlushingOldRanges();
testSeekDropsOldTimelineSegmentsBeforeTargetWindow();
testRecommendedSeekPointKeepsEarlierPrerollSegments();
testInvalidTimestampFailsExplicitly();
testEndOfStreamWaitsForQueuesAndUpdateEnd();
testAudioTrackSwitchRequestDropsQueuedOldInit();
testLiveAudioTrackSwitchCollectsThroughExistingBackpressure();
testVodAudioTrackRebuildWaitsForIdleSeekWithoutRemovingBuffers();
testVodAudioTrackSwitchPreparationCanBeCancelledWithoutLeavingPause();
testVodAudioTrackRebuildStartsTransmuxerSeekFromEndedMediaSource();
testVodAudioTrackSwitchCollectsThroughExistingBackpressure();
testAudioTrackSwitchCancelIsExactAndAllowsImmediateSuccessor();
testAudioTrackSwitchCancelRejectsStaleAttemptWithinTransaction();
testAudioTrackSwitchCancelDropsPendingPlanAndFencesLateRebuild();
testAudioTrackSwitchCancelDuringRebuildDropsQueuedDataAndLateCallbacks();
testAudioTrackSwitchCancelWhileWaitingForPlayableIntersection();
testLegacyAudioCancelDoesNotCancelActiveVideoTransaction();
testAudioTrackSwitchRebuildRejectsIncompleteOrMismatchedPlan();
testAudioTrackSwitchRebuildAcceptsCRAPresentationWindow();
testAudioTrackSwitchRebuildWaitsForIdleAndReplaysBothTracks();
testAudioTrackSwitchRebuildReusesExistingSourceBuffers();
testVodForwardAudioTrackSwitchPreservesVideoBuffer();
testVodForwardAudioTrackSwitchAcceptsMultipleShortFragments();
testInPlaceAudioTrackSwitchCancelDropsPendingFlushAndReplay();
testAudioTrackSwitchRebuildWaitsWithoutPlayableIntersection();
testAudioTrackSwitchRebuildFailureIsFatalWithoutSingleBufferFallback();
testAudioTrackSwitchRebuildFailureDefersToTransactionOwner();
testInvalidAudioRebuildPlanDefersToTransactionOwner();
testBackpressurePausesSeekWithoutOverridingSeekState();
testSeekStateWaitsForMediaElementSeekedEvent();
testVideoTrackSwitchConsumesRemuxedVideoWindowWithoutTimelineSeek();
testVideoTrackSwitchRequestsAndCommitsFromEndedMediaSource();
testVideoTrackSwitchRejectsInvalidRemuxedWindow();
testHevcVideoInitWaitsForAudioInit();
testHev1VideoInitWaitsForAudioInit();
testMMTSVideoInitHonorsHevcDeferOptOut();
testNonHevcMMTSVideoInitDoesNotWaitForAudioInit();
testPlayableForwardDurationRequiresAudioVideoIntersection();
testPendingVideoBytesPauseEvenWhenAudioIsMissing();
testBackpressureDoesNotRequireBothTrackData();
testSeekBackpressureCapsSingleTrackDuration();
testPendingQueuesTriggerBackpressureBeforeMSEAppend();
testPendingTimelineDurationTriggersBackpressureAfterSeek();
testAudioBytesTriggerBackpressureAndRecovery();
testFatalMediaElementStateStopsProducerAndDropsQueuedOutput();
testForwardDurationCanTriggerBackpressureAndRecover();
testMMTSVodWaitingAtByteCapPrefetchesUntilPlaybackProgresses();
testMMTSDirectSeekKeepsRequestedTimeWithBufferedVideoRandomAccessPreroll();
testMMTSDirectSeekWaitsWithoutBufferedVideoRandomAccessPoint();
testMMTSDirectSeekCrossesAudioOnlyGapWithContinuousVideoPreroll();
testNonMMTSDirectSeekKeepsRequestedTime();
testStartupGroupAppendsCompleteAudioVideoBatchBeforeRelease();
testSeekStartupGroupResetsBothSourceBufferParsers();
testOverlappingStartupAppendsKeepPerTrackCompletionIdentity();
testStartupGroupSeeksToFirstActualTrackIntersection();
testSeekStartupGroupPrerollsWithoutIntermediateRapSeek();
testStartupGroupRejectsMissingRequiredAudioSegment();
testStartupGroupAppendWatchdogIsAbsoluteAndFencesLateUpdateEnd();
testStartupGroupCompleteAppendClearsWatchdogBeforeRelease();
testStaleStartupGroupWatchdogCannotFailNewOperation();
testInvalidStartupGroupContractEmitsStructuredFailureOnce();
testStartupGroupAppendFailuresKeepExactIdentityAndEmitOnce();
testPendingStartupGroupExternalFatalIsStructured();
testStartupGroupFailureRequiresExactCurrentOperation();
testRecommendedSeekPointWaitsForPlayableIntersection();
testRecommendedSeekPointMovesToActualFutureIntersection();
testFutureSeekAudioUsesFutureVideoRangeForLeadControl();
testBufferedUserSeekStillFlushesAndSeeksTransmuxer();
testUnbufferedUserSeekFlushesAndSeeksTransmuxer();
testMMTSSourceIdentityRejectsBackwardSourceOnForwardTimeline();
testMMTSSourceIdentityAllowsNewSeekGeneration();
testMMTSSourceIdentityAllowsFilePositionReorderWithoutRawDtsRollback();
testMMTSSourceIdentityAllowsSameMpuSampleReorderWithoutSourceRollback();
testNonMMTSSourceIdentityDoesNotBlockAppend();
testMMTSPlaybackOperationFencesStaleAndMissingInput();
testAudioTrackSwitchFailurePhasesAreReportedOnce();
testVideoTrackSwitchRejectsMissingInitWrongAttemptAndStaleTransactionAtomically();

console.log('mse-buffer-state-machine tests passed');

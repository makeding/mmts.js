#!/usr/bin/env node

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/core/mse-controller.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default MSEController;', 'module.exports = MSEController;');

const moduleObject = {exports: {}};
const sandbox = {
    module: moduleObject,
    exports: moduleObject.exports,
    EventEmitter,
    Log: {e() {}, v() {}, w() {}},
    Browser: {},
    MSEEvents: {ERROR: 'error', UPDATE_END: 'update_end'},
    IllegalStateException: class IllegalStateException extends Error {},
    console,
    self: {},
};

vm.runInNewContext(source, sandbox, {filename: sourcePath});
const MSEController = moduleObject.exports;

function makeRanges(ranges) {
    return {
        length: ranges.length,
        start(index) {
            return ranges[index].start;
        },
        end(index) {
            return ranges[index].end;
        },
    };
}

function makeController() {
    const controller = new MSEController({isLive: false});
    const ranges = makeRanges([
        {start: 0, end: 5},
        {start: 30, end: 40},
    ]);
    controller._sourceBuffers.video = {buffered: ranges};
    controller._sourceBuffers.audio = {buffered: ranges};
    controller._bufferedSegmentRecords.video = [
        {begin: 0, end: 5, byteLength: 500},
        {begin: 30, end: 40, byteLength: 1000},
    ];
    controller._bufferedSegmentRecords.audio = [
        {begin: 0, end: 5, byteLength: 100},
        {begin: 30, end: 40, byteLength: 200},
    ];
    return controller;
}

function testForwardDurationStopsAtFirstGap() {
    const info = makeController().getForwardBufferInfo(0);
    assert.strictEqual(info.videoForwardDuration, 5);
    assert.strictEqual(info.audioForwardDuration, 5);
    assert.strictEqual(info.forwardDuration, 5);
    assert.strictEqual(info.videoForwardBytes, 1500);
    assert.strictEqual(info.videoBufferedBytes, 1500);
    assert.strictEqual(info.audioBufferedBytes, 300);
}

function testForwardDurationStartsAtRangeCoveringCurrentTime() {
    const info = makeController().getForwardBufferInfo(30);
    assert.strictEqual(info.videoForwardDuration, 10);
    assert.strictEqual(info.audioForwardDuration, 10);
    assert.strictEqual(info.forwardDuration, 10);
}

function testForwardDurationDoesNotJumpToFutureRange() {
    const info = makeController().getForwardBufferInfo(6);
    assert.strictEqual(info.videoForwardDuration, 0);
    assert.strictEqual(info.audioForwardDuration, 0);
    assert.strictEqual(info.forwardDuration, 0);
}

function testInflightRecordCountsBytesWithoutClaimingPlayableDuration() {
    const controller = makeController();
    controller._bufferedSegmentRecords.video.push({
        begin: 5,
        end: 8,
        byteLength: 300,
        pending: true,
    });

    const pending = controller.getForwardBufferInfo(0);
    assert.strictEqual(pending.videoForwardBytes, 1800);
    assert.strictEqual(pending.videoForwardDuration, 5);
    assert.strictEqual(controller._bufferedSegmentRecords.video.length, 3);

    controller._sourceBuffers.video.buffered = makeRanges([
        {start: 0, end: 8},
        {start: 30, end: 40},
    ]);
    controller._markAppendedMediaSegmentRecordsComplete('video');
    const completed = controller.getForwardBufferInfo(0);
    assert.strictEqual(completed.videoForwardDuration, 8);
    assert.strictEqual(completed.videoBufferedBytes, 1800);
}

function testBufferedBytesShrinkAfterPlayedRangeRemoval() {
    const controller = makeController();
    const remaining = makeRanges([{start: 30, end: 40}]);
    controller._sourceBuffers.video.buffered = remaining;
    controller._sourceBuffers.audio.buffered = remaining;

    const info = controller.getForwardBufferInfo(30);
    assert.strictEqual(info.videoBufferedBytes, 1000);
    assert.strictEqual(info.audioBufferedBytes, 200);
}

function makeSourceBuffer(changeType, operations) {
    const sourceBuffer = {
        updating: false,
        buffered: makeRanges([]),
        addEventListener() {},
        removeEventListener() {},
        appendBuffer(data) {
            operations.push({type: 'append', byteLength: data.byteLength});
        },
    };
    if (changeType) {
        sourceBuffer.changeType = changeType;
    }
    return sourceBuffer;
}

function makeParserResetController(changeType) {
    const operations = [];
    const controller = new MSEController({isLive: false});
    const sourceBuffer = makeSourceBuffer(changeType, operations);
    const oldMimeType = 'audio/mp4;codecs=mp4a.40.2';
    const targetMimeType = 'audio/mp4;codecs=mp4a.40.5';
    controller._mediaSource = {
        readyState: 'open',
        removeSourceBuffer() {
            operations.push({type: 'remove'});
        },
    };
    controller._sourceBuffers.audio = sourceBuffer;
    controller._mimeTypes.audio = oldMimeType;
    return {controller, sourceBuffer, operations, oldMimeType, targetMimeType};
}

function testParserResetUsesChangeTypeWithoutRemovingAudioSourceBuffer() {
    let changedMimeType = null;
    const harness = makeParserResetController((mimeType) => {
        changedMimeType = mimeType;
    });

    const result = harness.controller.resetParserStateDirect('audio', harness.targetMimeType);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(changedMimeType, harness.targetMimeType);
    assert.strictEqual(harness.controller._sourceBuffers.audio, harness.sourceBuffer);
    assert.strictEqual(harness.controller._mimeTypes.audio, harness.targetMimeType);
    assert.strictEqual(harness.operations.some((entry) => entry.type === 'remove'), false);
}

function testParserResetAllowsChangeTypeToReopenEndedMediaSource() {
    let harness;
    harness = makeParserResetController((mimeType) => {
        assert.strictEqual(mimeType, harness.targetMimeType);
        harness.controller._mediaSource.readyState = 'open';
    });
    harness.controller._mediaSource.readyState = 'ended';

    const result = harness.controller.resetParserStateDirect('audio', harness.targetMimeType);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(harness.controller._mediaSource.readyState, 'open');
    assert.strictEqual(harness.controller._sourceBuffers.audio, harness.sourceBuffer);
}

function testParserResetWithoutChangeTypeFailsWithoutRemovingAudioSourceBuffer() {
    const harness = makeParserResetController();

    const result = harness.controller.resetParserStateDirect('audio', harness.targetMimeType);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.message, 'audio SourceBuffer.changeType is unavailable');
    assert.strictEqual(harness.controller._sourceBuffers.audio, harness.sourceBuffer);
    assert.strictEqual(harness.controller._mimeTypes.audio, harness.oldMimeType);
    assert.strictEqual(harness.operations.some((entry) => entry.type === 'remove'), false);
}

function testParserResetFailureDoesNotRemoveAudioSourceBuffer() {
    const changeTypeError = new Error('changeType failed');
    const harness = makeParserResetController(() => {
        throw changeTypeError;
    });

    const result = harness.controller.resetParserStateDirect('audio', harness.targetMimeType);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, changeTypeError);
    assert.strictEqual(harness.controller._sourceBuffers.audio, harness.sourceBuffer);
    assert.strictEqual(harness.controller._mimeTypes.audio, harness.oldMimeType);
    assert.strictEqual(harness.operations.some((entry) => entry.type === 'remove'), false);
}

function testFreshAudioInitForFullMediaSourceRebuildNeverRemovesSourceBuffer() {
    const operations = [];
    const controller = new MSEController({isLive: false});
    const sourceBuffer = makeSourceBuffer(null, operations);
    controller._mediaSource = {
        readyState: 'open',
        streaming: true,
        addSourceBuffer(mimeType) {
            operations.push({type: 'add', mimeType});
            return sourceBuffer;
        },
        removeSourceBuffer() {
            operations.push({type: 'remove'});
        },
    };

    const result = controller.appendInitSegmentDirect({
        type: 'audio',
        container: 'audio/mp4',
        codec: 'mp4a.40.5',
        data: {byteLength: 256},
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(operations[0].type, 'add');
    assert.strictEqual(operations[1].type, 'append');
    assert.strictEqual(operations.some((entry) => entry.type === 'remove'), false);
}

function testAbandonReleasesSourceBuffersBeforeDroppingMediaSource() {
    const operations = [];
    const controller = new MSEController({isLive: false});
    const makeSourceBuffer = (type) => ({
        type,
        removeEventListener() {},
    });
    const videoSourceBuffer = makeSourceBuffer('video');
    const audioSourceBuffer = makeSourceBuffer('audio');
    controller._mediaSource = {
        readyState: 'open',
        removeSourceBuffer(sourceBuffer) {
            operations.push({type: 'remove', trackType: sourceBuffer.type});
        },
        removeEventListener() {},
    };
    controller._sourceBuffers.video = videoSourceBuffer;
    controller._sourceBuffers.audio = audioSourceBuffer;

    controller.abandon();

    assert.deepStrictEqual(operations, [
        {type: 'remove', trackType: 'video'},
        {type: 'remove', trackType: 'audio'},
    ]);
    assert.strictEqual(controller._sourceBuffers.video, null);
    assert.strictEqual(controller._sourceBuffers.audio, null);
    assert.strictEqual(controller._mediaSource, null);
}

testForwardDurationStopsAtFirstGap();
testForwardDurationStartsAtRangeCoveringCurrentTime();
testForwardDurationDoesNotJumpToFutureRange();
testInflightRecordCountsBytesWithoutClaimingPlayableDuration();
testBufferedBytesShrinkAfterPlayedRangeRemoval();
testParserResetUsesChangeTypeWithoutRemovingAudioSourceBuffer();
testParserResetAllowsChangeTypeToReopenEndedMediaSource();
testParserResetWithoutChangeTypeFailsWithoutRemovingAudioSourceBuffer();
testParserResetFailureDoesNotRemoveAudioSourceBuffer();
testFreshAudioInitForFullMediaSourceRebuildNeverRemovesSourceBuffer();
testAbandonReleasesSourceBuffersBeforeDroppingMediaSource();

console.log('mse-controller forward info tests passed');

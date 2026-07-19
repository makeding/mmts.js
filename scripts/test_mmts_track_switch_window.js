#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadWindowContract() {
    const sourcePath = path.resolve(__dirname, '../src/player/mmts-track-switch-window.ts');
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
        },
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require,
        module: moduleObject,
        exports: moduleObject.exports,
        Array,
        Math,
        isFinite,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

const {
    canAppendMMTSLiveVideoContinuation,
    getMMTSFirstPlayableWindow,
    getMMTSSegmentDecodeRange,
    isMMTSRandomAccessSafeVideoSegment,
    selectMMTSTrackSwitchSegmentPrefix,
    validateMMTSTrackSwitchSegmentPrefix,
} = loadWindowContract();

function makeVideo(begin, end, firstPlayableWindow, info = {}) {
    const segment = {
        type: 'video',
        info: Object.assign({
            beginDts: begin * 1000,
            endDts: end * 1000,
        }, info),
    };
    if (firstPlayableWindow) {
        segment.firstPlayableWindow = firstPlayableWindow;
    }
    return segment;
}

function makeAudio(begin, end, info = {}) {
    return {
        type: 'audio',
        info: Object.assign({
            beginDts: begin * 1000,
            endDts: end * 1000,
        }, info),
    };
}

function makeWindow(decodeStart, playableStart, playableEnd, compositionStart = playableStart) {
    return {
        decodeStart,
        compositionStart,
        syncPoint: playableStart,
        playableStart,
        playableEnd,
    };
}

function testCRAWindowUsesPresentationCoverage() {
    const segment = makeVideo(
        2.553,
        2.686,
        makeWindow(2.553, 2.837, 2.987)
    );
    const range = getMMTSSegmentDecodeRange(segment);
    const window = getMMTSFirstPlayableWindow(segment);
    assert.strictEqual(range.start, 2.553);
    assert.strictEqual(range.end, 2.686);
    assert.strictEqual(window.playableStart, 2.837);
    assert.strictEqual(window.playableEnd, 2.987);

    const selected = selectMMTSTrackSwitchSegmentPrefix([segment], 'video', 2.837, 0.05);
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(selected[0], segment);
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix(selected, 'video', 2.837, 0.05),
        true
    );

    const deepReorder = makeVideo(2.553, 2.686, makeWindow(2.553, 12, 12.1));
    assert.notStrictEqual(getMMTSFirstPlayableWindow(deepReorder), null);
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix([deepReorder], 'video', 12, 0.05),
        true,
        'valid CRA presentation coverage must not be capped by DTS distance'
    );
}

function testVideoWithoutWindowUsesDTSCoverage() {
    const segment = makeVideo(2.553, 2.686, null, {
        endPts: 2987,
        lastSample: {pts: 2960, duration: 27},
    });
    assert.deepStrictEqual(
        Array.from(selectMMTSTrackSwitchSegmentPrefix([segment], 'video', 2.837, 0.05)),
        []
    );
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix([segment], 'video', 2.837, 0.05),
        false
    );
}

function testContiguousVideoContinuationExtendsCoverage() {
    const first = makeVideo(2.553, 2.686, makeWindow(2.553, 2.837, 2.9));
    const continuation = makeVideo(2.686, 2.82, null, {
        endPts: 3060,
        firstSample: {pts: 2980, duration: 20},
        lastSample: {pts: 3040, duration: 20},
    });
    const selected = selectMMTSTrackSwitchSegmentPrefix(
        [first, continuation],
        'video',
        2.837,
        0.2
    );
    assert.strictEqual(selected.length, 2);
    assert.strictEqual(selected[0], first);
    assert.strictEqual(selected[1], continuation);
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix(selected, 'video', 2.837, 0.2),
        true
    );

    const gap = makeVideo(2.95, 3.08, null, {endPts: 3200});
    const afterGap = makeVideo(3.08, 3.2, null, {endPts: 3350});
    assert.strictEqual(
        selectMMTSTrackSwitchSegmentPrefix(
            [first, gap, afterGap],
            'video',
            2.837,
            0.4
        ).length,
        0,
        'a middle decode gap must invalidate the prefix instead of being skipped'
    );
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix(
            [first, gap, afterGap],
            'video',
            2.837,
            0.4
        ),
        false
    );
}

function testAudioRetainsDTSCoverage() {
    const first = makeAudio(10, 10.2, {
        endPts: 20000,
    });
    first.firstPlayableWindow = makeWindow(10, 19, 20);
    const continuation = makeAudio(10.2, 10.35, {
        endPts: 22000,
    });

    assert.strictEqual(
        selectMMTSTrackSwitchSegmentPrefix([first], 'audio', 10.21, 0.05).length,
        0,
        'audio coverage must not use video windows or PTS extension'
    );
    const selected = selectMMTSTrackSwitchSegmentPrefix(
        [first, continuation],
        'audio',
        10.21,
        0.05
    );
    assert.strictEqual(selected.length, 2);
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix(selected, 'audio', 10.21, 0.05),
        true
    );
}

function testLiveVideoContinuationUsesDecodeRanges() {
    const first = makeVideo(2.553, 2.686, makeWindow(2.553, 2.837, 2.987));
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(first, makeVideo(2.686, 2.82)),
        true,
        'continuation end may remain below the RAP presentation end'
    );
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(first, makeVideo(2.786, 2.9)),
        true,
        'a 100ms decode gap is permitted'
    );
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(first, makeVideo(2.685, 2.82)),
        false,
        'decode overlap is not a continuation'
    );
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(first, makeVideo(2.686, 2.68)),
        false,
        'a non-forward range is invalid'
    );
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(first, makeVideo(2.787, 2.9)),
        false,
        'a decode gap over 100ms is rejected'
    );
}

function testRandomAccessSafeVideoContractIsExplicit() {
    const segment = makeVideo(2.553, 2.686, makeWindow(2.553, 2.837, 2.987), {
        firstSample: {isSyncPoint: true},
    });
    assert.strictEqual(isMMTSRandomAccessSafeVideoSegment(segment), false);
    segment.mmtsRandomAccessSafe = true;
    assert.strictEqual(isMMTSRandomAccessSafeVideoSegment(segment), true);
    segment.info.firstSample.isSyncPoint = false;
    assert.strictEqual(isMMTSRandomAccessSafeVideoSegment(segment), false);
}

function testWindowCoherenceAndInvalidInputs() {
    const segment = makeVideo(5, 5.1, makeWindow(5.01, 5.2, 5.3));
    assert.strictEqual(getMMTSFirstPlayableWindow(segment), null);
    assert.strictEqual(
        selectMMTSTrackSwitchSegmentPrefix([segment], 'video', 5.02, 0.05).length,
        0,
        'an explicit incoherent window must not fall back to DTS coverage'
    );

    const invalidComposition = makeVideo(5, 5.1, makeWindow(5, 5.2, 5.3, 5.21));
    assert.strictEqual(getMMTSFirstPlayableWindow(invalidComposition), null);

    const invalidSync = makeVideo(5, 5.1, Object.assign(makeWindow(5, 5.2, 5.3), {
        syncPoint: 5.21,
    }));
    assert.strictEqual(getMMTSFirstPlayableWindow(invalidSync), null);

    assert.strictEqual(getMMTSSegmentDecodeRange(null), null);
    assert.strictEqual(getMMTSSegmentDecodeRange({info: {beginDts: 1, endDts: 1}}), null);
    assert.strictEqual(getMMTSSegmentDecodeRange({info: {beginDts: NaN, endDts: 2}}), null);
    assert.strictEqual(getMMTSFirstPlayableWindow(null), null);
    assert.strictEqual(selectMMTSTrackSwitchSegmentPrefix(null, 'video', 0, 0.05).length, 0);
    assert.strictEqual(selectMMTSTrackSwitchSegmentPrefix([], 'video', 0, 0.05).length, 0);
    assert.strictEqual(
        selectMMTSTrackSwitchSegmentPrefix([makeVideo(0, 1)], 'invalid', 0, 0.05).length,
        0
    );
    assert.strictEqual(
        selectMMTSTrackSwitchSegmentPrefix([makeVideo(0, 1)], 'video', -1, 0.05).length,
        0
    );
    assert.strictEqual(
        validateMMTSTrackSwitchSegmentPrefix([makeVideo(0, 1)], 'video', 0, NaN),
        false
    );
    assert.strictEqual(canAppendMMTSLiveVideoContinuation(null, makeVideo(0, 1)), false);
    assert.strictEqual(
        canAppendMMTSLiveVideoContinuation(makeAudio(0, 1), makeVideo(1, 2)),
        false
    );
}

testCRAWindowUsesPresentationCoverage();
testVideoWithoutWindowUsesDTSCoverage();
testContiguousVideoContinuationExtendsCoverage();
testAudioRetainsDTSCoverage();
testLiveVideoContinuationUsesDecodeRanges();
testRandomAccessSafeVideoContractIsExplicit();
testWindowCoherenceAndInvalidInputs();

console.log('MMTS track-switch presentation window tests passed');

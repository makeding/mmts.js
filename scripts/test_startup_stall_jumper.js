#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/player/startup-stall-jumper.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        esModuleInterop: true
    }
}).outputText;

const timers = [];
const BufferWindow = {
    inspect(media) {
        return {
            currentTime: media.currentTime,
            currentRangeIndex: 0,
            atCurrentRangeEnd: true,
            nextRangeStart: 1,
            nextRangeEnd: 3,
            nextRangeGap: 0.5,
        };
    }
};
const moduleObject = {exports: {}};
vm.runInNewContext(compiled, {
    module: moduleObject,
    exports: moduleObject.exports,
    require(id) {
        if (id === '../utils/logger') {
            return {__esModule: true, default: {w() {}}};
        }
        if (id === './buffer-window') {
            return {__esModule: true, default: BufferWindow};
        }
        return require(id);
    },
    console,
    self: {performance: {now: () => 1}},
    window: {
        setTimeout(callback, delay) {
            timers.push({callback, delay, cleared: false});
            return timers.length;
        },
        clearTimeout(timer) {
            timers[timer - 1].cleared = true;
        },
    },
}, {filename: sourcePath});
const StartupStallJumper = moduleObject.exports.default;

function makeMedia() {
    const listeners = {};
    return {
        currentTime: 0.5,
        readyState: 1,
        paused: false,
        ended: false,
        seeking: false,
        buffered: {},
        addEventListener(type, listener) {
            listeners[type] = listener;
        },
        removeEventListener(type) {
            delete listeners[type];
        },
        hasEventListener(type) {
            return type in listeners;
        },
        fire(type) {
            listeners[type]({type});
        },
    };
}

function testMMTSGapJumpWaitsForConfirmedStall() {
    timers.splice(0, timers.length);
    const media = makeMedia();
    const seeks = [];
    const jumper = new StartupStallJumper(
        media,
        (target) => {
            seeks.push(target);
            return true;
        },
        2,
        1,
        true,
        true,
        true
    );

    media.fire('waiting');
    assert.deepStrictEqual(seeks, []);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].delay, 1200);
    timers[0].callback();
    assert.deepStrictEqual(seeks, [1]);
    jumper.destroy();
}

function testDefaultGapJumpRemainsImmediate() {
    timers.splice(0, timers.length);
    const media = makeMedia();
    const seeks = [];
    const jumper = new StartupStallJumper(media, (target) => {
        seeks.push(target);
        return true;
    }, 2, 1, true, true, false);

    media.fire('waiting');
    assert.deepStrictEqual(seeks, [1]);
    jumper.destroy();
}

function testPlayingChecksAndFixesStuckPlayback() {
    timers.splice(0, timers.length);
    const media = makeMedia();
    const seeks = [];
    const jumper = new StartupStallJumper(media, (target) => {
        seeks.push(target);
        return true;
    }, 2, 1, true, true, true);

    media.fire('playing');
    assert.deepStrictEqual(seeks, []);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].delay, 1200);
    timers[0].callback();
    assert.deepStrictEqual(seeks, [1]);
    jumper.destroy();
}

function testPlayingCheckLeavesAdvancingPlaybackUntouched() {
    timers.splice(0, timers.length);
    const media = makeMedia();
    const seeks = [];
    const jumper = new StartupStallJumper(media, (target) => {
        seeks.push(target);
        return true;
    }, 2, 1, true, true, true);

    media.fire('playing');
    media.currentTime += 0.1;
    timers[0].callback();
    assert.deepStrictEqual(seeks, []);
    jumper.destroy();
}

function testDestroyRemovesPlayingListenerAndTimer() {
    timers.splice(0, timers.length);
    const media = makeMedia();
    const jumper = new StartupStallJumper(media, () => true);

    assert.strictEqual(media.hasEventListener('playing'), true);
    media.fire('playing');
    jumper.destroy();
    assert.strictEqual(media.hasEventListener('playing'), false);
    assert.strictEqual(timers[0].cleared, true);
}

testMMTSGapJumpWaitsForConfirmedStall();
testDefaultGapJumpRemainsImmediate();
testPlayingChecksAndFixesStuckPlayback();
testPlayingCheckLeavesAdvancingPlaybackUntouched();
testDestroyRemovesPlayingListenerAndTimer();

console.log('startup-stall-jumper tests passed');

#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/player/startup-buffer-gate.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        esModuleInterop: true
    }
}).outputText;

const moduleObject = {exports: {}};
const sandbox = {
    require: (id) => {
        if (id === '../utils/logger') {
            return {__esModule: true, default: {v() {}}};
        }
        return require(id);
    },
    module: moduleObject,
    exports: moduleObject.exports,
    console,
};
vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
const StartupBufferGate = moduleObject.exports.default;

function makeMediaElement(playResults) {
    const listeners = {};
    return {
        paused: true,
        currentTime: 0,
        buffered: {
            length: 0,
            start() {
                return 0;
            },
            end() {
                return 0;
            }
        },
        addEventListener(name, handler) {
            listeners[name] = handler;
        },
        removeEventListener(name, handler) {
            if (listeners[name] === handler) {
                delete listeners[name];
            }
        },
        hasEventListener(name) {
            return name in listeners;
        },
        dispatchEvent(name) {
            if (listeners[name]) {
                listeners[name]({type: name});
            }
        },
        play() {
            this.paused = false;
            return playResults.length > 0 ? playResults.shift() : Promise.resolve();
        },
        pause() {
            this.paused = true;
            if (listeners.pause) {
                listeners.pause({type: 'pause'});
            }
        }
    };
}

async function testActivationPlayRejectionRejectsDeferredRequest() {
    const error = new Error('autoplay blocked');
    error.name = 'NotAllowedError';
    const media = makeMediaElement([Promise.reject(error)]);
    const gate = new StartupBufferGate(media, 1, () => 0);

    await gate.requestPlay().then(
        () => assert.fail('requestPlay should reject when activation play is rejected'),
        (reason) => assert.strictEqual(reason, error)
    );
}

async function testHoldAbortDoesNotRejectDeferredRequest() {
    const abort = new Error('play interrupted by pause');
    abort.name = 'AbortError';
    let forward = 0;
    const media = makeMediaElement([Promise.reject(abort), Promise.resolve()]);
    const gate = new StartupBufferGate(media, 1, () => forward);
    let resolved = false;
    let rejected = false;
    const promise = gate.requestPlay();
    promise.then(
        () => {
            resolved = true;
        },
        () => {
            rejected = true;
        }
    );

    await Promise.resolve();
    assert.strictEqual(resolved, false);
    assert.strictEqual(rejected, false);

    forward = 2;
    gate.notifyBufferedRangeUpdate();
    await promise;
    assert.strictEqual(resolved, true);
    assert.strictEqual(rejected, false);
}

async function testMMTSStartupGroupControlsReleaseWithoutBufferedRange() {
    let resolved = false;
    const media = makeMediaElement([Promise.resolve(), Promise.resolve()]);
    const gate = new StartupBufferGate(media, 0, () => 10, true);
    const promise = gate.requestPlay().then(() => {
        resolved = true;
    });

    await Promise.resolve();
    assert.strictEqual(resolved, false);
    gate.releaseStartupGroup();
    await promise;
    assert.strictEqual(resolved, true);
}

async function testMMTSStartupGroupAndForwardBufferAreBothRequired() {
    let forward = 0;
    let resolved = false;
    const media = makeMediaElement([Promise.resolve(), Promise.resolve()]);
    const gate = new StartupBufferGate(media, 1.5, () => forward, true);
    const promise = gate.requestPlay().then(() => {
        resolved = true;
    });

    await Promise.resolve();
    gate.releaseStartupGroup();
    await Promise.resolve();
    assert.strictEqual(resolved, false);

    forward = 1.5;
    gate.notifyBufferedRangeUpdate();
    await promise;
    assert.strictEqual(resolved, true);
}

async function testNativePlayIsHeldUntilBothMMTSConditionsAreReady() {
    let forward = 0;
    const media = makeMediaElement([Promise.resolve()]);
    const gate = new StartupBufferGate(media, 1.5, () => forward, true);

    media.paused = false;
    media.dispatchEvent('play');
    assert.strictEqual(media.paused, true);

    gate.releaseStartupGroup();
    await Promise.resolve();
    assert.strictEqual(media.paused, true);

    forward = 1.5;
    gate.notifyBufferedRangeUpdate();
    await Promise.resolve();
    assert.strictEqual(media.paused, false);
}

async function testMMTSStartupMovesPastShortInitialBufferedIsland() {
    const media = makeMediaElement([Promise.resolve(), Promise.resolve()]);
    const ranges = [
        {start: 0.167, end: 0.318},
        {start: 0.701, end: 4.2},
    ];
    media.buffered = {
        length: ranges.length,
        start(index) {
            return ranges[index].start;
        },
        end(index) {
            return ranges[index].end;
        },
    };
    const jumps = [];
    const gate = new StartupBufferGate(
        media,
        3,
        () => media.currentTime >= 0.701 ? 3.499 : 0,
        true,
        (target) => {
            jumps.push(target);
            media.currentTime = target;
            return true;
        }
    );

    const promise = gate.requestPlay();
    await Promise.resolve();
    gate.releaseStartupGroup();
    await promise;
    assert.deepStrictEqual(jumps, [0.701]);
    assert.strictEqual(media.paused, false);
}

async function testMMTSAsyncStartupSeekRechecksBufferOnSeeked() {
    const media = makeMediaElement([Promise.resolve(), Promise.resolve()]);
    const ranges = [
        {start: 0.167, end: 0.318},
        {start: 0.701, end: 4.2},
    ];
    media.buffered = {
        length: ranges.length,
        start(index) {
            return ranges[index].start;
        },
        end(index) {
            return ranges[index].end;
        },
    };
    let forward = 0;
    let resolved = false;
    const jumps = [];
    const gate = new StartupBufferGate(
        media,
        3,
        () => forward,
        true,
        (target) => {
            jumps.push(target);
            return true;
        }
    );

    const promise = gate.requestPlay().then(() => {
        resolved = true;
    });
    await Promise.resolve();
    gate.releaseStartupGroup();
    await Promise.resolve();
    assert.deepStrictEqual(jumps, [0.701]);
    assert.strictEqual(media.currentTime, 0);
    assert.strictEqual(media.paused, true);
    assert.strictEqual(resolved, false);

    media.currentTime = 0.701;
    forward = 3.499;
    media.dispatchEvent('seeked');
    await promise;
    assert.strictEqual(media.paused, false);
    assert.strictEqual(resolved, true);

    gate.destroy();
    assert.strictEqual(media.hasEventListener('seeked'), false);
}

async function testMMTSVODRequiresPositiveBufferAfterAsyncStartupSeek() {
    const media = makeMediaElement([Promise.resolve(), Promise.resolve()]);
    const ranges = [{start: 0.167, end: 4.2}];
    media.buffered = {
        length: ranges.length,
        start(index) {
            return ranges[index].start;
        },
        end(index) {
            return ranges[index].end;
        },
    };
    let forward = 0;
    let resolved = false;
    const jumps = [];
    const gate = new StartupBufferGate(
        media,
        0,
        () => forward,
        true,
        (target) => {
            jumps.push(target);
            return true;
        }
    );

    const promise = gate.requestPlay().then(() => {
        resolved = true;
    });
    await Promise.resolve();
    gate.releaseStartupGroup();
    await Promise.resolve();
    assert.deepStrictEqual(jumps, [0.167]);
    assert.strictEqual(media.currentTime, 0);
    assert.strictEqual(media.paused, true);
    assert.strictEqual(resolved, false);

    media.currentTime = 0.167;
    forward = 4.033;
    media.dispatchEvent('seeked');
    await promise;
    assert.strictEqual(media.paused, false);
    assert.strictEqual(resolved, true);
}

async function testMMTSVODDoesNotReleaseWithoutBufferedRange() {
    const media = makeMediaElement([Promise.resolve()]);
    const gate = new StartupBufferGate(media, 0, () => 0, true);
    let resolved = false;
    const promise = gate.requestPlay().then(
        () => {
            resolved = true;
        },
        (error) => {
            assert.strictEqual(error.name, 'AbortError');
        }
    );

    await Promise.resolve();
    gate.releaseStartupGroup();
    await Promise.resolve();
    assert.strictEqual(media.paused, true);
    assert.strictEqual(resolved, false);

    gate.cancelPendingPlay();
    await promise;
}

(async () => {
    await testActivationPlayRejectionRejectsDeferredRequest();
    await testHoldAbortDoesNotRejectDeferredRequest();
    await testMMTSStartupGroupControlsReleaseWithoutBufferedRange();
    await testMMTSStartupGroupAndForwardBufferAreBothRequired();
    await testNativePlayIsHeldUntilBothMMTSConditionsAreReady();
    await testMMTSStartupMovesPastShortInitialBufferedIsland();
    await testMMTSAsyncStartupSeekRechecksBufferOnSeeked();
    await testMMTSVODRequiresPositiveBufferAfterAsyncStartupSeek();
    await testMMTSVODDoesNotReleaseWithoutBufferedRange();
    console.log('startup-buffer-gate tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

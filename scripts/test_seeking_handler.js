#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

class FakeTimers {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.tasks = new Map();
    }

    setTimeout(callback, delay) {
        const id = this.nextId++;
        this.tasks.set(id, {callback, due: this.now + delay});
        return id;
    }

    clearTimeout(id) {
        this.tasks.delete(id);
    }

    advance(milliseconds) {
        const target = this.now + milliseconds;
        while (true) {
            let nextId = null;
            let nextTask = null;
            for (const [id, task] of this.tasks) {
                if (task.due <= target && (nextTask == null || task.due < nextTask.due)) {
                    nextId = id;
                    nextTask = task;
                }
            }
            if (nextTask == null) {
                break;
            }
            this.now = nextTask.due;
            this.tasks.delete(nextId);
            nextTask.callback();
        }
        this.now = target;
    }
}

function makeRanges(ranges = []) {
    return {
        length: ranges.length,
        start(index) {
            return ranges[index][0];
        },
        end(index) {
            return ranges[index][1];
        },
    };
}

class FakeMediaElement {
    constructor() {
        this.currentTime = 0;
        this.buffered = makeRanges();
        this.seekable = makeRanges();
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    removeEventListener(type, listener) {
        if (this.listeners.get(type) === listener) {
            this.listeners.delete(type);
        }
    }

    seekFromMedia(seconds) {
        this.currentTime = seconds;
        const listener = this.listeners.get('seeking');
        listener({type: 'seeking'});
    }
}

function loadSeekingHandler(timers) {
    const sourcePath = path.resolve(__dirname, '../src/player/seeking-handler.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const browser = {
        chrome: false,
        msedge: false,
        msie: false,
        safari: false,
        version: {major: 0, build: 0},
    };
    class FakeIDRSampleList {
        clear() {}
        appendArray() {}
        getLastSyncPointBeforeDts() { return null; }
    }
    const requireMap = {
        '../utils/browser': {__esModule: true, default: browser},
        '../core/media-segment-info': {IDRSampleList: FakeIDRSampleList},
    };
    const windowObject = {
        setTimeout: timers.setTimeout.bind(timers),
        clearTimeout: timers.clearTimeout.bind(timers),
    };
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        self: {performance: {now: () => timers.now}},
        window: windowObject,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports.default;
}

function makeHarness(onSeekRequest) {
    const timers = new FakeTimers();
    const SeekingHandler = loadSeekingHandler(timers);
    const media = new FakeMediaElement();
    const unbufferedSeeks = [];
    const handler = new SeekingHandler(
        {isMMTS: true, isLive: false, accurateSeek: true},
        media,
        (milliseconds) => unbufferedSeeks.push(milliseconds),
        onSeekRequest
    );
    return {handler, media, timers, unbufferedSeeks};
}

function testMediaSeeksDispatchOnlyLastTarget() {
    const requests = [];
    const h = makeHarness((seconds, source) => {
        requests.push([seconds, source]);
        return true;
    });

    h.media.seekFromMedia(10);
    h.timers.advance(40);
    h.media.seekFromMedia(20);
    h.timers.advance(40);
    h.media.seekFromMedia(30);
    h.timers.advance(99);
    assert.deepStrictEqual(requests, []);
    h.timers.advance(1);
    assert.deepStrictEqual(requests, [[30, 'media']]);
}

function testApiSeekDispatchesImmediately() {
    const requests = [];
    const h = makeHarness((seconds, source) => {
        requests.push([seconds, source]);
        return true;
    });

    h.media.seekFromMedia(10);
    h.timers.advance(40);
    h.handler.seek(42);
    assert.deepStrictEqual(requests, [[42, 'api']]);
    assert.strictEqual(h.timers.tasks.size, 0);
    h.timers.advance(200);
    assert.deepStrictEqual(requests, [[42, 'api']]);
}

function testDestroyCancelsPendingMediaSeek() {
    const requests = [];
    const h = makeHarness((seconds, source) => {
        requests.push([seconds, source]);
        return true;
    });

    h.media.seekFromMedia(15);
    h.handler.destroy();
    h.timers.advance(1000);
    assert.deepStrictEqual(requests, []);
    assert.strictEqual(h.timers.tasks.size, 0);
}

function testRejectedControlledSeekUsesUnbufferedFallback() {
    const requests = [];
    const h = makeHarness((seconds, source) => {
        requests.push([seconds, source]);
        return false;
    });

    h.media.seekFromMedia(15);
    h.timers.advance(100);
    assert.deepStrictEqual(requests, [[15, 'media']]);
    assert.deepStrictEqual(h.unbufferedSeeks, [15000]);
    assert.strictEqual(h.media.currentTime, 15);
}

function main() {
    testMediaSeeksDispatchOnlyLastTarget();
    testApiSeekDispatchesImmediately();
    testDestroyCancelsPendingMediaSeek();
    testRejectedControlledSeekUsesUnbufferedFallback();
    console.log('seeking-handler tests passed');
}

main();

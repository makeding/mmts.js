#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadModule(relativePath, requireMap = {}, globals = {}) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = Object.assign({
        require(id) {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) {
                return requireMap[id];
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
        ArrayBuffer,
        Uint8Array,
        Promise,
        Object,
        Number,
        parseInt,
        isNaN,
        isFinite,
        setTimeout,
        clearTimeout,
    }, globals);
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

class TestException extends Error {}

const exceptionModule = {
    NotImplementedException: TestException,
    RuntimeException: TestException,
    IllegalStateException: TestException,
    InvalidArgumentException: TestException,
};
const loaderModule = loadModule('src/io/loader.js', {
    '../utils/exception.js': exceptionModule,
});

class MockHeaders {
    constructor(values = {}) {
        this.values = {};
        for (const name of Object.keys(values)) {
            this.values[name.toLowerCase()] = String(values[name]);
        }
    }

    append(name, value) {
        this.values[name.toLowerCase()] = String(value);
    }

    has(name) {
        return Object.prototype.hasOwnProperty.call(this.values, name.toLowerCase());
    }

    get(name) {
        return this.has(name) ? this.values[name.toLowerCase()] : null;
    }
}

class MockAbortController {
    constructor() {
        this.signal = {aborted: false};
    }

    abort() {
        this.signal.aborted = true;
    }
}

const fetchSelf = {
    Headers: MockHeaders,
    AbortController: MockAbortController,
    ReadableStream: class {},
    setTimeout,
    fetch: null,
};
const FetchStreamLoader = loadModule('src/io/fetch-stream-loader.js', {
    '../utils/logger.js': {__esModule: true, default: {e() {}, w() {}}},
    '../utils/browser.js': {__esModule: true, default: {chrome: false, msedge: false}},
    './loader.js': loaderModule,
    '../utils/exception.js': exceptionModule,
}, {self: fetchSelf}).default;

function makeResponse(options) {
    let readIndex = 0;
    const chunks = options.chunks || [];
    return {
        ok: options.status >= 200 && options.status <= 299,
        status: options.status,
        statusText: options.statusText || '',
        url: options.url,
        headers: new MockHeaders(options.headers),
        body: {
            cancel() {
                return Promise.resolve();
            },
            getReader() {
                return {
                    read() {
                        if (readIndex >= chunks.length) {
                            return Promise.resolve({done: true});
                        }
                        return Promise.resolve({done: false, value: chunks[readIndex++]});
                    },
                    cancel() {
                        return Promise.resolve();
                    }
                };
            }
        }
    };
}

function runFetchScenario(options) {
    const url = 'https://example.test/video.mmts';
    fetchSelf.fetch = () => Promise.resolve(makeResponse(Object.assign({url}, options.response)));
    const seekHandler = {
        getConfig(requestUrl, range) {
            return {
                url: requestUrl,
                headers: {Range: `bytes=${range.from}-${range.to === -1 ? '' : range.to}`}
            };
        },
        removeURLParameters(requestUrl) {
            return requestUrl;
        }
    };
    const loader = new FetchStreamLoader(seekHandler, {});
    const arrivals = [];
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fetch loader test timed out')), 1000);
        const finish = (result) => {
            clearTimeout(timeout);
            resolve(result);
        };
        loader.onDataArrival = (chunk, byteStart) => {
            arrivals.push({byteStart, bytes: Array.from(new Uint8Array(chunk))});
        };
        loader.onError = (type, info) => finish({kind: 'error', type, info, arrivals});
        loader.onComplete = (from, to) => finish({kind: 'complete', from, to, arrivals});
        loader.open({url}, options.range);
    });
}

async function testFetchUsesReadableStreamViewBounds() {
    const backing = Uint8Array.from([0xaa, 0x11, 0x22, 0xbb]);
    const result = await runFetchScenario({
        range: {from: 100, to: 101},
        response: {
            status: 206,
            headers: {
                'Content-Range': 'bytes 100-101/1000',
                'Content-Length': '2',
            },
            chunks: [backing.subarray(1, 3)],
        }
    });
    assert.strictEqual(result.kind, 'complete');
    assert.strictEqual(result.from, 100);
    assert.strictEqual(result.to, 101);
    assert.deepStrictEqual(result.arrivals, [{byteStart: 100, bytes: [0x11, 0x22]}]);
}

async function testFetchRejectsMismatchedContentRange() {
    const result = await runFetchScenario({
        range: {from: 100, to: 101},
        response: {
            status: 206,
            headers: {
                'Content-Range': 'bytes 0-1/1000',
                'Content-Length': '2',
            },
            chunks: [Uint8Array.from([0x11, 0x22])],
        }
    });
    assert.strictEqual(result.kind, 'error');
    assert.strictEqual(result.type, loaderModule.LoaderErrors.HTTP_STATUS_CODE_INVALID);
    assert.deepStrictEqual(result.arrivals, []);
}

async function testFetchRejectsMismatchedInitialContentRange() {
    const result = await runFetchScenario({
        range: {from: 0, to: -1},
        response: {
            status: 206,
            headers: {
                'Content-Range': 'bytes 10-11/12',
                'Content-Length': '2',
            },
            chunks: [Uint8Array.from([0x11, 0x22])],
        }
    });
    assert.strictEqual(result.kind, 'error');
    assert.strictEqual(result.type, loaderModule.LoaderErrors.HTTP_STATUS_CODE_INVALID);
    assert.deepStrictEqual(result.arrivals, []);
}

async function testFetchAcceptsValidOpenEndedRange() {
    const result = await runFetchScenario({
        range: {from: 100, to: -1},
        response: {
            status: 206,
            headers: {
                'Content-Range': 'bytes 100-103/104',
                'Content-Length': '4',
            },
            chunks: [Uint8Array.from([0x11, 0x22]), Uint8Array.from([0x33, 0x44])],
        }
    });
    assert.strictEqual(result.kind, 'complete');
    assert.strictEqual(result.from, 100);
    assert.strictEqual(result.to, 103);
    assert.deepStrictEqual(result.arrivals, [
        {byteStart: 100, bytes: [0x11, 0x22]},
        {byteStart: 102, bytes: [0x33, 0x44]},
    ]);
}

async function testFetchPausesWithoutReopeningRequest() {
    const url = 'https://example.test/video.mmts';
    let fetchCount = 0;
    fetchSelf.fetch = () => {
        fetchCount++;
        return Promise.resolve(makeResponse({
            url,
            status: 200,
            headers: {'Content-Length': '4'},
            chunks: [Uint8Array.from([0x11, 0x22]), Uint8Array.from([0x33, 0x44])],
        }));
    };
    const seekHandler = {
        getConfig(requestUrl) {
            return {url: requestUrl, headers: {Range: 'bytes=0-'}};
        },
        removeURLParameters(requestUrl) {
            return requestUrl;
        }
    };
    const loader = new FetchStreamLoader(seekHandler, {});
    const arrivals = [];
    const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Fetch pause test timed out')), 1000);
        const finish = (value) => {
            clearTimeout(timeout);
            resolve(value);
        };
        loader.onDataArrival = (chunk, byteStart) => {
            arrivals.push({byteStart, bytes: Array.from(new Uint8Array(chunk))});
            if (arrivals.length === 1) {
                loader.pause();
                setTimeout(() => loader.resume(), 0);
            }
        };
        loader.onError = (type, info) => finish({kind: 'error', type, info});
        loader.onComplete = (from, to) => finish({kind: 'complete', from, to});
        loader.open({url}, {from: 0, to: -1});
    });
    assert.deepStrictEqual(result, {kind: 'complete', from: 0, to: 3});
    assert.strictEqual(fetchCount, 1);
    assert.deepStrictEqual(arrivals, [
        {byteStart: 0, bytes: [0x11, 0x22]},
        {byteStart: 2, bytes: [0x33, 0x44]},
    ]);
}

class FakeSpeedSampler {
    constructor() {
        this.lastSecondKBps = 0;
    }

    reset() {}
    addBytes() {}
}

class UnusedLoader {
    static isSupported() {
        return false;
    }
}

class FakeSeekHandler {}

class ControlledLoader {
    constructor() {
        this.type = 'controlled-loader';
        this.needStashBuffer = true;
        this.status = loaderModule.LoaderStatus.kIdle;
        this.range = null;
        ControlledLoader.instances.push(this);
    }

    isWorking() {
        return this.status === loaderModule.LoaderStatus.kConnecting ||
            this.status === loaderModule.LoaderStatus.kBuffering;
    }

    open(dataSource, range) {
        this.dataSource = dataSource;
        this.range = Object.assign({}, range);
        this.status = loaderModule.LoaderStatus.kBuffering;
    }

    abort() {
        this.status = loaderModule.LoaderStatus.kComplete;
    }

    destroy() {
        this.status = loaderModule.LoaderStatus.kIdle;
    }

    emit(bytes, byteStart) {
        const data = Uint8Array.from(bytes);
        this.onDataArrival(data.buffer, byteStart, data.byteLength);
    }
}

ControlledLoader.instances = [];

class SupportedFetchLoader extends ControlledLoader {
    static isSupported() {
        return true;
    }
}

class SupportedRangeLoader extends ControlledLoader {
    static isSupported() {
        return true;
    }
}

class PausableControlledLoader extends ControlledLoader {
    constructor() {
        super();
        this.pauseCount = 0;
        this.resumeCount = 0;
    }

    get supportsPause() {
        return true;
    }

    pause() {
        this.pauseCount++;
    }

    resume() {
        this.resumeCount++;
    }
}

const IOController = loadModule('src/io/io-controller.js', {
    '../utils/logger.js': {__esModule: true, default: {v() {}, w() {}}},
    './speed-sampler.js': {__esModule: true, default: FakeSpeedSampler},
    './loader.js': loaderModule,
    './fetch-stream-loader.js': {__esModule: true, default: UnusedLoader},
    './xhr-moz-chunked-loader.js': {__esModule: true, default: UnusedLoader},
    './xhr-msstream-loader.js': {__esModule: true, default: UnusedLoader},
    './xhr-range-loader.js': {__esModule: true, default: UnusedLoader},
    './websocket-loader.js': {__esModule: true, default: UnusedLoader},
    './range-seek-handler.js': {__esModule: true, default: FakeSeekHandler},
    './param-seek-handler.js': {__esModule: true, default: FakeSeekHandler},
    '../utils/exception.js': exceptionModule,
}).default;

const LoaderSelectionIOController = loadModule('src/io/io-controller.js', {
    '../utils/logger.js': {__esModule: true, default: {v() {}, w() {}}},
    './speed-sampler.js': {__esModule: true, default: FakeSpeedSampler},
    './loader.js': loaderModule,
    './fetch-stream-loader.js': {__esModule: true, default: SupportedFetchLoader},
    './xhr-moz-chunked-loader.js': {__esModule: true, default: UnusedLoader},
    './xhr-msstream-loader.js': {__esModule: true, default: UnusedLoader},
    './xhr-range-loader.js': {__esModule: true, default: SupportedRangeLoader},
    './websocket-loader.js': {__esModule: true, default: UnusedLoader},
    './range-seek-handler.js': {__esModule: true, default: FakeSeekHandler},
    './param-seek-handler.js': {__esModule: true, default: FakeSeekHandler},
    '../utils/exception.js': exceptionModule,
}).default;

function makeIOController(config = {}) {
    ControlledLoader.instances = [];
    return new IOController({url: 'https://example.test/video.mmts'}, Object.assign({
        seekType: 'range',
        customLoader: ControlledLoader,
        enableStashBuffer: false,
    }, config), null);
}

function testIOResumesAfterLastConsumedByte() {
    const source = Array.from({length: 16}, (_, index) => index);
    const received = [];
    const io = makeIOController();
    io.onDataArrival = (chunk, byteStart) => {
        assert.strictEqual(byteStart, received.length);
        received.push(...new Uint8Array(chunk));
        return chunk.byteLength;
    };
    io.open();
    ControlledLoader.instances[0].emit(source.slice(0, 8), 0);
    io.pause();
    io.resume();
    assert.deepStrictEqual(ControlledLoader.instances[1].range, {from: 8, to: -1});
    ControlledLoader.instances[1].emit(source.slice(8), 8);
    assert.deepStrictEqual(received, source);
    io.destroy();
}

function testIORefetchesUndispatchedStash() {
    const source = Array.from({length: 16}, (_, index) => index);
    const received = [];
    const io = makeIOController({enableStashBuffer: true, stashInitialSize: 8});
    io.onDataArrival = (chunk, byteStart) => {
        assert.strictEqual(byteStart, received.length);
        received.push(...new Uint8Array(chunk));
        return chunk.byteLength;
    };
    io.open();
    ControlledLoader.instances[0].emit(source.slice(0, 4), 0);
    assert.deepStrictEqual(received, []);
    io.pause();
    io.resume();
    assert.deepStrictEqual(ControlledLoader.instances[1].range, {from: 0, to: -1});
    ControlledLoader.instances[1].emit(source, 0);
    assert.deepStrictEqual(received, source);
    io.destroy();
}

function testIORefetchesPartiallyConsumedChunk() {
    const source = Array.from({length: 16}, (_, index) => index);
    const received = [];
    let firstDispatch = true;
    const io = makeIOController();
    io.onDataArrival = (chunk, byteStart) => {
        assert.strictEqual(byteStart, received.length);
        const bytes = new Uint8Array(chunk);
        const consumed = firstDispatch ? 3 : bytes.byteLength;
        firstDispatch = false;
        received.push(...bytes.subarray(0, consumed));
        return consumed;
    };
    io.open();
    ControlledLoader.instances[0].emit(source.slice(0, 8), 0);
    io.pause();
    io.resume();
    assert.deepStrictEqual(ControlledLoader.instances[1].range, {from: 3, to: -1});
    ControlledLoader.instances[1].emit(source.slice(3), 3);
    assert.deepStrictEqual(received, source);
    io.destroy();
}

function testIOResumesFromPendingStashAfterDirectChunks() {
    const source = Array.from({length: 40}, (_, index) => index);
    const received = [];
    const io = makeIOController({enableStashBuffer: true, stashInitialSize: 8});
    io.onDataArrival = (chunk, byteStart) => {
        assert.strictEqual(byteStart, received.length);
        received.push(...new Uint8Array(chunk));
        return chunk.byteLength;
    };
    io.open();
    ControlledLoader.instances[0].emit(source.slice(0, 12), 0);
    ControlledLoader.instances[0].emit(source.slice(12, 24), 12);
    ControlledLoader.instances[0].emit(source.slice(24, 28), 24);
    assert.deepStrictEqual(received, source.slice(0, 24));
    io.pause();
    io.resume();
    assert.deepStrictEqual(ControlledLoader.instances[1].range, {from: 24, to: -1});
    ControlledLoader.instances[1].emit(source.slice(24), 24);
    assert.deepStrictEqual(received, source);
    io.destroy();
}

function testIOPausesLoaderInPlaceAndPreservesStash() {
    const received = [];
    const io = makeIOController({
        customLoader: PausableControlledLoader,
        enableStashBuffer: true,
        stashInitialSize: 8,
    });
    io.onDataArrival = (chunk, byteStart) => {
        assert.strictEqual(byteStart, received.length);
        received.push(...new Uint8Array(chunk));
        return chunk.byteLength;
    };
    io.open();
    const loader = ControlledLoader.instances[0];
    loader.emit([0, 1, 2, 3], 0);
    assert.strictEqual(io._stashUsed, 4);

    io.pause();
    assert.strictEqual(loader.pauseCount, 1);
    assert.strictEqual(loader.status, loaderModule.LoaderStatus.kBuffering);
    assert.strictEqual(io._stashUsed, 4);

    io.resume();
    assert.strictEqual(loader.resumeCount, 1);
    assert.strictEqual(ControlledLoader.instances.length, 1);
    assert.strictEqual(io._stashUsed, 4);

    loader.emit([4, 5, 6, 7, 8, 9, 10, 11], 4);
    assert.deepStrictEqual(received, [0, 1, 2, 3]);
    assert.strictEqual(io._stashUsed, 8);
    assert.strictEqual(io._stashByteStart, 4);
    io.destroy();
}

function testIOPrefersBoundedRangeLoaderWhenConfigured() {
    const io = new LoaderSelectionIOController({url: 'https://example.test/video.mmts'}, {
        seekType: 'range',
        preferRangeLoader: true,
        enableStashBuffer: false,
    }, null);
    assert.strictEqual(io.loaderType, 'controlled-loader');
    assert.strictEqual(io._loaderClass, SupportedRangeLoader);
    io.destroy();
}

function testIOKeepsFetchPriorityWithoutRangePreference() {
    const io = new LoaderSelectionIOController({url: 'https://example.test/video.mmts'}, {
        seekType: 'range',
        preferRangeLoader: false,
        enableStashBuffer: false,
    }, null);
    assert.strictEqual(io._loaderClass, SupportedFetchLoader);
    io.destroy();
}

(async () => {
    await testFetchUsesReadableStreamViewBounds();
    await testFetchRejectsMismatchedContentRange();
    await testFetchRejectsMismatchedInitialContentRange();
    await testFetchAcceptsValidOpenEndedRange();
    await testFetchPausesWithoutReopeningRequest();
    testIOResumesAfterLastConsumedByte();
    testIORefetchesUndispatchedStash();
    testIORefetchesPartiallyConsumedChunk();
    testIOResumesFromPendingStashAfterDirectChunks();
    testIOPausesLoaderInPlaceAndPreservesStash();
    testIOPrefersBoundedRangeLoaderWhenConfigured();
    testIOKeepsFetchPriorityWithoutRangePreference();
    console.log('io range resume tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

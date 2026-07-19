#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/utils/mmts-duration-probe.ts');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace(
        'function loadRange(url: string,',
        'export function loadRange(url: string,'
    )
    .replace(
        'function isTargetVideoAsset(asset: MMTAsset | undefined,',
        'export function isTargetVideoAsset(asset: MMTAsset | undefined,'
    );
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        esModuleInterop: true
    }
}).outputText;

const moduleObject = {exports: {}};
const importStub = {
    __esModule: true,
    default: class {},
    MMTPPayloadType: {},
};
let xhrScenario = null;
let lastXHR = null;
class MockXMLHttpRequest {
    constructor() {
        this.readyState = 0;
        this.status = 0;
        this.response = null;
        this.headers = {};
        this.aborted = false;
        this.bodyDelivered = false;
        lastXHR = this;
    }

    open() {}

    setRequestHeader(name, value) {
        this.requestHeader = [name, value];
    }

    getResponseHeader(name) {
        return this.headers[name.toLowerCase()] || null;
    }

    abort() {
        this.aborted = true;
    }

    send() {
        this.status = xhrScenario.status;
        this.headers = xhrScenario.headers || {};
        this.readyState = 2;
        if (this.onreadystatechange) {
            this.onreadystatechange();
        }
        if (this.aborted) {
            return;
        }
        this.response = xhrScenario.response;
        this.bodyDelivered = true;
        this.readyState = 4;
        if (this.onreadystatechange) {
            this.onreadystatechange();
        }
        this.onload();
    }
}
const sandbox = {
    require: () => importStub,
    module: moduleObject,
    exports: moduleObject.exports,
    XMLHttpRequest: MockXMLHttpRequest,
    console,
};

vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
const isTargetVideoAsset = moduleObject.exports.isTargetVideoAsset;
const loadRange = moduleObject.exports.loadRange;

assert.strictEqual(isTargetVideoAsset(undefined, 100, undefined), false);
assert.strictEqual(isTargetVideoAsset({mediaType: 'video', packetId: 100}, 100, undefined), true);
assert.strictEqual(isTargetVideoAsset({mediaType: 'audio', packetId: 100}, 100, undefined), false);
assert.strictEqual(isTargetVideoAsset(undefined, 100, 100), true);
assert.strictEqual(isTargetVideoAsset(undefined, 99, 100), false);
assert.strictEqual(isTargetVideoAsset({mediaType: 'video', packetId: 100}, 100, 100), true);
assert.strictEqual(isTargetVideoAsset({mediaType: 'audio', packetId: 100}, 100, 100), false);

async function testValidRangeResponse() {
    xhrScenario = {
        status: 206,
        headers: {
            'content-range': 'bytes 100-103/1000',
            'content-length': '4',
        },
        response: new ArrayBuffer(4),
    };
    const response = await loadRange('https://example.test/video.mmts', 100, 103, {});
    assert.strictEqual(response.data.byteLength, 4);
    assert.strictEqual(response.contentLength, 4);
    assert.strictEqual(response.totalLength, 1000);
    assert.deepStrictEqual(lastXHR.requestHeader, ['Range', 'bytes=100-103']);
}

async function testIgnoredRangeResponseIsAbortedAtHeaders() {
    xhrScenario = {
        status: 200,
        headers: {'content-length': String(4 * 1024 * 1024 * 1024)},
        response: new ArrayBuffer(0),
    };
    await assert.rejects(
        loadRange('https://example.test/video.mmts', 900, 999, {}),
        /Range request was not honored/
    );
    assert.strictEqual(lastXHR.aborted, true);
    assert.strictEqual(lastXHR.bodyDelivered, false);
}

async function testMismatchedContentRangeIsRejected() {
    xhrScenario = {
        status: 206,
        headers: {
            'content-range': 'bytes 0-99/1000',
            'content-length': '100',
        },
        response: new ArrayBuffer(100),
    };
    await assert.rejects(
        loadRange('https://example.test/video.mmts', 900, 999, {}),
        /Range request was not honored/
    );
    assert.strictEqual(lastXHR.aborted, true);
    assert.strictEqual(lastXHR.bodyDelivered, false);
}

(async () => {
    await testValidRangeResponse();
    await testIgnoredRangeResponseIsAbortedAtHeaders();
    await testMismatchedContentRangeIsRejected();
    console.log('mmts-duration-probe tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

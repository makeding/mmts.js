#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/demux/compressed-ip.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2018,
        esModuleInterop: true
    }
}).outputText;

const moduleObject = {exports: {}};
vm.runInNewContext(compiled, {
    module: moduleObject,
    exports: moduleObject.exports,
    require,
    console,
}, {filename: sourcePath});
const CompressedIP = moduleObject.exports.default;

function makePacket(headerType, headerLength) {
    const packet = new Uint8Array(3 + headerLength);
    packet[0] = 0xab;
    packet[1] = 0xcd;
    packet[2] = headerType;
    return packet;
}

function assertHeader(headerType, headerLength, expectedOffset) {
    const parsed = CompressedIP.parse(makePacket(headerType, headerLength));
    assert.ok(parsed);
    assert.strictEqual(parsed.contextId, 0xabc);
    assert.strictEqual(parsed.sequenceNumber, 0xd);
    assert.strictEqual(parsed.headerType, headerType);
    assert.strictEqual(parsed.payloadOffset, expectedOffset);

    if (headerLength > 0) {
        assert.strictEqual(CompressedIP.parse(makePacket(headerType, headerLength - 1)), null);
    }
}

assertHeader(0x20, 20, 23);
assertHeader(0x21, 2, 5);
assertHeader(0x60, 42, 45);
assertHeader(0x61, 0, 3);
assert.strictEqual(CompressedIP.parse(new Uint8Array([0, 0, 0xff])), null);
assert.strictEqual(CompressedIP.parse(new Uint8Array([0, 0])), null);

console.log('mmts compressed IP tests passed');

#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/demux/tlv.ts');
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
const TLV = moduleObject.exports.default;

function makePacket(type, payload) {
    const packet = new Uint8Array(payload.length + 4);
    packet[0] = 0x7f;
    packet[1] = type;
    packet[2] = (payload.length >>> 8) & 0xff;
    packet[3] = payload.length & 0xff;
    packet.set(payload, 4);
    return packet;
}

function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

function parseChunked(stream, chunkSize) {
    const payloads = [];
    let stash = new Uint8Array(0);
    for (let offset = 0; offset < stream.byteLength; offset += chunkSize) {
        const chunk = stream.subarray(offset, Math.min(stream.byteLength, offset + chunkSize));
        const input = stash.byteLength > 0 ? concat([stash, chunk]) : chunk;
        const result = TLV.parse(input);
        for (const packet of result.packets) {
            payloads.push(Array.from(packet.payload));
        }
        stash = result.needMoreData && result.consumed < input.byteLength ?
            input.slice(result.consumed) :
            new Uint8Array(0);
    }
    assert.strictEqual(stash.byteLength, 0);
    return payloads;
}

function testPartialNextHeaderIsRetained() {
    const first = makePacket(0x03, new Uint8Array([1, 2, 3]));
    const second = makePacket(0x03, new Uint8Array([4, 5, 6, 7]));
    for (let headerBytes = 1; headerBytes < 4; headerBytes++) {
        const input = concat([first, second.subarray(0, headerBytes)]);
        const result = TLV.parse(input);
        assert.strictEqual(result.packets.length, 1);
        assert.strictEqual(result.needMoreData, true);
        assert.strictEqual(result.consumed, first.byteLength);
    }
}

function testEveryChunkBoundaryPreservesPackets() {
    const packets = [
        makePacket(0x03, new Uint8Array([1, 2, 3])),
        makePacket(0x01, new Uint8Array([4, 5, 6, 7, 8])),
        makePacket(0xfe, new Uint8Array([9])),
        makePacket(0x03, new Uint8Array([10, 11, 12, 13, 14, 15])),
    ];
    const stream = concat(packets);
    const expected = packets.map((packet) => Array.from(packet.subarray(4)));
    for (let chunkSize = 1; chunkSize <= stream.byteLength; chunkSize++) {
        assert.deepStrictEqual(parseChunked(stream, chunkSize), expected);
    }
}

testPartialNextHeaderIsRetained();
testEveryChunkBoundaryPreservesPackets();

console.log('mmts tlv chunking tests passed');

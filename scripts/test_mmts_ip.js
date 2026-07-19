#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/demux/ip.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
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
const IP = moduleObject.exports.default;

function writeU16(data, offset, value) {
    data[offset] = (value >>> 8) & 0xff;
    data[offset + 1] = value & 0xff;
}

function makeIpv4(payload, options = {}) {
    const headerLength = options.headerLength || 20;
    const data = new Uint8Array(headerLength + 8 + payload.length);
    data[0] = 0x40 | (headerLength / 4);
    writeU16(data, 2, data.length);
    writeU16(data, 6, options.fragment || 0);
    data[9] = options.protocol === undefined ? 17 : options.protocol;
    writeU16(data, headerLength + 4, 8 + payload.length);
    data.set(payload, headerLength + 8);
    return data;
}

function makeIpv6(payload, withDestinationOptions = false) {
    const extensionLength = withDestinationOptions ? 8 : 0;
    const data = new Uint8Array(40 + extensionLength + 8 + payload.length);
    data[0] = 0x60;
    writeU16(data, 4, extensionLength + 8 + payload.length);
    data[6] = withDestinationOptions ? 60 : 17;
    let udpOffset = 40;
    if (withDestinationOptions) {
        data[40] = 17;
        data[41] = 0;
        udpOffset += 8;
    }
    writeU16(data, udpOffset + 4, 8 + payload.length);
    data.set(payload, udpOffset + 8);
    return data;
}

const payload = Uint8Array.from([1, 2, 3, 4]);
assert.deepStrictEqual({...IP.parseUdpPayload(makeIpv4(payload, {headerLength: 24}), 4)}, {
    payloadOffset: 32,
    payloadLength: 4
});
assert.deepStrictEqual({...IP.parseUdpPayload(makeIpv6(payload), 6)}, {
    payloadOffset: 48,
    payloadLength: 4
});
assert.deepStrictEqual({...IP.parseUdpPayload(makeIpv6(payload, true), 6)}, {
    payloadOffset: 56,
    payloadLength: 4
});
assert.strictEqual(IP.parseUdpPayload(makeIpv4(payload, {protocol: 6}), 4), null);
assert.strictEqual(IP.parseUdpPayload(makeIpv4(payload, {fragment: 0x2000}), 4), null);
assert.strictEqual(IP.parseUdpPayload(new Uint8Array(20), 4), null);
assert.strictEqual(IP.parseUdpPayload(new Uint8Array(40), 6), null);

console.log('mmts IP/UDP tests passed');

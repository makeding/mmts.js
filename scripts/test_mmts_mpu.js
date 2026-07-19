#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/demux/mpu.ts');
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
const MPU = moduleObject.exports.default;

function u16(value) {
    return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value) {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function timedUnit(sampleNumber, payload) {
    return Uint8Array.from([
        ...u32(1), ...u32(sampleNumber), ...u32(0), 0, 0, ...payload
    ]);
}

function makeMpu(flags, body) {
    const packet = Uint8Array.from([
        0, 0, flags, 0, ...u32(10), ...body
    ]);
    const length = packet.length - 2;
    packet[0] = (length >>> 8) & 0xff;
    packet[1] = length & 0xff;
    return packet;
}

const first = timedUnit(1, [1, 2]);
const second = timedUnit(2, [3, 4, 5]);
const aggregatedBody = Uint8Array.from([
    ...u16(first.length), ...first,
    ...u16(second.length), ...second
]);
const aggregated = MPU.parse(makeMpu((2 << 4) | (1 << 3) | 1, aggregatedBody));
assert.ok(aggregated);
assert.strictEqual(aggregated.mfuFragments.length, 2);
assert.deepStrictEqual(Array.from(aggregated.mfuFragments[0].payload), [1, 2]);
assert.deepStrictEqual(Array.from(aggregated.mfuFragments[1].payload), [3, 4, 5]);

assert.strictEqual(MPU.parse(makeMpu((2 << 4) | (1 << 3) | 1, Uint8Array.from([
    ...aggregatedBody, 0xff
]))), null);
assert.strictEqual(MPU.parse(makeMpu((2 << 4) | (1 << 3) | (1 << 1) | 1, aggregatedBody)), null);
assert.strictEqual(MPU.parse(makeMpu((2 << 4) | (1 << 3), new Uint8Array(13))), null);

console.log('mmts MPU tests passed');

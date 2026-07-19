#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const sourcePath = path.resolve(__dirname, '../src/demux/mmtp.ts');
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
const MMTP = moduleObject.exports.default;

function packet(version, authenticatedPayloadLength, payload, mac) {
    const extension = Uint8Array.from([
        0x80, 0x01, 0x00, 0x03,
        0x02,
        (authenticatedPayloadLength >>> 8) & 0xff,
        authenticatedPayloadLength & 0xff
    ]);
    return Uint8Array.from([
        (version << 6) | 0x02,
        0x02,
        0x00, 0x01,
        0, 0, 0, 0,
        0, 0, 0, 1,
        0x00, 0x00,
        0x00, extension.length,
        ...extension,
        ...payload,
        ...mac
    ]);
}

const parsed = MMTP.parse(packet(0, 4, [1, 2, 3, 4], [0xaa, 0xbb]));
assert.ok(parsed);
assert.deepStrictEqual(Array.from(parsed.payload), [1, 2, 3, 4]);
assert.deepStrictEqual(Array.from(parsed.messageAuthenticationCode), [0xaa, 0xbb]);
assert.strictEqual(parsed.extensionHeaderScrambling.messageAuthenticationControl, 1);
assert.strictEqual(MMTP.parse(packet(0, 10, [1, 2, 3, 4], [])), null);
assert.strictEqual(MMTP.parse(packet(1, 4, [1, 2, 3, 4], [])), null);

console.log('mmts MMTP tests passed');

#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadParser() {
    const sourcePath = path.resolve(__dirname, '..', 'src/demux/h265-parser.js');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = {
        require(id) {
            if (id === './exp-golomb.js') {
                return {__esModule: true, default: class ExpGolomb {}};
            }
            throw new Error(`Unexpected import: ${id}`);
        },
        module: moduleObject,
        exports: moduleObject.exports,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports.default;
}

function codecString(parser, profileSpace, profileIdc, compatibility, tierFlag, levelIdc, constraints) {
    return parser._getCodecString(
        profileSpace,
        profileIdc,
        compatibility,
        tierFlag,
        levelIdc,
        constraints
    );
}

const parser = loadParser();

assert.strictEqual(
    codecString(parser, 0, 2, [0x20, 0x00, 0x00, 0x00], 0, 183, [0xB0, 0, 0, 0, 0, 0]),
    'hvc1.2.4.L183.B0'
);
assert.strictEqual(
    codecString(parser, 0, 1, [0x60, 0x00, 0x00, 0x00], 0, 93, [0, 0, 0, 0, 0, 0]),
    'hvc1.1.6.L93'
);
assert.strictEqual(
    codecString(parser, 1, 4, [0x82, 0x00, 0x00, 0x00], 1, 120, [0xB0, 0x23, 0, 0, 0, 0]),
    'hvc1.A4.41.H120.B0.23'
);
assert.strictEqual(
    codecString(parser, 2, 1, [0xF7, 0x7D, 0xB5, 0x7B], 1, 254, [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC]),
    'hvc1.B1.DEADBEEF.H254.12.34.56.78.9A.BC'
);
assert.strictEqual(
    codecString(parser, 3, 31, [0, 0, 0, 0], 0, 90, [0x00, 0x01, 0, 0, 0, 0]),
    'hvc1.C31.0.L90.00.01'
);

console.log('h265 codec string tests passed');

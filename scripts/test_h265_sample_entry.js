#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadModule(relativePath, requireMap) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
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
        require(id) {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) {
                return requireMap[id];
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

function loadNormalizer() {
    const sourcePath = path.resolve(__dirname, '..', 'src/demux/h265-sample-entry.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const H265NaluType = {
        kSliceVPS: 32,
        kSliceSPS: 33,
        kSlicePPS: 34
    };
    const moduleObject = {exports: {}};
    const sandbox = {
        require(id) {
            if (id === './h265') {
                return {H265NaluType};
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports.normalizeH265AccessUnitForSampleEntry;
}

function loadH265() {
    return loadModule('src/demux/h265.ts', {
        '../utils/logger': {__esModule: true, default: {e() {}, v() {}, w() {}, i() {}, d() {}}},
        '../utils/exception': {IllegalStateException: class IllegalStateException extends Error {}},
    });
}

function loadMP4Generator() {
    const exports = loadModule('src/remux/mp4-generator.js', {});
    return exports.default;
}

function makeNalu(type, length) {
    return {type, data: new Uint8Array(length)};
}

function testHvc1RemovesParameterSetsAndPreservesOrder() {
    const normalize = loadNormalizer();
    const vps = makeNalu(32, 8);
    const sps = makeNalu(33, 12);
    const pps = makeNalu(34, 7);
    const aud = makeNalu(35, 6);
    const sei = makeNalu(39, 10);
    const slice = makeNalu(21, 20);
    const units = [vps, sps, pps, aud, sei, slice];

    const result = normalize('hvc1', units, 63);

    assert.deepStrictEqual(Array.from(result.units), [aud, sei, slice]);
    assert.strictEqual(result.length, 36);
    assert.deepStrictEqual(units, [vps, sps, pps, aud, sei, slice]);
}

function testHvc1LeavesConformantAccessUnitUntouched() {
    const normalize = loadNormalizer();
    const units = [makeNalu(39, 10), makeNalu(21, 20)];

    const result = normalize('hvc1', units, 30);

    assert.strictEqual(result.units, units);
    assert.strictEqual(result.length, 30);
}

function testHev1RetainsParameterSets() {
    const normalize = loadNormalizer();
    const units = [makeNalu(32, 8), makeNalu(33, 12), makeNalu(34, 7), makeNalu(21, 20)];

    const result = normalize('hev1', units, 47);

    assert.strictEqual(result.units, units);
    assert.strictEqual(result.length, 47);
}

function testUnsupportedSampleEntryIsRejected() {
    const normalize = loadNormalizer();
    assert.throws(
        () => normalize('avc1', [], 0),
        /Unsupported HEVC sample entry type: avc1/
    );
}

function testHev1ConfigurationAllowsInBandParameterSets() {
    const {HEVCDecoderConfigurationRecord} = loadH265();
    const details = {
        general_profile_space: 0,
        general_tier_flag: 0,
        general_profile_idc: 2,
        general_profile_compatibility_flags_1: 0,
        general_profile_compatibility_flags_2: 0,
        general_profile_compatibility_flags_3: 0,
        general_profile_compatibility_flags_4: 0,
        general_constraint_indicator_flags_1: 0,
        general_constraint_indicator_flags_2: 0,
        general_constraint_indicator_flags_3: 0,
        general_constraint_indicator_flags_4: 0,
        general_constraint_indicator_flags_5: 0,
        general_constraint_indicator_flags_6: 0,
        general_level_idc: 183,
        min_spatial_segmentation_idc: 0,
        parallelismType: 0,
        chroma_format_idc: 1,
        bit_depth_luma_minus8: 2,
        bit_depth_chroma_minus8: 2,
        constant_frame_rate: 0,
        num_temporal_layers: 4,
        temporal_id_nested: true,
    };
    const complete = new HEVCDecoderConfigurationRecord(
        new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), details
    ).getData();
    const inBand = new HEVCDecoderConfigurationRecord(
        new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), details, false
    ).getData();

    assert.strictEqual(complete[23] & 0x80, 0x80);
    assert.strictEqual(complete[29] & 0x80, 0x80);
    assert.strictEqual(complete[35] & 0x80, 0x80);
    assert.strictEqual(inBand[23] & 0x80, 0);
    assert.strictEqual(inBand[29] & 0x80, 0);
    assert.strictEqual(inBand[35] & 0x80, 0);
}

function findBoxType(data, type) {
    const typeBytes = Array.from(type, (char) => char.charCodeAt(0));
    for (let offset = 4; offset <= data.length - typeBytes.length; offset++) {
        if (typeBytes.every((value, index) => data[offset + index] === value)) {
            return offset;
        }
    }
    return -1;
}

function testHevcSampleEntryCarriesNclxColorInformation() {
    const MP4 = loadMP4Generator();
    MP4.init();
    const entry = MP4.hvc1({
        codec: 'hev1.2.4.L153.B0',
        codecWidth: 3840,
        codecHeight: 2160,
        hvcc: new Uint8Array([1, 2, 3]),
        videoFullRangeFlag: false,
        colourPrimaries: 9,
        transferCharacteristics: 18,
        matrixCoefficients: 9,
    });

    const colrTypeOffset = findBoxType(entry, 'colr');
    assert.notStrictEqual(colrTypeOffset, -1);
    assert.deepStrictEqual(
        Array.from(entry.subarray(colrTypeOffset + 4, colrTypeOffset + 15)),
        [0x6E, 0x63, 0x6C, 0x78, 0x00, 0x09, 0x00, 0x12, 0x00, 0x09, 0x00]
    );
}

function testHevcSampleEntryOmitsColorBoxWithoutCompleteMetadata() {
    const MP4 = loadMP4Generator();
    MP4.init();
    const entry = MP4.hvc1({
        codec: 'hvc1.2.4.L153.B0',
        codecWidth: 3840,
        codecHeight: 2160,
        hvcc: new Uint8Array([1, 2, 3]),
    });

    assert.strictEqual(findBoxType(entry, 'colr'), -1);
}

function testHevcSampleEntryCanAdvertiseSDRWithoutChangingYuvMatrix() {
    const MP4 = loadMP4Generator();
    MP4.init();
    const entry = MP4.hvc1({
        codec: 'hev1.2.4.L153.B0',
        codecWidth: 3840,
        codecHeight: 2160,
        hvcc: new Uint8Array([1, 2, 3]),
        videoFullRangeFlag: false,
        colourPrimaries: 1,
        transferCharacteristics: 1,
        matrixCoefficients: 9,
    });

    const colrTypeOffset = findBoxType(entry, 'colr');
    assert.notStrictEqual(colrTypeOffset, -1);
    assert.deepStrictEqual(
        Array.from(entry.subarray(colrTypeOffset + 4, colrTypeOffset + 15)),
        [0x6E, 0x63, 0x6C, 0x78, 0x00, 0x01, 0x00, 0x01, 0x00, 0x09, 0x00]
    );
}

testHvc1RemovesParameterSetsAndPreservesOrder();
testHvc1LeavesConformantAccessUnitUntouched();
testHev1RetainsParameterSets();
testUnsupportedSampleEntryIsRejected();
testHev1ConfigurationAllowsInBandParameterSets();
testHevcSampleEntryCarriesNclxColorInformation();
testHevcSampleEntryOmitsColorBoxWithoutCompleteMetadata();
testHevcSampleEntryCanAdvertiseSDRWithoutChangingYuvMatrix();

console.log('h265 sample-entry tests passed');

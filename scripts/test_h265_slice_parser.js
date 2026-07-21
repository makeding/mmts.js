#!/usr/bin/env node

/** @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com> */

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
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        },
        fileName: sourcePath
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
        exports: moduleObject.exports,
        console,
        Uint8Array,
        DataView,
        ArrayBuffer,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

class IllegalStateException extends Error {}
class InvalidArgumentException extends Error {}
const expGolomb = loadModule('src/demux/exp-golomb.js', {
    '../utils/exception.js': {IllegalStateException, InvalidArgumentException},
});
const H265NaluParser = loadModule('src/demux/h265-parser.js', {
    './exp-golomb.js': expGolomb,
}).default;

// SPS extracted from the BS Fuji 4K HLG sample used by the demo. It includes several emulation-prevention
// bytes, so the test also covers the EBSP -> RBSP -> EBSP round trip used by the prototype rewriter.
const BS4K_HLG_SPS_BASE64 =
    'QgEGAiAAAAMAsAAAAwAAAwCZAACgAeAgAhxNjRiCZJCllOAoQkSCbKUAAAMD6QAA6mCAPpwAgUvAAATEtAAABMXsXAAATEtAAABMXsXAAATEtAAABMXsXAAATEtAAABMXsRA';

class BitWriter {
    constructor() {
        this.bits = [];
    }
    writeBit(value) {
        this.bits.push(value ? 1 : 0);
    }
    writeBits(value, width) {
        for (let bit = width - 1; bit >= 0; bit--) {
            this.writeBit((value >>> bit) & 1);
        }
    }
    writeUE(value) {
        const codeNum = value + 1;
        const width = Math.floor(Math.log2(codeNum)) + 1;
        for (let i = 0; i < width - 1; i++) {
            this.writeBit(0);
        }
        this.writeBits(codeNum, width);
    }
    writeSE(value) {
        this.writeUE(value <= 0 ? -2 * value : 2 * value - 1);
    }
    finish() {
        this.writeBit(1);
        while (this.bits.length % 8 !== 0) {
            this.writeBit(0);
        }
        const bytes = new Uint8Array(this.bits.length / 8);
        this.bits.forEach((bit, index) => {
            bytes[index >>> 3] |= bit << (7 - (index & 7));
        });
        return bytes;
    }
}

function naluHeader(nalUnitType, temporalId = 0, layerId = 0) {
    return new Uint8Array([
        ((nalUnitType & 0x3f) << 1) | ((layerId >>> 5) & 1),
        ((layerId & 0x1f) << 3) | ((temporalId + 1) & 7),
    ]);
}

function makeSlice(options = {}) {
    const nalUnitType = options.nalUnitType === undefined ? 1 : options.nalUnitType;
    const first = options.first === undefined ? true : options.first;
    const ppsId = options.ppsId === undefined ? 3 : options.ppsId;
    const writer = new BitWriter();
    writer.writeBit(first);
    if (nalUnitType >= 16 && nalUnitType <= 23) {
        writer.writeBit(options.noOutputOfPriorPics === undefined ? false : options.noOutputOfPriorPics);
    }
    writer.writeUE(ppsId);
    if (!first) {
        if (options.dependentEnabled) {
            writer.writeBit(Boolean(options.dependent));
        }
        writer.writeBits(options.address || 1, options.addressBits || 5);
        if (options.dependent) {
            const body = writer.finish();
            const result = new Uint8Array(2 + body.length);
            result.set(naluHeader(nalUnitType, options.temporalId || 0, options.layerId || 0), 0);
            result.set(body, 2);
            return result;
        }
    }
    for (let i = 0; i < (options.extraHeaderBits || 0); i++) {
        writer.writeBit((options.extraHeaderValue >>> ((options.extraHeaderBits || 0) - i - 1)) & 1);
    }
    writer.writeUE(options.sliceType === undefined ? 1 : options.sliceType);
    if (options.outputFlagPresent) {
        writer.writeBit(options.picOutputFlag === undefined ? true : options.picOutputFlag);
    }
    if (options.separateColourPlane) {
        writer.writeBits(options.colourPlaneId || 0, 2);
    }
    if (nalUnitType !== 19 && nalUnitType !== 20) {
        writer.writeBits(options.pocLsb || 0, options.pocBits || 8);
    }
    const body = writer.finish();
    const result = new Uint8Array(2 + body.length);
    result.set(naluHeader(nalUnitType, options.temporalId || 0, options.layerId || 0), 0);
    result.set(body, 2);
    return result;
}

function makePPS(temporalId = 0, layerId = 0) {
    const writer = new BitWriter();
    writer.writeUE(3);
    writer.writeUE(0);
    writer.writeBit(1);
    writer.writeBit(0);
    writer.writeBits(0, 3);
    writer.writeBit(0);
    writer.writeBit(0);
    writer.writeUE(0);
    writer.writeUE(0);
    writer.writeSE(0);
    writer.writeBit(0);
    writer.writeBit(0);
    writer.writeBit(0);
    writer.writeSE(0);
    writer.writeSE(0);
    for (let i = 0; i < 10; i++) {
        writer.writeBit(0);
    }
    const body = writer.finish();
    const result = new Uint8Array(2 + body.length);
    result.set(naluHeader(34, temporalId, layerId), 0);
    result.set(body, 2);
    return result;
}

const pps = {
    pic_parameter_set_id: 3,
    dependent_slice_segments_enabled_flag: true,
    output_flag_present_flag: true,
    num_extra_slice_header_bits: 2,
};
const sps = {
    max_sub_layers_minus1: 2,
    slice_segment_address_bits: 5,
    pic_size_in_ctbs_y: 20,
    separate_colour_plane_flag: true,
    log2_max_pic_order_cnt_lsb: 8,
};

(function testNaluHeader() {
    const parsed = H265NaluParser.parseNaluHeader(naluHeader(1, 2));
    assert(parsed);
    assert.strictEqual(parsed.nal_unit_type, 1);
    assert.strictEqual(parsed.temporal_id, 2);
    assert.strictEqual(H265NaluParser.parseNaluHeader(new Uint8Array([0x80, 0x01])), null);
    assert.strictEqual(H265NaluParser.parseNaluHeader(new Uint8Array([0x02, 0x00])), null);
})();

(function testSPSColorimetryRewritePreservesBt2020Matrix() {
    const source = new Uint8Array(Buffer.from(BS4K_HLG_SPS_BASE64, 'base64'));
    const before = H265NaluParser.parseSPS(source);
    assert.strictEqual(before.colour_primaries, 9);
    assert.strictEqual(before.transfer_characteristics, 18);
    assert.strictEqual(before.matrix_coeffs, 9);

    const rewritten = H265NaluParser.rewriteSPSColorimetry(source, 1, 1);
    assert(rewritten instanceof Uint8Array);
    const after = H265NaluParser.parseSPS(rewritten);
    assert.strictEqual(after.colour_primaries, 1);
    assert.strictEqual(after.transfer_characteristics, 1);
    assert.strictEqual(after.matrix_coeffs, 9);
    assert.strictEqual(after.codec_size.width, before.codec_size.width);
    assert.strictEqual(after.codec_size.height, before.codec_size.height);
    assert.strictEqual(after.frame_rate.fps_num, before.frame_rate.fps_num);
    assert.strictEqual(after.frame_rate.fps_den, before.frame_rate.fps_den);
})();

(function testPpsAllowsNonzeroTemporalId() {
    const parsed = H265NaluParser.parsePPS(makePPS(3));
    assert.strictEqual(parsed.pic_parameter_set_id, 3);
    assert.strictEqual(parsed.nalu_header.temporal_id, 3);
    assert.throws(() => H265NaluParser.parsePPS(makePPS(0, 1)), /Invalid HEVC PPS NAL unit/);
})();

(function testFirstSliceAndPrefixUseDeclaredPps() {
    const slice = makeSlice({
        temporalId: 2,
        ppsId: 3,
        extraHeaderBits: 2,
        extraHeaderValue: 1,
        sliceType: 1,
        outputFlagPresent: true,
        picOutputFlag: false,
        separateColourPlane: true,
        colourPlaneId: 2,
        pocBits: 8,
        pocLsb: 200,
    });
    const prefix = H265NaluParser.parseSliceHeaderPrefix(slice);
    assert(prefix);
    assert.strictEqual(prefix.slice_pic_parameter_set_id, 3);
    assert.strictEqual(prefix.first_slice_segment_in_pic_flag, true);

    const parsed = H265NaluParser.parseSliceHeader(slice, pps, sps);
    assert(parsed);
    assert.strictEqual(parsed.nalu_header.temporal_id, 2);
    assert.strictEqual(parsed.slice_type, 1);
    assert.strictEqual(parsed.pic_output_flag, false);
    assert.strictEqual(parsed.slice_pic_order_cnt_lsb, 200);
})();

(function testDependentSliceAddress() {
    const slice = makeSlice({
        first: false,
        ppsId: 3,
        dependentEnabled: true,
        dependent: true,
        addressBits: 5,
        address: 7,
    });
    const parsed = H265NaluParser.parseSliceHeader(slice, pps, sps);
    assert(parsed);
    assert.strictEqual(parsed.first_slice_segment_in_pic_flag, false);
    assert.strictEqual(parsed.dependent_slice_segment_flag, true);
    assert.strictEqual(parsed.slice_segment_address, 7);
    assert.strictEqual(parsed.slice_type, undefined);
})();

(function testIdrHasZeroPoc() {
    const slice = makeSlice({
        nalUnitType: 19,
        ppsId: 3,
        noOutputOfPriorPics: true,
        extraHeaderBits: 2,
        sliceType: 2,
        outputFlagPresent: true,
        separateColourPlane: true,
    });
    const parsed = H265NaluParser.parseSliceHeader(slice, pps, sps);
    assert(parsed);
    assert.strictEqual(parsed.no_output_of_prior_pics_flag, true);
    assert.strictEqual(parsed.slice_pic_order_cnt_lsb, 0);
})();

(function testExactParameterAndTemporalValidation() {
    const slice = makeSlice({
        ppsId: 3,
        extraHeaderBits: 2,
        outputFlagPresent: true,
        separateColourPlane: true,
        pocLsb: 4,
    });
    assert.strictEqual(H265NaluParser.parseSliceHeader(slice, {...pps, pic_parameter_set_id: 4}, sps), null);

    const tooHighTemporal = makeSlice({
        temporalId: 3,
        ppsId: 3,
        extraHeaderBits: 2,
        outputFlagPresent: true,
        separateColourPlane: true,
        pocLsb: 4,
    });
    assert.strictEqual(H265NaluParser.parseSliceHeader(tooHighTemporal, pps, sps), null);

    const irapTemporal = makeSlice({
        nalUnitType: 21,
        temporalId: 1,
        ppsId: 3,
        extraHeaderBits: 2,
        outputFlagPresent: true,
        separateColourPlane: true,
        pocLsb: 4,
    });
    assert.strictEqual(H265NaluParser.parseSliceHeader(irapTemporal, pps, sps), null);
})();

(function testLayerAddressAndTruncationValidation() {
    const layered = makeSlice({
        layerId: 1,
        ppsId: 3,
        extraHeaderBits: 2,
        outputFlagPresent: true,
        separateColourPlane: true,
        pocLsb: 4,
    });
    assert.strictEqual(H265NaluParser.parseSliceHeader(layered, pps, sps), null);

    const badAddress = makeSlice({
        first: false,
        ppsId: 3,
        dependentEnabled: true,
        dependent: true,
        addressBits: 5,
        address: 20,
    });
    assert.strictEqual(H265NaluParser.parseSliceHeader(badAddress, pps, sps), null);
    assert.strictEqual(H265NaluParser.parseSliceHeader(new Uint8Array([0x02, 0x01]), pps, sps), null);
})();

console.log('H.265 slice parser tests passed');

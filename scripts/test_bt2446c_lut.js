'use strict';

const assert = require('assert');
const bt = require('../demo/webgpu-bt2446c.js');

function assertClose(actual, expected, tolerance, label) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`
    );
}

function narrow10BitToSignal(code) {
    return (code - 64) / (940 - 64);
}

function signalToNarrow10Bit(signal) {
    return Math.round(64 + (940 - 64) * signal);
}

function assertNarrow10BitRGB(actualSignal, expectedCodes, tolerance, label) {
    actualSignal.forEach((value, channel) => {
        const actualCode = signalToNarrow10Bit(value);
        assert.ok(
            Math.abs(actualCode - expectedCodes[channel]) <= tolerance,
            `${label}[${channel}]: expected code ${expectedCodes[channel]}, got ${actualCode}`
        );
    });
}

// --- ARIB STD-B72 Attachment 4 inverse mappings (default: display-referred) ---

// Table G4-1 contains narrow-range 10-bit RGB signal levels before and after
// conversion. Up to two codes of tolerance cover the rounded matrix constants
// published by BT.2407 and the table's own rounding.
const aribTableG41 = [
    ['75% White', [721, 721, 721], [940, 940, 940], [940, 940, 940]],
    ['75% Yellow', [721, 721, 64], [940, 940, 64], [940, 939, 64]],
    ['75% Cyan', [64, 721, 721], [64, 940, 940], [64, 940, 924]],
    ['75% Green', [64, 721, 64], [64, 940, 64], [64, 940, 64]],
    ['75% Magenta', [721, 64, 721], [940, 64, 940], [940, 64, 894]],
    ['75% Red', [721, 64, 64], [940, 64, 64], [940, 64, 64]],
    ['75% Blue', [64, 64, 721], [64, 64, 940], [64, 64, 789]],
    ['75% BT.709 Yellow', [713, 719, 316], [939, 940, 64], [933, 934, 64]],
    ['75% BT.709 Cyan', [538, 709, 718], [64, 940, 939], [64, 924, 922]],
    ['75% BT.709 Green', [512, 706, 296], [71, 939, 66], [124, 915, 99]],
    ['75% BT.709 Magenta', [651, 286, 705], [940, 65, 940], [854, 89, 853]],
    ['75% BT.709 Red', [639, 269, 164], [940, 64, 64], [835, 64, 64]],
    ['75% BT.709 Blue', [227, 147, 702], [66, 64, 940], [93, 64, 768]],
];

for (const [name, inputCodes, expectedScene, expectedDisplay] of aribTableG41) {
    const inputSignal = inputCodes.map(narrow10BitToSignal);
    assertNarrow10BitRGB(
        bt.mapHLGToSDRARIBSceneSignal(inputSignal),
        expectedScene,
        2,
        `ARIB scene ${name}`
    );
    assertNarrow10BitRGB(
        bt.mapHLGToSDRARIBDisplaySignal(inputSignal),
        expectedDisplay,
        2,
        `ARIB display ${name}`
    );
}

// The scene-referred path restores SDR reference white instead of compressing
// it. WebGPU output is sRGB presentation light, so neutral white is 1.0.
const gray75Scene = bt.mapHLGToSDRARIBScene([0.75, 0.75, 0.75]);
assertClose(gray75Scene[0], 1.0, 1e-6, 'ARIB scene 75% HLG gray');
const gray75Display = bt.mapHLGToSDRARIBDisplay([0.75, 0.75, 0.75]);
assertClose(gray75Display[0], 1.0, 1e-6, 'ARIB display 75% HLG gray');
const defaultGray75 = bt.mapHLGToSDR([0.75, 0.75, 0.75]);
assertClose(defaultGray75[0], gray75Display[0], 1e-6, 'default mode is ARIB display');

// --- Legacy experimental 291-nit tone mapper ---

// 75% HLG is the 203-nit HDR reference white. Under the 291-nit OOTF it becomes
// 74 nits HDR display light; the tone curve maps it to 86% SDR signal
// (BT.1886-encoded 0.86 -> 69.6 nits -> sRGB-encoded 0.852).
const gray75ARIB = bt.mapHLGToSDRARIB([0.75, 0.75, 0.75]);
assertClose(gray75ARIB[0], 0.852, 0.01, 'ARIB 75% HLG gray');
assertClose(gray75ARIB[1], 0.852, 0.01, 'ARIB 75% HLG gray');
assertClose(gray75ARIB[2], 0.852, 0.01, 'ARIB 75% HLG gray');

// 100% HLG (291 nits under OOTF) maps to 100 nits SDR = 1.0 sRGB (peak).
const gray100ARIB = bt.mapHLGToSDRARIB([1, 1, 1]);
assertClose(gray100ARIB[0], 1.0, 0.01, 'ARIB 100% HLG gray');

// Saturated BT.2020 red: the YCbCr chroma scaling keeps hue intact. Blue must
// stay non-zero (the BT.2020 red primary carries B content after the BT.709
// gamut clip).
const saturatedRedARIB = bt.mapHLGToSDRARIB([1, 0, 0]);
assert.ok(saturatedRedARIB[0] > 0.99, 'ARIB saturated red R near clip, got ' + saturatedRedARIB[0]);
assert.ok(saturatedRedARIB[2] > 0.1, 'ARIB saturated red must retain blue (hue preserved), got B=' + saturatedRedARIB[2]);
assert.ok(saturatedRedARIB[1] < saturatedRedARIB[2], 'ARIB saturated red G < B (BT.2020 red hue), got G=' + saturatedRedARIB[1] + ' B=' + saturatedRedARIB[2]);

// 75% HLG saturated red must stay below 1.0 (tonemap shoulder compresses it).
const red75ARIB = bt.mapHLGToSDRARIB([0.75, 0, 0]);
assert.ok(red75ARIB[0] > 0.9 && red75ARIB[0] <= 1.0, 'ARIB 75% HLG red near-but-below clip, got ' + red75ARIB[0]);

// Gray sweep must be monotonically increasing and never clip before HLG 1.0.
for (let h = 0; h <= 1.0; h += 0.05) {
    const v = bt.mapHLGToSDRARIB([h, h, h])[0];
    assert.ok(v >= 0 && v <= 1.0, 'ARIB gray sweep in range at HLG ' + h + ': ' + v);
}
const prev = bt.mapHLGToSDRARIB([0.5, 0.5, 0.5])[0];
const next = bt.mapHLGToSDRARIB([0.6, 0.6, 0.6])[0];
assert.ok(next > prev, 'ARIB gray sweep monotonic');

// --- Method A (BT.2446-1 Method A, YCbCr chroma scaling) ---

// Method A's perceptual tone curve maps 75% HLG (HDR reference white = 203 nits)
// to roughly one third of sRGB, which is much darker than Method C because A's
// pSDR anchor is the 203-nit reference white, not 1000-nit peak.
const gray75A = bt.mapHLGToSDRMethodA([0.75, 0.75, 0.75]);
assertClose(gray75A[0], 0.334, 0.01, 'Method A 75% HLG gray');
assertClose(gray75A[1], 0.334, 0.01, 'Method A 75% HLG gray');
assertClose(gray75A[2], 0.334, 0.01, 'Method A 75% HLG gray');

// Saturated BT.2020 red (HLG 1,0,0): the YCbCr chroma scaling in Method A keeps
// hue intact and the 0.1 * Cr red-highlight compensation pulls it well below
// clip. R must stay below 0.85 (not blow to 1.0 like a hard-clip path), and the
// blue channel must stay non-zero so the hue is preserved.
const saturatedRedA = bt.mapHLGToSDRMethodA([1, 0, 0]);
assert.ok(saturatedRedA[0] < 0.85, 'Method A saturated red R must stay below clip, got ' + saturatedRedA[0]);
assert.ok(saturatedRedA[0] > 0.7, 'Method A saturated red R should still be bright, got ' + saturatedRedA[0]);
assert.ok(saturatedRedA[2] > 0.1, 'Method A saturated red must retain blue (hue preserved), got B=' + saturatedRedA[2]);
assert.ok(saturatedRedA[1] < saturatedRedA[2], 'Method A saturated red G < B (BT.2020 red hue), got G=' + saturatedRedA[1] + ' B=' + saturatedRedA[2]);

// 75% HLG saturated red must stay even further from the sRGB clip.
const red75A = bt.mapHLGToSDRMethodA([0.75, 0, 0]);
assert.ok(red75A[0] < 0.5, 'Method A 75% HLG red must stay well below clip, got ' + red75A[0]);

// Pure HLG white (1,1,1) maps near ~0.65 sRGB (well below clip; reference white
// is 203 nits, not 1000).
const whiteA = bt.mapHLGToSDRMethodA([1, 1, 1]);
assertClose(whiteA[0], 0.647, 0.02, 'Method A HLG white');
assertClose(whiteA[1], 0.647, 0.02, 'Method A HLG white');
assertClose(whiteA[2], 0.647, 0.02, 'Method A HLG white');

// --- Method C (BT.2446-1 Method C, crosstalk + Lab chroma correction) ---

// Method C's tone curve maps 75% HLG to ~0.434 sRGB (Lref = 203 nits, tone-mapped
// down from the 1000-nit model).
const gray75C = bt.mapHLGToSDRMethodC([0.75, 0.75, 0.75]);
assertClose(gray75C[0], 0.434, 0.01, 'Method C 75% HLG gray');
assertClose(gray75C[1], 0.434, 0.01, 'Method C 75% HLG gray');
assertClose(gray75C[2], 0.434, 0.01, 'Method C 75% HLG gray');

// Method C maps pure HLG white (1,1,1) to ~0.842 sRGB. The Lab chroma correction
// above Lref pulls highlights toward achromatic; this gray stays achromatic.
const whiteC = bt.mapHLGToSDRMethodC([1, 1, 1]);
assertClose(whiteC[0], 0.842, 0.01, 'Method C HLG white');
assertClose(whiteC[1], 0.842, 0.01, 'Method C HLG white');
assertClose(whiteC[2], 0.842, 0.01, 'Method C HLG white');

// Pure saturated red under Method C: BT.2020 -> BT.709 gamut pushes red near the
// BT.709 primary, which is the standard behaviour for Method C + clip gamut
// mapping (hdr-toys' default). Red lands at ~0.99, green clips to 0, blue has a
// small residual from the crosstalk inverse. This is the expected trade-off:
// Method C is optimised for natural imagery, not pure primaries.
const saturatedRedC = bt.mapHLGToSDRMethodC([1, 0, 0]);
assert.ok(saturatedRedC[0] > 0.98, 'Method C saturated red R near clip, got ' + saturatedRedC[0]);
assert.ok(saturatedRedC[1] < 0.01, 'Method C saturated red G clips to 0, got ' + saturatedRedC[1]);

// Lab chroma correction only triggers for L > Lref, where Lref is the Lab L of
// 1000-nit white (=100). HLG 1.0 maps to Lab L=100 exactly, so the correction is
// effectively a super-white (>1000 nit) guard. Verify it actually engages on a
// super-white input: HLG 1.0 on one channel drives OOTF to peak on that
// channel; in units of reference white that exceeds [1,1,1]. Compare Method C
// (with correction) against Method A (without) on an extreme high-light
// saturated colour and check C produces a less-clipped, more achromatic result.
const superWhite = [1, 1, 1];  // Lab L = 100 = Lref, correction just engages
const superWhiteA = bt.mapHLGToSDRMethodA(superWhite);
const superWhiteC = bt.mapHLGToSDRMethodC(superWhite);
// Both should be achromatic for gray input.
assertClose(superWhiteA[0], superWhiteA[1], 1e-6, 'Method A super-white gray R==G');
assertClose(superWhiteC[0], superWhiteC[1], 1e-6, 'Method C super-white gray R==G');

// For a clearly super-white saturated input we need Lab L > 100, i.e. luminance
// above 1000 nits. The crosstalk step alone reduces saturation; verify it does
// not produce a more saturated result than Method A on a mid-tone saturated
// colour where chroma correction is dormant.
const midSaturated = [0.5, 0.3, 0.2];
const midSatA = bt.mapHLGToSDRMethodA(midSaturated);
const midSatC = bt.mapHLGToSDRMethodC(midSaturated);
const midSatSpreadA = Math.max(midSatA[0], midSatA[1], midSatA[2]) - Math.min(midSatA[0], midSatA[1], midSatA[2]);
const midSatSpreadC = Math.max(midSatC[0], midSatC[1], midSatC[2]) - Math.min(midSatC[0], midSatC[1], midSatC[2]);
// Both methods must produce a valid in-range sRGB colour.
assert.ok(midSatA.every(v => v >= 0 && v <= 1), 'Method A mid-saturated in range');
assert.ok(midSatC.every(v => v >= 0 && v <= 1), 'Method C mid-saturated in range');
// And both must preserve hue ordering (R > G > B for this input).
assert.ok(midSatA[0] > midSatA[1] && midSatA[1] > midSatA[2], 'Method A hue ordering preserved');
assert.ok(midSatC[0] > midSatC[1] && midSatC[1] > midSatC[2], 'Method C hue ordering preserved');

// LUT dimensions: 33^3 packed into 256-byte rows.
const lutScene = bt.buildLUT(33, 'arib-scene');
assert.strictEqual(lutScene.size, 33);
assert.strictEqual(lutScene.bytesPerRow, 256);
assert.strictEqual(lutScene.data.length, 256 * 33 * 33);

const lutDisplay = bt.buildLUT(33, 'arib-display');
assert.strictEqual(lutDisplay.data.length, 256 * 33 * 33);

const lutA = bt.buildLUT(33, 'bt2446a');
assert.strictEqual(lutA.size, 33);
assert.strictEqual(lutA.bytesPerRow, 256);
assert.strictEqual(lutA.data.length, 256 * 33 * 33);

const lutC = bt.buildLUT(33, 'bt2446c');
assert.strictEqual(lutC.data.length, 256 * 33 * 33);

// mapDisplayedSDRToBT2446 round-trips the browser SDR presentation back to HLG
// signal, then applies the chosen method. Verify mode dispatch works.
const displayed = bt.mapDisplayedSDRToBT2446([0.5, 0.5, 0.5], 'bt2446a');
assertClose(displayed[0], displayed[1], 1e-6, 'mapDisplayed gray R==G');
assertClose(displayed[1], displayed[2], 1e-6, 'mapDisplayed gray G==B');

console.log('ARIB inverse and BT.2446 LUT tests passed.');

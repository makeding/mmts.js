'use strict';

const assert = require('assert');
const bt2446c = require('../demo/webgpu-bt2446c.js');

function assertClose(actual, expected, tolerance, label) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`
    );
}

// Method B's 291-nit HLG display model keeps 50% HLG near 51% sRGB.
const halfHLGMethodB = bt2446c.mapHLGToSDRMethodB([0.5, 0.5, 0.5]);
assertClose(halfHLGMethodB[0], 0.512, 0.01, 'Method B 50% HLG red');
assertClose(halfHLGMethodB[1], 0.512, 0.01, 'Method B 50% HLG green');
assertClose(halfHLGMethodB[2], 0.512, 0.01, 'Method B 50% HLG blue');

// The 55-nit breakpoint and logarithmic shoulder map 75% HLG near 84% sRGB.
const referenceWhiteMethodB = bt2446c.mapHLGToSDRMethodB([0.75, 0.75, 0.75]);
assertClose(referenceWhiteMethodB[0], 0.842, 0.01, 'Method B 75% HLG red');
assertClose(referenceWhiteMethodB[1], 0.842, 0.01, 'Method B 75% HLG green');
assertClose(referenceWhiteMethodB[2], 0.842, 0.01, 'Method B 75% HLG blue');

// 75% HLG is the 203-nit HDR reference white.  The BS Fuji simulcast-matching
// shoulder maps it to 90% BT.1886 SDR signal, represented as about 0.895 sRGB.
const referenceWhite = bt2446c.mapHLGToSDRMethodC([0.75, 0.75, 0.75]);
assertClose(referenceWhite[0], 0.895, 0.01, '75% HLG red');
assertClose(referenceWhite[1], 0.895, 0.01, '75% HLG green');
assertClose(referenceWhite[2], 0.895, 0.01, '75% HLG blue');

const lut = bt2446c.buildLUT(33, 'bt2446b');
assert.strictEqual(lut.size, 33);
assert.strictEqual(lut.bytesPerRow, 256);
assert.strictEqual(lut.data.length, 256 * 33 * 33);

const methodCLUT = bt2446c.buildLUT(33, 'bt2446c');
assert.strictEqual(methodCLUT.data.length, 256 * 33 * 33);

// Regression for the broadcast-ad red that exposed Method C's excessive lift.
// Method B must keep this sample well below Method C's almost-clipped red.
const displayedAdRed = [0.637751, 0.238331, 0.145312];
const adRedMethodB = bt2446c.mapDisplayedSDRToBT2446(displayedAdRed, 'bt2446b');
const adRedMethodC = bt2446c.mapDisplayedSDRToBT2446(displayedAdRed, 'bt2446c');
assert.ok(adRedMethodB[0] < adRedMethodC[0] - 0.15);

console.log('BT.2446-B/C fixed LUT tests passed.');

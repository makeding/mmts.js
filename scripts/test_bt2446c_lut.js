'use strict';

const assert = require('assert');
const bt2446c = require('../demo/webgpu-bt2446c.js');

function assertClose(actual, expected, tolerance, label) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`
    );
}

// BT.2446-C's fixed curve maps a 50% HLG grey close to 70% SDR signal.
const halfHLG = bt2446c.mapHLGToSDR([0.5, 0.5, 0.5]);
assertClose(halfHLG[0], 0.683, 0.01, '50% HLG red');
assertClose(halfHLG[1], 0.683, 0.01, '50% HLG green');
assertClose(halfHLG[2], 0.683, 0.01, '50% HLG blue');

// 75% HLG is the 203-nit HDR reference white and maps close to 96% SDR signal.
const referenceWhite = bt2446c.mapHLGToSDR([0.75, 0.75, 0.75]);
assertClose(referenceWhite[0], 0.958, 0.01, '75% HLG red');
assertClose(referenceWhite[1], 0.958, 0.01, '75% HLG green');
assertClose(referenceWhite[2], 0.958, 0.01, '75% HLG blue');

const lut = bt2446c.buildLUT(33);
assert.strictEqual(lut.size, 33);
assert.strictEqual(lut.bytesPerRow, 256);
assert.strictEqual(lut.data.length, 256 * 33 * 33);

console.log('BT.2446-C fixed LUT tests passed.');

#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadModule(relativePath, requireMap = {}) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

const MMTSTimestampTable = loadModule('src/demux/mmts-timestamp-table.ts').default;

function makeVideoAsset() {
    return {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        videoFrameRate: 8,
        timestampDescriptors: [
            {mpuSequenceNumber: 20, presentationTimeUs: 1000000}
        ],
        extendedTimestampDescriptors: [
            {
                mpuSequenceNumber: 20,
                timescale: 90000,
                ptsOffsetType: 0,
                defaultPtsOffset: 0,
                decodingTimeOffset: 3000,
                presentationTimeLeapIndicator: 0,
                au: [
                    {dtsPtsOffset: 3000, ptsOffset: 0},
                    {dtsPtsOffset: 1500, ptsOffset: 0},
                    {dtsPtsOffset: 0, ptsOffset: 0}
                ]
            }
        ]
    };
}

function testVideoRequiresCompletePresentationMap() {
    const table = new MMTSTimestampTable();
    const asset = makeVideoAsset();
    assert.strictEqual(table.getTimestampAtAccessUnit(asset, 20, 0), null);
    assert.strictEqual(table.getTimestampAtAccessUnit(asset, 20, 0, undefined, [0, 0, 2]), null);
    assert.strictEqual(table.getTimestampAtAccessUnit(asset, 20, 0, undefined, [0, 1]), null);
}

function testVideoFrameRateOffsetWithIdentityMap() {
    const table = new MMTSTimestampTable();
    const asset = makeVideoAsset();
    const timestamps = table.getTimestampsForMpu(asset, 20, undefined, [0, 1, 2]);
    assert.ok(timestamps);
    assert.deepStrictEqual(
        timestamps.map((item) => [item.rawDts, item.rawPts, item.presentationIndex]),
        [
            [87000, 90000, 0],
            [90002, 91502, 1],
            [93004, 93004, 2]
        ]
    );
    assert.deepStrictEqual(timestamps.map((item) => item.dts), [0, 3002, 6004]);
}

function testBFrameReorderAndVariablePtsOffsets() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 61, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 61,
            timescale: 1000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 20,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 90, ptsOffset: 30},
                {dtsPtsOffset: 0, ptsOffset: 40},
                {dtsPtsOffset: 10, ptsOffset: 30}
            ]
        }]
    };
    const timestamps = table.getTimestampsForMpu(asset, 61, undefined, [2, 0, 1]);
    assert.ok(timestamps);
    assert.deepStrictEqual(
        timestamps.map((item) => [item.rawDts, item.rawPts, item.presentationIndex]),
        [
            [980, 1070, 2],
            [1000, 1000, 0],
            [1030, 1040, 1]
        ]
    );
}

function testPresentationWindowDoesNotRequirePocMap() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 61, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 61,
            timescale: 1000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 20,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 90, ptsOffset: 30},
                {dtsPtsOffset: 0, ptsOffset: 40},
                {dtsPtsOffset: 10, ptsOffset: 30}
            ]
        }]
    };
    assert.strictEqual(table.getTimestampsForMpu(asset, 61), null);
    assert.deepStrictEqual({...table.getMpuPresentationWindow(asset, 61)}, {
        rawPtsStart: 1000,
        rawPtsEnd: 1100,
        timescale: 1000,
        presentationTimeLeapIndicator: 0
    });
}

function testFixedRatePresentationWindowIncludesLastFrame() {
    const table = new MMTSTimestampTable();
    assert.deepStrictEqual({...table.getMpuPresentationWindow(makeVideoAsset(), 20)}, {
        rawPtsStart: 90000,
        rawPtsEnd: 94506,
        timescale: 90000,
        presentationTimeLeapIndicator: 0
    });
}

function testInconsistentFirstDecodeOffsetIsRejected() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 62, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 62,
            timescale: 1000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 20,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 80, ptsOffset: 30},
                {dtsPtsOffset: 0, ptsOffset: 40},
                {dtsPtsOffset: 10, ptsOffset: 30}
            ]
        }]
    };
    assert.strictEqual(table.getTimestampsForMpu(asset, 62, undefined, [2, 0, 1]), null);
}

function testInitialDtsInvariantAllowsOneTickQuantization() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 64, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 64,
            timescale: 1000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 19,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 90, ptsOffset: 30},
                {dtsPtsOffset: 0, ptsOffset: 40},
                {dtsPtsOffset: 10, ptsOffset: 30}
            ]
        }]
    };
    const timestamps = table.getTimestampsForMpu(asset, 64, undefined, [2, 0, 1]);
    assert.ok(timestamps);
    assert.strictEqual(timestamps[0].rawDts, 980);
}

function testZeroPresentationIntervalIsRejected() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 50, presentationTimeUs: 4000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 50,
            timescale: 90000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 0,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 0, ptsOffset: 0},
                {dtsPtsOffset: 0, ptsOffset: 3003}
            ]
        }]
    };
    assert.strictEqual(table.getTimestampsForMpu(asset, 50, undefined, [0, 1]), null);
}

function testNonMonotonicDecodeTimelineIsRejected() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 63, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 63,
            timescale: 1000,
            ptsOffsetType: 1,
            defaultPtsOffset: 40,
            decodingTimeOffset: 0,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 0, ptsOffset: 0},
                {dtsPtsOffset: 100, ptsOffset: 0}
            ]
        }]
    };
    assert.strictEqual(table.getTimestampsForMpu(asset, 63, undefined, [0, 1]), null);
}

function testEpochTimestampScalingKeepsIntegerPrecision() {
    const table = new MMTSTimestampTable();
    const presentationTimeUs = 1784468887000036;
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 90, presentationTimeUs}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 90,
            timescale: 180000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 0,
            presentationTimeLeapIndicator: 0,
            au: [{dtsPtsOffset: 0, ptsOffset: 3003}]
        }]
    };
    const timestamps = table.getTimestampsForMpu(asset, 90, undefined, [0]);
    assert.ok(timestamps);
    assert.strictEqual(timestamps[0].rawDts, 321204399660006);
}

function testAudioUsesIdentityPresentationOrder() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf110,
        assetType: 'mp4a',
        mediaType: 'audio',
        timestampDescriptors: [{mpuSequenceNumber: 30, presentationTimeUs: 2000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 30,
            timescale: 48000,
            ptsOffsetType: 2,
            defaultPtsOffset: 0,
            decodingTimeOffset: 0,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 0, ptsOffset: 1024},
                {dtsPtsOffset: 0, ptsOffset: 1024}
            ]
        }]
    };
    const timestamps = table.getTimestampsForMpu(asset, 30);
    assert.ok(timestamps);
    assert.deepStrictEqual(timestamps.map((item) => item.rawDts), [96000, 97024]);
}

function testFixedOffsetsRequireDeclaredRateWhenAnIntervalExists() {
    const table = new MMTSTimestampTable();
    const asset = {
        packetId: 0xf100,
        assetType: 'hev1',
        mediaType: 'video',
        timestampDescriptors: [{mpuSequenceNumber: 80, presentationTimeUs: 1000000}],
        extendedTimestampDescriptors: [{
            mpuSequenceNumber: 80,
            timescale: 90000,
            ptsOffsetType: 0,
            defaultPtsOffset: 0,
            decodingTimeOffset: 0,
            presentationTimeLeapIndicator: 0,
            au: [
                {dtsPtsOffset: 0, ptsOffset: 0},
                {dtsPtsOffset: 0, ptsOffset: 0}
            ]
        }]
    };
    assert.strictEqual(table.getTimestampsForMpu(asset, 80, undefined, [0, 1]), null);
}

function testReservedPtsOffsetTypeIsRejected() {
    const table = new MMTSTimestampTable();
    const asset = makeVideoAsset();
    asset.extendedTimestampDescriptors[0].ptsOffsetType = 3;
    assert.strictEqual(table.getTimestampsForMpu(asset, 20, undefined, [0, 1, 2]), null);
}

function testLeapIndicatorIsMetadataOnly() {
    const table = new MMTSTimestampTable();
    const asset = makeVideoAsset();
    asset.extendedTimestampDescriptors[0].presentationTimeLeapIndicator = 2;
    const timestamp = table.getTimestampAtAccessUnit(asset, 20, 0, undefined, [0, 1, 2]);
    assert.ok(timestamp);
    assert.strictEqual(timestamp.rawPts, 90000);
    assert.strictEqual(timestamp.presentationTimeLeapIndicator, 2);

    asset.extendedTimestampDescriptors[0].presentationTimeLeapIndicator = 3;
    assert.strictEqual(table.getTimestampsForMpu(asset, 20, undefined, [0, 1, 2]), null);
}

testVideoRequiresCompletePresentationMap();
testVideoFrameRateOffsetWithIdentityMap();
testBFrameReorderAndVariablePtsOffsets();
testPresentationWindowDoesNotRequirePocMap();
testFixedRatePresentationWindowIncludesLastFrame();
testInconsistentFirstDecodeOffsetIsRejected();
testInitialDtsInvariantAllowsOneTickQuantization();
testZeroPresentationIntervalIsRejected();
testNonMonotonicDecodeTimelineIsRejected();
testEpochTimestampScalingKeepsIntegerPrecision();
testAudioUsesIdentityPresentationOrder();
testFixedOffsetsRequireDeclaredRateWhenAnIntervalExists();
testReservedPtsOffsetTypeIsRejected();
testLeapIndicatorIsMetadataOnly();

console.log('mmts timestamp table tests passed');

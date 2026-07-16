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
        require: (id) => {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) {
                return requireMap[id];
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

function loadAssembler() {
    return loadModule('src/utils/mmts-subtitle-assembler.ts', {
        '../demux/mpu': {},
        '../demux/mmt-si': {},
        '../demux/mmts-program': {},
        '../demux/mmts-track-data': {
            MMTSSubtitleData: class MMTSSubtitleData {}
        },
        './utf8-conv.js': {__esModule: true, default: (data) => Buffer.from(data).toString('utf8')},
        './mmts-demuxer-utils': {
            readU16(data, offset) {
                return (data[offset] << 8) | data[offset + 1];
            },
            readU32(data, offset) {
                return (data[offset] << 24) |
                    (data[offset + 1] << 16) |
                    (data[offset + 2] << 8) |
                    data[offset + 3];
            }
        }
    }).default;
}

function makeSubtitleUnit(text) {
    const payload = Buffer.from(text, 'utf8');
    const unit = new Uint8Array(7 + payload.byteLength);
    unit[0] = 1;
    unit[1] = 2;
    unit[2] = 0;
    unit[3] = 0;
    unit[4] = 0;
    unit[5] = (payload.byteLength >> 8) & 0xff;
    unit[6] = payload.byteLength & 0xff;
    unit.set(payload, 7);
    return unit;
}

function makeAsset() {
    return {
        assetType: 'stpp',
        codec: 'ttml',
        language: 'jpn'
    };
}

function testSubtitleTimestampUsesSampleNumber() {
    const MMTSSubtitleAssembler = loadAssembler();
    const subtitles = [];
    let requested = null;
    const assembler = new MMTSSubtitleAssembler({
        getTimestampAtAccessUnit(packetId, mpuSequenceNumber, auIndex) {
            requested = {packetId, mpuSequenceNumber, auIndex};
            return {
                dts: 96000,
                pts: 96000,
                rawDts: 96000,
                rawPts: 96000,
                timescale: 48000,
                decodingIndex: auIndex,
                presentationIndex: auIndex
            };
        },
        getVideoTimeline() {
            return {
                lastVideoDts: 1200,
                lastVideoPts: 1200,
                outputVideoDtsBase: 0,
                outputVideoRawDtsBase: 1000,
                videoSampleIndex: 4,
                droppedVideoSampleCount: 0
            };
        },
        onSubtitleData(subtitle) {
            subtitles.push(subtitle);
        }
    });

    assembler.processMfuUnit(0x120, makeAsset(), 30, {sampleNumber: 3}, makeSubtitleUnit('caption'));

    assert.deepStrictEqual(requested, {packetId: 0x120, mpuSequenceNumber: 30, auIndex: 2});
    assert.strictEqual(subtitles.length, 1);
    assert.strictEqual(subtitles[0].rawPts, 2000);
    assert.strictEqual(subtitles[0].pts, 1000);
    assert.strictEqual(subtitles[0].text, 'caption');
}

function testSubtitleTimestampIsNotConsumedWithoutSampleNumber() {
    const MMTSSubtitleAssembler = loadAssembler();
    const subtitles = [];
    let calls = 0;
    const assembler = new MMTSSubtitleAssembler({
        getTimestampAtAccessUnit() {
            calls++;
            return null;
        },
        getVideoTimeline() {
            return {
                lastVideoDts: -1,
                lastVideoPts: -1,
                outputVideoDtsBase: -1,
                outputVideoRawDtsBase: -1,
                videoSampleIndex: 0,
                droppedVideoSampleCount: 0
            };
        },
        onSubtitleData(subtitle) {
            subtitles.push(subtitle);
        }
    });

    assembler.processMfuUnit(0x120, makeAsset(), 30, {}, makeSubtitleUnit('caption'));

    assert.strictEqual(calls, 0);
    assert.strictEqual(subtitles.length, 1);
    assert.strictEqual(subtitles[0].pts, undefined);
}

testSubtitleTimestampUsesSampleNumber();
testSubtitleTimestampIsNotConsumedWithoutSampleNumber();

console.log('mmts subtitle assembler tests passed');

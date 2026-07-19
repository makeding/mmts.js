#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadModule(relativePath, requireMap, globals) {
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
    const sandbox = Object.assign({
        require: (id) => {
            if (requireMap && Object.prototype.hasOwnProperty.call(requireMap, id)) {
                return requireMap[id];
            }
            return require(id);
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    }, globals || {});
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

function loadAAC(userAgent) {
    return loadModule('src/demux/aac.ts', {
        './mpeg4-audio': {
            MPEG4SamplingFrequencies: [
                96000, 88200, 64000, 48000, 44100, 32000,
                24000, 22050, 16000, 12000, 11025, 8000, 7350
            ],
            MPEG4AudioObjectTypes: {
                kNull: 0,
                kAACMain: 1,
                kAAC_LC: 2,
                kAAC_SSR: 3,
                kAAC_LTP: 4,
                kAAC_SBR: 5,
                kAAC_Scalable: 6,
            },
            MPEG4SamplingFrequencyIndex: {},
        },
        '../utils/logger.js': {__esModule: true, default: {e() {}, v() {}, w() {}}},
        '../utils/logger': {__esModule: true, default: {e() {}, v() {}, w() {}}},
        './exp-golomb': {__esModule: true, default: class ExpGolomb {}},
    }, {
        navigator: {userAgent},
    });
}

function loadConfig() {
    return loadModule('src/config.js', {
        './utils/browser.js': {__esModule: true, default: {firefox: false}},
    });
}

function loadMP4Generator() {
    return loadModule('src/remux/mp4-generator.js', {});
}

function loadRemuxer() {
    class MediaSegmentInfoList {
        isEmpty() { return true; }
    }
    return loadModule('src/remux/mp4-remuxer.js', {
        '../utils/logger.js': {__esModule: true, default: {e() {}, v() {}, w() {}}},
        './mp4-generator.js': {__esModule: true, default: {}},
        './aac-silent.js': {__esModule: true, default: {}},
        '../utils/browser.js': {__esModule: true, default: {safari: false}},
        '../core/media-segment-info.js': {
            SampleInfo: class {},
            MediaSegmentInfo: class {},
            MediaSegmentInfoList,
        },
        '../utils/exception.js': {IllegalStateException: class IllegalStateException extends Error {}},
    });
}

function loadMMTSDemuxerUtils() {
    return loadModule('src/utils/mmts-demuxer-utils.ts', {
        '../demux/mmt-si': {},
        '../demux/mmtp': {MMTPEncryptionFlag: {}, MMTPPayloadType: {}},
        '../demux/mpu': {__esModule: true, default: {}},
        '../demux/h265': {H265NaluType: {}},
        '../demux/aac': {},
        '../demux/mmts-track-data': {},
    });
}

function containsAscii(buffer, text) {
    const bytes = Buffer.from(buffer);
    return bytes.indexOf(Buffer.from(text, 'ascii')) >= 0;
}

function testFivePointOneAACKeepsLCProfile() {
    const aac = loadAAC('Mozilla/5.0 Chrome/120.0');
    const asc = new aac.AudioSpecificConfig({
        audio_object_type: 2,
        sampling_freq_index: 3,
        channel_config: 6,
    });
    assert.strictEqual(asc.codec_mimetype, 'mp4a.40.2');
    assert.strictEqual(asc.original_codec_mimetype, 'mp4a.40.2');
    assert.strictEqual(asc.channel_count, 6);
    assert.strictEqual(asc.config.length, 2);
}

function testExtendedAribChannelConfigurationsAreIdentifiedButNotSelected() {
    const utils = loadMMTSDemuxerUtils();
    assert.strictEqual(utils.audioLayoutFromAacConfig(11), '6.1ch');
    assert.strictEqual(utils.audioLayoutFromAacConfig(12), '7.1ch');
    assert.strictEqual(utils.audioLayoutFromAacConfig(13), '22.2ch');
    assert.strictEqual(utils.audioLayoutFromAacConfig(14), '7.1ch');
    assert.strictEqual(utils.audioChannelCountFromAacConfig(13), 24);

    const declared = utils.createMMTSAudioTrackInfo({
        packetId: 0xf110,
        assetType: 'mp4a',
        mediaType: 'audio',
        codec: 'aac-latm',
        audioComponentType: 0x11
    }, undefined, false);
    assert.strictEqual(declared.supported, false);
    assert.strictEqual(declared.unsupportedReason, 'channel-layout');
    assert.strictEqual(utils.isMMTSAudioTrackSelectable(declared), false);

    const parsed = utils.updateMMTSAudioTrackInfoFromFrame(0xf110, {
        channel_config: 13,
        sampling_frequency: 48000
    }, declared, false);
    assert.strictEqual(parsed.channelLayout, '22.2ch');
    assert.strictEqual(parsed.channelCount, 24);
    assert.strictEqual(parsed.supported, false);
    assert.strictEqual(parsed.unsupportedReason, 'aac-channel-config');
}

function testMMTSDefaultsPreserveAudioAndVideoGaps() {
    const configModule = loadConfig();
    const vodConfig = configModule.createDefaultConfig();
    configModule.applyMediaDataSourceConfig(vodConfig, {type: 'mmts'}, undefined);
    assert.strictEqual(vodConfig.mmtsDeferHevcVideoInitUntilAudio, true);
    assert.strictEqual(vodConfig.mmtsClampAudioTimestampGap, false);
    assert.strictEqual(vodConfig.mmtsClampVideoTimestampGap, false);
    assert.strictEqual(vodConfig.lazyLoadRecoverBytes, 96 * 1024 * 1024);
    assert.strictEqual(vodConfig.mseAppendBatchDuration, 0.5);

    const liveConfig = configModule.createDefaultConfig();
    configModule.applyMediaDataSourceConfig(liveConfig, {type: 'mmts', isLive: true}, undefined);
    assert.strictEqual(liveConfig.mmtsDeferHevcVideoInitUntilAudio, false);
    assert.strictEqual(liveConfig.mmtsClampAudioTimestampGap, false);
    assert.strictEqual(liveConfig.mmtsClampVideoTimestampGap, false);
    assert.strictEqual(liveConfig.lazyLoadRecoverBytes, 32 * 1024 * 1024);
    assert.strictEqual(liveConfig.mseAppendBatchDuration, 0.35);
}

function testHEVCInitUsesHvc1SampleEntry() {
    const MP4 = loadMP4Generator().default;
    const initSegment = MP4.generateInitSegment({
        type: 'video',
        id: 1,
        timescale: 1000,
        duration: 0,
        codecWidth: 7680,
        codecHeight: 4320,
        presentWidth: 7680,
        presentHeight: 4320,
        codec: 'hvc1.2.1.L183.B0',
        hvcc: new Uint8Array([1, 2, 3, 4]),
    });

    assert.strictEqual(containsAscii(initSegment, 'hvc1'), true);
    assert.strictEqual(containsAscii(initSegment, 'avc1'), false);
}

function testHEVCInitUsesHev1SampleEntry() {
    const MP4 = loadMP4Generator().default;
    const initSegment = MP4.generateInitSegment({
        type: 'video',
        id: 1,
        timescale: 1000,
        duration: 0,
        codecWidth: 7680,
        codecHeight: 4320,
        presentWidth: 7680,
        presentHeight: 4320,
        codec: 'hev1.2.1.L183.B0',
        hvcc: new Uint8Array([1, 2, 3, 4]),
    });

    assert.strictEqual(containsAscii(initSegment, 'hev1'), true);
    assert.strictEqual(containsAscii(initSegment, 'hvc1'), false);
    assert.strictEqual(containsAscii(initSegment, 'avc1'), false);
}

function testMMTSAudioGapPreservationCanBeExplicitlyDisabled() {
    const MP4Remuxer = loadRemuxer().default;
    const remuxer = Object.create(MP4Remuxer.prototype);
    remuxer._isMMTS = true;
    remuxer._config = {mmtsClampAudioTimestampGap: true};
    assert.strictEqual(remuxer._shouldPreserveAudioTimestampGap(727, 21.333), false);

    const preservingRemuxer = Object.create(MP4Remuxer.prototype);
    preservingRemuxer._isMMTS = true;
    preservingRemuxer._config = {mmtsClampAudioTimestampGap: false};
    assert.strictEqual(preservingRemuxer._shouldPreserveAudioTimestampGap(727, 21.333), true);
}

function testVideoSegmentCarriesMMTSSourceInfo() {
    const MP4Remuxer = loadRemuxer().default;
    const remuxer = Object.create(MP4Remuxer.prototype);
    const sourceInfo = remuxer._makeSegmentMMTSSourceInfo([
        {mmtsSourceInfo: {packetId: 1, mpuSequenceNumber: 10, sampleNumber: 1, filePosition: 1000, rawDts: 0, dts: 0}},
        {mmtsSourceInfo: {packetId: 1, mpuSequenceNumber: 10, sampleNumber: 2, filePosition: 2000, rawDts: 33, dts: 33}},
    ]);
    assert.strictEqual(sourceInfo.packetId, 1);
    assert.strictEqual(sourceInfo.firstSample.sampleNumber, 1);
    assert.strictEqual(sourceInfo.lastSample.sampleNumber, 2);
    assert.strictEqual(sourceInfo.lastSample.filePosition, 2000);
}

function testFirstVideoPlayableWindowUsesRemuxedTimeline() {
    const MP4Remuxer = loadRemuxer().default;
    const remuxer = Object.create(MP4Remuxer.prototype);
    const window = remuxer._makeFirstVideoPlayableWindow([
        {dts: 1000, pts: 1040, duration: 40, isKeyframe: true},
        {dts: 1040, pts: 1000, duration: 40, isKeyframe: false},
    ]);
    assert.strictEqual(window.decodeStart, 1);
    assert.strictEqual(window.compositionStart, 1);
    assert.strictEqual(window.syncPoint, 1.04);
    assert.strictEqual(window.playableStart, 1.04);
    assert.strictEqual(window.playableEnd, 1.08);
}

testFivePointOneAACKeepsLCProfile();
testExtendedAribChannelConfigurationsAreIdentifiedButNotSelected();
testMMTSDefaultsPreserveAudioAndVideoGaps();
testHEVCInitUsesHvc1SampleEntry();
testHEVCInitUsesHev1SampleEntry();
testMMTSAudioGapPreservationCanBeExplicitlyDisabled();
testVideoSegmentCarriesMMTSSourceInfo();
testFirstVideoPlayableWindowUsesRemuxedTimeline();

console.log('mmts aac/config/remux tests passed');

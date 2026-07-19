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
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = {
        require: (id) => {
            if (requireMap && Object.prototype.hasOwnProperty.call(requireMap, id)) {
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

function loadProgram() {
    const mpu = loadModule('src/demux/mpu.ts', {});
    const timestampTable = loadModule('src/demux/mmts-timestamp-table.ts', {
        './mmt-si': {}
    });
    const program = loadModule('src/demux/mmts-program.ts', {
        './mmt-si': {
            __esModule: true,
            default: {
                createFragmentState() {
                    return {data: [], lastSeq: 0, state: 'init'};
                },
                parseSignalingPayload() {
                    return {assets: [], conditionalAccessInfos: [], messages: [], tables: []};
                }
            }
        },
        './mmtp': {},
        './mpu': mpu,
        './mmts-timestamp-table': timestampTable
    });
    return new program.default();
}

function writeU16(data, offset, value) {
    data[offset] = (value >>> 8) & 0xff;
    data[offset + 1] = value & 0xff;
}

function writeU32(data, offset, value) {
    data[offset] = (value >>> 24) & 0xff;
    data[offset + 1] = (value >>> 16) & 0xff;
    data[offset + 2] = (value >>> 8) & 0xff;
    data[offset + 3] = value & 0xff;
}

function makeTimedMfuPayload(options) {
    const media = options.media || new Uint8Array([0, 0, 0, 1, 0x26]);
    const payload = new Uint8Array(8 + 14 + media.byteLength);
    writeU16(payload, 0, payload.byteLength - 2);
    payload[2] = (2 << 4) | (1 << 3) | (options.fragmentationIndicator << 1);
    payload[3] = options.fragmentCounter || 0;
    writeU32(payload, 4, options.mpuSequenceNumber);
    writeU32(payload, 8, options.movieFragmentSequenceNumber || 1);
    writeU32(payload, 12, options.sampleNumber);
    writeU32(payload, 16, options.offset || 0);
    payload[20] = 0;
    payload[21] = 0;
    payload.set(media, 22);
    return payload;
}

function makeMmtpPacket(sequenceNumber, payload) {
    return {
        version: 1,
        packetCounterFlag: false,
        fecType: 0,
        extensionHeaderFlag: false,
        rapFlag: false,
        payloadType: 0,
        packetId: 0xf100,
        deliveryTimestamp: 0,
        packetSequenceNumber: sequenceNumber,
        payload
    };
}

function testPacketSequenceGapDropsOpenFragmentedMfu() {
    const program = loadProgram();

    const first = program.parseMpuPacket(makeMmtpPacket(10, makeTimedMfuPayload({
        mpuSequenceNumber: 100,
        sampleNumber: 1,
        fragmentationIndicator: 1,
        fragmentCounter: 1,
        media: new Uint8Array([0, 0, 0])
    })), 1000);

    assert.notStrictEqual(first, null);
    assert.strictEqual(first.loss.packetSequenceGap, false);
    assert.strictEqual(first.loss.fragmentedUnitDropped, false);
    assert.strictEqual(first.units.length, 0);

    const afterGap = program.parseMpuPacket(makeMmtpPacket(12, makeTimedMfuPayload({
        mpuSequenceNumber: 100,
        sampleNumber: 2,
        fragmentationIndicator: 0,
        media: new Uint8Array([0, 0, 0, 1, 0x26])
    })), 2000);

    assert.notStrictEqual(afterGap, null);
    assert.strictEqual(afterGap.loss.packetSequenceGap, true);
    assert.strictEqual(afterGap.loss.fragmentedUnitDropped, true);
    assert.strictEqual(afterGap.loss.expectedSeq, 11);
    assert.strictEqual(afterGap.loss.actualSeq, 12);
    assert.strictEqual(afterGap.discontinuity, true);
    assert.strictEqual(afterGap.units.length, 1);
    assert.strictEqual(afterGap.units[0].fragment.sampleNumber, 2);
    assert.strictEqual(afterGap.units[0].filePosition, 2000);
}

function testSequentialPacketsDoNotReportLoss() {
    const program = loadProgram();

    program.parseMpuPacket(makeMmtpPacket(20, makeTimedMfuPayload({
        mpuSequenceNumber: 101,
        sampleNumber: 1,
        fragmentationIndicator: 0
    })), 1000);

    const next = program.parseMpuPacket(makeMmtpPacket(21, makeTimedMfuPayload({
        mpuSequenceNumber: 101,
        sampleNumber: 2,
        fragmentationIndicator: 0
    })), 2000);

    assert.notStrictEqual(next, null);
    assert.strictEqual(next.loss.packetSequenceGap, false);
    assert.strictEqual(next.loss.fragmentedUnitDropped, false);
    assert.strictEqual(next.discontinuity, false);
    assert.strictEqual(next.units.length, 1);
}

function testVodSeekPreservesTimestampBaseButResetsMpuCursor() {
    const program = loadProgram();
    program.stream_states_by_packet_id_ = {
        0xf100: {
            firstDts: 1782723048377,
            lastMpuSequenceNumber: 13233226,
        },
    };

    program.resetMediaState(true);

    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(program.stream_states_by_packet_id_)),
        {
            0xf100: {
                firstDts: 1782723048377,
            },
        }
    );
}

function testDuplicateUnfragmentedPacketIsDropped() {
    const program = loadProgram();
    const payload = makeTimedMfuPayload({
        mpuSequenceNumber: 102,
        sampleNumber: 1,
        fragmentationIndicator: 0,
        media: new Uint8Array([1, 2, 3])
    });

    const first = program.parseMpuPacket(makeMmtpPacket(30, payload), 1000);
    const duplicate = program.parseMpuPacket(makeMmtpPacket(30, payload), 1000);
    const next = program.parseMpuPacket(makeMmtpPacket(31, makeTimedMfuPayload({
        mpuSequenceNumber: 102,
        sampleNumber: 2,
        fragmentationIndicator: 0,
        media: new Uint8Array([4, 5, 6])
    })), 2000);

    assert.notStrictEqual(first, null);
    assert.strictEqual(first.units.length, 1);
    assert.strictEqual(duplicate, null);
    assert.notStrictEqual(next, null);
    assert.strictEqual(next.loss.packetSequenceGap, false);
    assert.strictEqual(next.units.length, 1);
}

function testDuplicateMiddleFragmentIsNotAppendedTwice() {
    const program = loadProgram();
    const firstPayload = makeTimedMfuPayload({
        mpuSequenceNumber: 103,
        sampleNumber: 1,
        fragmentationIndicator: 1,
        media: new Uint8Array([1, 2])
    });
    const middlePayload = makeTimedMfuPayload({
        mpuSequenceNumber: 103,
        sampleNumber: 1,
        fragmentationIndicator: 2,
        media: new Uint8Array([3, 4])
    });
    const lastPayload = makeTimedMfuPayload({
        mpuSequenceNumber: 103,
        sampleNumber: 1,
        fragmentationIndicator: 3,
        media: new Uint8Array([5, 6])
    });

    program.parseMpuPacket(makeMmtpPacket(40, firstPayload), 1000);
    program.parseMpuPacket(makeMmtpPacket(41, middlePayload), 2000);
    const duplicate = program.parseMpuPacket(makeMmtpPacket(41, middlePayload), 2000);
    const completed = program.parseMpuPacket(makeMmtpPacket(42, lastPayload), 3000);

    assert.strictEqual(duplicate, null);
    assert.notStrictEqual(completed, null);
    assert.strictEqual(completed.loss.packetSequenceGap, false);
    assert.strictEqual(completed.units.length, 1);
    assert.deepStrictEqual(Array.from(completed.units[0].unit), [1, 2, 3, 4, 5, 6]);
}

function testFragmentedMfuAllowsSpecCompliantIncreasingOffsets() {
    const program = loadProgram();
    const firstPayload = makeTimedMfuPayload({
        mpuSequenceNumber: 104,
        movieFragmentSequenceNumber: 8,
        sampleNumber: 3,
        offset: 100,
        fragmentationIndicator: 1,
        fragmentCounter: 2,
        media: new Uint8Array([1, 2])
    });
    const middlePayload = makeTimedMfuPayload({
        mpuSequenceNumber: 104,
        movieFragmentSequenceNumber: 8,
        sampleNumber: 3,
        offset: 102,
        fragmentationIndicator: 2,
        fragmentCounter: 1,
        media: new Uint8Array([3, 4])
    });
    const lastPayload = makeTimedMfuPayload({
        mpuSequenceNumber: 104,
        movieFragmentSequenceNumber: 8,
        sampleNumber: 3,
        offset: 104,
        fragmentationIndicator: 3,
        fragmentCounter: 0,
        media: new Uint8Array([5, 6])
    });

    program.parseMpuPacket(makeMmtpPacket(50, firstPayload), 1000);
    program.parseMpuPacket(makeMmtpPacket(51, middlePayload), 2000);
    const completed = program.parseMpuPacket(makeMmtpPacket(52, lastPayload), 3000);

    assert.notStrictEqual(completed, null);
    assert.strictEqual(completed.loss.fragmentedUnitDropped, false);
    assert.strictEqual(completed.units.length, 1);
    assert.strictEqual(completed.units[0].fragment.movieFragmentSequenceNumber, 8);
    assert.strictEqual(completed.units[0].fragment.offset, 100);
    assert.deepStrictEqual(Array.from(completed.units[0].unit), [1, 2, 3, 4, 5, 6]);
}

testPacketSequenceGapDropsOpenFragmentedMfu();
testSequentialPacketsDoNotReportLoss();
testVodSeekPreservesTimestampBaseButResetsMpuCursor();
testDuplicateUnfragmentedPacketIsDropped();
testDuplicateMiddleFragmentIsNotAppendedTwice();
testFragmentedMfuAllowsSpecCompliantIncreasingOffsets();

console.log('mmts program packet loss tests passed');

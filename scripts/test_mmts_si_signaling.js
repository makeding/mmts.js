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
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        }
    }).outputText;
    const moduleObject = {exports: {}};
    const sandbox = {
        require: (id) => Object.prototype.hasOwnProperty.call(requireMap || {}, id) ? requireMap[id] : require(id),
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

function bytes(...values) {
    return Uint8Array.from(values.flatMap((value) => value instanceof Uint8Array ? Array.from(value) : value));
}

function u16(value) {
    return [value >> 8, value & 0xff];
}

function u32(value) {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function fourcc(value) {
    return Array.from(Buffer.from(value, 'ascii'));
}

function descriptor(tag, payload) {
    return bytes(u16(tag), payload.byteLength, payload);
}

function asset(type, packetId, descriptors) {
    const payload = bytes(
        0x00, 0x00, 0x00, 0x00, 0x00, // identifier type and scheme
        0x01, 0x01,                   // asset ID length and value
        fourcc(type),
        0x00,                         // no asset clock relation
        0x01, 0x00, ...u16(packetId), // one packet-id location
        ...u16(descriptors.byteLength), descriptors
    );
    return payload;
}

function mpt(tableId, version, mode, assets) {
    const payload = bytes(
        mode << 6,
        0x01, 0xaa,
        0x00, 0x00,
        assets.length,
        ...assets
    );
    return bytes(tableId, version, ...u16(payload.byteLength), payload);
}

function signalingPacket(table) {
    const message = signalingMessage(table);
    return bytes(0x01, 0x00, ...u16(message.byteLength), message);
}

function signalingMessage(table) {
    return bytes(0x80, 0x00, 0x00, ...u16(table.byteLength), table);
}

function testAssetDescriptorsAndHvc1() {
    const MMTSI = loadModule('src/demux/mmt-si.ts', {}).default;
    const hevc = descriptor(0x800a, bytes(
        0x21, ...u32(0x60000000),
        0xf0, 0, 0, 0, 0, 0,
        0xb7, 0xe0, 0x05, 0x07
    ));
    const audioComponent = descriptor(0x8014, bytes(
        0x03, 0x03, 0x00, 0x10, 0x1c, 0x00, 0x4e,
        ...fourcc('jpn')
    ));
    const audio = bytes(
        audioComponent,
        descriptor(0x8008, bytes(0x0f)),
        descriptor(0x8009, bytes(0x80, 0x02, 0x11, 0x90))
    );
    const result = MMTSI.parseSignalingPayload(
        signalingPacket(mpt(0x20, 4, 2, [
            asset('hvc1', 0x120, hevc),
            asset('mp4a', 0x121, audio)
        ])),
        1,
        MMTSI.createFragmentState()
    );

    assert.strictEqual(result.mptTables.length, 1);
    const assets = result.mptTables[0].assets;
    assert.strictEqual(assets[0].mediaType, 'video');
    assert.strictEqual(assets[0].codec, 'hevc');
    assert.strictEqual(assets[0].hevcProfileIdc, 1);
    assert.strictEqual(assets[0].hevcLevelIdc, 0xb7);
    assert.strictEqual(assets[0].hevcProgressiveSourceFlag, true);
    assert.strictEqual(assets[0].hevcInterlacedSourceFlag, true);
    assert.strictEqual(assets[0].hevcNonPackedConstraintFlag, true);
    assert.strictEqual(assets[0].hevcFrameOnlyConstraintFlag, true);
    assert.strictEqual(assets[0].hevcTemporalLayerSubsetFlag, true);
    assert.strictEqual(assets[0].hevcStillPresentFlag, true);
    assert.strictEqual(assets[0].hevc24HourPicturePresentFlag, true);
    assert.strictEqual(assets[0].hevcTemporalIdMin, 5);
    assert.strictEqual(assets[0].hevcTemporalIdMax, 7);
    assert.strictEqual(assets[1].codec, 'aac');
    assert.strictEqual(assets[1].audioStreamType, 0x1c);
    assert.deepStrictEqual(Array.from(assets[1].audioSpecificConfig), [0x11, 0x90]);
}

function testOrderedMptSubsets() {
    const mmtsi = loadModule('src/demux/mmt-si.ts', {});
    const MMTSProgram = loadModule('src/demux/mmts-program.ts', {
        './mmt-si': mmtsi,
        './mpu': {__esModule: true, default: {}},
        './mmts-timestamp-table': {__esModule: true, default: class {}}
    }).default;
    const program = new MMTSProgram();
    const firstSubset = signalingPacket(mpt(0x11, 7, 0, [asset('mp4a', 0x131, bytes())]));
    const secondSubset = signalingPacket(mpt(0x12, 7, 0, [asset('hvc1', 0x132, bytes())]));

    // Mode 00 must wait for subset 0 when subset 1 arrives first.
    assert.strictEqual(program.parseSignalingPacket({payload: secondSubset, packetSequenceNumber: 1, packetId: 1}).length, 0);
    const assets = program.parseSignalingPacket({payload: firstSubset, packetSequenceNumber: 2, packetId: 1});
    assert.deepStrictEqual(Array.from(assets, (item) => item.packetId), [0x131, 0x132]);
    assert.strictEqual(program.getAsset(0x132).assetType, 'hvc1');
}

function testTimestampRestartUsesEarliestDescriptorSignalingPosition() {
    const mmtsi = loadModule('src/demux/mmt-si.ts', {});
    const MMTSProgram = loadModule('src/demux/mmts-program.ts', {
        './mmt-si': mmtsi,
        './mpu': {__esModule: true, default: {}},
        './mmts-timestamp-table': {__esModule: true, default: class {}}
    }).default;
    const program = new MMTSProgram();
    const timestamp = descriptor(0x0001, bytes(
        ...u32(20),
        ...u32(0), ...u32(0)
    ));
    const extendedTimestamp = descriptor(0x8026, bytes(
        0x01, ...u32(1000),
        ...u32(20), 0x00, ...u16(0), 0x01, ...u16(0)
    ));

    program.parseSignalingPacket({
        payload: signalingPacket(mpt(0x20, 1, 2, [asset('hvc1', 0x140, timestamp)])),
        packetSequenceNumber: 1,
        packetId: 1
    }, 1000);
    program.parseSignalingPacket({
        payload: signalingPacket(mpt(0x20, 2, 2, [asset('hvc1', 0x140, extendedTimestamp)])),
        packetSequenceNumber: 2,
        packetId: 1
    }, 2000);

    assert.strictEqual(program.getTimestampRestartFilePosition(0x140, 20), 1000);
    program.resetMediaState(true);
    assert.strictEqual(program.getTimestampRestartFilePosition(0x140, 20), null);
    assert.strictEqual(program.getAsset(0x140).assetType, 'hvc1');
}

function testFragmentedSignalingUsesFirstFragmentPosition() {
    const mmtsi = loadModule('src/demux/mmt-si.ts', {});
    const MMTSProgram = loadModule('src/demux/mmts-program.ts', {
        './mmt-si': mmtsi,
        './mpu': {__esModule: true, default: {}},
        './mmts-timestamp-table': {__esModule: true, default: class {}}
    }).default;
    const program = new MMTSProgram();
    const descriptors = bytes(
        descriptor(0x0001, bytes(...u32(21), ...u32(0), ...u32(0))),
        descriptor(0x8026, bytes(
            0x01, ...u32(1000),
            ...u32(21), 0x00, ...u16(0), 0x01, ...u16(0)
        ))
    );
    const message = signalingMessage(
        mpt(0x20, 1, 2, [asset('hvc1', 0x141, descriptors)])
    );
    const split = Math.floor(message.byteLength / 2);

    assert.strictEqual(program.parseSignalingPacket({
        payload: bytes(0x40, 0x00, message.subarray(0, split)),
        packetSequenceNumber: 10,
        packetId: 1
    }, 4096).length, 0);
    program.parseSignalingPacket({
        payload: bytes(0xc0, 0x00, message.subarray(split)),
        packetSequenceNumber: 11,
        packetId: 1
    }, 8192);

    assert.strictEqual(program.getTimestampRestartFilePosition(0x141, 21), 4096);
}

function testDuplicateSignalingPacketIsIgnored() {
    const MMTSI = loadModule('src/demux/mmt-si.ts', {}).default;
    const state = MMTSI.createFragmentState();
    const payload = signalingPacket(mpt(0x20, 4, 2, [asset('hvc1', 0x150, bytes())]));
    const first = MMTSI.parseSignalingPayload(payload, 100, state);
    const duplicate = MMTSI.parseSignalingPayload(payload, 100, state);

    assert.strictEqual(first.mptTables.length, 1);
    assert.strictEqual(duplicate.mptTables.length, 0);
    assert.strictEqual(duplicate.messages.length, 0);
}

testAssetDescriptorsAndHvc1();
testOrderedMptSubsets();
testTimestampRestartUsesEarliestDescriptorSignalingPosition();
testFragmentedSignalingUsesFirstFragmentPosition();
testDuplicateSignalingPacketIsIgnored();

console.log('mmts SI signaling tests passed');

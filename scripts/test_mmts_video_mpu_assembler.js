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

function makeLengthPrefixedNalu(type, firstSlice) {
    const data = new Uint8Array(7);
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
    data[3] = 3;
    data[4] = type << 1;
    data[5] = 1;
    data[6] = firstSlice ? 0x80 : 0;
    return {type, data};
}

function makeAssembler() {
    const exports = loadModule('src/demux/mmts-video-mpu-assembler.ts', {
        './h265': {
            H265NaluType: {
                kSliceAUD: 35
            }
        },
        './mpu': {
            __esModule: true,
            default: {
                readLengthPrefixedUnitLength(unit) {
                    if (unit.byteLength < 4) {
                        return undefined;
                    }
                    return (unit[0] << 24) | (unit[1] << 16) | (unit[2] << 8) | unit[3];
                }
            }
        },
        '../utils/mmts-demuxer-utils': {
            isH265VclNalu(type) {
                return type >= 0 && type <= 31;
            }
        }
    });
    return new exports.default();
}

function appendVcl(assembler, sampleNumber, firstSlice, filePosition) {
    return appendVclForMpu(assembler, 12, sampleNumber, firstSlice, filePosition);
}

function appendVclForMpu(assembler, mpuSequenceNumber, sampleNumber, firstSlice, filePosition) {
    return appendVclForPacketAndMpu(assembler, 0x100, mpuSequenceNumber, sampleNumber, firstSlice, filePosition);
}

function appendVclForPacketAndMpu(assembler, packetId, mpuSequenceNumber, sampleNumber, firstSlice, filePosition) {
    return appendVclForPacketAndMpuWithOffset(
        assembler,
        packetId,
        mpuSequenceNumber,
        sampleNumber,
        firstSlice,
        firstSlice ? 0 : 9,
        filePosition
    );
}

function appendVclForPacketAndMpuWithOffset(assembler,
                                            packetId,
                                            mpuSequenceNumber,
                                            sampleNumber,
                                            firstSlice,
                                            offset,
                                            filePosition) {
    return assembler.appendNalu({
        packetId,
        mpuSequenceNumber,
        sampleNumber,
        offset,
        filePosition,
        nalu: makeLengthPrefixedNalu(1, firstSlice),
        keyframe: false,
        isVcl: true
    });
}

function testPositiveSampleNumberIndexes() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVcl(assembler, 1, true, 100).length, 0);
    const completed = appendVcl(assembler, 2, true, 200);
    assert.strictEqual(completed.length, 0);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 2);
    assert.strictEqual(flushed[0].sampleNumber, 1);
    assert.strictEqual(flushed[0].auIndex, 0);
    assert.strictEqual(flushed[1].sampleNumber, 2);
    assert.strictEqual(flushed[1].auIndex, 1);
}

function testZeroSampleNumberUsesFirstSliceOrder() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVcl(assembler, 0, true, 100).length, 0);
    assert.strictEqual(appendVcl(assembler, 0, false, 110).length, 0);
    const completed = appendVcl(assembler, 0, true, 200);
    assert.strictEqual(completed.length, 0);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 2);
    assert.strictEqual(flushed[0].sampleNumber, 0);
    assert.strictEqual(flushed[0].auIndex, 0);
    assert.strictEqual(flushed[0].units.length, 2);
    assert.strictEqual(flushed[1].sampleNumber, 0);
    assert.strictEqual(flushed[1].auIndex, 1);
    assert.strictEqual(flushed[1].units.length, 1);
}

function testZeroSampleNumberDoesNotUseOffsetWithoutHevcBoundary() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVclForPacketAndMpuWithOffset(assembler, 0x100, 12, 0, true, 0, 100).length, 0);
    assert.strictEqual(appendVclForPacketAndMpuWithOffset(assembler, 0x100, 12, 0, false, 9, 110).length, 0);
    assert.strictEqual(appendVclForPacketAndMpuWithOffset(assembler, 0x100, 12, 0, false, 0, 200).length, 0);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].auIndex, 0);
    assert.strictEqual(flushed[0].units.length, 3);
}

function testPositiveSampleNumberIsAuthoritative() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVclForPacketAndMpuWithOffset(assembler, 0x100, 12, 1, true, 0, 100).length, 0);
    assert.strictEqual(appendVclForPacketAndMpuWithOffset(assembler, 0x100, 12, 1, true, 0, 110).length, 0);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].sampleNumber, 1);
    assert.strictEqual(flushed[0].auIndex, 0);
    assert.strictEqual(flushed[0].units.length, 2);
}

function testNonVclBelongsToFollowingAccessUnit() {
    const assembler = makeAssembler();
    const aud = makeLengthPrefixedNalu(35, false);

    assert.strictEqual(assembler.appendNalu({
        packetId: 0x100,
        mpuSequenceNumber: 12,
        sampleNumber: 1,
        offset: 0,
        filePosition: 90,
        nalu: aud,
        keyframe: false,
        isVcl: false
    }).length, 0);
    assert.strictEqual(appendVcl(assembler, 1, true, 100).length, 0);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].auIndex, 0);
    assert.strictEqual(flushed[0].filePosition, 90);
    assert.strictEqual(flushed[0].units.length, 2);
}

function testCompletedAccessUnitsFlushAtMpuBoundary() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVclForMpu(assembler, 12, 0, true, 100).length, 0);
    assert.strictEqual(appendVclForMpu(assembler, 12, 0, true, 200).length, 0);
    const completed = appendVclForMpu(assembler, 13, 0, true, 300);
    assert.strictEqual(completed.length, 2);
    assert.strictEqual(completed[0].mpuSequenceNumber, 12);
    assert.strictEqual(completed[0].auIndex, 0);
    assert.strictEqual(completed[1].mpuSequenceNumber, 12);
    assert.strictEqual(completed[1].auIndex, 1);
}

function testInterleavedPacketsKeepIndependentMpuState() {
    const assembler = makeAssembler();

    assert.strictEqual(appendVclForPacketAndMpu(assembler, 0x100, 12, 0, true, 100).length, 0);
    assert.strictEqual(appendVclForPacketAndMpu(assembler, 0x101, 50, 0, true, 120).length, 0);
    assert.strictEqual(appendVclForPacketAndMpu(assembler, 0x100, 12, 0, true, 200).length, 0);

    const completed = appendVclForPacketAndMpu(assembler, 0x100, 13, 0, true, 300);
    assert.strictEqual(completed.length, 2);
    assert.strictEqual(completed[0].packetId, 0x100);
    assert.strictEqual(completed[0].auIndex, 0);
    assert.strictEqual(completed[1].packetId, 0x100);
    assert.strictEqual(completed[1].auIndex, 1);

    const flushed = assembler.flush();
    assert.strictEqual(flushed.length, 2);
    assert.strictEqual(flushed[0].packetId, 0x100);
    assert.strictEqual(flushed[0].mpuSequenceNumber, 13);
    assert.strictEqual(flushed[1].packetId, 0x101);
    assert.strictEqual(flushed[1].mpuSequenceNumber, 50);
}

function testStandaloneAccessUnitWaitsForMpuBoundary() {
    const assembler = makeAssembler();
    const unit = makeLengthPrefixedNalu(1, true);

    let completed = assembler.appendStandaloneAccessUnit(
        0x100,
        12,
        undefined,
        100,
        [unit],
        unit.data.byteLength,
        false
    );
    assert.strictEqual(completed.length, 0);

    completed = appendVclForMpu(assembler, 13, 0, true, 200);
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0].mpuSequenceNumber, 12);
    assert.strictEqual(completed[0].auIndex, 0);
    assert.strictEqual(completed[0].sampleNumber, undefined);
}

function testDiscontinuityReconciliation() {
    const assembler = makeAssembler();

    appendVcl(assembler, 0, true, 100);
    let result = assembler.reconcileMpuDiscontinuity(0x100, 12, 0);
    assert.strictEqual(result.completed.length, 0);
    assert.strictEqual(result.dropped.auIndex, 0);

    appendVcl(assembler, 0, true, 200);
    result = assembler.reconcileMpuDiscontinuity(0x100, 13, 0);
    assert.strictEqual(result.completed.length, 1);
    assert.strictEqual(result.completed[0].auIndex, 1);
    assert.strictEqual(result.dropped, null);
}

testPositiveSampleNumberIndexes();
testZeroSampleNumberUsesFirstSliceOrder();
testZeroSampleNumberDoesNotUseOffsetWithoutHevcBoundary();
testPositiveSampleNumberIsAuthoritative();
testNonVclBelongsToFollowingAccessUnit();
testCompletedAccessUnitsFlushAtMpuBoundary();
testInterleavedPacketsKeepIndependentMpuState();
testStandaloneAccessUnitWaitsForMpuBoundary();
testDiscontinuityReconciliation();

console.log('mmts video mpu assembler tests passed');

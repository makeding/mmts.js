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
    };
    vm.runInNewContext(compiled, sandbox, {filename: sourcePath});
    return moduleObject.exports;
}

const loggerStub = {__esModule: true, default: {e() {}, v() {}, w() {}, i() {}, d() {}}};
const h265 = loadModule('src/demux/h265.ts', {
    '../utils/logger': loggerStub,
    '../utils/logger.js': loggerStub,
});
const HEVCPocRecovery = loadModule('src/demux/hevc-poc.ts', {
    './h265': h265,
}).default;
const N = h265.H265NaluType;

function picture(auIndex, nalUnitType, pocLsb, options = {}) {
    return {
        auIndex,
        nalUnitType,
        temporalId: options.temporalId === undefined ? 0 : options.temporalId,
        pocLsb,
        log2MaxPicOrderCntLsb: options.log2MaxPicOrderCntLsb || 4,
        parameterSetSignature: options.parameterSetSignature || 'v0:s0:p0:g1',
    };
}

(function testBFramePresentationMapping() {
    const recovery = new HEVCPocRecovery();
    const prepared = recovery.prepareMpu([
        picture(0, N.kSliceIDR_W_RADL, 0),
        picture(1, N.kSliceTRAIL_R, 2),
        picture(2, N.kSliceTRAIL_R, 1),
    ]);
    assert(prepared);
    assert.deepStrictEqual(Array.from(prepared.pictures, (item) => item.poc), [0, 2, 1]);
    assert.deepStrictEqual(Array.from(prepared.presentationIndexes), [0, 2, 1]);
    assert.strictEqual(recovery.commit(prepared), true);
})();

(function testPocLsbWrapAcrossMpus() {
    const recovery = new HEVCPocRecovery();
    const first = recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 14),
    ]);
    assert(first);
    assert.strictEqual(first.pictures[0].poc, 14);
    recovery.commit(first);

    const wrapped = recovery.prepareMpu([
        picture(0, N.kSliceTRAIL_R, 1),
    ]);
    assert(wrapped);
    assert.strictEqual(wrapped.pictures[0].poc, 17);
})();

(function testTemporalLayerDoesNotReplacePrevTid0State() {
    const recovery = new HEVCPocRecovery();
    const randomAccess = recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 0),
    ]);
    assert(randomAccess);
    recovery.commit(randomAccess);

    const prepared = recovery.prepareMpu([
        picture(0, N.kSliceTRAIL_R, 15, {temporalId: 1}),
        picture(1, N.kSliceTRAIL_R, 1, {temporalId: 0}),
    ]);
    assert(prepared);
    assert.deepStrictEqual(Array.from(prepared.pictures, (item) => item.poc), [-1, 1]);
})();

(function testCraLeadingRaslOutputRules() {
    const recovery = new HEVCPocRecovery();
    const startup = recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 10, {log2MaxPicOrderCntLsb: 5}),
        picture(1, N.kSliceRASL_R, 8, {log2MaxPicOrderCntLsb: 5}),
    ]);
    assert(startup);
    assert.strictEqual(startup.pictures[0].noRaslOutput, true);
    assert.strictEqual(startup.pictures[1].outputAllowed, false);
    assert.deepStrictEqual(Array.from(startup.presentationIndexes), [1, 0]);
    recovery.commit(startup);

    const continuousCra = recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 20, {log2MaxPicOrderCntLsb: 5}),
        picture(1, N.kSliceRASL_R, 18, {log2MaxPicOrderCntLsb: 5}),
    ]);
    assert(continuousCra);
    assert.strictEqual(continuousCra.pictures[0].noRaslOutput, false);
    assert.strictEqual(continuousCra.pictures[1].outputAllowed, true);
})();

(function testBlaAlwaysStartsNoRaslOutputPeriod() {
    const recovery = new HEVCPocRecovery();
    const idr = recovery.prepareMpu([picture(0, N.kSliceIDR_N_LP, 0)]);
    assert(idr);
    recovery.commit(idr);
    const bla = recovery.prepareMpu([
        picture(0, N.kSliceBLA_W_RADL, 7),
        picture(1, N.kSliceRASL_R, 5),
    ]);
    assert(bla);
    assert.strictEqual(bla.pictures[0].noRaslOutput, true);
    assert.strictEqual(bla.pictures[1].outputAllowed, false);
})();

(function testParameterSetSwitchRequiresIrap() {
    const recovery = new HEVCPocRecovery();
    const initial = recovery.prepareMpu([picture(0, N.kSliceCRA_NUT, 0)]);
    assert(initial);
    recovery.commit(initial);

    assert.strictEqual(recovery.prepareMpu([
        picture(0, N.kSliceTRAIL_R, 1, {parameterSetSignature: 'v1:s1:p1:g2'}),
    ]), null);

    const switched = recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 4, {parameterSetSignature: 'v1:s1:p1:g2'}),
    ]);
    assert(switched);
})();

(function testDuplicatePocRejectsWholeMpu() {
    const recovery = new HEVCPocRecovery();
    assert.strictEqual(recovery.prepareMpu([
        picture(0, N.kSliceIDR_W_RADL, 0),
        picture(1, N.kSliceTRAIL_R, 0),
    ]), null);
})();

(function testRejectedMpuWaitsForNextRandomAccess() {
    const recovery = new HEVCPocRecovery();
    const initial = recovery.prepareMpu([picture(0, N.kSliceCRA_NUT, 0)]);
    assert(initial);
    recovery.commit(initial);
    recovery.rejectMpu();
    assert.strictEqual(recovery.waitingForRandomAccess, true);
    assert.strictEqual(recovery.prepareMpu([picture(0, N.kSliceTRAIL_R, 1)]), null);
    const recovered = recovery.prepareMpu([picture(0, N.kSliceIDR_N_LP, 0)]);
    assert(recovered);
})();

(function testEosResetsCommittedState() {
    const recovery = new HEVCPocRecovery();
    const prepared = recovery.prepareMpu([picture(0, N.kSliceCRA_NUT, 0)], true);
    assert(prepared);
    recovery.commit(prepared);
    assert.strictEqual(recovery.waitingForRandomAccess, true);
    assert.strictEqual(recovery.prepareMpu([picture(0, N.kSliceTRAIL_R, 1)]), null);
})();

(function testInvalidIrapAndTemporalInputsReject() {
    const recovery = new HEVCPocRecovery();
    assert.strictEqual(recovery.prepareMpu([
        picture(0, N.kSliceRSV_IRAP_VCL22, 0),
    ]), null);
    assert.strictEqual(recovery.prepareMpu([
        picture(0, N.kSliceCRA_NUT, 0, {temporalId: 1}),
    ]), null);
})();

console.log('HEVC POC recovery tests passed');

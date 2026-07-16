#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function compile(relativePath, requireMap = {}) {
    const sourcePath = path.resolve(__dirname, '..', relativePath);
    const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018},
    }).outputText;
    const moduleObject = {exports: {}};
    vm.runInNewContext(output, {
        module: moduleObject,
        exports: moduleObject.exports,
        require(id) {
            if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
            return require(id);
        },
        Date,
        Object,
        Number,
        Set,
        isFinite,
        TypeError,
        setTimeout,
        clearTimeout,
    }, {filename: sourcePath});
    return moduleObject.exports;
}

const operationModule = compile('src/core/playback-operation.ts');
const Coordinator = compile('src/player/mmts-video-track-switch-transaction.ts', {
    '../core/playback-operation': operationModule,
}).default;

function makeOperation(generation, packetId) {
    return operationModule.createPlaybackOperation({
        scopeId: 'video-track-switch-test',
        timelineGeneration: generation,
        kind: 'video-switch',
        transactionId: generation,
        phase: 'requested',
        requestedTimeMilliseconds: 1000,
        packetId,
    });
}

function makeReservation(generation = 1, packetId = 0xf201, priorPacketId = 0xf200) {
    return {
        operation: makeOperation(generation, packetId),
        priorCommittedPacketId: priorPacketId,
        targetPacketId: packetId,
    };
}

function makeCoordinator() {
    let now = 0;
    const timers = [];
    const timedOut = [];
    const coordinator = new Coordinator({
        now: () => now,
        setTimer(callback, delay) {
            const timer = {callback, delay, cleared: false};
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) { timer.cleared = true; },
        onTimeout(transaction) { timedOut.push(transaction); },
        stageTimeout: () => 100,
    });
    return {coordinator, timers, timedOut, setNow(value) { now = value; }};
}

function acceptSelection(coordinator, operation, overrides = {}) {
    return coordinator.selectionResult(operation, Object.assign({
        transactionId: operation.transactionId,
        attempt: operation.attempt,
        accepted: true,
        changed: true,
        requestedPacketId: operation.packetId,
        selectedPacketId: operation.packetId,
        reason: 'selected',
    }, overrides));
}

function testCompleteTransitionVectorAndStaleCompletion() {
    const h = makeCoordinator();
    const activated = h.coordinator.request(makeReservation());
    const operation = activated.transaction.operation;
    assert.strictEqual(h.coordinator.transition(operation, 'requested', 'selecting').stage, 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation).type, 'accepted');
    assert.strictEqual(h.coordinator.transition(operation, 'waiting-init', 'waiting-media').stage,
        'waiting-media');
    assert.strictEqual(h.coordinator.transition(operation, 'waiting-media', 'submitted').stage, 'submitted');
    assert.strictEqual(h.coordinator.setPendingMediaInfo(operation, {duration: 12}), true);
    assert.strictEqual(h.coordinator.setPendingMediaInfo(
        Object.assign({}, operation, {transactionId: 99}),
        {duration: 99}
    ), false);
    assert.strictEqual(h.coordinator.commit(Object.assign({}, operation, {transactionId: 99})), null);
    assert.strictEqual(h.coordinator.active.stage, 'submitted');
    const committed = h.coordinator.commit(operation);
    assert.strictEqual(committed.stage, 'committed');
    assert.strictEqual(committed.pendingMediaInfo.duration, 12);
    assert(Object.isFrozen(committed.pendingMediaInfo));
    assert.strictEqual(h.coordinator.setPendingMediaInfo(operation, {duration: 13}), false);
    assert.strictEqual(h.coordinator.commit(operation), null);
}

function testLastWriteWinsAtoBtoA() {
    const h = makeCoordinator();
    const activeB = h.coordinator.request(makeReservation(1, 0xf201, 0xf200));
    assert.strictEqual(activeB.type, 'activate');
    assert.strictEqual(h.coordinator.request(makeReservation(2, 0xf200, 0xf200)).type, 'queued');
    assert.strictEqual(h.coordinator.queued.targetPacketId, 0xf200);
    assert.strictEqual(h.coordinator.request(makeReservation(3, 0xf201, 0xf200)).type, 'same-target');
    assert.strictEqual(h.coordinator.queued, null);
}

function testWatchdogResetsByStageAndRejectsStaleAck() {
    const h = makeCoordinator();
    const activated = h.coordinator.request(makeReservation());
    const operation = activated.transaction.operation;
    const firstTimer = h.timers[h.timers.length - 1];
    h.setNow(40);
    h.coordinator.transition(operation, 'requested', 'selecting');
    assert.strictEqual(h.coordinator.setConfirmedTrackData(operation, {tracks: [1]}), true);
    assert(Object.isFrozen(h.coordinator.active.confirmedTrackData));
    assert.strictEqual(firstTimer.cleared, true);
    assert.strictEqual(acceptSelection(h.coordinator, operation, {transactionId: undefined}).type, 'stale');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {attempt: undefined}).type, 'stale');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {transactionId: 88}).type, 'stale');
    assert.strictEqual(h.coordinator.active.stage, 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {attempt: 1}).type, 'stale');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {changed: undefined}).type, 'rejected');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {changed: 1}).type, 'rejected');
    assert.strictEqual(h.coordinator.active.stage, 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation).type, 'accepted');

    h.setNow(139);
    h.timers[h.timers.length - 1].callback();
    assert.strictEqual(h.timedOut.length, 0);
    h.setNow(140);
    h.timers[h.timers.length - 1].callback();
    assert.strictEqual(h.timedOut.length, 1);
    assert.strictEqual(h.timedOut[0].stage, 'waiting-init');
}

function testAlreadySelectedRequiresMatchingIdentity() {
    const h = makeCoordinator();
    const activated = h.coordinator.request(makeReservation());
    const operation = activated.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation, {
        changed: false,
        selectedPacketId: 0xf200,
        reason: 'already-selected',
    }).type, 'rejected');
    const accepted = acceptSelection(h.coordinator, operation, {
        changed: false,
        reason: 'already-selected',
    });
    assert.strictEqual(accepted.type, 'accepted');
    assert.strictEqual(accepted.transaction.stage, 'waiting-init');
    assert.strictEqual(accepted.transaction.terminal, false);
    assert.strictEqual(accepted.transaction.internalSelectionChanged, true);
    assert.strictEqual(h.coordinator.active.stage, 'waiting-init');
    assert.strictEqual(h.coordinator.commit(operation), null);
}

function testBoundedRecoveryAndFrozenSnapshots() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation(1, 0xf201, 0xf200));
    const queued = makeReservation(2, 0xf200, 0xf200);
    queued.recoveryDepth = 1;
    queued.recoveryOperation = makeOperation(3, 0xf200);
    h.coordinator.request(queued);
    h.coordinator.abort(active.transaction.operation);
    const promoted = h.coordinator.promote(active.transaction.operation, 1, 0xf201);
    assert(promoted);
    assert.strictEqual(promoted.recoveryDepth, 1);
    assert.strictEqual(promoted.priorCommittedPacketId, 0xf201);
    assert.strictEqual(promoted.recoveryOperation.packetId, 0xf201);
    assert(Object.isFrozen(promoted));
    assert(Object.isFrozen(promoted.operation));
    assert(Object.isFrozen(promoted.recoveryOperation));

    const invalid = makeReservation(4, 0xf202, 0xf201);
    invalid.recoveryDepth = 2;
    assert.throws(() => h.coordinator.request(invalid), /Invalid MMTS video/);
}

function testAbortSnapshotDoesNotLeakPendingMediaInfo() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation(1, 0xf201, 0xf200));
    const operation = active.transaction.operation;
    assert.strictEqual(h.coordinator.setPendingMediaInfo(operation, {duration: 20}), true);
    const aborted = h.coordinator.abort(operation);
    assert.strictEqual(aborted.stage, 'aborted');
    assert.strictEqual(aborted.pendingMediaInfo.duration, 20);
    assert(Object.isFrozen(aborted.pendingMediaInfo));
    assert.strictEqual(h.coordinator.setPendingMediaInfo(operation, {duration: 21}), false);

    const next = h.coordinator.request(makeReservation(2, 0xf202, 0xf200));
    assert.strictEqual(next.type, 'activate');
    assert.strictEqual(next.transaction.pendingMediaInfo, undefined);
    h.coordinator.clear();
    assert.strictEqual(h.coordinator.active, null);
    assert.strictEqual(h.coordinator.queued, null);
}

function testAdaptiveVodSeekAttemptCanBeAdopted() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation(1, 0xf201, 0xf200));
    const operation = active.transaction.operation;
    assert.strictEqual(h.coordinator.transition(operation, 'requested', 'selecting').stage, 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation).type, 'accepted');
    assert.strictEqual(h.coordinator.active.stage, 'waiting-init');

    const retryOperation = operationModule.createNextPlaybackAttempt(operation, {
        phase: 'adaptive-retry',
    });
    assert.strictEqual(h.coordinator.canAdoptAttempt(retryOperation), true);
    const adopted = h.coordinator.adoptAttempt(retryOperation);
    assert(adopted);
    assert.strictEqual(adopted.operation.attempt, 1);
    assert.strictEqual(adopted.stage, 'selecting');
    assert.strictEqual(acceptSelection(h.coordinator, operation).type, 'stale');
    assert.strictEqual(acceptSelection(h.coordinator, retryOperation, {
        changed: false,
        reason: 'already-selected',
    }).type, 'accepted');
    assert.strictEqual(h.coordinator.active.stage, 'waiting-init');
}

testCompleteTransitionVectorAndStaleCompletion();
testLastWriteWinsAtoBtoA();
testWatchdogResetsByStageAndRejectsStaleAck();
testAlreadySelectedRequiresMatchingIdentity();
testBoundedRecoveryAndFrozenSnapshots();
testAbortSnapshotDoesNotLeakPendingMediaInfo();
testAdaptiveVodSeekAttemptCanBeAdopted();
console.log('mmts video-track transaction coordinator tests passed');

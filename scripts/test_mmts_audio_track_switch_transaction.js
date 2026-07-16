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
const Coordinator = compile('src/player/mmts-audio-track-switch-transaction.ts', {
    '../core/playback-operation': operationModule,
}).default;

function makeOperation(generation, packetId, requestedTimeMilliseconds = 1000) {
    return operationModule.createPlaybackOperation({
        scopeId: 'audio-track-switch-test',
        timelineGeneration: generation,
        kind: 'audio-switch',
        transactionId: generation,
        phase: 'requested',
        requestedTimeMilliseconds,
        packetId,
    });
}

function makeReservation(strategy, generation = 1, packetId = 0xf111) {
    return {
        operation: makeOperation(generation, packetId),
        priorCommittedPacketId: 0xf110,
        targetPacketId: packetId,
        strategy,
        resumeIntent: true,
    };
}

function makeCoordinator(options = {}) {
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
        stageTimeout: options.stageTimeout || (() => 100),
    });
    return {coordinator, timers, timedOut, setNow(value) { now = value; }};
}

function runCommonTransitionVector(strategy) {
    const h = makeCoordinator();
    const activated = h.coordinator.request(makeReservation(strategy));
    assert.strictEqual(activated.type, 'activate');
    const operation = activated.transaction.operation;
    assert.strictEqual(h.coordinator.transition(operation, 'requested', 'preparing').stage, 'preparing');
    assert.strictEqual(h.coordinator.transition(operation, 'preparing', 'selecting').stage, 'selecting');
    assert.strictEqual(h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }).type, 'accepted');
    assert.strictEqual(h.coordinator.transition(operation, 'waiting-init', 'collecting-overlap').stage,
        'collecting-overlap');
    assert.strictEqual(h.coordinator.transition(operation, 'collecting-overlap', 'submitted').stage,
        'submitted');
    assert.strictEqual(h.coordinator.transition(operation, 'submitted', 'rebuilding').stage, 'rebuilding');
    assert.strictEqual(h.coordinator.commit(operation).stage, 'committed');
    assert.strictEqual(h.coordinator.commit(operation), null);
}

function testStrictInvariants() {
    const h = makeCoordinator();
    const activated = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = activated.transaction.operation;
    assert.strictEqual(h.coordinator.transition(operation, 'requested', 'rebuilding'), null);
    assert.strictEqual(h.coordinator.transition(operation, 'requested', 'preparing').stage, 'preparing');
    assert.strictEqual(h.coordinator.transition(operation, 'preparing', 'selecting').stage, 'selecting');
    assert.strictEqual(h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }).type, 'rejected');
    const skippedAttempt = Object.assign({}, operation, {
        attempt: 2,
        attemptKey: operation.transactionKey + ':2',
        phase: 'adaptive-retry',
    });
    assert.strictEqual(h.coordinator.canAdoptAttempt(skippedAttempt), false);
    assert.strictEqual(h.coordinator.adoptAttempt(skippedAttempt), null);
    const retryOperation = operationModule.createNextPlaybackAttempt(operation, {
        phase: 'adaptive-retry',
    });
    assert.strictEqual(h.coordinator.canAdoptAttempt(retryOperation), true);
    assert.strictEqual(h.coordinator.adoptAttempt(retryOperation).operation.attempt, 1);
    assert.strictEqual(h.coordinator.adoptAttempt(operation), null);

    const snapshot = h.coordinator.active;
    assert(Object.isFrozen(snapshot));
    assert(Object.isFrozen(snapshot.operation));
    snapshot.operation.attempt = 8;
    assert.strictEqual(h.coordinator.active.operation.attempt, 1);

}

function testQueuedReservationCanBecomeBoundedRecovery() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek', 1, 0xf111));
    const queued = h.coordinator.request(makeReservation('vod-reseek', 2, 0xf110));
    assert.strictEqual(active.type, 'activate');
    assert.strictEqual(queued.type, 'queued');
    h.coordinator.abort(active.transaction.operation);
    const promoted = h.coordinator.promote(active.transaction.operation, 2500, 1);
    assert(promoted);
    assert.strictEqual(promoted.recoveryDepth, 1);
    assert.strictEqual(promoted.targetPacketId, 0xf110);
    assert.strictEqual(promoted.operation.requestedTimeMilliseconds, 2500);
}

function testRetryAcceptsAlreadySelectedInternalTarget() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = active.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    assert.strictEqual(h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    }).type, 'accepted');
    const retry = operationModule.createNextPlaybackAttempt(operation, {
        phase: 'preparing',
        requestedTimeMilliseconds: 1200,
    });
    assert.strictEqual(h.coordinator.canAdoptAttempt(retry), true);
    assert(h.coordinator.adoptAttempt(retry));
    h.coordinator.transition(retry, 'preparing', 'selecting');
    assert.strictEqual(h.coordinator.selectionResult(retry, {
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    }).type, 'accepted');
    assert.strictEqual(h.coordinator.active.internalSelectionChanged, true);
}

function testFreshTransactionAdoptsAlreadySelectedInternalTarget() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = active.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    assert.strictEqual(h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: false,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'already-selected',
    }).type, 'accepted');
    assert.strictEqual(h.coordinator.active.internalSelectionChanged, true);
}

function testQueueAndEarlyTimer() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('live-forward', 1, 0xf111));
    assert.strictEqual(h.coordinator.request(makeReservation('live-forward', 2, 0xf110)).type, 'queued');
    assert.strictEqual(h.coordinator.request(makeReservation('live-forward', 3, 0xf111)).type, 'same-target');
    assert.strictEqual(h.coordinator.queued, null);

    h.setNow(50);
    h.timers[h.timers.length - 1].callback();
    assert.strictEqual(h.timedOut.length, 0);
    const rearmed = h.timers[h.timers.length - 1];
    assert.strictEqual(rearmed.delay, 50);
    h.setNow(100);
    rearmed.callback();
    assert.strictEqual(h.timedOut.length, 1);
    assert.strictEqual(h.timedOut[0].operation.transactionId, active.transaction.operation.transactionId);
}

function testSameCommittedTargetOnlyActivatesRecovery() {
    const h = makeCoordinator();
    assert.strictEqual(
        h.coordinator.request(makeReservation('vod-reseek', 1, 0xf110)).type,
        'same-target'
    );
    assert.strictEqual(h.coordinator.active, null);
    assert.strictEqual(h.timers.length, 0);
    const recovery = makeReservation('vod-reseek', 2, 0xf110);
    recovery.recoveryDepth = 1;
    assert.strictEqual(h.coordinator.request(recovery).type, 'activate');
}

function testSameCommittedTargetClearsQueuedReservationAfterCommit() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('live-forward', 1, 0xf111));
    const operation = active.transaction.operation;
    h.coordinator.request(makeReservation('live-forward', 2, 0xf110));
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    h.coordinator.transition(operation, 'waiting-init', 'collecting-overlap');
    h.coordinator.transition(operation, 'collecting-overlap', 'submitted');
    h.coordinator.transition(operation, 'submitted', 'rebuilding');
    h.coordinator.commit(operation);
    assert.strictEqual(h.coordinator.queued.targetPacketId, 0xf110);

    const stayCommitted = makeReservation('live-forward', 3, 0xf111);
    stayCommitted.priorCommittedPacketId = 0xf111;
    assert.strictEqual(h.coordinator.request(stayCommitted).type, 'same-target');
    assert.strictEqual(h.coordinator.queued, null);
    assert.strictEqual(h.coordinator.active, null);
}

function testNewUserIntentReplacesQueuedReservationAfterCommit() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('live-forward', 1, 0xf111));
    const operation = active.transaction.operation;
    h.coordinator.request(makeReservation('live-forward', 2, 0xf110));
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    h.coordinator.transition(operation, 'waiting-init', 'collecting-overlap');
    h.coordinator.transition(operation, 'collecting-overlap', 'submitted');
    h.coordinator.transition(operation, 'submitted', 'rebuilding');
    h.coordinator.commit(operation);

    const latest = makeReservation('live-forward', 3, 0xf112);
    latest.priorCommittedPacketId = 0xf111;
    const result = h.coordinator.request(latest);
    assert.strictEqual(result.type, 'activate');
    assert.strictEqual(result.transaction.targetPacketId, 0xf112);
    assert.strictEqual(h.coordinator.queued, null);
}

function testRecoveryPreservesQueuedUserIntent() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('live-forward', 1, 0xf111));
    h.coordinator.request(makeReservation('live-forward', 4, 0xf112));
    h.coordinator.abort(active.transaction.operation);
    const recovery = makeReservation('live-forward', 2, 0xf110);
    recovery.recoveryDepth = 1;
    const result = h.coordinator.request(recovery);
    assert.strictEqual(result.type, 'activate');
    assert.strictEqual(result.transaction.targetPacketId, 0xf110);
    assert.strictEqual(h.coordinator.queued.targetPacketId, 0xf112);
}

function testRetryStopsAtSubmission() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = active.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    h.coordinator.selectionResult(operation, {
        accepted: true,
        changed: true,
        requestedPacketId: 0xf111,
        selectedPacketId: 0xf111,
        reason: 'selected',
    });
    h.coordinator.transition(operation, 'waiting-init', 'collecting-overlap');
    h.coordinator.transition(operation, 'collecting-overlap', 'submitted');
    const retry = operationModule.createNextPlaybackAttempt(operation, {
        phase: 'adaptive-retry',
        requestedTimeMilliseconds: 2000,
    });
    assert.strictEqual(h.coordinator.canAdoptAttempt(retry), false);
    assert.strictEqual(h.coordinator.adoptAttempt(retry), null);
    h.coordinator.transition(operation, 'submitted', 'rebuilding');
    assert.strictEqual(h.coordinator.canAdoptAttempt(retry), false);
    assert.strictEqual(h.coordinator.adoptAttempt(retry), null);
}

function testStrategyDataDoesNotExtendDeadline() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('live-forward'));
    const operation = active.transaction.operation;
    const timerCount = h.timers.length;
    const deadline = h.coordinator.active.deadline;
    assert.strictEqual(h.coordinator.setConfirmedTrackData(operation, {tracks: []}), true);
    assert.strictEqual(h.coordinator.setPendingMediaInfo(operation, {duration: 1}), true);
    assert.strictEqual(h.timers.length, timerCount);
    assert.strictEqual(h.coordinator.active.deadline, deadline);
    h.setNow(deadline);
    h.timers[h.timers.length - 1].callback();
    assert.strictEqual(h.timedOut.length, 1);
}

function testRecoveryOperationRequiresTimestamp() {
    const h = makeCoordinator();
    const reservation = makeReservation('vod-reseek');
    reservation.recoveryOperation = makeOperation(2, 0xf110);
    delete reservation.recoveryOperation.requestedTimeMilliseconds;
    assert.throws(() => h.coordinator.request(reservation), /recovery reservation/);
}

function testInvalidRetryIsAtomic() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = active.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'preparing');
    const before = h.coordinator.active;
    const invalidRetry = Object.assign(
        operationModule.createNextPlaybackAttempt(operation, {phase: 'adaptive-retry'}),
        {requestedTimeMilliseconds: NaN}
    );
    assert.strictEqual(h.coordinator.canAdoptAttempt(invalidRetry), false);
    assert.strictEqual(h.coordinator.adoptAttempt(invalidRetry), null);
    const after = h.coordinator.active;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(after.operation)),
        JSON.parse(JSON.stringify(before.operation)));
    assert.strictEqual(after.stage, before.stage);
    assert.strictEqual(after.deadline, before.deadline);
}

function testPromotionRebasesCommittedTrack() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek', 1, 0xf111));
    const queuedReservation = makeReservation('vod-reseek', 2, 0xf110);
    queuedReservation.recoveryOperation = makeOperation(3, 0xf110);
    h.coordinator.request(queuedReservation);
    h.coordinator.abort(active.transaction.operation);
    const promoted = h.coordinator.promote(active.transaction.operation, 3000, undefined, 0xf111);
    assert(promoted);
    assert.strictEqual(promoted.priorCommittedPacketId, 0xf111);
    assert.strictEqual(promoted.recoveryOperation.packetId, 0xf111);
}

function testPromotionConsumesNewlyCommittedTarget() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek', 1, 0xf111));
    h.coordinator.request(makeReservation('vod-reseek', 2, 0xf110));
    h.coordinator.abort(active.transaction.operation);
    assert.strictEqual(
        h.coordinator.promote(active.transaction.operation, 3000, undefined, 0xf110),
        null
    );
    assert.strictEqual(h.coordinator.queued, null);
    assert.strictEqual(h.coordinator.active, null);
}

function testSelectingMarksPossibleMutation() {
    const h = makeCoordinator();
    const active = h.coordinator.request(makeReservation('vod-reseek'));
    const operation = active.transaction.operation;
    h.coordinator.transition(operation, 'requested', 'preparing');
    h.coordinator.transition(operation, 'preparing', 'selecting');
    assert.strictEqual(h.coordinator.active.selectionMayHaveMutated, true);
}

runCommonTransitionVector('vod-reseek');
runCommonTransitionVector('live-forward');
testStrictInvariants();
testQueuedReservationCanBecomeBoundedRecovery();
testRetryAcceptsAlreadySelectedInternalTarget();
testFreshTransactionAdoptsAlreadySelectedInternalTarget();
testQueueAndEarlyTimer();
testSameCommittedTargetOnlyActivatesRecovery();
testSameCommittedTargetClearsQueuedReservationAfterCommit();
testNewUserIntentReplacesQueuedReservationAfterCommit();
testRecoveryPreservesQueuedUserIntent();
testRetryStopsAtSubmission();
testStrategyDataDoesNotExtendDeadline();
testRecoveryOperationRequiresTimestamp();
testInvalidRetryIsAtomic();
testPromotionRebasesCommittedTrack();
testPromotionConsumesNewlyCommittedTarget();
testSelectingMarksPossibleMutation();
console.log('mmts audio-track transaction coordinator tests passed');

#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

function loadMSEPlayer() {
    const sourcePath = path.resolve(__dirname, '../src/player/mse-player.ts');
    const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
        }
    }).outputText;
    const created = [];
    class MainThread {
        constructor(mediaDataSource) {
            created.push({engine: 'main', type: mediaDataSource.type});
        }
    }
    class DedicatedThread {
        static isSupported() { return true; }
        constructor(mediaDataSource) {
            created.push({engine: 'dedicated', type: mediaDataSource.type});
        }
    }
    const moduleObject = {exports: {}};
    vm.runInNewContext(compiled, {
        require(id) {
            if (id === './player-engine-main-thread') {
                return {__esModule: true, default: MainThread};
            }
            if (id === './player-engine-dedicated-thread') {
                return {__esModule: true, default: DedicatedThread};
            }
            if (id === '../utils/logger') {
                return {__esModule: true, default: {e() {}}};
            }
            if (id === '../utils/exception') {
                return {InvalidArgumentException: class InvalidArgumentException extends Error {}};
            }
            return {};
        },
        module: moduleObject,
        exports: moduleObject.exports,
        console,
    }, {filename: sourcePath});
    return {MSEPlayer: moduleObject.exports.default, created};
}

function assertMMTSStallRecoveryCoversLivePlayback(sourceFile) {
    const sourcePath = path.resolve(__dirname, `../src/player/${sourceFile}`);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const constructorStart = source.indexOf('new StartupStallJumper(');
    assert.notStrictEqual(constructorStart, -1, `${sourceFile} must create StartupStallJumper`);
    const constructorCall = source.slice(constructorStart, constructorStart + 700);

    assert.match(
        constructorCall,
        /this\._config\.isMMTS === true,\s*this\._config\.isMMTS === true,\s*/,
        `${sourceFile} must use conservative continuous-buffer recovery for live and VOD MMTS`
    );
    assert.doesNotMatch(
        constructorCall,
        /this\._config\.isMMTS === true\s*&&\s*this\._config\.isLive !== true/,
        `${sourceFile} must not leave live MMTS on speculative stall seeks`
    );
}

const {MSEPlayer, created} = loadMSEPlayer();
new MSEPlayer({type: 'mpegts'}, {enableWorkerForMSE: true});
new MSEPlayer({type: 'm2ts'}, {enableWorkerForMSE: true});
new MSEPlayer({type: 'flv'}, {enableWorkerForMSE: true});
new MSEPlayer({type: 'mmts'}, {enableWorkerForMSE: true});

assert.deepStrictEqual(
    JSON.parse(JSON.stringify(created)),
    [
        {engine: 'dedicated', type: 'mpegts'},
        {engine: 'dedicated', type: 'm2ts'},
        {engine: 'dedicated', type: 'flv'},
        {engine: 'dedicated', type: 'mmts'},
    ]
);

assertMMTSStallRecoveryCoversLivePlayback('player-engine-main-thread.ts');
assertMMTSStallRecoveryCoversLivePlayback('player-engine-dedicated-thread.ts');

console.log('mse player engine selection tests passed');

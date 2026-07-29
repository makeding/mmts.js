#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
    const args = {
        directory: '../mmts.js-draft',
        durationSeconds: 30,
        actionIntervalSeconds: 6,
        mode: 'cocktail',
        seed: undefined,
        files: [],
        artifactDir: path.join(os.tmpdir(),
            `mmts-browser-samples-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--directory') args.directory = argv[++i];
        else if (arg === '--file') args.files.push(argv[++i]);
        else if (arg === '--duration') args.durationSeconds = Number(argv[++i]);
        else if (arg === '--action-interval') args.actionIntervalSeconds = Number(argv[++i]);
        else if (arg === '--mode') args.mode = argv[++i];
        else if (arg === '--seed') args.seed = Number(argv[++i]);
        else if (arg === '--artifact-dir') args.artifactDir = argv[++i];
        else throw new Error(`unknown argument: ${arg}`);
    }
    args.directory = path.resolve(args.directory);
    args.files = args.files.map((file) => path.resolve(file));
    args.artifactDir = path.resolve(args.artifactDir);
    if (args.files.length === 0 &&
        (!fs.existsSync(args.directory) || !fs.statSync(args.directory).isDirectory())) {
        throw new Error(`sample directory does not exist: ${args.directory}`);
    }
    for (const file of args.files) {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new Error(`sample file does not exist: ${file}`);
        }
    }
    if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0 ||
        !Number.isFinite(args.actionIntervalSeconds) || args.actionIntervalSeconds <= 0) {
        throw new Error('duration and action interval must be positive finite seconds');
    }
    if (args.seed !== undefined && !Number.isFinite(args.seed)) {
        throw new Error('seed must be finite');
    }
    if (!['linear', 'seek', 'tracks', 'cocktail'].includes(args.mode)) {
        throw new Error('mode must be linear, seek, tracks, or cocktail');
    }
    return args;
}

function collectSamples(directory) {
    return fs.readdirSync(directory, {withFileTypes: true})
        .filter((entry) => entry.isFile() &&
            (/\.(mmts|mmt|tlv)$/i.test(entry.name) || entry.name === '8k'))
        .map((entry) => path.join(directory, entry.name))
        .sort((a, b) => a.localeCompare(b));
}

function main() {
    const args = parseArgs(process.argv);
    const samples = args.files.length > 0 ? args.files : collectSamples(args.directory);
    if (samples.length === 0) throw new Error(`no MMTS samples found in ${args.directory}`);
    fs.mkdirSync(args.artifactDir, {recursive: true});
    const stressScript = path.resolve(__dirname, 'test_mmts_browser_stress.js');
    const results = [];

    for (let i = 0; i < samples.length; i++) {
        const file = samples[i];
        const name = path.basename(file);
        const sampleArtifactDir = path.join(args.artifactDir,
            `${String(i + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9._-]+/gi, '_')}`);
        console.log(`\n[${i + 1}/${samples.length}] ${name} (${fs.statSync(file).size} bytes)`);
        const stressArgs = [
            stressScript,
            '--file', file,
            '--mode', args.mode,
            '--duration', String(args.durationSeconds),
            '--seek-interval', String(args.actionIntervalSeconds),
            '--artifact-dir', sampleArtifactDir,
        ];
        if (args.seed !== undefined) stressArgs.push('--seed', String(args.seed));
        const run = childProcess.spawnSync(process.execPath, stressArgs, {stdio: 'inherit'});
        results.push({file, ok: run.status === 0, status: run.status, signal: run.signal});
    }

    const summary = {args, results};
    fs.writeFileSync(path.join(args.artifactDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log('\nMMTS sample matrix:');
    for (const result of results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${path.basename(result.file)}`);
    }
    console.log(`summary=${path.join(args.artifactDir, 'summary.json')}`);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main();

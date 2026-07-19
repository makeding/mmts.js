#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
    const args = {
        file: process.env.MMTS_TEST_FILE || 'demo/8k',
        mode: 'seek',
        durationSeconds: 180,
        seekIntervalSeconds: 8,
        stallTimeoutSeconds: 25,
        seed: 0x811fa744,
        targets: [0, 16, 37, 49, 51, 56, 62, 68, 75, 86, 105],
        headed: false,
        executablePath: process.env.CHROME_BIN,
        artifactDir: undefined,
        videoPacketId: undefined,
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--file') {
            args.file = argv[++i];
        } else if (arg === '--mode') {
            args.mode = argv[++i];
        } else if (arg === '--duration') {
            args.durationSeconds = Number(argv[++i]);
        } else if (arg === '--seek-interval') {
            args.seekIntervalSeconds = Number(argv[++i]);
        } else if (arg === '--stall-timeout') {
            args.stallTimeoutSeconds = Number(argv[++i]);
        } else if (arg === '--seed') {
            args.seed = Number(argv[++i]);
        } else if (arg === '--targets') {
            args.targets = argv[++i].split(',').map(Number);
        } else if (arg === '--headed') {
            args.headed = true;
        } else if (arg === '--chrome') {
            args.executablePath = argv[++i];
        } else if (arg === '--artifact-dir') {
            args.artifactDir = argv[++i];
        } else if (arg === '--video-packet-id') {
            args.videoPacketId = Number(argv[++i]);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    if (!['linear', 'seek', 'tracks', 'cocktail'].includes(args.mode)) {
        throw new Error('--mode must be linear, seek, tracks, or cocktail');
    }
    if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0 ||
        !Number.isFinite(args.seekIntervalSeconds) || args.seekIntervalSeconds <= 0 ||
        !Number.isFinite(args.stallTimeoutSeconds) || args.stallTimeoutSeconds <= 0 ||
        !Number.isFinite(args.seed)) {
        throw new Error('duration, seek interval, stall timeout, and seed must be finite positive values');
    }
    if (!Array.isArray(args.targets) || args.targets.some((value) =>
        !Number.isFinite(value) || value < 0)) {
        throw new Error('--targets must contain non-negative finite seconds');
    }
    args.file = path.resolve(args.file);
    if (!fs.existsSync(args.file) || !fs.statSync(args.file).isFile()) {
        throw new Error(`MMTS test file does not exist: ${args.file}`);
    }
    if (args.executablePath) {
        args.executablePath = path.resolve(args.executablePath);
    }
    args.artifactDir = path.resolve(args.artifactDir || path.join(
        os.tmpdir(),
        `mmts-browser-stress-${new Date().toISOString().replace(/[:.]/g, '-')}`
    ));
    return args;
}

function findChrome(explicitPath) {
    const candidates = [
        explicitPath,
        '/run/current-system/sw/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const selected = candidates.find((candidate) => fs.existsSync(candidate));
    if (!selected) {
        throw new Error('Chrome/Chromium not found; pass --chrome or run through nix-shell with a browser package');
    }
    return selected;
}

function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value || '');
    if (!match) return null;
    let start;
    let end;
    if (match[1] === '') {
        const suffix = Number(match[2]);
        if (!Number.isFinite(suffix) || suffix <= 0) return null;
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || start >= size || end < start) {
        return null;
    }
    return {start, end: Math.min(end, size - 1)};
}

function sendFile(request, response, file, contentType) {
    const size = fs.statSync(file).size;
    const range = parseRange(request.headers.range, size);
    const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-type': contentType,
        'access-control-allow-origin': '*',
    };
    if (request.method === 'HEAD') {
        response.writeHead(200, Object.assign(headers, {'content-length': size}));
        response.end();
        return;
    }
    if (request.headers.range && range === null) {
        response.writeHead(416, {'content-range': `bytes */${size}`});
        response.end();
        return;
    }
    if (range) {
        const length = range.end - range.start + 1;
        response.writeHead(206, Object.assign(headers, {
            'content-length': length,
            'content-range': `bytes ${range.start}-${range.end}/${size}`,
        }));
        fs.createReadStream(file, {start: range.start, end: range.end}).pipe(response);
        return;
    }
    response.writeHead(200, Object.assign(headers, {'content-length': size}));
    fs.createReadStream(file).pipe(response);
}

function createHarnessHtml(videoPacketId, fileSize) {
    const packetId = Number.isFinite(videoPacketId) ? videoPacketId : null;
    return `<!doctype html>
<meta charset="utf-8">
<title>MMTS browser stress test</title>
<video id="video" muted playsinline style="width:960px;height:540px;background:#000"></video>
<script src="/dist/mpegts.js"></script>
<script>
(async () => {
    const video = document.getElementById('video');
    video.muted = true;
    const state = window.__MMTS_TEST_STATE__ = {
        status: 'booting', failure: null, events: [], mediaInfo: null, durationProbe: null,
        audioTracks: null, videoTracks: null, switchCount: 0, switchResults: [],
        operationWarnings: [],
        statistics: null, startedAt: performance.now(), lastProgressAt: performance.now(),
        lastCurrentTime: 0, seekCount: 0,
    };
    function ranges(value) {
        const result = [];
        for (let i = 0; i < value.length; i++) result.push([value.start(i), value.end(i)]);
        return result;
    }
    function record(event, detail) {
        const item = {wall: performance.now() / 1000, event, currentTime: video.currentTime, detail};
        state.events.push(item);
        if (state.events.length > 300) state.events.shift();
        console.log('[mmts-autotest]', JSON.stringify(item));
    }
    function fail(kind, detail) {
        if (!state.failure) state.failure = {kind, detail, currentTime: video.currentTime, wall: performance.now() / 1000};
        state.status = 'failed';
        record('failure', state.failure);
    }
    ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'ended'].forEach((name) => {
        video.addEventListener(name, () => record(name, {readyState: video.readyState, buffered: ranges(video.buffered)}));
    });
    ['seeking', 'seeked'].forEach((name) => {
        video.addEventListener(name, () => {
            state.lastCurrentTime = video.currentTime;
            state.lastProgressAt = performance.now();
        });
    });
    video.addEventListener('error', () => fail('HTMLMediaElement', {
        code: video.error && video.error.code,
        message: video.error && video.error.message,
        buffered: ranges(video.buffered),
    }));
    const config = {
        enableWorker: true,
        lazyLoad: true,
        lazyLoadMaxDuration: 90,
        lazyLoadRecoverDuration: 60,
        seekType: 'range',
        rangeLoadZeroStart: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 6,
        autoCleanupMinBackwardDuration: 2,
        statisticsInfoReportInterval: 1000,
        lazyLoadMaxBytes: 112 * 1024 * 1024,
        lazyLoadRecoverBytes: 96 * 1024 * 1024,
        mseBufferVideoSoftLimitBytes: 112 * 1024 * 1024,
        mseBufferVideoHardLimitBytes: 128 * 1024 * 1024,
        mseBufferAudioSoftLimitBytes: 8 * 1024 * 1024,
        mseBufferAudioHardLimitBytes: 12 * 1024 * 1024,
        mseBufferForwardTargetDuration: 90,
        mseBufferRecoverForwardDuration: 60,
        mseAppendTrackLeadLimit: 2,
        mseAppendBatchDuration: 0.5,
        mmtsClampVideoTimestampGap: false,
        mmtsClampAudioTimestampGap: false,
    };
    if (${packetId === null ? 'false' : 'true'}) config.mmtsVideoPacketId = ${packetId || 0};
    const mediaDataSource = {
        type: 'mmts', url: new URL('/8k', location.href).href,
        isLive: false, filesize: ${fileSize},
    };
    if (typeof mpegts.probeMMTSDuration === 'function') {
        state.status = 'probing';
        try {
            const probeOptions = {filesize: mediaDataSource.filesize};
            if (${packetId === null ? 'false' : 'true'}) probeOptions.videoPacketId = ${packetId || 0};
            const result = await mpegts.probeMMTSDuration(mediaDataSource.url, probeOptions);
            state.durationProbe = result;
            if (result && Number.isFinite(result.duration) && result.duration > 0) {
                mediaDataSource.duration = result.duration;
            }
            record('duration-probe', result);
        } catch (error) {
            record('duration-probe-failed', {message: error && error.message});
        }
    }
    const player = window.__MMTS_PLAYER__ = mpegts.createPlayer(mediaDataSource, config);
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, (type, detail, info) => {
        const message = info && info.msg ? String(info.msg) : '';
        const operation = info && info.playbackOperation;
        const operationKind = operation && operation.kind;
        const fatalMediaPipeline = /MediaSource entered a fatal state|appendBuffer|HTMLMediaElement\.error|video decode error/i.test(message);
        const recoverableTrackSwitch = operationKind === 'audio-switch' ||
            operationKind === 'video-switch' || /track switch/i.test(message);
        if (recoverableTrackSwitch && !fatalMediaPipeline && !video.error) {
            const warning = {type, detail, info};
            state.operationWarnings.push(warning);
            if (state.operationWarnings.length > 30) state.operationWarnings.shift();
            record('operation-warning', warning);
            resumeAfterTrackFailure();
            return;
        }
        fail('mpegts', {type, detail, info});
    });
    player.on(mpegts.Events.MEDIA_INFO, (info) => {
        if (!state.mediaInfo) record('media-info', info);
        state.mediaInfo = info;
    });
    player.on(mpegts.Events.MMTS_AUDIO_TRACKS, (tracks) => {
        state.audioTracks = tracks;
        record('audio-tracks', tracks);
    });
    player.on(mpegts.Events.MMTS_VIDEO_TRACKS, (tracks) => {
        state.videoTracks = tracks;
        record('video-tracks', tracks);
    });
    player.on(mpegts.Events.STATISTICS_INFO, (info) => {
        state.statistics = info;
    });
    const play = async () => {
        try {
            await player.play();
            if (state.status !== 'failed') state.status = 'playing';
        } catch (error) {
            record('play-rejected', {name: error && error.name, message: error && error.message});
            if (video.error) fail('play', {message: error && error.message});
        }
    };
    const resumeAfterTrackFailure = () => {
        const atEnd = video.ended || (Number.isFinite(video.duration) &&
            video.duration > 0 && video.currentTime >= video.duration - 0.05);
        if (atEnd) {
            record('track-switch-resume-skipped', {reason: 'playback-ended'});
            return;
        }
        if (video.paused) play();
    };
    player.load();
    video.addEventListener('canplay', play, {once: true});
    setTimeout(play, 1000);
    setInterval(() => {
        if (video.currentTime > state.lastCurrentTime + 0.01) {
            state.lastCurrentTime = video.currentTime;
            state.lastProgressAt = performance.now();
        }
    }, 250);
    window.__mmtsSeek = (seconds) => {
        state.seekCount++;
        record('seek-request', {seconds});
        player.currentTime = seconds;
        play();
    };
    window.__mmtsSwitchTrack = async (kind) => {
        if (video.ended || (Number.isFinite(video.duration) && video.duration > 0 &&
            video.currentTime >= video.duration - 0.05)) {
            const skipped = {kind, skipped: true, reason: 'playback-ended'};
            state.switchResults.push(skipped);
            if (state.switchResults.length > 30) state.switchResults.shift();
            record('track-switch-skipped', skipped);
            return skipped;
        }
        const collection = kind === 'audio' ? state.audioTracks : state.videoTracks;
        const tracks = collection && Array.isArray(collection.tracks) ? collection.tracks : [];
        const candidates = tracks.filter((track) => track && Number.isInteger(track.packetId) &&
            track.selected !== true && (kind !== 'audio' || track.supported !== false));
        if (candidates.length === 0) {
            const skipped = {kind, skipped: true, reason: 'no-alternative-track'};
            record('track-switch-skipped', skipped);
            return skipped;
        }
        const target = candidates[state.switchCount % candidates.length];
        state.switchCount++;
        record('track-switch-request', {kind, packetId: target.packetId});
        try {
            const operation = kind === 'audio' ?
                player.selectAudioTrack(target.packetId) : player.selectVideoTrack(target.packetId);
            const outcome = await Promise.race([
                Promise.resolve(operation).then((result) => ({type: 'result', result})),
                new Promise((resolve) => video.addEventListener('ended',
                    () => resolve({type: 'ended'}), {once: true})),
                // A failed VOD switch can consume one 45s data timeout and a
                // second recovery timeout before settling back to the old track.
                new Promise((_, reject) => setTimeout(() => reject(new Error('track switch timeout')), 100000)),
            ]);
            if (outcome.type === 'ended') {
                const item = {kind, packetId: target.packetId, skipped: true, reason: 'playback-ended'};
                state.switchResults.push(item);
                if (state.switchResults.length > 30) state.switchResults.shift();
                record('track-switch-skipped', item);
                return item;
            }
            const result = outcome.result;
            const item = {kind, packetId: target.packetId, result};
            state.switchResults.push(item);
            if (state.switchResults.length > 30) state.switchResults.shift();
            if (result && result.terminal === true && result.status === 'failed') {
                state.operationWarnings.push(item);
                if (state.operationWarnings.length > 30) state.operationWarnings.shift();
                record('track-switch-failed', item);
                resumeAfterTrackFailure();
            } else {
                record('track-switch-result', item);
            }
            return item;
        } catch (error) {
            const item = {kind, packetId: target.packetId, error: error && error.message};
            state.switchResults.push(item);
            if (state.switchResults.length > 30) state.switchResults.shift();
            record('track-switch-failed', item);
            resumeAfterTrackFailure();
            return item;
        }
    };
    window.__mmtsSnapshot = () => {
        const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        return {
            status: state.status,
            failure: state.failure,
            currentTime: video.currentTime,
            duration: video.duration,
            paused: video.paused,
            ended: video.ended,
            seeking: video.seeking,
            readyState: video.readyState,
            networkState: video.networkState,
            buffered: ranges(video.buffered),
            mediaError: video.error ? {code: video.error.code, message: video.error.message} : null,
            mediaInfo: state.mediaInfo,
            durationProbe: state.durationProbe,
            audioTracks: state.audioTracks,
            videoTracks: state.videoTracks,
            statistics: state.statistics,
            seekCount: state.seekCount,
            switchCount: state.switchCount,
            switchResults: state.switchResults.slice(),
            operationWarnings: state.operationWarnings.slice(),
            lastProgressAgo: (performance.now() - state.lastProgressAt) / 1000,
            quality: quality && {
                totalVideoFrames: quality.totalVideoFrames,
                droppedVideoFrames: quality.droppedVideoFrames,
                corruptedVideoFrames: quality.corruptedVideoFrames,
            },
            recentEvents: state.events.slice(-30),
        };
    };
})();
</script>`;
}

function createServer(args, repoRoot) {
    const html = Buffer.from(createHarnessHtml(args.videoPacketId, fs.statSync(args.file).size));
    const dist = path.join(repoRoot, 'dist/mpegts.js');
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/') {
            response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': html.length,
                'cache-control': 'no-store',
            });
            response.end(request.method === 'HEAD' ? undefined : html);
            return;
        }
        if (url.pathname === '/dist/mpegts.js') {
            sendFile(request, response, dist, 'text/javascript; charset=utf-8');
            return;
        }
        if (url.pathname === '/8k') {
            sendFile(request, response, args.file, 'application/octet-stream');
            return;
        }
        response.writeHead(404);
        response.end();
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function waitForFile(file, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (fs.existsSync(file)) {
                resolve();
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                reject(new Error(`timeout waiting for ${file}`));
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
    });
}

function httpJson(method, url) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, {method}, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on('error', reject);
        request.end();
    });
}

class CDPClient {
    constructor(url) {
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.socket = new WebSocket(url);
        this.ready = new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, {once: true});
            this.socket.addEventListener('error', reject, {once: true});
        });
        this.socket.addEventListener('message', (event) => this.onMessage(event.data));
        this.socket.addEventListener('close', () => {
            for (const pending of this.pending.values()) {
                pending.reject(new Error('Chrome DevTools connection closed'));
            }
            this.pending.clear();
        });
    }

    onMessage(data) {
        const message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
        if (message.id) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result || {});
            return;
        }
        const listeners = this.listeners.get(message.method) || [];
        for (const listener of listeners) listener(message.params || {});
    }

    on(method, listener) {
        const listeners = this.listeners.get(method) || [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }

    async send(method, params = {}) {
        await this.ready;
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
        this.socket.send(JSON.stringify({id, method, params}));
        return promise;
    }

    close() {
        this.socket.close();
    }
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'page evaluation failed');
    }
    return result.result ? result.result.value : undefined;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}

function writeReport(args, outcome, snapshot, consoleLines) {
    fs.mkdirSync(args.artifactDir, {recursive: true});
    fs.writeFileSync(path.join(args.artifactDir, 'result.json'), JSON.stringify({
        outcome,
        args: Object.assign({}, args, {file: args.file}),
        snapshot,
        console: consoleLines.slice(-500),
    }, null, 2));
}

async function captureFailure(client, args, snapshot, consoleLines) {
    writeReport(args, 'fail', snapshot, consoleLines);
    if (!client) return;
    try {
        const screenshot = await client.send('Page.captureScreenshot', {format: 'png'});
        fs.writeFileSync(path.join(args.artifactDir, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
    } catch (_) {
        // The renderer may already be gone after a fatal media error.
    }
}

async function runTest(client, args) {
    const consoleLines = [];
    const appendDiagnostic = (line) => {
        consoleLines.push(line);
        if (consoleLines.length > 2000) consoleLines.shift();
    };
    client.on('Runtime.consoleAPICalled', (event) => {
        const values = (event.args || []).map((arg) => arg.value !== undefined ? arg.value : arg.description);
        const line = values.join(' ');
        appendDiagnostic(line);
        if (/failure|MediaError|VideoToolbox|appendBuffer/.test(line)) {
            console.log(line);
        }
    });
    client.on('Runtime.exceptionThrown', (event) => {
        const text = event.exceptionDetails && event.exceptionDetails.text;
        appendDiagnostic(`page exception: ${text}`);
    });
    client.on('Log.entryAdded', (event) => {
        const entry = event.entry || {};
        appendDiagnostic(`browser ${entry.level || 'log'}: ${entry.text || ''}`);
    });
    client.on('Media.playerErrorsRaised', (event) => {
        appendDiagnostic(`media errors: ${JSON.stringify(event)}`);
    });
    client.on('Media.playerMessagesLogged', (event) => {
        const messages = event.messages || [];
        for (const message of messages) {
            if (message.level === 'error' || /error|invalid|keyframe/i.test(message.message || '')) {
                appendDiagnostic(`media ${message.level}: ${message.message}`);
            }
        }
    });
    await Promise.all([
        client.send('Runtime.enable'),
        client.send('Page.enable'),
        client.send('Log.enable'),
        client.send('Media.enable'),
    ]);

    const startDeadline = Date.now() + 60000;
    let snapshot;
    while (Date.now() < startDeadline) {
        snapshot = await evaluate(client, 'window.__mmtsSnapshot ? window.__mmtsSnapshot() : null');
        if (snapshot && (snapshot.status === 'playing' || snapshot.failure)) break;
        await sleep(500);
    }
    if (!snapshot || snapshot.status !== 'playing') {
        const message = snapshot && snapshot.failure ?
            `playback startup failed: ${JSON.stringify(snapshot.failure)}` :
            'playback did not start within 60 seconds';
        throw Object.assign(new Error(message), {snapshot, consoleLines});
    }

    const started = Date.now();
    let nextSeekAt = started + args.seekIntervalSeconds * 1000;
    let targetIndex = 0;
    let actionIndex = 0;
    const random = makeRandom(args.seed);
    let lastReportAt = 0;
    while ((Date.now() - started) / 1000 < args.durationSeconds) {
        snapshot = await evaluate(client, 'window.__mmtsSnapshot()');
        if (snapshot.failure || snapshot.mediaError) {
            throw Object.assign(new Error(`media failure at ${snapshot.currentTime}s`), {snapshot, consoleLines});
        }
        if (snapshot.ended) return {snapshot, consoleLines};
        if (snapshot.lastProgressAgo > args.stallTimeoutSeconds) {
            throw Object.assign(new Error(`playback stalled for ${snapshot.lastProgressAgo.toFixed(1)}s`), {
                snapshot,
                consoleLines,
            });
        }
        if (Date.now() - lastReportAt >= 5000) {
            lastReportAt = Date.now();
            console.log(`progress wall=${((Date.now() - started) / 1000).toFixed(1)}s ` +
                `media=${Number(snapshot.currentTime).toFixed(3)}s seeks=${snapshot.seekCount} ` +
                `ready=${snapshot.readyState} buffered=${JSON.stringify(snapshot.buffered)}`);
        }
        if (args.mode !== 'linear' && Date.now() >= nextSeekAt) {
            const action = args.mode === 'cocktail' ?
                ['seek', 'audio', 'video'][actionIndex++ % 3] : args.mode;
            let actionResult;
            if (action === 'seek') {
                let target;
                const duration = Number.isFinite(snapshot.duration) ? snapshot.duration : 459;
                if (args.mode === 'seek') {
                    target = args.targets[targetIndex++ % args.targets.length];
                } else {
                    target = Math.max(0, random() * Math.max(1, duration - 5));
                }
                target = Math.min(target, Math.max(0, duration - 1));
                await evaluate(client, `window.__mmtsSeek(${JSON.stringify(target)})`);
            } else {
                const kind = action === 'tracks' ?
                    (actionIndex++ % 2 === 0 ? 'audio' : 'video') : action;
                actionResult = await evaluate(client,
                    `window.__mmtsSwitchTrack(${JSON.stringify(kind)})`);
            }
            snapshot = await evaluate(client, 'window.__mmtsSnapshot()');
            if (snapshot.failure || snapshot.mediaError) {
                throw Object.assign(new Error(`media failure after ${action} action at ` +
                    `${snapshot.currentTime}s`), {snapshot, consoleLines});
            }
            if (snapshot.ended) return {snapshot, consoleLines};
            if (actionResult && actionResult.skipped === true &&
                actionResult.reason === 'playback-ended') {
                return {snapshot, consoleLines};
            }
            const failedTrackSwitch = actionResult && (
                typeof actionResult.error === 'string' ||
                (actionResult.result && actionResult.result.status === 'failed')
            );
            if (failedTrackSwitch) {
                const recoveryDeadline = Date.now() + 5000;
                while (snapshot.lastProgressAgo > 2 && !snapshot.failure &&
                    !snapshot.mediaError && !snapshot.ended && Date.now() < recoveryDeadline) {
                    await sleep(250);
                    snapshot = await evaluate(client, 'window.__mmtsSnapshot()');
                }
                if (snapshot.failure || snapshot.mediaError) {
                    throw Object.assign(new Error(`media failure during ${action} recovery at ` +
                        `${snapshot.currentTime}s`), {snapshot, consoleLines});
                }
                if (snapshot.ended) return {snapshot, consoleLines};
            }
            if (snapshot.lastProgressAgo > args.stallTimeoutSeconds) {
                throw Object.assign(new Error(`playback stalled after ${action} action for ` +
                    `${snapshot.lastProgressAgo.toFixed(1)}s`), {snapshot, consoleLines});
            }
            nextSeekAt = Date.now() + args.seekIntervalSeconds * 1000;
        }
        await sleep(1000);
    }
    return {snapshot, consoleLines};
}

async function main() {
    if (typeof WebSocket !== 'function') {
        throw new Error('Node.js 22+ is required; run with nix-shell -p nodejs_22');
    }
    const args = parseArgs(process.argv);
    const repoRoot = path.resolve(__dirname, '..');
    const chrome = findChrome(args.executablePath);
    const server = await createServer(args, repoRoot);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmts-chrome-'));
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const chromeArgs = [
        `--user-data-dir=${userDataDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--window-size=1280,720',
        '--mute-audio',
    ];
    if (args.headed) {
        chromeArgs.push('--window-position=-10000,-10000');
    } else {
        chromeArgs.push('--headless=new');
    }
    chromeArgs.push('about:blank');
    const chromeProcess = childProcess.spawn(chrome, chromeArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    const chromeStderr = [];
    chromeProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        chromeStderr.push(text);
        if (chromeStderr.length > 200) chromeStderr.shift();
    });

    let client;
    try {
        await waitForFile(activePortFile, 15000);
        const port = Number(fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]);
        const address = server.address();
        const pageUrl = `http://127.0.0.1:${address.port}/`;
        const target = await httpJson('PUT', `http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`);
        client = new CDPClient(target.webSocketDebuggerUrl);
        console.log(`chrome=${chrome}`);
        console.log(`mode=${args.mode} headed=${args.headed} muted=true duration=${args.durationSeconds}s`);
        console.log(`media=${args.file}`);
        const result = await runTest(client, args);
        writeReport(args, 'pass', result.snapshot, result.consoleLines);
        console.log(`PASS media=${Number(result.snapshot.currentTime).toFixed(3)}s ` +
            `seeks=${result.snapshot.seekCount} frames=${result.snapshot.quality &&
                result.snapshot.quality.totalVideoFrames}`);
        console.log(`report=${path.join(args.artifactDir, 'result.json')}`);
    } catch (error) {
        const snapshot = error.snapshot || (client ? await evaluate(
            client,
            'window.__mmtsSnapshot ? window.__mmtsSnapshot() : null'
        ).catch(() => null) : null);
        await captureFailure(client, args, snapshot, error.consoleLines || chromeStderr).catch(() => {});
        console.error(`FAIL ${error && error.stack ? error.stack : error}`);
        console.error(`artifacts=${args.artifactDir}`);
        process.exitCode = 1;
    } finally {
        if (client) client.close();
        await new Promise((resolve) => server.close(resolve));
        chromeProcess.kill('SIGTERM');
        await Promise.race([
            new Promise((resolve) => chromeProcess.once('exit', resolve)),
            sleep(3000),
        ]);
        if (chromeProcess.exitCode === null) chromeProcess.kill('SIGKILL');
        fs.rmSync(userDataDir, {recursive: true, force: true});
    }
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});

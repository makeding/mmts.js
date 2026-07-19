#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

function parseArgs(argv) {
    const args = {
        browser: 'all',
        mime: 'audio/mp4; codecs="mp4a.40.2"',
        videoMime: 'video/mp4; codecs="avc1.64000d"',
        switchTime: undefined,
        minimumForward: 0.25,
        replacementEnd: undefined,
        executablePath: undefined,
        reseek: false,
        removeBefore: false,
        removeFrom: undefined,
        afterCaptureMs: 300,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--before') {
            args.before = argv[++i];
        } else if (arg === '--after') {
            args.after = argv[++i];
        } else if (arg === '--browser') {
            args.browser = argv[++i];
        } else if (arg === '--mime') {
            args.mime = argv[++i];
        } else if (arg === '--video') {
            args.video = argv[++i];
        } else if (arg === '--video-mime') {
            args.videoMime = argv[++i];
        } else if (arg === '--switch-time') {
            args.switchTime = Number(argv[++i]);
        } else if (arg === '--minimum-forward') {
            args.minimumForward = Number(argv[++i]);
        } else if (arg === '--replacement-end') {
            args.replacementEnd = Number(argv[++i]);
        } else if (arg === '--executable-path') {
            args.executablePath = argv[++i];
        } else if (arg === '--reseek') {
            args.reseek = true;
        } else if (arg === '--remove-before') {
            args.removeBefore = true;
        } else if (arg === '--remove-from') {
            args.removeFrom = Number(argv[++i]);
        } else if (arg === '--after-capture-ms') {
            args.afterCaptureMs = Number(argv[++i]);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (!args.before || !args.after || !Number.isFinite(args.switchTime) || args.switchTime < 0) {
        throw new Error('usage: node scripts/probe_mse_track_switch.js --before FILE --after FILE --switch-time SECONDS [--video FILE] [--mime MIME] [--video-mime MIME] [--minimum-forward SECONDS] [--replacement-end SECONDS] [--remove-before] [--remove-from SECONDS] [--reseek] [--after-capture-ms MILLISECONDS] [--browser chromium|edge|firefox|all] [--executable-path FILE]');
    }
    if (!['chromium', 'edge', 'firefox', 'all'].includes(args.browser)) {
        throw new Error('--browser must be chromium, edge, firefox, or all');
    }
    if (args.browser === 'edge' && !args.executablePath) {
        throw new Error('--browser edge requires --executable-path');
    }
    if (!Number.isFinite(args.minimumForward) || args.minimumForward <= 0) {
        throw new Error('--minimum-forward must be positive');
    }
    if (!Number.isFinite(args.afterCaptureMs) || args.afterCaptureMs < 250) {
        throw new Error('--after-capture-ms must be at least 250');
    }
    if (args.removeFrom !== undefined &&
        (!Number.isFinite(args.removeFrom) || args.removeFrom < 0)) {
        throw new Error('--remove-from must be a non-negative finite number');
    }
    if (args.removeFrom !== undefined && !args.removeBefore) {
        throw new Error('--remove-from requires --remove-before');
    }
    if (args.replacementEnd !== undefined &&
        (!Number.isFinite(args.replacementEnd) || args.replacementEnd <= args.switchTime)) {
        throw new Error('--replacement-end must be after --switch-time');
    }
    args.before = path.resolve(args.before);
    args.after = path.resolve(args.after);
    if (args.video) {
        args.video = path.resolve(args.video);
    }
    if (args.executablePath) {
        args.executablePath = path.resolve(args.executablePath);
    }
    return args;
}

function splitFragmentedMP4(file) {
    const data = fs.readFileSync(file);
    let offset = 0;
    let mediaOffset = -1;
    while (offset + 8 <= data.length) {
        let size = data.readUInt32BE(offset);
        const type = data.toString('ascii', offset + 4, offset + 8);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > data.length) break;
            const largeSize = data.readBigUInt64BE(offset + 8);
            if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error(`${file}: MP4 box is too large`);
            }
            size = Number(largeSize);
            headerSize = 16;
        } else if (size === 0) {
            size = data.length - offset;
        }
        if (size < headerSize || offset + size > data.length) {
            throw new Error(`${file}: invalid ${type || 'unknown'} box at byte ${offset}`);
        }
        if (type === 'moof') {
            mediaOffset = offset;
            break;
        }
        offset += size;
    }
    if (mediaOffset <= 0 || mediaOffset >= data.length) {
        throw new Error(`${file}: expected an initialization segment followed by moof/mdat media`);
    }
    return {
        init: data.subarray(0, mediaOffset),
        media: data.subarray(mediaOffset),
    };
}

function createServer(files) {
    const server = http.createServer((request, response) => {
        if (request.url === '/') {
            response.writeHead(200, {'content-type': 'text/html'});
            response.end('<!doctype html><meta charset="utf-8"><title>MSE track switch probe</title>');
            return;
        }
        const body = files[request.url];
        if (!body) {
            response.writeHead(404);
            response.end();
            return;
        }
        response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': body.length,
            'cache-control': 'no-store',
        });
        response.end(body);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function runBrowser(browserType, name, url, args) {
    const launchOptions = {headless: true};
    if (args.executablePath) {
        launchOptions.executablePath = args.executablePath;
    }
    if (name === 'chromium' || name === 'edge') {
        launchOptions.args = ['--autoplay-policy=no-user-gesture-required'];
    } else if (name === 'firefox') {
        launchOptions.firefoxUserPrefs = {
            'media.autoplay.default': 0,
            'media.autoplay.blocking_policy': 0,
        };
    }
    const browser = await browserType.launch(launchOptions);
    let activationTimer = null;
    try {
        const page = await browser.newPage();
        page.on('console', (message) => console.error(`${name}: ${message.text()}`));
        page.on('pageerror', (error) => console.error(`${name}: pageerror: ${error.message}`));
        await page.goto(url);
        activationTimer = setInterval(() => {
            page.mouse.click(10, 10).catch(() => {});
        }, 250);
        const result = await page.evaluate(async (options) => {
            const log = [];
            const video = document.createElement('video');
            video.muted = false;
            video.autoplay = false;
            document.body.appendChild(video);
            const requestedTimeMicroseconds = Math.round(options.switchTime * 1000000);
            const transactionKey = 'mse-track-switch-probe:audio-switch:1';
            const operation = {
                scopeId: 'mse-track-switch-probe',
                transactionKey,
                attemptKey: `${transactionKey}:0`,
                timelineGeneration: 1,
                kind: 'audio-switch',
                transactionId: 1,
                attempt: 0,
                phase: 'requested',
                intentTimeMicroseconds: requestedTimeMicroseconds,
                requestedTimeMicroseconds,
                requestedTimeMilliseconds: requestedTimeMicroseconds / 1000,
            };
            const operationAtPhase = (phase) => Object.assign({}, operation, {phase});
            log.push({event: 'operation-state', operation: operationAtPhase('requested')});

            function ranges(value) {
                const result = [];
                for (let i = 0; i < value.length; i++) {
                    result.push([value.start(i), value.end(i)]);
                }
                return result;
            }

            function waitForEvent(target, event, timeout = 10000) {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        cleanup();
                        reject(new Error(`timeout waiting for ${event}`));
                    }, timeout);
                    const onEvent = () => {
                        cleanup();
                        resolve();
                    };
                    const onError = () => {
                        cleanup();
                        reject(new Error(`${event} failed: mediaError=${video.error && video.error.code}`));
                    };
                    const cleanup = () => {
                        clearTimeout(timer);
                        target.removeEventListener(event, onEvent);
                        target.removeEventListener('error', onError);
                        target.removeEventListener('abort', onError);
                    };
                    target.addEventListener(event, onEvent, {once: true});
                    target.addEventListener('error', onError, {once: true});
                    target.addEventListener('abort', onError, {once: true});
                });
            }

            function withTimeout(promise, label, timeout = 10000) {
                return Promise.race([
                    promise,
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error(`timeout during ${label}`)),
                        timeout
                    )),
                ]);
            }

            async function update(sourceBuffer, label, action) {
                if (sourceBuffer.updating) {
                    await waitForEvent(sourceBuffer, 'updateend');
                }
                const completed = waitForEvent(sourceBuffer, 'updateend');
                action();
                await completed;
                log.push({operation: label, buffered: ranges(sourceBuffer.buffered)});
            }

            async function loadBytes(path) {
                const response = await fetch(path, {cache: 'no-store'});
                if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
                return new Uint8Array(await response.arrayBuffer());
            }

            async function recordDecodedAudio(phase, duration = 300) {
                const capture = video.captureStream || video.mozCaptureStream;
                if (!capture || !('MediaRecorder' in window) || !('OfflineAudioContext' in window)) {
                    throw new Error('decoded audio capture is unavailable');
                }
                const stream = capture.call(video);
                const trackDeadline = performance.now() + 5000;
                while (stream.getAudioTracks().length === 0 && performance.now() < trackDeadline) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                const audioTracks = stream.getAudioTracks();
                if (audioTracks.length === 0) {
                    throw new Error(`${phase} capture has no audio track`);
                }
                const audioStream = new MediaStream(audioTracks);
                const mimeType = [
                    'audio/ogg;codecs=opus',
                    'audio/webm;codecs=opus',
                ].find((type) => MediaRecorder.isTypeSupported(type));
                if (!mimeType) {
                    throw new Error('no supported Opus MediaRecorder MIME type');
                }
                const chunks = [];
                const recorder = new MediaRecorder(audioStream, {mimeType});
                recorder.addEventListener('dataavailable', (event) => {
                    if (event.data && event.data.size > 0) chunks.push(event.data);
                });
                const stopped = waitForEvent(recorder, 'stop');
                recorder.start(50);
                await new Promise((resolve) => setTimeout(resolve, duration));
                recorder.stop();
                await stopped;
                audioTracks.forEach((track) => track.stop());
                const encoded = new Blob(chunks, {type: mimeType});
                if (encoded.size === 0) {
                    throw new Error(`${phase} capture produced no encoded audio`);
                }
                const offline = new OfflineAudioContext(2, 1, 48000);
                const decoded = await withTimeout(
                    offline.decodeAudioData(await encoded.arrayBuffer()),
                    `${phase}-pcm-decode`
                );
                let sumSquares = 0;
                let peak = 0;
                let tailSumSquares = 0;
                let tailPeak = 0;
                let tailSampleCount = 0;
                for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
                    const samples = decoded.getChannelData(channel);
                    const tailStart = Math.max(0, samples.length - Math.floor(decoded.sampleRate * 0.25));
                    for (let index = 0; index < samples.length; index++) {
                        const value = samples[index];
                        sumSquares += value * value;
                        peak = Math.max(peak, Math.abs(value));
                        if (index >= tailStart) {
                            tailSumSquares += value * value;
                            tailPeak = Math.max(tailPeak, Math.abs(value));
                            tailSampleCount++;
                        }
                    }
                }
                const sampleCount = decoded.length * decoded.numberOfChannels;
                const rms = Math.sqrt(sumSquares / Math.max(sampleCount, 1));
                const tailRms = Math.sqrt(tailSumSquares / Math.max(tailSampleCount, 1));
                if (decoded.length === 0 || peak <= 0.00001 || rms <= 0.000001) {
                    throw new Error(`${phase} decoded PCM is silent: ${JSON.stringify({frames: decoded.length, peak, rms})}`);
                }
                if (tailPeak <= 0.00001 || tailRms <= 0.000001) {
                    throw new Error(`${phase} decoded PCM tail is silent: ${JSON.stringify({frames: decoded.length, tailPeak, tailRms})}`);
                }
                return {
                    encodedBytes: encoded.size,
                    frames: decoded.length,
                    channels: decoded.numberOfChannels,
                    sampleRate: decoded.sampleRate,
                    peak,
                    rms,
                    tailPeak,
                    tailRms,
                };
            }

            if (!('MediaSource' in window)) {
                throw new Error('MediaSource is unavailable');
            }
            if (!MediaSource.isTypeSupported(options.mime)) {
                throw new Error(`unsupported MIME: ${options.mime}`);
            }
            if (options.hasVideo && !MediaSource.isTypeSupported(options.videoMime)) {
                throw new Error(`unsupported video MIME: ${options.videoMime}`);
            }

            const [beforeInit, beforeMedia, afterInit, afterMedia, videoInit, videoMedia] = await Promise.all([
                loadBytes('/before-init'),
                loadBytes('/before-media'),
                loadBytes('/after-init'),
                loadBytes('/after-media'),
                options.hasVideo ? loadBytes('/video-init') : null,
                options.hasVideo ? loadBytes('/video-media') : null,
            ]);
            const mediaSource = new MediaSource();
            video.src = URL.createObjectURL(mediaSource);
            console.log('stage=opening-media-source');
            await waitForEvent(mediaSource, 'sourceopen');
            const sourceBuffer = mediaSource.addSourceBuffer(options.mime);
            const videoSourceBuffer = options.hasVideo ? mediaSource.addSourceBuffer(options.videoMime) : null;

            console.log('stage=appending-before-track');
            if (videoSourceBuffer) {
                await update(videoSourceBuffer, 'append-video-init', () => videoSourceBuffer.appendBuffer(videoInit));
                await update(videoSourceBuffer, 'append-video-media', () => videoSourceBuffer.appendBuffer(videoMedia));
            }
            await update(sourceBuffer, 'append-before-init', () => sourceBuffer.appendBuffer(beforeInit));
            await update(sourceBuffer, 'append-before-media', () => sourceBuffer.appendBuffer(beforeMedia));
            const beforeRanges = ranges(sourceBuffer.buffered);
            const beforeRange = beforeRanges.find((range) =>
                range[0] <= options.switchTime && range[1] >= options.switchTime + options.minimumForward
            );
            if (!beforeRange) {
                throw new Error(`initial media does not cover switch time: ${JSON.stringify(beforeRanges)}`);
            }

            video.currentTime = options.switchTime;
            console.log('stage=starting-playback');
            await withTimeout(video.play(), 'media-play');
            const beforeAudio = await recordDecodedAudio('before');
            const switchPosition = video.currentTime;
            if (sourceBuffer.updating) {
                await waitForEvent(sourceBuffer, 'updateend');
            }
            if (options.removeBefore) {
                const currentRanges = ranges(sourceBuffer.buffered);
                const staleEnd = currentRanges.reduce((end, range) => Math.max(end, range[1]), 0);
                const removeFrom = options.removeFrom === undefined ?
                    switchPosition : options.removeFrom;
                if (staleEnd > removeFrom + 0.001) {
                    console.log('stage=removing-old-track');
                    await update(
                        sourceBuffer,
                        'remove-old-track',
                        () => sourceBuffer.remove(removeFrom, staleEnd)
                    );
                }
            }
            sourceBuffer.changeType(options.mime);
            log.push({operation: 'changeType', buffered: ranges(sourceBuffer.buffered)});
            log.push({event: 'operation-state', operation: operationAtPhase('submitted')});
            console.log('stage=appending-after-track');
            await update(sourceBuffer, 'append-after-init', () => sourceBuffer.appendBuffer(afterInit));
            await update(sourceBuffer, 'append-after-media', () => sourceBuffer.appendBuffer(afterMedia));

            if (options.replacementEnd !== undefined) {
                const currentRanges = ranges(sourceBuffer.buffered);
                const staleEnd = currentRanges.reduce((end, range) => Math.max(end, range[1]), 0);
                if (staleEnd > options.replacementEnd + 0.001) {
                    await update(
                        sourceBuffer,
                        'remove-stale-tail',
                        () => sourceBuffer.remove(options.replacementEnd, staleEnd)
                    );
                }
            }

            if (options.reseek) {
                console.log('stage=reseeking-playback');
                const target = video.currentTime;
                const seeked = waitForEvent(video, 'seeked');
                video.currentTime = target;
                await seeked;
                log.push({operation: 'reseek-playback', target, currentTime: video.currentTime});
            }

            const switchedRanges = ranges(sourceBuffer.buffered);
            const switchedRange = switchedRanges.find((range) =>
                range[0] <= switchPosition && range[1] >= switchPosition + options.minimumForward
            );
            if (!switchedRange) {
                throw new Error(`replacement media does not cover switch time: ${JSON.stringify(switchedRanges)}`);
            }
            if (video.error) {
                throw new Error(`media element failed with code ${video.error.code}`);
            }

            const playbackStart = video.currentTime;
            console.log('stage=reading-after-pcm');
            const afterAudio = await recordDecodedAudio('after', options.afterCaptureMs);
            if (video.paused || video.ended) {
                throw new Error(`playback stopped after switch: paused=${video.paused} ended=${video.ended} currentTime=${video.currentTime}`);
            }
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline && video.currentTime < playbackStart + 0.1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (video.error) {
                    throw new Error(`media element failed during playback with code ${video.error.code}`);
                }
            }
            if (video.currentTime < playbackStart + 0.1) {
                throw new Error(`playback did not advance after switch: ${playbackStart} -> ${video.currentTime}`);
            }
            return {
                playbackOperation: operationAtPhase('committed'),
                userAgent: navigator.userAgent,
                mime: options.mime,
                switchPosition,
                playbackStart,
                playbackEnd: video.currentTime,
                buffered: ranges(sourceBuffer.buffered),
                mediaError: video.error ? video.error.code : null,
                paused: video.paused,
                readyState: video.readyState,
                decodedAudio: {before: beforeAudio, after: afterAudio},
                videoBuffered: videoSourceBuffer ? ranges(videoSourceBuffer.buffered) : [],
                log,
            };
        }, {
            mime: args.mime,
            switchTime: args.switchTime,
            minimumForward: args.minimumForward,
            replacementEnd: args.replacementEnd,
            reseek: args.reseek,
            removeBefore: args.removeBefore,
            removeFrom: args.removeFrom,
            afterCaptureMs: args.afterCaptureMs,
            hasVideo: !!args.video,
            videoMime: args.videoMime,
        });
        console.log(`${name}: PASS ${JSON.stringify(result)}`);
        return true;
    } catch (error) {
        console.error(`${name}: FAIL ${error && error.stack ? error.stack : error}`);
        return false;
    } finally {
        if (activationTimer !== null) {
            clearInterval(activationTimer);
        }
        await browser.close();
    }
}

async function main() {
    const args = parseArgs(process.argv);
    let playwright;
    try {
        playwright = require('playwright');
    } catch (_) {
        throw new Error('playwright is required; install it without modifying the project dependencies, then install Chromium and Firefox browser binaries');
    }
    const before = splitFragmentedMP4(args.before);
    const after = splitFragmentedMP4(args.after);
    const video = args.video ? splitFragmentedMP4(args.video) : null;
    console.log(`input: before_init=${before.init.length} before_media=${before.media.length} after_init=${after.init.length} after_media=${after.media.length}`);
    const server = await createServer({
        '/before-init': before.init,
        '/before-media': before.media,
        '/after-init': after.init,
        '/after-media': after.media,
        '/video-init': video && video.init,
        '/video-media': video && video.media,
    });
    try {
        const address = server.address();
        const url = `http://127.0.0.1:${address.port}/`;
        const browsers = args.browser === 'all' ? ['chromium', 'firefox'] : [args.browser];
        let passed = true;
        for (const name of browsers) {
            const browserType = name === 'edge' ? playwright.chromium : playwright[name];
            passed = await runBrowser(browserType, name, url, args) && passed;
        }
        process.exitCode = passed ? 0 : 1;
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});

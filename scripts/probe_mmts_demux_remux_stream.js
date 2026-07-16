#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(repoRoot, 'src');
const moduleCache = new Map();

function parseArgs(argv) {
    const args = {
        file: '',
        seconds: Infinity,
        bytes: Infinity,
        chunkSize: 2 * 1024 * 1024,
        gapThresholdMs: 80,
        live: false,
        firefoxLiveAudioRebuild: false,
        printFirstSegments: 0,
        verbose: false,
        audioSwitchPacketId: undefined,
        audioSwitchAtReadSeconds: undefined,
        audioSwitchTimelineSeconds: undefined,
        audioSwitchOutput: undefined,
        initialAudioOutput: undefined,
        audioSwitchRequiredForwardSeconds: 0.25,
        audioSwitchSecondPacketId: undefined,
        audioSwitchSecondAtReadSeconds: undefined,
        audioSwitchSecondTimelineSeconds: undefined,
        audioSwitchSecondOutput: undefined,
        videoSwitchPacketId: undefined,
        videoSwitchAtReadSeconds: undefined,
        videoSwitchOutput: undefined,
        videoSwitchRequiredForwardSeconds: 0.25,
        videoSwitchSecondPacketId: undefined,
        videoSwitchSecondAtReadSeconds: undefined,
        videoSwitchSecondOutput: undefined,
        initialVideoOutput: undefined,
        audioSwitchRebuildFromSeek: false,
        seekTargetSeconds: undefined,
        seekDurationSeconds: undefined,
        seekAfterSeconds: 2,
        seekLookbackBytes: 32 * 1024 * 1024,
        seekMaxReadBytes: 256 * 1024 * 1024,
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--seconds') {
            args.seconds = Number(argv[++i]);
        } else if (arg === '--bytes') {
            args.bytes = Number(argv[++i]);
        } else if (arg === '--chunk-size') {
            args.chunkSize = Number(argv[++i]);
        } else if (arg === '--gap-threshold-ms') {
            args.gapThresholdMs = Number(argv[++i]);
        } else if (arg === '--live') {
            args.live = true;
        } else if (arg === '--firefox-live-audio-rebuild') {
            args.firefoxLiveAudioRebuild = true;
        } else if (arg === '--print-first-segments') {
            args.printFirstSegments = Number(argv[++i]);
        } else if (arg === '--verbose') {
            args.verbose = true;
        } else if (arg === '--audio-switch-packet-id') {
            args.audioSwitchPacketId = Number(argv[++i]);
        } else if (arg === '--audio-switch-at-read-seconds') {
            args.audioSwitchAtReadSeconds = Number(argv[++i]);
        } else if (arg === '--audio-switch-timeline-seconds') {
            args.audioSwitchTimelineSeconds = Number(argv[++i]);
        } else if (arg === '--audio-switch-output') {
            args.audioSwitchOutput = argv[++i];
        } else if (arg === '--initial-audio-output') {
            args.initialAudioOutput = argv[++i];
        } else if (arg === '--audio-switch-required-forward-seconds') {
            args.audioSwitchRequiredForwardSeconds = Number(argv[++i]);
        } else if (arg === '--audio-switch-second-packet-id') {
            args.audioSwitchSecondPacketId = Number(argv[++i]);
        } else if (arg === '--audio-switch-second-at-read-seconds') {
            args.audioSwitchSecondAtReadSeconds = Number(argv[++i]);
        } else if (arg === '--audio-switch-second-timeline-seconds') {
            args.audioSwitchSecondTimelineSeconds = Number(argv[++i]);
        } else if (arg === '--audio-switch-second-output') {
            args.audioSwitchSecondOutput = argv[++i];
        } else if (arg === '--video-switch-packet-id') {
            args.videoSwitchPacketId = Number(argv[++i]);
        } else if (arg === '--video-switch-at-read-seconds') {
            args.videoSwitchAtReadSeconds = Number(argv[++i]);
        } else if (arg === '--video-switch-output') {
            args.videoSwitchOutput = argv[++i];
        } else if (arg === '--video-switch-required-forward-seconds') {
            args.videoSwitchRequiredForwardSeconds = Number(argv[++i]);
        } else if (arg === '--video-switch-second-packet-id') {
            args.videoSwitchSecondPacketId = Number(argv[++i]);
        } else if (arg === '--video-switch-second-at-read-seconds') {
            args.videoSwitchSecondAtReadSeconds = Number(argv[++i]);
        } else if (arg === '--video-switch-second-output') {
            args.videoSwitchSecondOutput = argv[++i];
        } else if (arg === '--initial-video-output') {
            args.initialVideoOutput = argv[++i];
        } else if (arg === '--audio-switch-rebuild-from-seek') {
            args.audioSwitchRebuildFromSeek = true;
        } else if (arg === '--seek-target-seconds') {
            args.seekTargetSeconds = Number(argv[++i]);
        } else if (arg === '--seek-duration-seconds') {
            args.seekDurationSeconds = Number(argv[++i]);
        } else if (arg === '--seek-after-seconds') {
            args.seekAfterSeconds = Number(argv[++i]);
        } else if (arg === '--seek-lookback-bytes') {
            args.seekLookbackBytes = Number(argv[++i]);
        } else if (arg === '--seek-max-read-bytes') {
            args.seekMaxReadBytes = Number(argv[++i]);
        } else if (!args.file) {
            args.file = arg;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    if (!args.file) {
        throw new Error('usage: node scripts/probe_mmts_demux_remux_stream.js <mmts-file> [--seconds N] [--bytes N] [--chunk-size N] [--live] [--firefox-live-audio-rebuild] [--print-first-segments N] [--verbose] [--audio-switch-packet-id N --audio-switch-at-read-seconds N --audio-switch-timeline-seconds N] [--initial-audio-output FILE] [--audio-switch-output FILE] [--audio-switch-required-forward-seconds N] [--audio-switch-second-packet-id N --audio-switch-second-at-read-seconds N --audio-switch-second-timeline-seconds N --audio-switch-second-output FILE] [--video-switch-packet-id N --video-switch-at-read-seconds N] [--initial-video-output FILE] [--video-switch-output FILE] [--video-switch-required-forward-seconds N] [--video-switch-second-packet-id N --video-switch-second-at-read-seconds N --video-switch-second-output FILE] [--audio-switch-rebuild-from-seek --seek-target-seconds N --seek-duration-seconds N] [--seek-after-seconds N] [--seek-lookback-bytes N] [--seek-max-read-bytes N]');
    }
    if (!Number.isFinite(args.chunkSize) || args.chunkSize <= 0) {
        throw new Error('--chunk-size must be a positive number');
    }
    if (!Number.isFinite(args.gapThresholdMs) || args.gapThresholdMs <= 0) {
        throw new Error('--gap-threshold-ms must be a positive number');
    }
    if (!Number.isFinite(args.printFirstSegments) || args.printFirstSegments < 0) {
        throw new Error('--print-first-segments must be a non-negative number');
    }
    if (!Number.isFinite(args.audioSwitchRequiredForwardSeconds) ||
        args.audioSwitchRequiredForwardSeconds <= 0) {
        throw new Error('--audio-switch-required-forward-seconds must be a positive number');
    }
    if (!Number.isFinite(args.videoSwitchRequiredForwardSeconds) ||
        args.videoSwitchRequiredForwardSeconds <= 0) {
        throw new Error('--video-switch-required-forward-seconds must be a positive number');
    }
    if ((args.seekTargetSeconds === undefined) !== (args.seekDurationSeconds === undefined) ||
        (args.seekTargetSeconds !== undefined &&
         (!Number.isFinite(args.seekTargetSeconds) || args.seekTargetSeconds < 0 ||
          !Number.isFinite(args.seekDurationSeconds) || args.seekDurationSeconds <= 0))) {
        throw new Error('--seek-target-seconds requires a non-negative target and a positive --seek-duration-seconds');
    }
    if (!Number.isFinite(args.seekAfterSeconds) || args.seekAfterSeconds < 0 ||
        !Number.isFinite(args.seekLookbackBytes) || args.seekLookbackBytes < 0 ||
        !Number.isFinite(args.seekMaxReadBytes) || args.seekMaxReadBytes <= 0) {
        throw new Error('seek probe limits must be finite non-negative values');
    }
    if (args.audioSwitchRebuildFromSeek &&
        (args.live || !Number.isFinite(args.audioSwitchPacketId) ||
         !Number.isFinite(args.seekTargetSeconds) || !Number.isFinite(args.seekDurationSeconds))) {
        throw new Error('--audio-switch-rebuild-from-seek requires VOD, --audio-switch-packet-id and seek target/duration');
    }
    const hasSecondAudioSwitch = args.audioSwitchSecondPacketId !== undefined ||
        args.audioSwitchSecondAtReadSeconds !== undefined ||
        args.audioSwitchSecondTimelineSeconds !== undefined ||
        args.audioSwitchSecondOutput !== undefined;
    if (hasSecondAudioSwitch &&
        (args.audioSwitchRebuildFromSeek ||
         !Number.isFinite(args.audioSwitchPacketId) ||
         !Number.isFinite(args.audioSwitchAtReadSeconds) ||
         !Number.isFinite(args.audioSwitchSecondPacketId) ||
         !Number.isFinite(args.audioSwitchSecondAtReadSeconds) ||
         args.audioSwitchSecondAtReadSeconds < 0 ||
         (args.audioSwitchSecondTimelineSeconds !== undefined &&
          (!Number.isFinite(args.audioSwitchSecondTimelineSeconds) || args.audioSwitchSecondTimelineSeconds < 0)))) {
        throw new Error('second audio switch requires a non-rebuild first switch and finite packet/read parameters');
    }
    const hasVideoSwitch = args.videoSwitchPacketId !== undefined ||
        args.videoSwitchAtReadSeconds !== undefined || args.videoSwitchOutput !== undefined;
    if (hasVideoSwitch &&
        (!Number.isFinite(args.videoSwitchPacketId) ||
         !Number.isFinite(args.videoSwitchAtReadSeconds) || args.videoSwitchAtReadSeconds < 0)) {
        throw new Error('video switch requires finite packet/read parameters');
    }
    const hasSecondVideoSwitch = args.videoSwitchSecondPacketId !== undefined ||
        args.videoSwitchSecondAtReadSeconds !== undefined || args.videoSwitchSecondOutput !== undefined;
    if (hasSecondVideoSwitch &&
        (!hasVideoSwitch || !Number.isFinite(args.videoSwitchSecondPacketId) ||
         !Number.isFinite(args.videoSwitchSecondAtReadSeconds) ||
         args.videoSwitchSecondAtReadSeconds < 0)) {
        throw new Error('second video switch requires a first switch and finite packet/read parameters');
    }

    args.file = path.resolve(args.file);
    return args;
}

function setupBrowserGlobals() {
    const navigator = {userAgent: 'node mmts demux remux probe'};
    global.navigator = navigator;
    global.self = global.self || {};
    global.self.navigator = navigator;
    global.self.setTimeout = setTimeout;
    global.self.clearTimeout = clearTimeout;
    global.window = global.window || global.self;
}

function resolveLocalModule(request, parentFilename) {
    if (!request.startsWith('.')) {
        return null;
    }

    const base = path.resolve(path.dirname(parentFilename), request);
    const candidates = [
        base,
        `${base}.ts`,
        `${base}.js`,
        `${base}.json`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.js')
    ];

    for (const candidate of candidates) {
        if (!candidate.startsWith(sourceRoot) && !candidate.startsWith(repoRoot)) {
            continue;
        }
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

function loadLocalModule(filename) {
    const resolved = path.resolve(filename);
    if (moduleCache.has(resolved)) {
        return moduleCache.get(resolved).exports;
    }

    if (resolved.endsWith('.json')) {
        const jsonModule = {exports: JSON.parse(fs.readFileSync(resolved, 'utf8'))};
        moduleCache.set(resolved, jsonModule);
        return jsonModule.exports;
    }

    const source = fs.readFileSync(resolved, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            allowJs: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true
        },
        fileName: resolved
    }).outputText;

    const moduleObject = {exports: {}};
    moduleCache.set(resolved, moduleObject);

    const localRequire = (request) => {
        const local = resolveLocalModule(request, resolved);
        if (local !== null) {
            return loadLocalModule(local);
        }
        return require(request);
    };

    const sandbox = {
        require: localRequire,
        module: moduleObject,
        exports: moduleObject.exports,
        __dirname: path.dirname(resolved),
        __filename: resolved,
        console,
        process,
        Buffer,
        ArrayBuffer,
        Uint8Array,
        DataView,
        setTimeout,
        clearTimeout,
        self: global.self,
        window: global.window,
        navigator: global.navigator
    };
    vm.runInNewContext(compiled, sandbox, {filename: resolved});
    return moduleObject.exports;
}

function getDefaultExport(moduleExports) {
    return moduleExports && moduleExports.__esModule ? moduleExports.default : moduleExports.default || moduleExports;
}

function toArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function readRange(file, offset, length) {
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, buffer, 0, length, offset);
        return buffer.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

function createStats() {
    return {
        init: {audio: 0, video: 0},
        initOrder: [],
        media: {
            audio: {segments: 0, samples: 0, bytes: 0, firstDts: undefined, lastDts: undefined, gaps: [], lastSource: null},
            video: {
                segments: 0,
                samples: 0,
                bytes: 0,
                firstDts: undefined,
                lastDts: undefined,
                gaps: [],
                lastSource: null,
                randomAccessSafeSegments: [],
            }
        },
        demux: {
            video: {samples: 0, firstDts: undefined, lastDts: undefined, gaps: [], lastSource: null}
        },
        drops: {
            video: {total: 0, byReason: {}, byMpu: {}, samples: [], recentSamples: [], samplesByMpu: {}}
        },
        rejectedVideoMpus: {total: 0, byReason: {}, byPacketId: {}, samples: []},
        discontinuities: [],
        firstDemuxVideoSamples: [],
        firstSegments: [],
        mediaInfo: null,
        audioTracks: null,
        videoTracks: null,
        startupGroups: [],
        audioSwitchInitSegments: [],
        audioSwitchMediaSegments: [],
        videoSwitchInitSegments: [],
        videoSwitchMediaSegments: [],
        errors: []
    };
}

function resetTimelineStats(stats) {
    const fresh = createStats();
    stats.init = fresh.init;
    stats.initOrder = fresh.initOrder;
    stats.media = fresh.media;
    stats.demux = fresh.demux;
    stats.drops = fresh.drops;
    stats.rejectedVideoMpus = fresh.rejectedVideoMpus;
    stats.discontinuities = fresh.discontinuities;
    stats.firstDemuxVideoSamples = fresh.firstDemuxVideoSamples;
    stats.firstSegments = fresh.firstSegments;
    stats.errors = fresh.errors;
}

function segmentBeginDts(segment) {
    if (segment.info && segment.info.beginDts !== undefined) {
        return segment.info.beginDts;
    }
    if (segment.info && segment.info.firstSample && segment.info.firstSample.dts !== undefined) {
        return segment.info.firstSample.dts;
    }
    return undefined;
}

function segmentEndDts(segment) {
    if (segment.info && segment.info.endDts !== undefined) {
        return segment.info.endDts;
    }
    if (segment.info && segment.info.lastSample && segment.info.lastSample.dts !== undefined) {
        return segment.info.lastSample.dts + (segment.info.lastSample.duration || 0);
    }
    return undefined;
}

function recordSegment(stats, type, segment, gapThresholdMs) {
    const track = stats.media[type];
    const begin = segmentBeginDts(segment);
    const end = segmentEndDts(segment);
    const source = segment.mmtsSourceInfo || null;

    if (track.lastDts !== undefined && begin !== undefined) {
        const gap = begin - track.lastDts;
        if (gap > gapThresholdMs) {
            track.gaps.push({
                previousEnd: track.lastDts,
                nextBegin: begin,
                gap,
                previousSource: track.lastSource,
                nextSource: source,
                nextSampleCount: segment.sampleCount || 0
            });
        }
    }

    track.segments++;
    track.samples += segment.sampleCount || 0;
    track.bytes += segment.data ? segment.data.byteLength : 0;
    if (track.firstDts === undefined && begin !== undefined) {
        track.firstDts = begin;
    }
    if (end !== undefined) {
        track.lastDts = end;
    }
    if (source !== null) {
        track.lastSource = source;
    }
    if (type === 'video' && segment.mmtsRandomAccessSafe === true) {
        track.randomAccessSafeSegments.push({beginDts: begin, endDts: end, source});
    }

    if (stats.firstSegments.length < stats.printFirstSegmentsLimit) {
        const firstSample = segment.info && segment.info.firstSample ? segment.info.firstSample : null;
        const lastSample = segment.info && segment.info.lastSample ? segment.info.lastSample : null;
        const syncPoints = segment.info && segment.info.syncPoints ? segment.info.syncPoints : [];
        stats.firstSegments.push({
            type,
            samples: segment.sampleCount || 0,
            bytes: segment.data ? segment.data.byteLength : 0,
            beginDts: begin,
            endDts: end,
            beginPts: segment.info ? segment.info.beginPts : undefined,
            endPts: segment.info ? segment.info.endPts : undefined,
            firstSample: firstSample ? {
                dts: firstSample.dts,
                pts: firstSample.pts,
                duration: firstSample.duration,
                originalDts: firstSample.originalDts,
                isSyncPoint: firstSample.isSyncPoint
            } : null,
            lastSample: lastSample ? {
                dts: lastSample.dts,
                pts: lastSample.pts,
                duration: lastSample.duration,
                originalDts: lastSample.originalDts,
                isSyncPoint: lastSample.isSyncPoint
            } : null,
            syncPoints: syncPoints.slice(0, 4).map((point) => ({
                dts: point.dts,
                pts: point.pts,
                duration: point.duration,
                originalDts: point.originalDts,
                fileposition: point.fileposition
            })),
            firstPlayableWindow: segment.firstPlayableWindow || null,
            mmtsRandomAccessSafe: segment.mmtsRandomAccessSafe === true,
            source
        });
    }
}

function recordDemuxVideoTrack(stats, videoTrack, gapThresholdMs) {
    if (!videoTrack || !Array.isArray(videoTrack.samples)) {
        return;
    }

    const track = stats.demux.video;
    const samples = videoTrack.samples.slice().sort((a, b) => {
        if (a.dts !== b.dts) {
            return a.dts - b.dts;
        }
        return a.pts - b.pts;
    });

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const dts = sample.dts;
        const source = sample.mmtsSourceInfo || null;
        if (track.lastDts !== undefined && dts !== undefined) {
            const gap = dts - track.lastDts;
            if (gap > gapThresholdMs) {
                track.gaps.push({
                    previousEnd: track.lastDts,
                    nextBegin: dts,
                    gap,
                    previousSource: track.lastSource,
                    nextSource: source
                });
            }
        }
        track.samples++;
        if (track.firstDts === undefined && dts !== undefined) {
            track.firstDts = dts;
        }
        if (dts !== undefined) {
            track.lastDts = dts;
        }
        if (source !== null) {
            track.lastSource = source;
        }
        if (stats.firstDemuxVideoSamples.length < stats.printFirstSegmentsLimit) {
            stats.firstDemuxVideoSamples.push({
                dts: sample.dts,
                pts: sample.pts,
                cts: sample.cts,
                isKeyframe: sample.isKeyframe,
                length: sample.length,
                naluTypes: Array.isArray(sample.units) ? sample.units.map((unit) => unit.type) : [],
                source
            });
        }
    }
}

function formatMs(value) {
    return value === undefined ? 'n/a' : `${Math.round(value)}ms`;
}

function printTrackSummary(type, track) {
    console.log(`${type}: segments=${track.segments} samples=${track.samples} bytes=${track.bytes}`);
    console.log(`${type}: range=${formatMs(track.firstDts)}..${formatMs(track.lastDts)} gaps_gt_threshold=${track.gaps.length}`);
    for (let i = 0; i < Math.min(track.gaps.length, 8); i++) {
        const gap = track.gaps[i];
        console.log(`${type}: gap#${i + 1} previous_end=${formatMs(gap.previousEnd)} next_begin=${formatMs(gap.nextBegin)} gap=${formatMs(gap.gap)}`);
        if (gap.previousSource || gap.nextSource) {
            console.log(`${type}: gap#${i + 1} source=${JSON.stringify({previous: gap.previousSource, next: gap.nextSource, nextSampleCount: gap.nextSampleCount})}`);
        }
    }
}

function printDemuxVideoSummary(track) {
    console.log(`demux_video: samples=${track.samples}`);
    console.log(`demux_video: range=${formatMs(track.firstDts)}..${formatMs(track.lastDts)} gaps_gt_threshold=${track.gaps.length}`);
    for (let i = 0; i < Math.min(track.gaps.length, 8); i++) {
        const gap = track.gaps[i];
        console.log(`demux_video: gap#${i + 1} previous_dts=${formatMs(gap.previousEnd)} next_dts=${formatMs(gap.nextBegin)} gap=${formatMs(gap.gap)}`);
        if (gap.previousSource || gap.nextSource) {
            console.log(`demux_video: gap#${i + 1} source=${JSON.stringify({previous: gap.previousSource, next: gap.nextSource})}`);
        }
    }
}

function recordVideoDrop(stats, packetId, mpuSequenceNumber, units, timestamp, reason) {
    const firstUnit = units && units.length > 0 ? units[0] : null;
    const dropStats = stats.drops.video;
    const dropReason = reason || 'unknown';
    dropStats.total++;
    dropStats.byReason[dropReason] = (dropStats.byReason[dropReason] || 0) + 1;
    dropStats.byMpu[mpuSequenceNumber] = (dropStats.byMpu[mpuSequenceNumber] || 0) + 1;
    const sample = {
        packetId,
        mpuSequenceNumber,
        reason: dropReason,
        dts: timestamp ? timestamp.dts : undefined,
        pts: timestamp ? timestamp.pts : undefined,
        rawDts: timestamp ? timestamp.rawDts : undefined,
        naluType: firstUnit ? firstUnit.type : undefined
    };
    if (dropStats.samples.length < 64) {
        dropStats.samples.push(sample);
    }
    const mpuSamples = dropStats.samplesByMpu[mpuSequenceNumber] || [];
    if (mpuSamples.length < 8) {
        mpuSamples.push(sample);
        dropStats.samplesByMpu[mpuSequenceNumber] = mpuSamples;
    }
    dropStats.recentSamples.push(sample);
    if (dropStats.recentSamples.length > 64) {
        dropStats.recentSamples.shift();
    }
}

function printDropSummary(stats) {
    const drops = stats.drops.video;
    console.log(`video_drops: total=${drops.total} by_reason=${JSON.stringify(drops.byReason)}`);
    const hotMpus = Object.keys(drops.byMpu)
        .map((mpu) => ({mpu: Number(mpu), count: drops.byMpu[mpu]}))
        .sort((a, b) => b.count - a.count || a.mpu - b.mpu)
        .slice(0, 12);
    console.log(`video_drops: hot_mpus=${JSON.stringify(hotMpus)}`);
    console.log(`video_drops: hot_samples=${JSON.stringify(hotMpus.map((item) => ({mpu: item.mpu, samples: drops.samplesByMpu[item.mpu] || []})))}`);
    console.log(`video_drops: sample=${JSON.stringify(drops.samples.slice(0, 12))}`);
    console.log(`video_drops: recent_sample=${JSON.stringify(drops.recentSamples.slice(-12))}`);
}

function createAudioSwitchProbe(label, packetId, atReadSeconds, timelineSeconds, output,
                                requiredForwardSeconds) {
    return {
        label,
        packetId,
        requestedStart: Number.isFinite(timelineSeconds) ? timelineSeconds : atReadSeconds,
        output,
        attempted: false,
        selectAccepted: false,
        selectionResult: null,
        contractId: undefined,
        initContract: null,
        mediaContract: null,
        initData: null,
        mediaData: null,
        mediaParts: [],
        mediaRanges: [],
        requiredForwardSeconds,
    };
}

function createAudioCapture(output) {
    return {
        output,
        initData: null,
        mediaParts: [],
        mediaRanges: [],
    };
}

function captureAudioMedia(capture, segment) {
    const beginDts = segmentBeginDts(segment);
    const endDts = segmentEndDts(segment);
    if (!capture || !segment || !segment.data || segment.data.byteLength === 0 ||
        !Number.isFinite(beginDts) || !Number.isFinite(endDts) || endDts <= beginDts) {
        return false;
    }
    const previousRange = capture.mediaRanges[capture.mediaRanges.length - 1];
    if (previousRange && Math.abs(beginDts - previousRange.endDts) > 100) {
        return false;
    }
    capture.mediaParts.push(Buffer.from(segment.data));
    capture.mediaRanges.push({beginDts, endDts});
    if (!capture.mediaData) {
        capture.mediaData = capture.mediaParts[0];
    }
    return true;
}

function hasRequiredAudioSwitchCoverage(probe) {
    const lastRange = probe && probe.mediaRanges[probe.mediaRanges.length - 1];
    return !!lastRange && lastRange.endDts / 1000 + 0.001 >=
        probe.requestedStart + probe.requiredForwardSeconds;
}

function summarizeMediaCapture(capture) {
    const firstRange = capture.mediaRanges[0];
    const lastRange = capture.mediaRanges[capture.mediaRanges.length - 1];
    return {
        initBytes: capture.initData ? capture.initData.byteLength : 0,
        mediaBytes: capture.mediaParts.reduce((total, part) => total + part.byteLength, 0),
        mediaParts: capture.mediaParts.length,
        mediaStart: firstRange ? firstRange.beginDts / 1000 : undefined,
        mediaEnd: lastRange ? lastRange.endDts / 1000 : undefined,
        output: capture.output,
    };
}

function summarizeAudioSwitchProbe(probe) {
    if (probe == null) {
        return null;
    }
    return {
        packetId: probe.packetId,
        requestedStart: probe.requestedStart,
        attempted: probe.attempted,
        selectAccepted: probe.selectAccepted,
        selectionReason: probe.selectionResult && probe.selectionResult.reason,
        selectionResult: probe.selectionResult,
        contractId: probe.contractId,
        initContract: probe.initContract,
        mediaContract: probe.mediaContract,
        initBytes: probe.initData ? probe.initData.byteLength : 0,
        mediaBytes: probe.mediaParts.reduce((total, part) => total + part.byteLength, 0),
        mediaParts: probe.mediaParts.length,
        mediaStart: probe.mediaRanges.length > 0 ? probe.mediaRanges[0].beginDts / 1000 : undefined,
        mediaEnd: probe.mediaRanges.length > 0 ?
            probe.mediaRanges[probe.mediaRanges.length - 1].endDts / 1000 : undefined,
        requiredForwardSeconds: probe.requiredForwardSeconds,
        output: probe.output,
    };
}

function recordAudioSwitchSelectionResult(probe, result) {
    probe.selectionResult = result || null;
    probe.selectAccepted = !!result && result.accepted === true;
    return probe.selectAccepted;
}

function validateAudioSwitchProbe(probe, previousProbe) {
    const errors = [];
    if (!probe.attempted) {
        errors.push(`${probe.label}: selection was not attempted`);
    }
    if (!probe.selectAccepted) {
        errors.push(`${probe.label}: selection was not accepted`);
    }
    if (!probe.initContract || !probe.initData || probe.initData.byteLength === 0) {
        errors.push(`${probe.label}: initialization segment is missing`);
    }
    if (!probe.mediaContract || !probe.mediaData || probe.mediaData.byteLength === 0) {
        errors.push(`${probe.label}: media segment is missing`);
    }
    const firstRange = probe.mediaRanges[0];
    const lastRange = probe.mediaRanges[probe.mediaRanges.length - 1];
    if (firstRange && firstRange.beginDts / 1000 > probe.requestedStart + 0.025) {
        errors.push(`${probe.label}: media starts after requested switch time`);
    }
    if (lastRange && lastRange.endDts / 1000 + 0.001 <
        probe.requestedStart + probe.requiredForwardSeconds) {
        errors.push(`${probe.label}: media does not cover the required forward window`);
    }
    if (probe.initContract && probe.initContract.packetId !== probe.packetId) {
        errors.push(`${probe.label}: initialization contract packetId mismatch`);
    }
    if (probe.mediaContract && probe.mediaContract.packetId !== probe.packetId) {
        errors.push(`${probe.label}: media contract packetId mismatch`);
    }
    if (probe.initContract && probe.mediaContract && probe.initContract.id !== probe.mediaContract.id) {
        errors.push(`${probe.label}: initialization/media contract id mismatch`);
    }
    if (previousProbe &&
        (!Number.isFinite(probe.contractId) ||
         !Number.isFinite(previousProbe.contractId) ||
         probe.contractId <= previousProbe.contractId)) {
        errors.push(`${probe.label}: contract id did not advance`);
    }
    return errors;
}

function createVideoSwitchProbe(label, packetId, atReadSeconds, output,
                                requiredForwardSeconds) {
    return {
        label,
        packetId,
        atReadSeconds,
        requestedStart: undefined,
        output,
        attempted: false,
        selectAccepted: false,
        selectionResult: null,
        contractId: undefined,
        initContract: null,
        mediaContract: null,
        initCodec: undefined,
        initData: null,
        mediaData: null,
        mediaParts: [],
        mediaRanges: [],
        firstMediaRandomAccessSafe: false,
        firstMediaSource: null,
        requiredForwardSeconds,
    };
}

function createVideoCapture(output) {
    return {
        output,
        initData: null,
        mediaParts: [],
        mediaRanges: [],
    };
}

function captureVideoMedia(capture, segment) {
    const beginDts = segmentBeginDts(segment);
    const endDts = segmentEndDts(segment);
    if (!capture || !segment || !segment.data || segment.data.byteLength === 0 ||
        !Number.isFinite(beginDts) || !Number.isFinite(endDts) || endDts <= beginDts) {
        return false;
    }
    const previousRange = capture.mediaRanges[capture.mediaRanges.length - 1];
    if (previousRange && Math.abs(beginDts - previousRange.endDts) > 100) {
        return false;
    }
    capture.mediaParts.push(Buffer.from(segment.data));
    capture.mediaRanges.push({beginDts, endDts});
    if (!capture.mediaData) {
        capture.mediaData = capture.mediaParts[0];
    }
    return true;
}

function hasRequiredVideoSwitchCoverage(probe) {
    const firstRange = probe && probe.mediaRanges[0];
    const lastRange = probe && probe.mediaRanges[probe.mediaRanges.length - 1];
    return !!firstRange && !!lastRange &&
        lastRange.endDts - firstRange.beginDts + 0.001 >= probe.requiredForwardSeconds * 1000;
}

function summarizeVideoSwitchProbe(probe) {
    if (probe == null) {
        return null;
    }
    return {
        packetId: probe.packetId,
        atReadSeconds: probe.atReadSeconds,
        requestedStart: probe.requestedStart,
        attempted: probe.attempted,
        selectAccepted: probe.selectAccepted,
        selectionReason: probe.selectionResult && probe.selectionResult.reason,
        selectionResult: probe.selectionResult,
        contractId: probe.contractId,
        initContract: probe.initContract,
        mediaContract: probe.mediaContract,
        initCodec: probe.initCodec,
        initBytes: probe.initData ? probe.initData.byteLength : 0,
        mediaBytes: probe.mediaParts.reduce((total, part) => total + part.byteLength, 0),
        mediaParts: probe.mediaParts.length,
        mediaStart: probe.mediaRanges.length > 0 ? probe.mediaRanges[0].beginDts / 1000 : undefined,
        mediaEnd: probe.mediaRanges.length > 0 ?
            probe.mediaRanges[probe.mediaRanges.length - 1].endDts / 1000 : undefined,
        firstMediaRandomAccessSafe: probe.firstMediaRandomAccessSafe,
        firstMediaSource: probe.firstMediaSource,
        requiredForwardSeconds: probe.requiredForwardSeconds,
        output: probe.output,
    };
}

function validateVideoSwitchProbe(probe, previousProbe) {
    const errors = [];
    if (!probe.attempted) {
        errors.push(`${probe.label}: selection was not attempted`);
    }
    if (!probe.selectAccepted) {
        errors.push(`${probe.label}: selection was not accepted`);
    }
    if (!probe.initContract || !probe.initData || probe.initData.byteLength === 0) {
        errors.push(`${probe.label}: initialization segment is missing`);
    }
    if (!probe.mediaContract || !probe.mediaData || probe.mediaData.byteLength === 0) {
        errors.push(`${probe.label}: media segment is missing`);
    }
    if (!probe.firstMediaRandomAccessSafe) {
        errors.push(`${probe.label}: first media segment is not random-access safe`);
    }
    if (!hasRequiredVideoSwitchCoverage(probe)) {
        errors.push(`${probe.label}: media does not cover the required forward window`);
    }
    if (probe.initContract && probe.initContract.packetId !== probe.packetId) {
        errors.push(`${probe.label}: initialization contract packetId mismatch`);
    }
    if (probe.mediaContract && probe.mediaContract.packetId !== probe.packetId) {
        errors.push(`${probe.label}: media contract packetId mismatch`);
    }
    if (probe.firstMediaSource && probe.firstMediaSource.packetId !== probe.packetId) {
        errors.push(`${probe.label}: first media source packetId mismatch`);
    }
    if (probe.initContract && probe.mediaContract &&
        probe.initContract.id !== probe.mediaContract.id) {
        errors.push(`${probe.label}: initialization/media contract id mismatch`);
    }
    if (previousProbe &&
        (!Number.isFinite(probe.contractId) ||
         !Number.isFinite(previousProbe.contractId) ||
         probe.contractId <= previousProbe.contractId)) {
        errors.push(`${probe.label}: contract id did not advance`);
    }
    return errors;
}

function main() {
    setupBrowserGlobals();
    const args = parseArgs(process.argv);
    const fileSize = fs.statSync(args.file).size;
    const Log = getDefaultExport(loadLocalModule(path.join(sourceRoot, 'utils/logger.js')));
    if (!args.verbose) {
        Log.ENABLE_VERBOSE = false;
        Log.ENABLE_DEBUG = false;
        Log.ENABLE_INFO = false;
        Log.ENABLE_WARN = false;
    }
    const MMTSDemuxer = getDefaultExport(loadLocalModule(path.join(sourceRoot, 'demux/mmts-demuxer.ts')));
    const MP4Remuxer = getDefaultExport(loadLocalModule(path.join(sourceRoot, 'remux/mp4-remuxer.js')));
    const TransmuxingController = getDefaultExport(loadLocalModule(path.join(sourceRoot, 'core/transmuxing-controller.js')));
    const playbackOperationModule = loadLocalModule(path.join(sourceRoot, 'core/playback-operation.ts'));
    const configModule = loadLocalModule(path.join(sourceRoot, 'config.js'));

    const firstChunk = readRange(args.file, 0, Math.min(fileSize, args.chunkSize));
    const probeData = MMTSDemuxer.probe(toArrayBuffer(firstChunk)) || {syncOffset: 0, packetCount: 0};
    const config = configModule.createDefaultConfig();
    configModule.applyMediaDataSourceConfig(config, {type: 'mmts', isLive: args.live}, undefined);
    config.mmtsVideoTailStashDuration = 0.5;
    const demuxer = new MMTSDemuxer(probeData, config);
    const remuxer = new MP4Remuxer(config);
    const stats = createStats();
    const firstAudioSwitchProbe = Number.isFinite(args.audioSwitchPacketId) ?
        createAudioSwitchProbe(
            'first',
            args.audioSwitchPacketId,
            args.audioSwitchRebuildFromSeek ? args.seekTargetSeconds : args.audioSwitchAtReadSeconds,
            args.audioSwitchTimelineSeconds,
            args.audioSwitchOutput,
            args.audioSwitchRequiredForwardSeconds
        ) : null;
    const secondAudioSwitchProbe = Number.isFinite(args.audioSwitchSecondPacketId) ?
        createAudioSwitchProbe(
            'second',
            args.audioSwitchSecondPacketId,
            args.audioSwitchSecondAtReadSeconds,
            args.audioSwitchSecondTimelineSeconds,
            args.audioSwitchSecondOutput,
            args.audioSwitchRequiredForwardSeconds
        ) : null;
    const audioSwitchProbes = [firstAudioSwitchProbe, secondAudioSwitchProbe].filter((probe) => probe != null);
    const initialAudioCapture = createAudioCapture(args.initialAudioOutput);
    const firstVideoSwitchProbe = Number.isFinite(args.videoSwitchPacketId) ?
        createVideoSwitchProbe(
            'first',
            args.videoSwitchPacketId,
            args.videoSwitchAtReadSeconds,
            args.videoSwitchOutput,
            args.videoSwitchRequiredForwardSeconds
        ) : null;
    const secondVideoSwitchProbe = Number.isFinite(args.videoSwitchSecondPacketId) ?
        createVideoSwitchProbe(
            'second',
            args.videoSwitchSecondPacketId,
            args.videoSwitchSecondAtReadSeconds,
            args.videoSwitchSecondOutput,
            args.videoSwitchRequiredForwardSeconds
        ) : null;
    const videoSwitchProbes = [firstVideoSwitchProbe, secondVideoSwitchProbe].filter(
        (probe) => probe != null
    );
    const initialVideoCapture = createVideoCapture(args.initialVideoOutput);
    let activeAudioSwitchProbe = null;
    let activeVideoSwitchProbe = null;
    stats.printFirstSegmentsLimit = args.printFirstSegments;
    const startupOperation = playbackOperationModule.createPlaybackOperation({
        scopeId: 'mmts-stream-probe',
        timelineGeneration: 0,
        kind: 'startup',
        transactionId: 0,
        requestedTimeMilliseconds: 0,
        phase: 'loading',
    });
    const startupCollector = Object.create(TransmuxingController.prototype);
    startupCollector._config = config;
    startupCollector._playbackOperation = startupOperation;
    startupCollector._producerPlaybackOperation = startupOperation;
    startupCollector._pendingMMTSVodAudioSwitchIntent = null;
    startupCollector._mmtsStartupGroup = startupCollector._createMMTSStartupGroupState(startupOperation);
    startupCollector._emitter = {
        emit(event, group) {
            if (event !== 'startup_group') {
                return;
            }
            stats.startupGroups.push({
                startupTime: group.startupTime,
                playableStart: group.playableStart,
                playableEnd: group.playableEnd,
                videoDecodeStart: group.videoDecodeStart,
                videoCompositionStart: group.videoCompositionStart,
                audioStart: group.audioStart,
                audioEnd: group.audioEnd,
                videoWindow: group.videoMediaSegment && group.videoMediaSegment.firstPlayableWindow,
                audioInitSwitch: group.audioInitSegment && group.audioInitSegment.mmtsAudioTrackSwitch,
                audioMediaSwitch: group.audioMediaSegment && group.audioMediaSegment.mmtsAudioTrackSwitch,
                hasAudio: group.hasAudio,
                hasVideo: group.hasVideo,
            });
        }
    };

    demuxer.filesize = fileSize;
    if (Number.isFinite(args.seekDurationSeconds)) {
        demuxer.overridedDuration = args.seekDurationSeconds * 1000;
    }
    const originalLogDroppedVideoSample = demuxer.logDroppedVideoSample;
    if (typeof originalLogDroppedVideoSample === 'function') {
        demuxer.logDroppedVideoSample = function(packetId, mpuSequenceNumber, units, timestamp, reason) {
            recordVideoDrop(stats, packetId, mpuSequenceNumber, units, timestamp, reason);
            return originalLogDroppedVideoSample.call(this, packetId, mpuSequenceNumber, units, timestamp, reason);
        };
    }
    const originalRejectVideoMpu = demuxer.rejectVideoMpu;
    if (typeof originalRejectVideoMpu === 'function') {
        demuxer.rejectVideoMpu = function(accessUnits, reason) {
            const first = Array.isArray(accessUnits) && accessUnits.length > 0 ? accessUnits[0] : null;
            const packetId = first ? first.packetId : undefined;
            const mpuSequenceNumber = first ? first.mpuSequenceNumber : undefined;
            const rejected = stats.rejectedVideoMpus;
            rejected.total++;
            rejected.byReason[reason] = (rejected.byReason[reason] || 0) + 1;
            if (packetId !== undefined) {
                rejected.byPacketId[packetId] = (rejected.byPacketId[packetId] || 0) + 1;
            }
            if (rejected.samples.length < 32) {
                rejected.samples.push({
                    packetId,
                    mpuSequenceNumber,
                    accessUnitCount: Array.isArray(accessUnits) ? accessUnits.length : 0,
                    reason,
                });
            }
            return originalRejectVideoMpu.call(this, accessUnits, reason);
        };
    }
    const originalHandleMpuDiscontinuity = demuxer.handleMpuDiscontinuity;
    if (typeof originalHandleMpuDiscontinuity === 'function') {
        demuxer.handleMpuDiscontinuity = function(packetId, asset, mpu, allowRemuxerReset) {
            if (stats.discontinuities.length < 32) {
                stats.discontinuities.push({
                    packetId,
                    mpuSequenceNumber: mpu ? mpu.mpuSequenceNumber : undefined,
                    allowRemuxerReset,
                    firstFragment: mpu && mpu.mfuFragments && mpu.mfuFragments.length > 0 ? {
                        fragmentationIndicator: mpu.mfuFragments[0].fragmentationIndicator,
                        sampleNumber: mpu.mfuFragments[0].sampleNumber,
                        offset: mpu.mfuFragments[0].offset,
                        nalUnitLength: mpu.mfuFragments[0].nalUnitLength
                    } : null
                });
            }
            return originalHandleMpuDiscontinuity.call(this, packetId, asset, mpu, allowRemuxerReset);
        };
    }
    const captureAudioSwitchSegment = (type, segment) => {
        const contract = segment && segment.mmtsAudioTrackSwitch;
        if (!contract) {
            return;
        }
        let probe = audioSwitchProbes.find((candidate) =>
            candidate.attempted && candidate.contractId === contract.id
        );
        if (!probe) {
            probe = audioSwitchProbes.find((candidate) =>
                candidate.attempted && candidate.contractId == null && candidate.packetId === contract.packetId
            );
        }
        if (!probe) {
            return;
        }
        if (probe.contractId == null) {
            probe.contractId = contract.id;
        }
        if (type === 'init') {
            probe.initContract = Object.assign({}, contract);
            probe.initData = Buffer.from(segment.data);
        } else {
            probe.mediaContract = Object.assign({}, contract);
            captureAudioMedia(probe, segment);
        }
    };
    const requestAudioSwitch = (probe, rebuildFromSeek = false, operation = null) => {
        probe.attempted = true;
        const switchIdentity = operation ?
            playbackOperationModule.createPlaybackSwitchIdentity(operation) : undefined;
        const result = demuxer.selectAudioTrack(
            probe.packetId,
            probe.requestedStart * 1000,
            () => remuxer.resetAudioState(),
            rebuildFromSeek,
            switchIdentity
        );
        if (operation) {
            startupCollector._pendingMMTSVodAudioSwitchIntent =
                demuxer.getPendingAudioTrackSwitch();
        }
        const accepted = recordAudioSwitchSelectionResult(probe, result);
        if (accepted) {
            activeAudioSwitchProbe = probe;
        }
        if (accepted && args.live && args.firefoxLiveAudioRebuild && !rebuildFromSeek) {
            if (!demuxer.resetVideoForDecoderBootstrap()) {
                stats.errors.push({
                    offset: -1,
                    message: `${probe.label}: failed to reset live video decoder bootstrap`,
                });
                return false;
            }
            remuxer.resetVideoState();
        }
        return accepted;
    };
    const captureVideoSwitchSegment = (type, segment) => {
        const contract = segment && segment.mmtsVideoTrackSwitch;
        if (!contract) {
            return;
        }
        let probe = videoSwitchProbes.find((candidate) =>
            candidate.attempted && candidate.contractId === contract.id
        );
        if (!probe) {
            probe = videoSwitchProbes.find((candidate) =>
                candidate.attempted && candidate.contractId == null &&
                candidate.packetId === contract.packetId
            );
        }
        if (!probe) {
            return;
        }
        if (probe.contractId == null) {
            probe.contractId = contract.id;
        }
        if (type === 'init') {
            probe.initContract = Object.assign({}, contract);
            probe.initData = Buffer.from(segment.data);
            probe.initCodec = segment.codec;
        } else {
            probe.mediaContract = Object.assign({}, contract);
            probe.firstMediaRandomAccessSafe = segment.mmtsRandomAccessSafe === true;
            probe.firstMediaSource = segment.mmtsSourceInfo || null;
            captureVideoMedia(probe, segment);
        }
    };
    const requestVideoSwitch = (probe, requestedStart, transactionId) => {
        probe.attempted = true;
        probe.requestedStart = requestedStart;
        const operation = playbackOperationModule.createPlaybackOperation({
            scopeId: 'mmts-stream-probe',
            timelineGeneration: transactionId,
            kind: 'video-switch',
            transactionId,
            requestedTimeMilliseconds: requestedStart * 1000,
            packetId: probe.packetId,
            phase: 'requested',
        });
        const switchIdentity = playbackOperationModule.createPlaybackSwitchIdentity(operation);
        const result = demuxer.selectVideoTrack(probe.packetId, switchIdentity);
        probe.selectionResult = result || null;
        probe.selectAccepted = !!result && result.accepted === true;
        if (probe.selectAccepted) {
            activeVideoSwitchProbe = probe;
        }
        return probe.selectAccepted;
    };
    remuxer.onInitSegment = (type, segment) => {
        if (stats.init[type] !== undefined) {
            stats.init[type]++;
        }
        if (stats.initOrder.length < 16) {
            stats.initOrder.push({
                type,
                codec: segment ? segment.codec : undefined,
                bytes: segment && segment.data ? segment.data.byteLength : 0
            });
        }
        startupCollector._collectMMTSStartupInitSegment(type, segment);
        if (type === 'audio' && (!firstAudioSwitchProbe || !firstAudioSwitchProbe.attempted) &&
            segment && segment.data && segment.data.byteLength > 0) {
            initialAudioCapture.initData = Buffer.from(segment.data);
        }
        if (type === 'audio' && segment && segment.mmtsAudioTrackSwitch) {
            stats.audioSwitchInitSegments.push(segment.mmtsAudioTrackSwitch);
            captureAudioSwitchSegment('init', segment);
        }
        if (type === 'video' && (!firstVideoSwitchProbe || !firstVideoSwitchProbe.attempted) &&
            segment && segment.data && segment.data.byteLength > 0) {
            initialVideoCapture.initData = Buffer.from(segment.data);
        }
        if (type === 'video' && segment && segment.mmtsVideoTrackSwitch) {
            stats.videoSwitchInitSegments.push(segment.mmtsVideoTrackSwitch);
            captureVideoSwitchSegment('init', segment);
        }
    };
    remuxer.onMediaSegment = (type, segment) => {
        if (stats.media[type]) {
            recordSegment(stats, type, segment, args.gapThresholdMs);
        }
        startupCollector._collectMMTSStartupMediaSegment(type, segment);
        if (type === 'audio' && (!firstAudioSwitchProbe || !firstAudioSwitchProbe.attempted)) {
            captureAudioMedia(initialAudioCapture, segment);
        }
        if (type === 'audio' && segment && segment.mmtsAudioTrackSwitch) {
            stats.audioSwitchMediaSegments.push({
                contract: segment.mmtsAudioTrackSwitch,
                beginDts: segmentBeginDts(segment),
                endDts: segmentEndDts(segment),
                bytes: segment.data ? segment.data.byteLength : 0,
                samples: segment.sampleCount || 0,
            });
            captureAudioSwitchSegment('media', segment);
        } else if (type === 'audio' && activeAudioSwitchProbe &&
            activeAudioSwitchProbe.contractId != null &&
            !hasRequiredAudioSwitchCoverage(activeAudioSwitchProbe)) {
            captureAudioMedia(activeAudioSwitchProbe, segment);
        }
        if (type === 'video' && (!firstVideoSwitchProbe || !firstVideoSwitchProbe.attempted)) {
            captureVideoMedia(initialVideoCapture, segment);
        }
        if (type === 'video' && segment && segment.mmtsVideoTrackSwitch) {
            stats.videoSwitchMediaSegments.push({
                contract: segment.mmtsVideoTrackSwitch,
                beginDts: segmentBeginDts(segment),
                endDts: segmentEndDts(segment),
                bytes: segment.data ? segment.data.byteLength : 0,
                samples: segment.sampleCount || 0,
                randomAccessSafe: segment.mmtsRandomAccessSafe === true,
                source: segment.mmtsSourceInfo || null,
            });
            captureVideoSwitchSegment('media', segment);
        } else if (type === 'video' && activeVideoSwitchProbe &&
            activeVideoSwitchProbe.contractId != null &&
            !hasRequiredVideoSwitchCoverage(activeVideoSwitchProbe)) {
            captureVideoMedia(activeVideoSwitchProbe, segment);
        }
    };
    remuxer.bindDataSource(demuxer);
    const remuxDataAvailable = demuxer.onDataAvailable;
    demuxer.onDataAvailable = (audioTrack, videoTrack, force) => {
        recordDemuxVideoTrack(stats, videoTrack, args.gapThresholdMs);
        remuxDataAvailable(audioTrack, videoTrack, force);
    };
    demuxer.onMediaInfo = (mediaInfo) => {
        stats.mediaInfo = mediaInfo;
        startupCollector._mediaInfo = mediaInfo;
        startupCollector._setMMTSStartupGroupMediaInfo(mediaInfo);
    };
    demuxer.onMMTSAudioTracks = (tracks) => {
        stats.audioTracks = tracks;
    };
    demuxer.onMMTSVideoTracks = (tracks) => {
        stats.videoTracks = tracks;
    };

    let offset = 0;
    let audioSwitchRequested = false;
    let secondAudioSwitchRequested = false;
    let videoSwitchRequested = false;
    let secondVideoSwitchRequested = false;
    let seekApplied = false;
    let seekStartOffset = undefined;
    let seekReadBytes = 0;
    let rebuildStartupGroupStartIndex = 0;
    let rebuildAudioInitStartIndex = 0;
    let rebuildAudioMediaStartIndex = 0;
    const fd = fs.openSync(args.file, 'r');
    try {
        while (offset < fileSize && offset < args.bytes) {
            const remaining = Math.min(args.chunkSize, fileSize - offset, args.bytes - offset);
            const buffer = Buffer.allocUnsafe(remaining);
            const read = fs.readSync(fd, buffer, 0, remaining, offset);
            if (read <= 0) {
                break;
            }

            try {
                demuxer.parseChunks(toArrayBuffer(buffer.subarray(0, read)), offset);
            } catch (error) {
                stats.errors.push({offset, message: error && error.stack ? error.stack : String(error)});
                break;
            }

            offset += read;
            if (seekApplied) {
                seekReadBytes += read;
            }
            const videoEnd = stats.media.video.lastDts;
            const audioEnd = stats.media.audio.lastDts;
            const maxEnd = Math.max(videoEnd || 0, audioEnd || 0);
            if (!seekApplied &&
                Number.isFinite(args.seekTargetSeconds) &&
                maxEnd >= args.seekAfterSeconds * 1000) {
                const targetMilliseconds = args.seekTargetSeconds * 1000;
                const durationMilliseconds = args.seekDurationSeconds * 1000;
                const estimatedPosition = Math.floor(targetMilliseconds * fileSize / durationMilliseconds);
                seekStartOffset = Math.max(0, estimatedPosition - args.seekLookbackBytes);
                let switchOperation = null;
                if (args.audioSwitchRebuildFromSeek) {
                    rebuildStartupGroupStartIndex = stats.startupGroups.length;
                    rebuildAudioInitStartIndex = stats.audioSwitchInitSegments.length;
                    rebuildAudioMediaStartIndex = stats.audioSwitchMediaSegments.length;
                    switchOperation = playbackOperationModule.createPlaybackOperation({
                        scopeId: 'mmts-stream-probe',
                        timelineGeneration: 1,
                        kind: 'audio-switch',
                        transactionId: 1,
                        requestedTimeMilliseconds: firstAudioSwitchProbe.requestedStart * 1000,
                        packetId: firstAudioSwitchProbe.packetId,
                        phase: 'requested',
                    });
                    startupCollector._playbackOperation = switchOperation;
                    startupCollector._producerPlaybackOperation = switchOperation;
                    startupCollector._pendingMMTSVodAudioSwitchIntent = null;
                    startupCollector._mmtsStartupGroup =
                        startupCollector._createMMTSStartupGroupState(switchOperation);
                }
                demuxer.seek(targetMilliseconds);
                remuxer.seek(targetMilliseconds);
                remuxer.insertDiscontinuity();
                if (args.audioSwitchRebuildFromSeek) {
                    audioSwitchRequested = requestAudioSwitch(
                        firstAudioSwitchProbe,
                        true,
                        switchOperation
                    );
                }
                resetTimelineStats(stats);
                stats.printFirstSegmentsLimit = args.printFirstSegments;
                offset = seekStartOffset;
                seekApplied = true;
                continue;
            }
            if (!audioSwitchRequested &&
                Number.isFinite(args.audioSwitchPacketId) &&
                Number.isFinite(args.audioSwitchAtReadSeconds) &&
                maxEnd >= args.audioSwitchAtReadSeconds * 1000) {
                const timelineSeconds = Number.isFinite(args.audioSwitchTimelineSeconds) ?
                    args.audioSwitchTimelineSeconds : args.audioSwitchAtReadSeconds;
                firstAudioSwitchProbe.requestedStart = timelineSeconds;
                audioSwitchRequested = requestAudioSwitch(firstAudioSwitchProbe);
            }
            if (!secondAudioSwitchRequested &&
                secondAudioSwitchProbe &&
                firstAudioSwitchProbe.selectAccepted &&
                firstAudioSwitchProbe.initData &&
                firstAudioSwitchProbe.mediaData &&
                maxEnd >= args.audioSwitchSecondAtReadSeconds * 1000) {
                secondAudioSwitchRequested = requestAudioSwitch(secondAudioSwitchProbe);
            }
            if (!videoSwitchRequested && firstVideoSwitchProbe &&
                maxEnd >= firstVideoSwitchProbe.atReadSeconds * 1000) {
                videoSwitchRequested = requestVideoSwitch(
                    firstVideoSwitchProbe,
                    maxEnd / 1000,
                    1
                );
            }
            if (!secondVideoSwitchRequested && secondVideoSwitchProbe &&
                firstVideoSwitchProbe.selectAccepted &&
                firstVideoSwitchProbe.initData &&
                firstVideoSwitchProbe.mediaData &&
                hasRequiredVideoSwitchCoverage(firstVideoSwitchProbe) &&
                maxEnd >= secondVideoSwitchProbe.atReadSeconds * 1000) {
                secondVideoSwitchRequested = requestVideoSwitch(
                    secondVideoSwitchProbe,
                    maxEnd / 1000,
                    2
                );
            }
            if (Number.isFinite(args.seconds) && maxEnd >= args.seconds * 1000) {
                break;
            }
            if (seekApplied && seekReadBytes >= args.seekMaxReadBytes) {
                break;
            }
        }
    } finally {
        fs.closeSync(fd);
    }

    try {
        remuxer.remux(demuxer.audio_track_, demuxer.video_track_, true);
    } catch (error) {
        stats.errors.push({offset, message: error && error.stack ? error.stack : String(error)});
    }

    if (initialAudioCapture.output && initialAudioCapture.initData &&
        initialAudioCapture.mediaParts.length > 0) {
        fs.writeFileSync(
            initialAudioCapture.output,
            Buffer.concat([initialAudioCapture.initData].concat(initialAudioCapture.mediaParts))
        );
    }
    for (const probe of audioSwitchProbes) {
        if (probe.output && probe.initData && probe.mediaParts.length > 0) {
            fs.writeFileSync(
                probe.output,
                Buffer.concat([probe.initData].concat(probe.mediaParts))
            );
        }
    }
    if (initialVideoCapture.output && initialVideoCapture.initData &&
        initialVideoCapture.mediaParts.length > 0) {
        fs.writeFileSync(
            initialVideoCapture.output,
            Buffer.concat([initialVideoCapture.initData].concat(initialVideoCapture.mediaParts))
        );
    }
    for (const probe of videoSwitchProbes) {
        if (probe.output && probe.initData && probe.mediaParts.length > 0) {
            fs.writeFileSync(
                probe.output,
                Buffer.concat([probe.initData].concat(probe.mediaParts))
            );
        }
    }

    const audioSwitchProbeErrors = [];
    if (firstAudioSwitchProbe) {
        audioSwitchProbeErrors.push(...validateAudioSwitchProbe(firstAudioSwitchProbe, null));
    }
    if (secondAudioSwitchProbe) {
        audioSwitchProbeErrors.push(...validateAudioSwitchProbe(secondAudioSwitchProbe, firstAudioSwitchProbe));
    }
    const videoSwitchProbeErrors = [];
    if (firstVideoSwitchProbe) {
        videoSwitchProbeErrors.push(...validateVideoSwitchProbe(firstVideoSwitchProbe, null));
    }
    if (secondVideoSwitchProbe) {
        videoSwitchProbeErrors.push(...validateVideoSwitchProbe(
            secondVideoSwitchProbe,
            firstVideoSwitchProbe
        ));
    }

    console.log(`file=${args.file}`);
    console.log(`read_bytes=${offset} file_size=${fileSize}`);
    if (seekApplied) {
        console.log(`seek_probe: target=${args.seekTargetSeconds}s start_offset=${seekStartOffset} read_bytes=${seekReadBytes}`);
    }
    console.log(`init: audio=${stats.init.audio} video=${stats.init.video}`);
    console.log(`init_order=${JSON.stringify(stats.initOrder)}`);
    if (stats.mediaInfo) {
        console.log(`media_info: duration=${stats.mediaInfo.duration} hasAudio=${stats.mediaInfo.hasAudio} hasVideo=${stats.mediaInfo.hasVideo}`);
    }
    if (stats.videoTracks) {
        console.log(`video_tracks=${JSON.stringify(stats.videoTracks)}`);
    }
    if (stats.audioTracks) {
        console.log(`audio_tracks=${JSON.stringify(stats.audioTracks)}`);
    }
    console.log(`startup_groups=${JSON.stringify(stats.startupGroups)}`);
    console.log(`audio_switch_init=${JSON.stringify(stats.audioSwitchInitSegments)}`);
    console.log(`audio_switch_media=${JSON.stringify(stats.audioSwitchMediaSegments)}`);
    console.log(`video_switch_init=${JSON.stringify(stats.videoSwitchInitSegments)}`);
    console.log(`video_switch_media=${JSON.stringify(stats.videoSwitchMediaSegments)}`);
    if (initialAudioCapture.output) {
        console.log(`initial_audio_capture=${JSON.stringify(summarizeMediaCapture(initialAudioCapture))}`);
    }
    if (firstAudioSwitchProbe) {
        console.log(`audio_switch_probe_first=${JSON.stringify(summarizeAudioSwitchProbe(firstAudioSwitchProbe))}`);
    }
    if (secondAudioSwitchProbe) {
        console.log(`audio_switch_probe_second=${JSON.stringify(summarizeAudioSwitchProbe(secondAudioSwitchProbe))}`);
    }
    if (firstAudioSwitchProbe) {
        console.log(`audio_switch_probe_errors=${JSON.stringify(audioSwitchProbeErrors)}`);
    }
    if (initialVideoCapture.output) {
        console.log(`initial_video_capture=${JSON.stringify(summarizeMediaCapture(initialVideoCapture))}`);
    }
    if (firstVideoSwitchProbe) {
        console.log(`video_switch_probe_first=${JSON.stringify(summarizeVideoSwitchProbe(firstVideoSwitchProbe))}`);
    }
    if (secondVideoSwitchProbe) {
        console.log(`video_switch_probe_second=${JSON.stringify(summarizeVideoSwitchProbe(secondVideoSwitchProbe))}`);
    }
    if (firstVideoSwitchProbe) {
        console.log(`video_switch_probe_errors=${JSON.stringify(videoSwitchProbeErrors)}`);
    }
    if (args.audioSwitchRebuildFromSeek) {
        console.log(`audio_switch_rebuild=${JSON.stringify({
            rebuildFromSeek: true,
            selectAccepted: audioSwitchRequested,
            selectionReason: firstAudioSwitchProbe.selectionResult &&
                firstAudioSwitchProbe.selectionResult.reason,
            selectionResult: firstAudioSwitchProbe.selectionResult,
            packetId: args.audioSwitchPacketId,
            requestedStart: Number.isFinite(args.audioSwitchTimelineSeconds) ?
                args.audioSwitchTimelineSeconds : args.seekTargetSeconds,
            startupGroups: stats.startupGroups.slice(rebuildStartupGroupStartIndex),
            audioInitContracts: stats.audioSwitchInitSegments.slice(rebuildAudioInitStartIndex),
            audioMediaContracts: stats.audioSwitchMediaSegments.slice(rebuildAudioMediaStartIndex),
        })}`);
    }
    printTrackSummary('video', stats.media.video);
    console.log(`video_random_access_safe=${JSON.stringify(stats.media.video.randomAccessSafeSegments)}`);
    printTrackSummary('audio', stats.media.audio);
    printDemuxVideoSummary(stats.demux.video);
    if (args.printFirstSegments > 0) {
        console.log(`first_demux_video_samples=${JSON.stringify(stats.firstDemuxVideoSamples)}`);
        console.log(`first_segments=${JSON.stringify(stats.firstSegments)}`);
    }
    printDropSummary(stats);
    console.log(`rejected_video_mpus=${JSON.stringify(stats.rejectedVideoMpus)}`);
    console.log(`discontinuities=${JSON.stringify(stats.discontinuities)}`);
    console.log(`errors=${stats.errors.length}`);
    for (const error of stats.errors) {
        console.log(`error offset=${error.offset}: ${error.message}`);
    }

    const hasOutput = stats.media.video.segments > 0 && stats.media.audio.segments > 0;
    const hasErrors = stats.errors.length > 0;
    process.exitCode = hasOutput && !hasErrors && audioSwitchProbeErrors.length === 0 &&
        videoSwitchProbeErrors.length === 0 ? 0 : 1;
}

if (require.main === module) {
    main();
}

module.exports = {recordAudioSwitchSelectionResult};

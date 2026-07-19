#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

function parseArgs(argv) {
    const args = {
        file: '',
        gapCheck: process.env.MMTS_GAP_CHECK_SCRIPT || '',
        startSec: 24,
        endSec: 56,
        stopAfterSec: 64,
        output: '',
        verbose: false
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--gap-check') {
            args.gapCheck = argv[++i];
        } else if (arg === '--start-sec') {
            args.startSec = Number(argv[++i]);
        } else if (arg === '--end-sec') {
            args.endSec = Number(argv[++i]);
        } else if (arg === '--stop-after-sec') {
            args.stopAfterSec = Number(argv[++i]);
        } else if (arg === '--output') {
            args.output = argv[++i];
        } else if (arg === '--verbose') {
            args.verbose = true;
        } else if (!args.file) {
            args.file = arg;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }

    if (!args.file || !args.gapCheck) {
        throw new Error('usage: node scripts/compare_mmts_gap_check.js <mmts-file> --gap-check <script> [--output result.json]');
    }
    if (!Number.isFinite(args.startSec) ||
        !Number.isFinite(args.endSec) ||
        !Number.isFinite(args.stopAfterSec)) {
        throw new Error('time range arguments must be finite numbers');
    }

    args.file = path.resolve(args.file);
    args.gapCheck = path.resolve(args.gapCheck);
    if (args.output) {
        args.output = path.resolve(args.output);
    }
    return args;
}

function runNodeScript(script, args) {
    const result = spawnSync(process.execPath, [script].concat(args), {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? result.error.message : ''
    };
}

function parseIntegerLine(output, name) {
    const match = output.match(new RegExp(`${name}=([0-9]+)`));
    return match ? Number(match[1]) : null;
}

function parseGapCheck(output) {
    const audioTracks = [];
    const audioPattern = /(0x[0-9a-f]+) audio samples=([0-9]+).*?gap_count_gt80ms=([0-9]+).*?max_gap=([^\n]+)/gi;
    let match;
    while ((match = audioPattern.exec(output)) !== null) {
        audioTracks.push({
            packetId: match[1],
            samples: Number(match[2]),
            gaps: Number(match[3]),
            maxGap: match[4].trim()
        });
    }

    const videoTimestampGroups = [];
    const videoPattern = /(0x[0-9a-f]+) video timestamp_groups=([0-9]+)/gi;
    while ((match = videoPattern.exec(output)) !== null) {
        videoTimestampGroups.push({
            packetId: match[1],
            timestampGroups: Number(match[2])
        });
    }

    return {
        sequenceGapsNearRange: parseIntegerLine(output, 'sequence_gaps_near_range'),
        audioTracks,
        videoTimestampGroups
    };
}

function parseProbeTrack(output, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}: range=([^\\n]*?) gaps_gt_threshold=([0-9]+)`);
    const match = output.match(pattern);
    return match ? {
        range: match[1].trim(),
        gaps: Number(match[2])
    } : null;
}

function parseProbe(output) {
    return {
        video: parseProbeTrack(output, 'video'),
        audio: parseProbeTrack(output, 'audio'),
        demuxVideo: parseProbeTrack(output, 'demux_video')
    };
}

function buildComparison(gapCheck, probe) {
    const expectedAudioGaps = gapCheck.audioTracks.reduce((sum, track) => sum + track.gaps, 0);
    const expectedPacketGaps = gapCheck.sequenceGapsNearRange;
    const issues = [];

    if (expectedPacketGaps === null) {
        issues.push('gap-check sequence gap count was not found');
    }
    if (probe.video === null) {
        issues.push('probe video track summary was not found');
    }
    if (probe.audio === null) {
        issues.push('probe audio track summary was not found');
    }

    if (expectedPacketGaps !== null && probe.video !== null && expectedPacketGaps === 0 && probe.video.gaps !== 0) {
        issues.push(`probe video media gaps ${probe.video.gaps} differ from zero source packet gaps`);
    }
    if (probe.audio !== null && probe.audio.gaps !== expectedAudioGaps) {
        issues.push(`probe audio media gaps ${probe.audio.gaps} differ from gap-check audio gaps ${expectedAudioGaps}`);
    }

    return {
        ok: issues.length === 0,
        issues,
        expected: {
            sequenceGapsNearRange: expectedPacketGaps,
            audioGaps: expectedAudioGaps
        },
        actual: {
            videoMediaGaps: probe.video ? probe.video.gaps : null,
            audioMediaGaps: probe.audio ? probe.audio.gaps : null,
            demuxVideoOutputGaps: probe.demuxVideo ? probe.demuxVideo.gaps : null
        }
    };
}

function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(args.file)) {
        throw new Error(`input file does not exist: ${args.file}`);
    }
    if (!fs.existsSync(args.gapCheck)) {
        throw new Error(`gap-check script does not exist: ${args.gapCheck}`);
    }

    const gapArgs = [
        args.file,
        String(args.startSec),
        String(args.endSec),
        String(args.stopAfterSec)
    ];
    if (args.verbose) {
        gapArgs.push('--verbose');
    }
    const gapRun = runNodeScript(args.gapCheck, gapArgs);

    const probeScript = path.resolve(__dirname, 'probe_mmts_demux_remux_stream.js');
    const probeRun = runNodeScript(probeScript, [
        args.file,
        '--seconds',
        String(args.stopAfterSec)
    ]);

    const summary = {
        file: args.file,
        range: {
            startSec: args.startSec,
            endSec: args.endSec,
            stopAfterSec: args.stopAfterSec
        },
        gapCheck: parseGapCheck(gapRun.stdout),
        probe: parseProbe(probeRun.stdout),
        commands: {
            gapCheckStatus: gapRun.status,
            probeStatus: probeRun.status
        }
    };
    summary.comparison = buildComparison(summary.gapCheck, summary.probe);
    if (gapRun.status !== 0) {
        summary.comparison.ok = false;
        summary.comparison.issues.push(`gap-check exited with status ${gapRun.status}`);
    }
    if (probeRun.status !== 0) {
        summary.comparison.ok = false;
        summary.comparison.issues.push(`probe exited with status ${probeRun.status}`);
    }
    if (gapRun.error) {
        summary.comparison.ok = false;
        summary.comparison.issues.push(gapRun.error);
    }
    if (probeRun.error) {
        summary.comparison.ok = false;
        summary.comparison.issues.push(probeRun.error);
    }

    const json = JSON.stringify(summary, null, 2);
    if (args.output) {
        fs.writeFileSync(args.output, `${json}\n`);
    }
    console.log(json);
    process.exitCode = summary.comparison.ok ? 0 : 1;
}

main();

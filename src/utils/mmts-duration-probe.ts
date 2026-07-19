/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import TLV from '../demux/tlv';
import CompressedIP from '../demux/compressed-ip';
import MMTP, {MMTPPayloadType} from '../demux/mmtp';
import MMTSProgram, {MMTSMpuPresentationWindow} from '../demux/mmts-program';
import {MMTAsset} from '../demux/mmt-si';

export interface MMTSDurationProbeOptions {
    filesize?: number;
    withCredentials?: boolean;
    timeout?: number;
    videoPacketId?: number;
    initialStartProbeBytes?: number;
    initialTailProbeBytes?: number;
    maxStartProbeBytes?: number;
    maxTailProbeBytes?: number;
}

export interface MMTSDurationProbeResult {
    duration: number;
    filesize: number;
    startTime: number;
    endTime: number;
    startOffset: number;
    endOffset: number;
    startPacketId: number;
    endPacketId: number;
}

interface MMTSTimestampPoint {
    time: number;
    filePosition: number;
    packetId: number;
}

interface RangeResponse {
    data: ArrayBuffer;
    contentLength: number;
    totalLength: number;
}

interface ParsedContentRange {
    from: number;
    to: number;
    total: number;
}

const DEFAULT_INITIAL_START_PROBE_BYTES = 4 * 1024 * 1024;
const DEFAULT_INITIAL_TAIL_PROBE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_START_PROBE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TAIL_PROBE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT = 10000;

export default function probeMMTSDuration(url: string,
                                          options: MMTSDurationProbeOptions = {}): Promise<MMTSDurationProbeResult> {
    if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('MMTS duration probe requires a URL'));
    }

    return resolveFileSize(url, options).then((filesize) => {
        return probeMMTSTimestampBoundary(url, filesize, 'start', options).then((start) => {
            const tailOptions = options.videoPacketId === undefined ?
                Object.assign({}, options, {videoPacketId: start.packetId}) :
                options;
            return probeMMTSTimestampBoundary(url, filesize, 'tail', tailOptions).then((end) => {
                const duration = Math.round(end.time - start.time);

                if (!isFinite(duration) || duration <= 0) {
                    throw new Error('MMTS duration probe found non-positive duration');
                }

                return {
                    duration,
                    filesize,
                    startTime: start.time,
                    endTime: end.time,
                    startOffset: start.filePosition,
                    endOffset: end.filePosition,
                    startPacketId: start.packetId,
                    endPacketId: end.packetId
                };
            });
        });
    });
}

function resolveFileSize(url: string, options: MMTSDurationProbeOptions): Promise<number> {
    if (isPositiveFiniteNumber(options.filesize)) {
        return Promise.resolve(options.filesize);
    }

    return loadHead(url, options).then((length) => {
        if (isPositiveFiniteNumber(length)) {
            return length;
        }
        return loadRange(url, 0, 0, options).then((response) => {
            if (isPositiveFiniteNumber(response.totalLength)) {
                return response.totalLength;
            }
            throw new Error('MMTS duration probe could not resolve filesize');
        });
    }, () => {
        return loadRange(url, 0, 0, options).then((response) => {
            if (isPositiveFiniteNumber(response.totalLength)) {
                return response.totalLength;
            }
            throw new Error('MMTS duration probe could not resolve filesize');
        });
    });
}

function probeMMTSTimestampBoundary(url: string,
                                    filesize: number,
                                    boundary: 'start' | 'tail',
                                    options: MMTSDurationProbeOptions): Promise<MMTSTimestampPoint> {
    const initial = boundary === 'start' ?
        getProbeByteCount(options.initialStartProbeBytes, DEFAULT_INITIAL_START_PROBE_BYTES, filesize) :
        getProbeByteCount(options.initialTailProbeBytes, DEFAULT_INITIAL_TAIL_PROBE_BYTES, filesize);
    const max = boundary === 'start' ?
        getProbeByteCount(options.maxStartProbeBytes, DEFAULT_MAX_START_PROBE_BYTES, filesize) :
        getProbeByteCount(options.maxTailProbeBytes, DEFAULT_MAX_TAIL_PROBE_BYTES, filesize);

    return probeMMTSTimestampBoundaryWithSize(url, filesize, boundary, initial, max, options);
}

function probeMMTSTimestampBoundaryWithSize(url: string,
                                            filesize: number,
                                            boundary: 'start' | 'tail',
                                            probeBytes: number,
                                            maxProbeBytes: number,
                                            options: MMTSDurationProbeOptions): Promise<MMTSTimestampPoint> {
    const from = boundary === 'start' ? 0 : Math.max(0, filesize - probeBytes);
    const to = boundary === 'start' ? Math.min(filesize - 1, probeBytes - 1) : filesize - 1;

    return loadRange(url, from, to, options).then((response) => {
        const points = parseMMTSTimestampPoints(response.data, from, options);
        const point = boundary === 'start' ? points[0] : points[points.length - 1];
        if (point !== undefined) {
            return point;
        }

        if (probeBytes >= maxProbeBytes || probeBytes >= filesize) {
            throw new Error(`MMTS duration probe could not find ${boundary} timestamp`);
        }

        const nextProbeBytes = Math.min(probeBytes * 4, maxProbeBytes, filesize);
        return probeMMTSTimestampBoundaryWithSize(url, filesize, boundary, nextProbeBytes, maxProbeBytes, options);
    });
}

function parseMMTSTimestampPoints(buffer: ArrayBuffer,
                                  byteStart: number,
                                  options: MMTSDurationProbeOptions): MMTSTimestampPoint[] {
    const result = TLV.parse(buffer);
    const program = new MMTSProgram();
    const points: MMTSTimestampPoint[] = [];
    const seenMpus: {[key: string]: boolean} = {};

    try {
        for (const packet of result.packets) {
            if (packet.packetType !== 0x03) {
                continue;
            }

            const compressedIP = CompressedIP.parse(packet.payload);
            if (compressedIP === null) {
                continue;
            }

            const mmtp = MMTP.parse(packet.payload.subarray(compressedIP.payloadOffset));
            if (mmtp === null) {
                continue;
            }

            if (mmtp.payloadType === MMTPPayloadType.ControlMessage) {
                program.parseSignalingPacket(mmtp, byteStart + packet.startOffset);
                continue;
            }

            if (mmtp.payloadType !== MMTPPayloadType.Mpu) {
                continue;
            }

            const filePosition = byteStart + packet.startOffset;
            const parsed = program.parseMpuPacket(mmtp, filePosition);
            if (parsed === null ||
                !isTargetVideoAsset(parsed.asset, mmtp.packetId, options.videoPacketId)) {
                continue;
            }

            const mpuSequenceNumber = parsed.mpu.mpuSequenceNumber;
            const key = `${mmtp.packetId}:${mpuSequenceNumber}`;
            if (!seenMpus[key]) {
                const window = program.getMpuPresentationWindow(
                    mmtp.packetId,
                    mpuSequenceNumber
                );
                if (pushPresentationWindowTimestampPoints(
                    points,
                    window,
                    filePosition,
                    mmtp.packetId
                )) {
                    seenMpus[key] = true;
                }
            }
        }
    } finally {
        program.destroy();
    }

    return points;
}

function isTargetVideoAsset(asset: MMTAsset | undefined,
                            packetId: number,
                            videoPacketId: number | undefined): boolean {
    if (videoPacketId !== undefined) {
        return packetId === videoPacketId && (asset === undefined || asset.mediaType === 'video');
    }
    return asset !== undefined && asset.mediaType === 'video';
}

function pushPresentationWindowTimestampPoints(points: MMTSTimestampPoint[],
                                               window: MMTSMpuPresentationWindow | null,
                                               filePosition: number,
                                               packetId: number): boolean {
    if (window === null || !isPositiveFiniteNumber(window.timescale)) {
        return false;
    }

    const startTime = window.rawPtsStart * 1000 / window.timescale;
    const endTime = window.rawPtsEnd * 1000 / window.timescale;
    if (!isFinite(startTime) || !isFinite(endTime) || endTime <= startTime) {
        return false;
    }

    points.push({
        time: startTime,
        filePosition,
        packetId
    }, {
        time: endTime,
        filePosition,
        packetId
    });
    return true;
}

function getProbeByteCount(value: number | undefined, fallback: number, filesize: number): number {
    const bytes = isPositiveFiniteNumber(value) ? value : fallback;
    return Math.max(1, Math.min(Math.floor(bytes), filesize));
}

function loadHead(url: string, options: MMTSDurationProbeOptions): Promise<number> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, true);
        xhr.timeout = getTimeout(options);
        xhr.withCredentials = options.withCredentials === true;
        xhr.onload = function() {
            if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0) {
                resolve(readContentLength(xhr));
            } else {
                reject(new Error(`HEAD failed with status ${xhr.status}`));
            }
        };
        xhr.onerror = function() {
            reject(new Error('HEAD failed'));
        };
        xhr.ontimeout = function() {
            reject(new Error('HEAD timed out'));
        };
        xhr.send();
    });
}

function loadRange(url: string,
                   from: number,
                   to: number,
                   options: MMTSDurationProbeOptions): Promise<RangeResponse> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let settled = false;
        const fail = (message: string, abort: boolean = false) => {
            if (settled) {
                return;
            }
            settled = true;
            if (abort) {
                xhr.onreadystatechange = null;
                xhr.abort();
            }
            reject(new Error(message));
        };
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = getTimeout(options);
        xhr.withCredentials = options.withCredentials === true;
        xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 2 || settled) {
                return;
            }
            const range = readContentRange(xhr);
            if (xhr.status !== 206 || !isRequestedContentRange(range, from, to)) {
                fail(`Range request was not honored for bytes=${from}-${to}`, true);
            }
        };
        xhr.onload = function() {
            if (settled) {
                return;
            }
            const range = readContentRange(xhr);
            const expectedLength = range !== null ? range.to - range.from + 1 : 0;
            if (xhr.status !== 206 ||
                !xhr.response ||
                !isRequestedContentRange(range, from, to) ||
                xhr.response.byteLength !== expectedLength) {
                fail(`Range request returned an invalid response for bytes=${from}-${to}`);
                return;
            }
            settled = true;
            resolve({
                data: xhr.response,
                contentLength: readContentLength(xhr),
                totalLength: range.total
            });
        };
        xhr.onerror = function() {
            fail('Range request failed');
        };
        xhr.ontimeout = function() {
            fail('Range request timed out');
        };
        xhr.send();
    });
}

function readContentLength(xhr: XMLHttpRequest): number {
    const length = parseInt(xhr.getResponseHeader('Content-Length') || '', 10);
    return isPositiveFiniteNumber(length) ? length : 0;
}

function readContentRange(xhr: XMLHttpRequest): ParsedContentRange | null {
    const value = xhr.getResponseHeader('Content-Range');
    const match = value ? /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim()) : null;
    if (match === null) {
        return null;
    }

    const from = parseInt(match[1], 10);
    const to = parseInt(match[2], 10);
    const total = parseInt(match[3], 10);
    if (!Number.isFinite(from) ||
        !Number.isFinite(to) ||
        !isPositiveFiniteNumber(total) ||
        from < 0 ||
        to < from ||
        to >= total) {
        return null;
    }
    return {from, to, total};
}

function isRequestedContentRange(range: ParsedContentRange | null,
                                 from: number,
                                 to: number): range is ParsedContentRange {
    return range !== null && range.from === from && range.to === to;
}

function getTimeout(options: MMTSDurationProbeOptions): number {
    return isPositiveFiniteNumber(options.timeout) ? options.timeout : DEFAULT_TIMEOUT;
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
    return typeof value === 'number' && isFinite(value) && value > 0;
}

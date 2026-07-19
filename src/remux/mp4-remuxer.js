/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import MP4 from './mp4-generator.js';
import AAC from './aac-silent.js';
import Browser from '../utils/browser.js';
import { SampleInfo, MediaSegmentInfo, MediaSegmentInfoList } from '../core/media-segment-info.js';
import { IllegalStateException } from '../utils/exception.js';


// Fragmented mp4 remuxer
class MP4Remuxer {

    constructor(config) {
        this.TAG = 'MP4Remuxer';

        this._config = config;
        this._isLive = (config.isLive === true) ? true : false;
        this._isMMTS = (config.isMMTS === true) ? true : false;

        this._dtsBase = -1;
        this._dtsBaseInited = false;
        this._audioDtsBase = Infinity;
        this._videoDtsBase = Infinity;
        this._audioNextDts = undefined;
        this._videoNextDts = undefined;
        this._audioStashedLastSample = null;
        this._videoStashedSamples = [];
        this._videoLastCompositionEnd = -1;
        this._videoStartupSegmentEmitted = false;
        this._pendingMMTSVideoTrackSwitch = null;
        this._pendingMMTSVideoReferenceRecoveryInit = null;
        this._loggedVideoFreezeGapCount = 0;
        this._loggedVideoPreservedGapCount = 0;
        this._loggedAudioFrameDropCount = 0;

        this._audioMeta = null;
        this._videoMeta = null;

        this._audioSegmentInfoList = new MediaSegmentInfoList('audio');
        this._videoSegmentInfoList = new MediaSegmentInfoList('video');

        this._onInitSegment = null;
        this._onMediaSegment = null;

        // Workaround for chrome < 50: Always force first sample as a Random Access Point in media segment
        // see https://bugs.chromium.org/p/chromium/issues/detail?id=229412
        this._forceFirstIDR = (Browser.chrome &&
                              (Browser.version.major < 50 ||
                              (Browser.version.major === 50 && Browser.version.build < 2661))) ? true : false;

        // Workaround for IE11/Edge: Fill silent aac frame after keyframe-seeking
        // Make audio beginDts equals with video beginDts, in order to fix seek freeze
        this._fillSilentAfterSeek = (Browser.msedge || Browser.msie);

        // While only FireFox supports 'audio/mp4, codecs="mp3"', use 'audio/mpeg' for chrome, safari, ...
        this._mp3UseMpegAudio = !Browser.firefox;

        this._fillAudioTimestampGap = this._config.fixAudioTimestampGap;
    }

    destroy() {
        this._dtsBase = -1;
        this._dtsBaseInited = false;
        this._audioMeta = null;
        this._videoMeta = null;
        this._pendingMMTSVideoTrackSwitch = null;
        this._pendingMMTSVideoReferenceRecoveryInit = null;
        this._audioSegmentInfoList.clear();
        this._audioSegmentInfoList = null;
        this._videoSegmentInfoList.clear();
        this._videoSegmentInfoList = null;
        this._onInitSegment = null;
        this._onMediaSegment = null;
    }

    bindDataSource(producer) {
        producer.onDataAvailable = this.remux.bind(this);
        producer.onTrackMetadata = this._onTrackMetadataReceived.bind(this);
        producer.onDiscontinuity = this.insertDiscontinuity.bind(this);
        producer.onVideoDiscontinuity = this.resetVideoState.bind(this);
        return this;
    }

    /* prototype: function onInitSegment(type: string, initSegment: ArrayBuffer): void
       InitSegment: {
           type: string,
           data: ArrayBuffer,
           codec: string,
           container: string
       }
    */
    get onInitSegment() {
        return this._onInitSegment;
    }

    set onInitSegment(callback) {
        this._onInitSegment = callback;
    }

    /* prototype: function onMediaSegment(type: string, mediaSegment: MediaSegment): void
       MediaSegment: {
           type: string,
           data: ArrayBuffer,
           sampleCount: int32
           info: MediaSegmentInfo
       }
    */
    get onMediaSegment() {
        return this._onMediaSegment;
    }

    set onMediaSegment(callback) {
        this._onMediaSegment = callback;
    }

    insertDiscontinuity() {
        this._audioStashedLastSample = null;
        this._videoStashedSamples = [];
        this._videoLastCompositionEnd = -1;
        this._audioNextDts = this._videoNextDts = undefined;
        this._loggedAudioFrameDropCount = 0;
        this._pendingMMTSVideoReferenceRecoveryInit = null;
        if (this._isMMTS) {
            this._videoStartupSegmentEmitted = false;
        }
    }

    resetAudioState() {
        this._audioStashedLastSample = null;
        this._audioNextDts = undefined;
        this._audioSegmentInfoList.clear();
        this._loggedAudioFrameDropCount = 0;
    }

    resetVideoState() {
        this._videoStashedSamples = [];
        this._videoLastCompositionEnd = -1;
        this._videoNextDts = undefined;
        this._videoSegmentInfoList.clear();
        this._pendingMMTSVideoTrackSwitch = null;
        this._pendingMMTSVideoReferenceRecoveryInit = null;
        if (this._isMMTS) {
            this._videoStartupSegmentEmitted = false;
        }
    }

    seek(originalDts) {
        this._audioStashedLastSample = null;
        this._videoStashedSamples = [];
        this._videoLastCompositionEnd = -1;
        this._videoSegmentInfoList.clear();
        this._audioSegmentInfoList.clear();
        this._loggedAudioFrameDropCount = 0;
        this._pendingMMTSVideoTrackSwitch = null;
        this._pendingMMTSVideoReferenceRecoveryInit = null;
        if (this._isMMTS) {
            this._videoStartupSegmentEmitted = false;
        }
    }

    remux(audioTrack, videoTrack, force = false) {
        if (!this._onMediaSegment) {
            throw new IllegalStateException('MP4Remuxer: onMediaSegment callback must be specificed!');
        }
        if (!this._dtsBaseInited) {
            this._calculateDtsBase(audioTrack, videoTrack);
        }
        if (videoTrack) {
            this._remuxVideo(videoTrack, force);
        }
        if (audioTrack) {
            this._remuxAudio(audioTrack, force);
        }
    }

    _onTrackMetadataReceived(type, metadata) {
        let metabox = null;

        let container = 'mp4';
        let codec = metadata.codec;

        if (type === 'audio') {
            this._audioMeta = metadata;
            if (metadata.codec === 'mp3' && this._mp3UseMpegAudio) {
                // 'audio/mpeg' for MP3 audio track
                container = 'mpeg';
                codec = '';
                metabox = new Uint8Array();
            } else {
                // 'audio/mp4, codecs="codec"'
                metabox = MP4.generateInitSegment(metadata);
            }
        } else if (type === 'video') {
            this._videoMeta = metadata;
            metabox = MP4.generateInitSegment(metadata);
        } else {
            return;
        }

        // dispatch metabox (Initialization Segment)
        if (!this._onInitSegment) {
            throw new IllegalStateException('MP4Remuxer: onInitSegment callback must be specified!');
        }
        let initSegment = {
            type: type,
            data: metabox.buffer,
            codec: codec,
            container: `${type}/${container}`,
            mediaDuration: metadata.duration  // in timescale 1000 (milliseconds)
        };
        if (type === 'audio' && metadata.mmtsAudioTrackSwitch) {
            initSegment.mmtsAudioTrackSwitch = Object.assign({}, metadata.mmtsAudioTrackSwitch);
        } else if (type === 'video' && metadata.mmtsVideoTrackSwitch) {
            initSegment.mmtsVideoTrackSwitch = this._cloneMMTSVideoTrackSwitchContext(
                metadata.mmtsVideoTrackSwitch
            );
        }
        if (type === 'video' && metadata.mmtsVideoReferenceRecovery === true) {
            // Keep the init segment attached to the exact recovery media
            // boundary.  A separately queued init can overtake older media in
            // the MSE state machine and reset the parser too early.
            initSegment.mmtsVideoReferenceRecovery = true;
            this._pendingMMTSVideoReferenceRecoveryInit = initSegment;
            return;
        }
        this._onInitSegment(type, initSegment);
    }

    _calculateDtsBase(audioTrack, videoTrack) {
        if (this._dtsBaseInited) {
            return;
        }

        let hasDtsBase = false;
        if (audioTrack && audioTrack.samples && audioTrack.samples.length) {
            this._audioDtsBase = audioTrack.samples[0].dts;
            hasDtsBase = true;
        }
        if (videoTrack && videoTrack.samples && videoTrack.samples.length) {
            this._videoDtsBase = videoTrack.samples[0].dts;
            hasDtsBase = true;
        }
        if (!hasDtsBase) {
            return;
        }

        this._dtsBase = Math.min(this._audioDtsBase, this._videoDtsBase);
        this._dtsBaseInited = true;
    }

    getTimestampBase() {
        if (!this._dtsBaseInited) {
            return undefined;
        }
        return this._dtsBase;
    }

    flushStashedSamples() {
        let videoSamples = this._videoStashedSamples;
        let audioSample = this._audioStashedLastSample;

        let videoTrack = {
            type: 'video',
            id: 1,
            sequenceNumber: 0,
            samples: [],
            length: 0
        };

        if (videoSamples.length > 0) {
            videoTrack.samples.push.apply(videoTrack.samples, videoSamples);
            videoTrack.length = videoSamples.reduce((sum, sample) => sum + sample.length, 0);
        }

        let audioTrack = {
            type: 'audio',
            id: 2,
            sequenceNumber: 0,
            samples: [],
            length: 0
        };

        if (audioSample != null) {
            audioTrack.samples.push(audioSample);
            audioTrack.length = audioSample.length;
        }

        this._videoStashedSamples = [];
        this._audioStashedLastSample = null;

        this._remuxVideo(videoTrack, true);
        this._remuxAudio(audioTrack, true);
    }

    _remuxAudio(audioTrack, force) {
        if (this._audioMeta == null) {
            return;
        }

        let track = audioTrack;
        let samples = track.samples;
        let mmtsAudioTrackSwitch = track.mmtsAudioTrackSwitch;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1, lastPts = -1;
        let refSampleDuration = this._audioMeta.refSampleDuration;

        let mpegRawTrack = this._audioMeta.codec === 'mp3' && this._mp3UseMpegAudio;
        let firstSegmentAfterSeek = this._dtsBaseInited && this._audioNextDts === undefined;

        let insertPrefixSilentFrame = false;

        if (!samples || samples.length === 0) {
            if (!force || this._audioStashedLastSample == null) {
                return;
            }
        }
        if (samples.length === 1 && !force) {
            // If [sample count in current batch] === 1 && (force != true)
            // Ignore and keep in demuxer's queue
            return;
        }  // else if (force === true) do remux

        let offset = 0;
        let mdatbox = null;
        let mdatBytes = 0;

        // calculate initial mdat size
        if (mpegRawTrack) {
            // for raw mpeg buffer
            offset = 0;
            mdatBytes = track.length;
        } else {
            // for fmp4 mdat box
            offset = 8;  // size + type
            mdatBytes = 8 + track.length;
        }


        let lastSample = null;

        // Pop the lastSample and waiting for stash
        if (samples.length > 1 && !force) {
            lastSample = samples.pop();
            mdatBytes -= lastSample.length;
        }

        // Insert [stashed lastSample in the previous batch] to the front
        if (this._audioStashedLastSample != null) {
            let sample = this._audioStashedLastSample;
            this._audioStashedLastSample = null;
            samples.unshift(sample);
            mdatBytes += sample.length;
        }

        // Stash the lastSample of current batch, waiting for next batch
        if (lastSample != null) {
            this._audioStashedLastSample = lastSample;
        }

        let firstSampleOriginalDts = samples[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._audioNextDts) {
            dtsCorrection = firstSampleOriginalDts - this._audioNextDts;
        } else {  // this._audioNextDts == undefined
            if (this._audioSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
                if (this._fillSilentAfterSeek && !this._videoSegmentInfoList.isEmpty()) {
                    if (this._audioMeta.originalCodec !== 'mp3') {
                        insertPrefixSilentFrame = true;
                    }
                }
            } else {
                let lastSample = this._audioSegmentInfoList.getLastSampleBefore(firstSampleOriginalDts);
                if (lastSample != null) {
                    let distance = (firstSampleOriginalDts - (lastSample.originalDts + lastSample.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastSample.dts + lastSample.duration + distance;
                    dtsCorrection = firstSampleOriginalDts - expectedDts;
                } else { // lastSample == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        if (insertPrefixSilentFrame) {
            // align audio segment beginDts to match with current video segment's beginDts
            let firstSampleDts = firstSampleOriginalDts - dtsCorrection;
            let videoSegment = this._videoSegmentInfoList.getLastSegmentBefore(firstSampleOriginalDts);
            if (videoSegment != null && videoSegment.beginDts < firstSampleDts) {
                let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                if (silentUnit) {
                    let dts = videoSegment.beginDts;
                    let silentFrameDuration = firstSampleDts - videoSegment.beginDts;
                    Log.v(this.TAG, `InsertPrefixSilentAudio: dts: ${dts}, duration: ${silentFrameDuration}`);
                    samples.unshift({ unit: silentUnit, dts: dts, pts: dts });
                    mdatBytes += silentUnit.byteLength;
                }  // silentUnit == null: Cannot generate, skip
            } else {
                insertPrefixSilentFrame = false;
            }
        }

        let mp4Samples = [];

        // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            let unit = sample.unit;
            let originalDts = sample.dts - this._dtsBase;
            let dts = originalDts;
            let needFillSilentFrames = false;
            let silentFrames = null;
            let sampleDuration = 0;

            if (originalDts < -0.001) {
                mdatBytes -= unit.byteLength;
                continue; //pass the first sample with the invalid dts
            }

            if (this._audioMeta.codec !== 'mp3' && refSampleDuration != null) {
                // for AAC codec, we need to keep dts increase based on refSampleDuration
                let curRefDts = originalDts;
                const maxAudioFramesDrift = 3;
                if (this._audioNextDts) {
                    curRefDts = this._audioNextDts;
                }

                dtsCorrection = originalDts - curRefDts;
                if (dtsCorrection <= -maxAudioFramesDrift * refSampleDuration) {
                    // If we're overlapping by more than maxAudioFramesDrift number of frame, drop this sample
                    if (this._loggedAudioFrameDropCount < 8) {
                        this._loggedAudioFrameDropCount++;
                        Log.w(this.TAG, `Dropping 1 audio frame (originalDts: ${originalDts} ms ,curRefDts: ${curRefDts} ms)  due to dtsCorrection: ${dtsCorrection} ms overlap.`);
                    } else if (this._loggedAudioFrameDropCount === 8) {
                        this._loggedAudioFrameDropCount++;
                        Log.w(this.TAG, 'Suppress further repeated audio frame drop logs');
                    }
                    mdatBytes -= unit.byteLength;
                    continue;
                }
                else if (this._shouldPreserveAudioTimestampGap(dtsCorrection, refSampleDuration)) {
                    dts = Math.floor(originalDts);
                    sampleDuration = Math.floor(originalDts + refSampleDuration) - dts;
                    this._audioNextDts = originalDts + refSampleDuration;
                }
                else if (dtsCorrection >= maxAudioFramesDrift * refSampleDuration && this._fillAudioTimestampGap && !Browser.safari) {
                    // Silent frame generation, if large timestamp gap detected && config.fixAudioTimestampGap
                    needFillSilentFrames = true;
                    // We need to insert silent frames to fill timestamp gap
                    let frameCount = Math.floor(dtsCorrection / refSampleDuration);
                    Log.w(this.TAG, 'Large audio timestamp gap detected, may cause AV sync to drift. ' +
                        'Silent frames will be generated to avoid unsync.\n' +
                        `originalDts: ${originalDts} ms, curRefDts: ${curRefDts} ms, ` +
                        `dtsCorrection: ${Math.round(dtsCorrection)} ms, generate: ${frameCount} frames`);


                    dts = Math.floor(curRefDts);
                    sampleDuration = Math.floor(curRefDts + refSampleDuration) - dts;

                    let silentUnit = AAC.getSilentFrame(this._audioMeta.originalCodec, this._audioMeta.channelCount);
                    if (silentUnit == null) {
                        Log.w(this.TAG, 'Unable to generate silent frame for ' +
                            `${this._audioMeta.originalCodec} with ${this._audioMeta.channelCount} channels, repeat last frame`);
                        // Repeat last frame
                        silentUnit = unit;
                    }
                    silentFrames = [];

                    for (let j = 0; j < frameCount; j++) {
                        curRefDts = curRefDts + refSampleDuration;
                        let intDts = Math.floor(curRefDts);  // change to integer
                        let intDuration = Math.floor(curRefDts + refSampleDuration) - intDts;
                        let frame = {
                            dts: intDts,
                            pts: intDts,
                            cts: 0,
                            unit: silentUnit,
                            size: silentUnit.byteLength,
                            duration: intDuration,  // wait for next sample
                            originalDts: originalDts,
                            flags: {
                                isLeading: 0,
                                dependsOn: 1,
                                isDependedOn: 0,
                                hasRedundancy: 0
                            }
                        };
                        silentFrames.push(frame);
                        mdatBytes += frame.size;

                    }

                    this._audioNextDts = curRefDts + refSampleDuration;

                } else {

                    dts = Math.floor(curRefDts);
                    sampleDuration = Math.floor(curRefDts + refSampleDuration) - dts;
                    this._audioNextDts = curRefDts + refSampleDuration;

                }
            } else {
                // keep the original dts calculate algorithm for mp3
                dts = originalDts - dtsCorrection;


                if (i !== samples.length - 1) {
                    let nextDts = samples[i + 1].dts - this._dtsBase - dtsCorrection;
                    sampleDuration = nextDts - dts;
                } else {  // the last sample
                    if (lastSample != null) {  // use stashed sample's dts to calculate sample duration
                        let nextDts = lastSample.dts - this._dtsBase - dtsCorrection;
                        sampleDuration = nextDts - dts;
                    } else if (mp4Samples.length >= 1) {  // use second last sample duration
                        sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
                    } else {  // the only one sample, use reference sample duration
                        sampleDuration = Math.floor(refSampleDuration);
                    }
                }
                this._audioNextDts = dts + sampleDuration;
            }

            if (firstDts === -1) {
                firstDts = dts;
            }
            mp4Samples.push({
                dts: dts,
                pts: dts,
                cts: 0,
                unit: sample.unit,
                size: sample.unit.byteLength,
                duration: sampleDuration,
                originalDts: originalDts,
                flags: {
                    isLeading: 0,
                    dependsOn: 1,
                    isDependedOn: 0,
                    hasRedundancy: 0
                }
            });

            if (needFillSilentFrames) {
                // Silent frames should be inserted after wrong-duration frame
                mp4Samples.push.apply(mp4Samples, silentFrames);
            }
        }

        if (mp4Samples.length === 0) {
            //no samples need to remux
            track.samples = [];
            track.length = 0;
            return;
        }

        // allocate mdatbox
        if (mpegRawTrack) {
            // allocate for raw mpeg buffer
            mdatbox = new Uint8Array(mdatBytes);
        } else {
            // allocate for fmp4 mdat box
            mdatbox = new Uint8Array(mdatBytes);
            // size field
            mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
            mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
            mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
            mdatbox[3] = (mdatBytes) & 0xFF;
            // type field (fourCC)
            mdatbox.set(MP4.types.mdat, 4);
        }

        // Write samples into mdatbox
        for (let i = 0; i < mp4Samples.length; i++) {
            let unit = mp4Samples[i].unit;
            mdatbox.set(unit, offset);
            offset += unit.byteLength;
        }

        let latest = mp4Samples[mp4Samples.length - 1];
        lastDts = latest.dts + latest.duration;
        //this._audioNextDts = lastDts;

        // fill media segment info & add to info list
        let info = new MediaSegmentInfo();
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstDts;
        info.endPts = lastDts;
        info.originalBeginDts = mp4Samples[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstSample = new SampleInfo(mp4Samples[0].dts,
                                          mp4Samples[0].pts,
                                          mp4Samples[0].duration,
                                          mp4Samples[0].originalDts,
                                          false);
        info.lastSample = new SampleInfo(latest.dts,
                                         latest.pts,
                                         latest.duration,
                                         latest.originalDts,
                                         false);
        if (!this._isLive) {
            this._audioSegmentInfoList.append(info);
        }

        track.samples = mp4Samples;
        track.sequenceNumber++;

        let moofbox = null;

        if (mpegRawTrack) {
            // Generate empty buffer, because useless for raw mpeg
            moofbox = new Uint8Array();
        } else {
            // Generate moof for fmp4 segment
            moofbox = MP4.moof(track, firstDts);
        }

        track.samples = [];
        track.length = 0;

        let segment = {
            type: 'audio',
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            sampleCount: mp4Samples.length,
            info: info
        };
        if (mmtsAudioTrackSwitch) {
            segment.mmtsAudioTrackSwitch = this._makeMMTSAudioTrackSwitch(mmtsAudioTrackSwitch, info);
        }

        if (mpegRawTrack && firstSegmentAfterSeek) {
            // For MPEG audio stream in MSE, if seeking occurred, before appending new buffer
            // We need explicitly set timestampOffset to the desired point in timeline for mpeg SourceBuffer.
            segment.timestampOffset = firstDts;
        }

        this._onMediaSegment('audio', segment);
    }

    _makeMMTSAudioTrackSwitch(context, info) {
        const requestedStart = context && context.requestedStart;
        const audioDecodeStart = info && info.beginDts / 1000;
        const audioStart = info && info.beginPts / 1000;
        const audioEnd = info && info.endPts / 1000;
        if (!context || !Number.isInteger(context.id) || context.id < 0 ||
            !Number.isInteger(context.attempt) || context.attempt < 0 ||
            !Number.isInteger(context.packetId) || context.packetId < 0 ||
            !Number.isSafeInteger(context.requestedStartMicroseconds) ||
            context.requestedStartMicroseconds < 0 ||
            !isFinite(requestedStart) || requestedStart < 0 ||
            !isFinite(audioDecodeStart) || !isFinite(audioStart) ||
            !isFinite(audioEnd) || audioEnd <= audioStart) {
            throw new IllegalStateException('Invalid MMTS audio track switch timeline');
        }
        return Object.assign({}, context, {
            packetId: context.packetId,
            requestedStart,
            audioDecodeStart,
            audioStart,
            audioEnd,
        });
    }

    _selectVideoEmitCount(samples, force) {
        if (force) {
            return samples.length;
        }
        if (samples.length <= 1) {
            return 0;
        }

        let refSampleDuration = Math.floor(this._videoMeta.refSampleDuration);
        let suffixMinPts = new Array(samples.length + 1);
        suffixMinPts[samples.length] = Infinity;
        for (let i = samples.length - 1; i >= 0; i--) {
            suffixMinPts[i] = Math.min(samples[i].pts, suffixMinPts[i + 1]);
        }

        let emitCount = 0;
        let prefixMaxPtsEnd = -Infinity;
        for (let i = 0; i < samples.length - 1; i++) {
            let duration = samples[i + 1].dts - samples[i].dts;
            if (duration <= 0) {
                duration = refSampleDuration;
            }
            prefixMaxPtsEnd = Math.max(prefixMaxPtsEnd, samples[i].pts + duration);
            if (prefixMaxPtsEnd <= suffixMinPts[i + 1]) {
                emitCount = i + 1;
            }
        }
        return emitCount >= 2 ? emitCount : 0;
    }

    _getVideoTailStashCount(samples, force) {
        if (force) {
            return 0;
        }

        let stashDuration = this._config.mmtsVideoTailStashDuration;
        if (typeof stashDuration !== 'number' || !isFinite(stashDuration) || stashDuration <= 0) {
            return 0;
        }

        let refSampleDuration = Math.max(1, Math.floor(this._videoMeta.refSampleDuration));
        return Math.min(samples.length, 16, Math.ceil(stashDuration * 1000 / refSampleDuration));
    }

    _dropOverlappedVideoSamples(samples) {
        if (this._isMMTS) {
            return samples;
        }

        if (this._videoLastCompositionEnd < 0) {
            return samples;
        }

        let refSampleDuration = Math.floor(this._videoMeta.refSampleDuration);
        let tolerance = Math.max(1, Math.floor(refSampleDuration / 4));
        let writeIndex = 0;
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            let duration = refSampleDuration;
            if (i + 1 < samples.length) {
                duration = samples[i + 1].dts - sample.dts;
                if (duration <= 0) {
                    duration = refSampleDuration;
                }
            }

            if (!sample.isKeyframe && sample.pts + duration <= this._videoLastCompositionEnd + tolerance) {
                continue;
            }
            samples[writeIndex++] = sample;
        }
        samples.length = writeIndex;
        return samples;
    }

    _remuxVideo(videoTrack, force) {
        if (this._videoMeta == null) {
            return;
        }

        let track = videoTrack;
        let samples = track.samples;
        if (track.mmtsVideoTrackSwitch) {
            this._pendingMMTSVideoTrackSwitch = this._cloneMMTSVideoTrackSwitchContext(
                track.mmtsVideoTrackSwitch
            );
        }
        let mmtsVideoTrackSwitch = this._pendingMMTSVideoTrackSwitch;
        let dtsCorrection = undefined;
        let firstDts = -1, lastDts = -1;
        let firstPts = -1, lastPts = -1;

        if (!samples) {
            samples = [];
        }
        if (this._videoStashedSamples.length > 0) {
            samples = this._videoStashedSamples.concat(samples);
        }
        if (samples.length === 0) {
            return;
        }

        // fMP4 trun sample order defines decode order. MMTS packet order may
        // differ from DTS order when HEVC carries frame reordering, so sort
        // before calculating durations and writing mdat.
        samples.sort((a, b) => {
            if (a.dts !== b.dts) {
                return a.dts - b.dts;
            }
            return a.pts - b.pts;
        });

        samples = this._dropOverlappedVideoSamples(samples);
        if (samples.length === 0) {
            this._videoStashedSamples = [];
            track.samples = [];
            track.length = 0;
            return;
        }

        let emitCount = this._selectVideoEmitCount(samples, force);
        let tailStashCount = this._getVideoTailStashCount(samples, force);
        if (tailStashCount > 0) {
            emitCount = Math.min(emitCount, Math.max(0, samples.length - tailStashCount));
        }
        if (emitCount === 0) {
            this._videoStashedSamples = samples;
            track.samples = [];
            track.length = 0;
            return;
        }

        let pendingSamples = samples.slice(emitCount);
        samples = samples.slice(0, emitCount);
        this._videoStashedSamples = pendingSamples;

        // A fragmented MP4 stream may only begin at a random access point.
        // Demuxers normally provide this guarantee, but retain the invariant at
        // the remux boundary because this is the final owner of fMP4 semantics.
        if (!this._videoStartupSegmentEmitted && !samples[0].isKeyframe) {
            const firstRapIndex = samples.findIndex((sample) => sample.isKeyframe);
            if (firstRapIndex < 0) {
                this._videoStashedSamples = force ? [] : samples.concat(pendingSamples);
                track.samples = [];
                track.length = 0;
                if (force) {
                    Log.w(this.TAG, 'Drop initial video samples without a random access point');
                }
                return;
            }
            samples = samples.slice(firstRapIndex);
        }

        if (samples.length === 0) {
            return;
        }
        if (samples.length === 1 && !force) {
            this._videoStashedSamples = samples.concat(this._videoStashedSamples);
            track.samples = [];
            track.length = 0;
            return;
        }  // else if (force === true) do remux

        let lastSample = pendingSamples.length > 0 ? pendingSamples[0] : null;
        let mdatBytes = 8 + samples.reduce((sum, sample) => sum + sample.length, 0);

        if (mdatBytes <= 8) {
            if (!force) {
                this._videoStashedSamples = samples.concat(this._videoStashedSamples);
                track.samples = [];
                track.length = 0;
                return;
            }
        }

        let offset = 8;
        let mdatbox = null;


        let firstSampleOriginalDts = samples[0].dts - this._dtsBase;

        // calculate dtsCorrection
        if (this._videoNextDts) {
            if (this._shouldPreserveMarkedVideoGap() && this._hasMarkedVideoGapBeforeSample(samples[0])) {
                dtsCorrection = 0;
                this._logPreservedVideoGapBeforeFirstSample(samples[0], firstSampleOriginalDts);
            } else if (this._shouldPreserveVideoTimestampGap(firstSampleOriginalDts - this._videoNextDts)) {
                dtsCorrection = 0;
            } else {
                dtsCorrection = firstSampleOriginalDts - this._videoNextDts;
            }
        } else {  // this._videoNextDts == undefined
            if (this._videoSegmentInfoList.isEmpty()) {
                dtsCorrection = 0;
            } else {
                let lastSample = this._videoSegmentInfoList.getLastSampleBefore(firstSampleOriginalDts);
                if (lastSample != null) {
                    let distance = (firstSampleOriginalDts - (lastSample.originalDts + lastSample.duration));
                    if (distance <= 3) {
                        distance = 0;
                    }
                    let expectedDts = lastSample.dts + lastSample.duration + distance;
                    dtsCorrection = firstSampleOriginalDts - expectedDts;
                } else { // lastSample == null, cannot found
                    dtsCorrection = 0;
                }
            }
        }

        let info = new MediaSegmentInfo();
        let mp4Samples = [];

        // Correct dts for each sample, and calculate sample duration. Then output to mp4Samples
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            let originalDts = sample.dts - this._dtsBase;
            let isKeyframe = sample.isKeyframe;
            let dts = originalDts - dtsCorrection;
            let cts = sample.cts;
            let pts = dts + cts;

            if (firstDts === -1) {
                firstDts = dts;
                firstPts = pts;
            }

            let sampleDuration = 0;

            if (i !== samples.length - 1) {
                let nextDts = samples[i + 1].dts - this._dtsBase - dtsCorrection;
                sampleDuration = nextDts - dts;
            } else {  // the last sample
                if (lastSample != null) {  // use stashed sample's dts to calculate sample duration
                    let nextDts = lastSample.dts - this._dtsBase - dtsCorrection;
                    sampleDuration = nextDts - dts;
                } else if (mp4Samples.length >= 1) {  // use second last sample duration
                    sampleDuration = mp4Samples[mp4Samples.length - 1].duration;
                } else {  // the only one sample, use reference sample duration
                    sampleDuration = Math.floor(this._videoMeta.refSampleDuration);
                }
            }

            let nextDurationSample = i !== samples.length - 1 ? samples[i + 1] : lastSample;
            this._logVideoFreezeGapIfNeeded(sample, nextDurationSample, dts, sampleDuration);

            if (isKeyframe) {
                let syncPoint = new SampleInfo(dts, pts, sampleDuration, sample.dts, true);
                syncPoint.fileposition = sample.fileposition;
                info.appendSyncPoint(syncPoint);
            }

            mp4Samples.push({
                dts: dts,
                pts: pts,
                cts: cts,
                units: sample.units,
                size: sample.length,
                isKeyframe: isKeyframe,
                duration: sampleDuration,
                originalDts: originalDts,
                mmtsSourceInfo: this._makeRemuxedMMTSSourceInfo(sample.mmtsSourceInfo, dts, pts),
                mmtsRandomAccessSafe: sample.mmtsRandomAccessSafe === true,
                flags: {
                    isLeading: 0,
                    dependsOn: isKeyframe ? 2 : 1,
                    isDependedOn: isKeyframe ? 1 : 0,
                    hasRedundancy: 0,
                    isNonSync: isKeyframe ? 0 : 1
                }
            });
        }

        // allocate mdatbox
        mdatbox = new Uint8Array(mdatBytes);
        mdatbox[0] = (mdatBytes >>> 24) & 0xFF;
        mdatbox[1] = (mdatBytes >>> 16) & 0xFF;
        mdatbox[2] = (mdatBytes >>>  8) & 0xFF;
        mdatbox[3] = (mdatBytes) & 0xFF;
        mdatbox.set(MP4.types.mdat, 4);

        // Write samples into mdatbox
        for (let i = 0; i < mp4Samples.length; i++) {
            let units = mp4Samples[i].units;
            while (units.length) {
                let unit = units.shift();
                let data = unit.data;
                mdatbox.set(data, offset);
                offset += data.byteLength;
            }
        }

        let latest = mp4Samples[mp4Samples.length - 1];
        lastDts = latest.dts + latest.duration;
        lastPts = latest.pts + latest.duration;
        this._videoNextDts = lastDts;

        let compositionOrder = mp4Samples.slice().sort((a, b) => {
            if (a.pts !== b.pts) {
                return a.pts - b.pts;
            }
            return a.dts - b.dts;
        });
        let lastCompositionSample = compositionOrder[compositionOrder.length - 1];
        this._videoLastCompositionEnd = lastCompositionSample.pts + lastCompositionSample.duration;

        // fill media segment info & add to info list
        info.beginDts = firstDts;
        info.endDts = lastDts;
        info.beginPts = firstPts;
        info.endPts = lastPts;
        info.originalBeginDts = mp4Samples[0].originalDts;
        info.originalEndDts = latest.originalDts + latest.duration;
        info.firstSample = new SampleInfo(mp4Samples[0].dts,
                                          mp4Samples[0].pts,
                                          mp4Samples[0].duration,
                                          mp4Samples[0].originalDts,
                                          mp4Samples[0].isKeyframe);
        info.lastSample = new SampleInfo(latest.dts,
                                         latest.pts,
                                         latest.duration,
                                         latest.originalDts,
                                         latest.isKeyframe);
        if (!this._isLive) {
            this._videoSegmentInfoList.append(info);
        }

        track.samples = mp4Samples;
        track.sequenceNumber++;

        // workaround for chrome < 50: force first sample as a random access point
        // see https://bugs.chromium.org/p/chromium/issues/detail?id=229412
        if (this._forceFirstIDR) {
            let flags = mp4Samples[0].flags;
            flags.dependsOn = 2;
            flags.isNonSync = 0;
        }

        let moofbox = MP4.moof(track, firstDts);
        track.samples = [];
        track.length = 0;

        const mmtsSourceInfo = this._makeSegmentMMTSSourceInfo(mp4Samples);
        const segment = {
            type: 'video',
            data: this._mergeBoxes(moofbox, mdatbox).buffer,
            sampleCount: mp4Samples.length,
            info: info
        };
        const recoveryInit = this._pendingMMTSVideoReferenceRecoveryInit;
        if (recoveryInit && mp4Samples[0].isKeyframe) {
            segment.data = this._mergeBoxes(
                new Uint8Array(recoveryInit.data),
                new Uint8Array(segment.data)
            ).buffer;
            segment.resetParserState = true;
            segment.container = recoveryInit.container;
            segment.codec = recoveryInit.codec;
            segment.mmtsVideoReferenceRecovery = true;
            this._pendingMMTSVideoReferenceRecoveryInit = null;
        }
        if (mp4Samples[0].isKeyframe) {
            segment.firstPlayableWindow = this._makeFirstVideoPlayableWindow(mp4Samples);
        }
        if (mp4Samples[0].mmtsRandomAccessSafe === true) {
            segment.mmtsRandomAccessSafe = true;
        }
        if (!this._videoStartupSegmentEmitted) {
            this._videoStartupSegmentEmitted = true;
        }
        if (mmtsVideoTrackSwitch) {
            segment.mmtsVideoTrackSwitch = this._makeMMTSVideoTrackSwitch(mmtsVideoTrackSwitch, mp4Samples);
            this._pendingMMTSVideoTrackSwitch = null;
        }
        if (mmtsSourceInfo !== null) {
            segment.mmtsSourceInfo = mmtsSourceInfo;
        }

        this._onMediaSegment('video', segment);
    }

    _makeFirstVideoPlayableWindow(samples) {
        const first = samples[0];
        const compositionStart = samples.reduce((start, sample) => Math.min(start, sample.pts), Infinity);
        const compositionEnd = samples.reduce((end, sample) => {
            return Math.max(end, sample.pts + sample.duration);
        }, -Infinity);
        const syncPoint = first.pts;
        return {
            decodeStart: first.dts / 1000,
            compositionStart: compositionStart / 1000,
            syncPoint: syncPoint / 1000,
            playableStart: syncPoint / 1000,
            playableEnd: compositionEnd / 1000
        };
    }

    _makeMMTSVideoTrackSwitch(context, samples) {
        const first = samples && samples[0];
        if (!context || !Number.isInteger(context.id) || context.id < 0 ||
            !Number.isInteger(context.attempt) || context.attempt < 0 ||
            !Number.isInteger(context.packetId) || context.packetId < 0 ||
            !first || first.isKeyframe !== true) {
            throw new IllegalStateException('Invalid MMTS video track switch boundary');
        }
        const window = this._makeFirstVideoPlayableWindow(samples);
        if (!isFinite(window.decodeStart) || !isFinite(window.compositionStart) ||
            !isFinite(window.syncPoint) || !isFinite(window.playableStart) ||
            !isFinite(window.playableEnd) || window.playableStart < 0 ||
            window.playableEnd <= window.playableStart) {
            throw new IllegalStateException('Invalid MMTS video track switch timeline');
        }
        return Object.assign({}, context, {
            packetId: context.packetId,
            videoDecodeStart: window.decodeStart,
            videoCompositionStart: window.compositionStart,
            syncPoint: window.syncPoint,
            playableStart: window.playableStart,
            playableEnd: window.playableEnd,
        });
    }

    _cloneMMTSVideoTrackSwitchContext(context) {
        if (!context || !Number.isInteger(context.id) || context.id < 0 ||
            !Number.isInteger(context.attempt) || context.attempt < 0 ||
            !Number.isInteger(context.packetId) || context.packetId < 0) {
            throw new IllegalStateException('Invalid MMTS video track switch identity');
        }
        return Object.assign({}, context);
    }

    _makeRemuxedMMTSSourceInfo(sourceInfo, dts, pts) {
        if (!sourceInfo) {
            return null;
        }
        let remuxed = Object.assign({}, sourceInfo);
        remuxed.dts = dts;
        remuxed.pts = pts;
        return remuxed;
    }

    _makeSegmentMMTSSourceInfo(samples) {
        let firstSample = null;
        let lastSample = null;
        for (let i = 0; i < samples.length; i++) {
            const sourceInfo = samples[i].mmtsSourceInfo;
            if (!sourceInfo) {
                continue;
            }
            if (firstSample === null) {
                firstSample = sourceInfo;
            }
            lastSample = sourceInfo;
        }
        if (firstSample === null) {
            return null;
        }
        return Object.assign({}, firstSample, {
            firstSample,
            lastSample: lastSample || firstSample
        });
    }

    _hasMarkedVideoGapBeforeSample(sample) {
        return sample &&
            sample.mmtsVideoGapBefore &&
            sample.mmtsVideoGapBefore.duration > 0;
    }

    _shouldPreserveMarkedVideoGap() {
        return !this._config.mmtsClampVideoTimestampGap;
    }

    _shouldPreserveAudioTimestampGap(dtsCorrection, refSampleDuration) {
        return !this._config.mmtsClampAudioTimestampGap &&
            this._isMMTS &&
            dtsCorrection >= Math.max(50, refSampleDuration * 2);
    }

    _shouldPreserveVideoTimestampGap(dtsCorrection) {
        if (!this._isMMTS) {
            return false;
        }
        if (dtsCorrection < this._getPreservedVideoTimestampGapThreshold()) {
            return false;
        }

        return true;
    }

    _getPreservedVideoTimestampGapThreshold() {
        let refSampleDuration = Math.floor(this._videoMeta.refSampleDuration);
        return Math.max(1000, refSampleDuration * 60);
    }

    _logPreservedVideoGapBeforeFirstSample(sample, originalDts) {
        if (this._loggedVideoPreservedGapCount >= 8 || !this._hasMarkedVideoGapBeforeSample(sample)) {
            return;
        }

        let gap = sample.mmtsVideoGapBefore;
        this._loggedVideoPreservedGapCount++;
        Log.v(
            this.TAG,
            `Preserve video gap before recovery sample #${this._loggedVideoPreservedGapCount}, ` +
            `original_dts=${Math.round(originalDts)}, gap=${Math.round(gap.duration)} ms`
        );
    }

    _logVideoFreezeGapIfNeeded(sample, nextSample, dts, duration) {
        if (!this._shouldPreserveMarkedVideoGap() ||
            this._loggedVideoFreezeGapCount >= 8 ||
            !this._hasMarkedVideoGapBeforeSample(nextSample)) {
            return;
        }

        let refSampleDuration = Math.floor(this._videoMeta.refSampleDuration);
        let threshold = Math.max(refSampleDuration * 3, 50);
        if (duration < threshold) {
            return;
        }

        this._loggedVideoFreezeGapCount++;
        Log.v(
            this.TAG,
            `Extend video sample duration across loss #${this._loggedVideoFreezeGapCount}, ` +
            `dts=${Math.round(dts)}, duration=${Math.round(duration)}, ` +
            `next_keyframe_dts=${Math.round(nextSample.dts - this._dtsBase)}`
        );
    }

    _mergeBoxes(moof, mdat) {
        let result = new Uint8Array(moof.byteLength + mdat.byteLength);
        result.set(moof, 0);
        result.set(mdat, moof.byteLength);
        return result;
    }

}

export default MP4Remuxer;

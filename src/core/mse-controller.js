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

import EventEmitter from 'events';
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import MSEEvents from './mse-events';
import {IllegalStateException} from '../utils/exception.js';

// Media Source Extensions controller
class MSEController {

    constructor(config) {
        this.TAG = 'MSEController';

        this._config = config;
        this._emitter = new EventEmitter();

        if (this._config.isLive) {
            const useLiveCleanupWindow =
                this._config.autoCleanupSourceBuffer == undefined &&
                this._config.autoCleanupMaxBackwardDuration === 3 * 60 &&
                this._config.autoCleanupMinBackwardDuration === 2 * 60;

            if (this._config.autoCleanupSourceBuffer == undefined) {
                // For live stream, do auto cleanup by default
                this._config.autoCleanupSourceBuffer = true;
            }
            if (useLiveCleanupWindow) {
                this._config.autoCleanupMaxBackwardDuration = 30;
                this._config.autoCleanupMinBackwardDuration = 10;
            }
        }

        this.e = {
            onSourceOpen: this._onSourceOpen.bind(this),
            onSourceEnded: this._onSourceEnded.bind(this),
            onSourceClose: this._onSourceClose.bind(this),
            onStartStreaming: this._onStartStreaming.bind(this),
            onEndStreaming: this._onEndStreaming.bind(this),
            onQualityChange: this._onQualityChange.bind(this),
            onSourceBufferError: this._onSourceBufferError.bind(this),
            onSourceBufferUpdateEnd: this._onSourceBufferUpdateEnd.bind(this)
        };

        // Use ManagedMediaSource only if w3c MediaSource is not available (e.g. iOS Safari)
        this._useManagedMediaSource = ('ManagedMediaSource' in self) && !('MediaSource' in self);

        this._mediaSource = null;
        this._mediaSourceObjectURL = null;

        this._mediaElementProxy = null;

        this._isBufferFull = false;
        this._hasFatalMediaError = false;
        this._hasPendingEos = false;

        this._requireSetMediaDuration = false;
        this._pendingMediaDuration = 0;

        this._mimeTypes = {
            video: null,
            audio: null
        };
        this._sourceBuffers = {
            video: null,
            audio: null
        };
        this._lastInitSegments = {
            video: null,
            audio: null
        };
        this._bufferedSegmentRecords = {
            video: [],
            audio: []
        };
        this._pendingRemoveRanges = {
            video: [],
            audio: []
        };
        this._lastLiveSeekableRange = {
            start: NaN,
            end: NaN
        };
    }

    destroy() {
        if (this._mediaSource) {
            this.shutdown();
        }
        if (this._mediaSourceObjectURL) {
            this.revokeObjectURL();
        }
        this.e = null;
        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    initialize(mediaElementProxy) {
        if (this._mediaSource) {
            throw new IllegalStateException('MediaSource has been attached to an HTMLMediaElement!');
        }

        if (this._useManagedMediaSource) {
            Log.v(this.TAG, 'Using ManagedMediaSource');
        }

        let ms = this._mediaSource = this._useManagedMediaSource ? new self.ManagedMediaSource() : new self.MediaSource();
        ms.addEventListener('sourceopen', this.e.onSourceOpen);
        ms.addEventListener('sourceended', this.e.onSourceEnded);
        ms.addEventListener('sourceclose', this.e.onSourceClose);

        if (this._useManagedMediaSource) {
            ms.addEventListener('startstreaming', this.e.onStartStreaming);
            ms.addEventListener('endstreaming', this.e.onEndStreaming);
            ms.addEventListener('qualitychange', this.e.onQualityChange);
        }

        this._mediaElementProxy = mediaElementProxy;
    }

    shutdown() {
        if (this._mediaSource) {
            let ms = this._mediaSource;
            for (let type in this._sourceBuffers) {
                this._bufferedSegmentRecords[type] = null;
                this._pendingRemoveRanges[type] = null;
                this._lastInitSegments[type] = null;

                // remove all sourcebuffers
                let sb = this._sourceBuffers[type];
                if (sb) {
                    if (ms.readyState !== 'closed') {
                        // ms edge can throw an error: Unexpected call to method or property access
                        try {
                            ms.removeSourceBuffer(sb);
                        } catch (error) {
                            Log.e(this.TAG, error.message);
                        }
                        sb.removeEventListener('error', this.e.onSourceBufferError);
                        sb.removeEventListener('updateend', this.e.onSourceBufferUpdateEnd);
                    }
                    this._mimeTypes[type] = null;
                    this._sourceBuffers[type] = null;
                }
            }
            if (ms.readyState === 'open') {
                try {
                    ms.endOfStream();
                } catch (error) {
                    Log.e(this.TAG, error.message);
                }
            }
            this._mediaElementProxy = null;
            ms.removeEventListener('sourceopen', this.e.onSourceOpen);
            ms.removeEventListener('sourceended', this.e.onSourceEnded);
            ms.removeEventListener('sourceclose', this.e.onSourceClose);
            if (this._useManagedMediaSource) {
                ms.removeEventListener('startstreaming', this.e.onStartStreaming);
                ms.removeEventListener('endstreaming', this.e.onEndStreaming);
                ms.removeEventListener('qualitychange', this.e.onQualityChange);
            }
            this._bufferedSegmentRecords = {
                video: [],
                audio: []
            };
            this._clearLiveSeekableRange();
            this._isBufferFull = false;
            this._hasFatalMediaError = false;
            this._mediaSource = null;
        }
    }

    abandon() {
        if (!this._mediaSource) {
            return;
        }

        let ms = this._mediaSource;
        for (let type in this._sourceBuffers) {
            this._bufferedSegmentRecords[type] = null;
            this._pendingRemoveRanges[type] = null;
            this._lastInitSegments[type] = null;

            let sb = this._sourceBuffers[type];
            if (sb) {
                sb.removeEventListener('error', this.e.onSourceBufferError);
                sb.removeEventListener('updateend', this.e.onSourceBufferUpdateEnd);
                if (ms.readyState !== 'closed') {
                    // Release parser and decoder resources before a replacement MediaSource is attached.
                    try {
                        ms.removeSourceBuffer(sb);
                    } catch (error) {
                        Log.e(this.TAG, error.message);
                    }
                }
                this._mimeTypes[type] = null;
                this._sourceBuffers[type] = null;
            }
        }

        this._bufferedSegmentRecords = {
            video: [],
            audio: []
        };
        this._mediaElementProxy = null;
        ms.removeEventListener('sourceopen', this.e.onSourceOpen);
        ms.removeEventListener('sourceended', this.e.onSourceEnded);
        ms.removeEventListener('sourceclose', this.e.onSourceClose);
        if (this._useManagedMediaSource) {
            ms.removeEventListener('startstreaming', this.e.onStartStreaming);
            ms.removeEventListener('endstreaming', this.e.onEndStreaming);
            ms.removeEventListener('qualitychange', this.e.onQualityChange);
        }
        this._mediaSource = null;
    }

    isManagedMediaSource() {
        return this._useManagedMediaSource;
    }

    getObject() {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }
        return this._mediaSource;
    }

    getHandle() {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }
        return this._mediaSource.handle;
    }

    getObjectURL() {
        if (!this._mediaSource) {
            throw new IllegalStateException('MediaSource has not been initialized yet!');
        }

        if (this._mediaSourceObjectURL == null) {
            this._mediaSourceObjectURL = URL.createObjectURL(this._mediaSource);
        }
        return this._mediaSourceObjectURL;
    }

    revokeObjectURL() {
        if (this._mediaSourceObjectURL) {
            URL.revokeObjectURL(this._mediaSourceObjectURL);
            this._mediaSourceObjectURL = null;
        }
    }

    _makeMimeType(initSegment) {
        let mimeType = `${initSegment.container}`;
        if (initSegment.codec && initSegment.codec.length > 0) {
            if (initSegment.codec === 'opus' && Browser.safari) {
                initSegment.codec = 'Opus';
            }
            mimeType += `;codecs=${initSegment.codec}`;
        }
        return mimeType;
    }

    _addSourceBuffer(type, mimeType) {
        let sb;
        try {
            sb = this._mediaSource.addSourceBuffer(mimeType);
            sb.addEventListener('error', this.e.onSourceBufferError);
            sb.addEventListener('updateend', this.e.onSourceBufferUpdateEnd);
        } catch (error) {
            Log.e(this.TAG, error.message);
            return {ok: false, error};
        }

        this._sourceBuffers[type] = sb;
        this._mimeTypes[type] = mimeType;
        return {ok: true, sourceBuffer: sb};
    }

    _resetSourceBufferParserState(type, mimeType) {
        let sb = this._sourceBuffers[type];
        if (!this._mediaSource || !sb || sb.updating ||
            (this._mediaSource.readyState !== 'open' && this._mediaSource.readyState !== 'ended')) {
            return {ok: false, blocked: true};
        }

        if (typeof sb.changeType !== 'function') {
            let error = new Error(`${type} SourceBuffer.changeType is unavailable`);
            Log.e(this.TAG, error.message);
            return {ok: false, error};
        }

        try {
            Log.v(this.TAG, `Reset ${type} SourceBuffer parser state, mimeType: ${mimeType}`);
            sb.changeType(mimeType);
            this._mimeTypes[type] = mimeType;
            return {ok: true};
        } catch (error) {
            Log.w(this.TAG, `Failed to reset ${type} SourceBuffer parser state: ${error.message}`);
            return {ok: false, error};
        }
    }

    ensureSourceBufferDirect(initSegment) {
        if (!this._mediaSource || this._mediaSource.readyState !== 'open' ||
            this._mediaSource.streaming === false) {
            return {ok: false, blocked: true};
        }

        let type = initSegment.type;
        let mimeType = this._makeMimeType(initSegment);
        let sb = this._sourceBuffers[type];
        if (sb) {
            return {ok: true, empty: true};
        }

        let result = this._addSourceBuffer(type, mimeType);
        if (!result.ok) {
            this._emitter.emit(MSEEvents.ERROR, {code: result.error.code, msg: result.error.message});
            return result;
        }
        return {ok: true, empty: true};
    }

    appendInitSegmentDirect(initSegment, resetParserState = false) {
        if (!this._mediaSource ||
            (this._mediaSource.readyState !== 'open' && this._mediaSource.readyState !== 'ended') ||
            this._mediaSource.streaming === false) {
            return {ok: false, blocked: true};
        }

        let is = resetParserState ? Object.assign({}, initSegment) : initSegment;
        let type = is.type;
        let mimeType = this._makeMimeType(is);
        Log.v(this.TAG, 'Received Initialization Segment, mimeType: ' + mimeType);

        let sb = this._sourceBuffers[type];
        if (sb && sb.updating) {
            return {ok: false, blocked: true};
        }

        if (!sb) {
            if (this._mediaSource.readyState !== 'open') {
                return {ok: false, blocked: true};
            }
            let result = this._addSourceBuffer(type, mimeType);
            if (!result.ok) {
                this._emitter.emit(MSEEvents.ERROR, {code: result.error.code, msg: result.error.message});
                return result;
            }
            sb = result.sourceBuffer;
        } else if (resetParserState || mimeType !== this._mimeTypes[type]) {
            if (mimeType !== this._mimeTypes[type]) {
                Log.v(this.TAG, `Notice: ${type} mimeType changed, origin: ${this._mimeTypes[type]}, target: ${mimeType}`);
            }
            let result = this._resetSourceBufferParserState(type, mimeType);
            if (!result.ok) {
                if (result.error) {
                    this._emitter.emit(MSEEvents.ERROR, {code: result.error.code, msg: result.error.message});
                }
                return result;
            }
            sb = this._sourceBuffers[type];
        }

        this._lastInitSegments[type] = Object.assign({}, is);

        if (!sb || sb.updating) {
            return {ok: false, blocked: true};
        }

        if (!is.data || is.data.byteLength === 0) {
            return {ok: true, empty: true};
        }

        try {
            sb.appendBuffer(is.data);
            this._isBufferFull = false;
            return {ok: true};
        } catch (error) {
            if (error.code === 22 || error.name === 'QuotaExceededError') {
                this._isBufferFull = true;
                return {ok: false, quota: true, error};
            }
            this._emitFatalMediaError(error);
            return {ok: false, error};
        }
    }

    appendMediaSegmentDirect(mediaSegment) {
        let type = mediaSegment.type;
        if (!this._mediaSource ||
            (this._mediaSource.readyState !== 'open' && this._mediaSource.readyState !== 'ended') ||
            this._mediaSource.streaming === false) {
            return {ok: false, blocked: true};
        }
        if (this._hasFatalMediaError) {
            return {ok: false, fatal: true};
        }
        let sb = this._sourceBuffers[type];
        if (!sb || sb.updating || this._hasPendingRemoveRanges()) {
            return {ok: false, blocked: true};
        }

        let segment = mediaSegment;
        if (typeof segment.timestampOffset === 'number' && isFinite(segment.timestampOffset)) {
            let currentOffset = sb.timestampOffset;
            let targetOffset = segment.timestampOffset / 1000;
            let delta = Math.abs(currentOffset - targetOffset);
            if (delta > 0.1) {
                Log.v(this.TAG, `Update MPEG audio timestampOffset from ${currentOffset} to ${targetOffset}`);
                sb.timestampOffset = targetOffset;
            }
            delete segment.timestampOffset;
        }

        if (!segment.data || segment.data.byteLength === 0) {
            return {ok: true, empty: true};
        }

        if (segment.resetParserState) {
            let result = this._resetSourceBufferParserState(
                type,
                segment.mimeType || this._makeMimeType(segment)
            );
            if (!result.ok) {
                return result;
            }
            sb = this._sourceBuffers[type];
            delete segment.resetParserState;
            delete segment.mimeType;
        }

        try {
            sb.appendBuffer(segment.data);
            this._recordAppendedMediaSegment(type, segment);
            this._isBufferFull = false;
            return {ok: true};
        } catch (error) {
            if (error.code === 22 || error.name === 'QuotaExceededError') {
                this._isBufferFull = true;
                return {ok: false, quota: true, error};
            }
            this._emitFatalMediaError(error);
            return {ok: false, error};
        }
    }

    removeRangeDirect(type, start, end) {
        if (!this._mediaSource ||
            (this._mediaSource.readyState !== 'open' && this._mediaSource.readyState !== 'ended')) {
            return {ok: false, blocked: true};
        }
        let sb = this._sourceBuffers[type];
        if (!sb || sb.updating || !isFinite(start) || !isFinite(end) || end <= start) {
            return {ok: false, blocked: true};
        }

        try {
            sb.remove(start, end);
            return {ok: true};
        } catch (error) {
            this._emitFatalMediaError(error);
            return {ok: false, error};
        }
    }

    resetParserStateDirect(type, mimeType) {
        let sb = this._sourceBuffers[type];
        if (!this._mediaSource || !sb || sb.updating ||
            (this._mediaSource.readyState !== 'open' && this._mediaSource.readyState !== 'ended')) {
            return {ok: false, blocked: true};
        }
        return this._resetSourceBufferParserState(type, mimeType);
    }

    getMediaSourceState() {
        let sourceBuffers = {};
        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            sourceBuffers[type] = {
                exists: !!sb,
                updating: !!(sb && sb.updating)
            };
        }
        return {
            readyState: this._mediaSource ? this._mediaSource.readyState : 'closed',
            streaming: this._mediaSource ? this._mediaSource.streaming : undefined,
            hasFatalMediaError: this._hasFatalMediaError,
            hasPendingRemoveRanges: this._hasPendingRemoveRanges(),
            sourceBuffers
        };
    }

    getBufferedRanges(type) {
        let sb = this._sourceBuffers[type];
        let ranges = [];
        if (!sb) {
            return ranges;
        }
        try {
            for (let i = 0; i < sb.buffered.length; i++) {
                ranges.push({
                    start: sb.buffered.start(i),
                    end: sb.buffered.end(i)
                });
            }
        } catch (error) {
            return [];
        }
        return ranges;
    }

    getLastInitSegment(type) {
        let segment = this._lastInitSegments[type];
        return segment ? Object.assign({}, segment) : null;
    }

    setMediaDuration(duration) {
        if (this._config.isLive || !isFinite(duration) || duration <= 0) {
            return;
        }

        if (this._pendingMediaDuration > duration) {
            duration = this._pendingMediaDuration;
        }

        this._requireSetMediaDuration = true;
        this._pendingMediaDuration = duration;
        this._updateMediaSourceDuration();
    }

    clearBufferedRanges() {
        for (let type in this._sourceBuffers) {
            this._clearTypeBufferedRanges(type);
        }
    }

    _clearTypeBufferedRanges(type) {
        if (!this._sourceBuffers[type]) {
            return;
        }

        // abort current buffer append algorithm
        let sb = this._sourceBuffers[type];
        if (this._mediaSource.readyState === 'open') {
            try {
                // If range removal algorithm is running, InvalidStateError will be throwed
                // Ignore it.
                sb.abort();
            } catch (error) {
                Log.e(this.TAG, error.message);
            }
        }

        if (this._mediaSource.readyState === 'closed') {
            // Parent MediaSource object has been detached from HTMLMediaElement
            return;
        }

        // record ranges to be remove from SourceBuffer
        for (let i = 0; i < sb.buffered.length; i++) {
            let start = sb.buffered.start(i);
            let end = sb.buffered.end(i);
            this._pendingRemoveRanges[type].push({start, end});
        }
        Log.v(this.TAG, `Clear ${type} SourceBuffer`);

        // if sb is not updating, let's remove ranges now!
        if (!sb.updating) {
            this._doRemoveRanges();
        }

    }

    endOfStream() {
        let ms = this._mediaSource;
        let sb = this._sourceBuffers;
        if (!ms || ms.readyState !== 'open') {
            return;
        }
        if (sb.video && sb.video.updating || sb.audio && sb.audio.updating) {
            // If any sourcebuffer is updating, defer endOfStream operation
            // See _onSourceBufferUpdateEnd()
            this._hasPendingEos = true;
        } else {
            this._hasPendingEos = false;
            // Notify media data loading complete
            // This is helpful for correcting total duration to match last media segment
            // Otherwise MediaElement's ended event may not be triggered
            this._fixDurationOnEndOfStream();
            ms.endOfStream();
        }
    }

    _fixDurationOnEndOfStream() {
        if (this._config.isLive) {
            return;
        }

        let ms = this._mediaSource;
        if (!ms || ms.readyState !== 'open') {
            return;
        }

        let bufferedEnd = this._getBufferedEnd();
        if (bufferedEnd <= 0) {
            return;
        }

        let current = ms.duration;
        if (isFinite(current) && current >= bufferedEnd) {
            return;
        }

        Log.v(this.TAG, `Update MediaSource duration from ${current} to ${bufferedEnd} on endOfStream`);
        ms.duration = bufferedEnd;
    }

    _getBufferedEnd() {
        let end = 0;
        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            if (!sb) {
                continue;
            }

            let buffered = sb.buffered;
            for (let i = 0; i < buffered.length; i++) {
                end = Math.max(end, buffered.end(i));
            }
        }
        return end;
    }

    _updateMediaSourceDuration() {
        if (this._config.isLive) {
            this._requireSetMediaDuration = false;
            this._pendingMediaDuration = 0;
            return;
        }

        let sb = this._sourceBuffers;
        if (this._mediaSource.readyState !== 'open') {
            return;
        }
        if ((sb.video && sb.video.updating) || (sb.audio && sb.audio.updating)) {
            return;
        }

        let current = this._mediaSource.duration;
        let target = this._pendingMediaDuration;

        if (target > 0 && (!isFinite(current) || target > current)) {
            Log.v(this.TAG, `Update MediaSource duration from ${current} to ${target}`);
            this._mediaSource.duration = target;
        }

        this._requireSetMediaDuration = false;
        this._pendingMediaDuration = 0;
    }

    _getLiveBufferedRange() {
        let currentTime = this._mediaElementProxy ? this._mediaElementProxy.getCurrentTime() : 0;
        let start = -Infinity;
        let end = Infinity;
        let hasRange = false;

        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            if (!sb) {
                continue;
            }

            let buffered = sb.buffered;
            if (buffered.length === 0) {
                return null;
            }

            let rangeIndex = buffered.length - 1;
            for (let i = 0; i < buffered.length; i++) {
                let from = buffered.start(i);
                let to = buffered.end(i);
                if (currentTime >= from && currentTime < to) {
                    rangeIndex = i;
                    break;
                }
            }

            start = Math.max(start, buffered.start(rangeIndex));
            end = Math.min(end, buffered.end(rangeIndex));
            hasRange = true;
        }

        if (!hasRange || !isFinite(start) || !isFinite(end) || end <= start) {
            return null;
        }

        return {start, end};
    }

    _updateLiveSeekableRange() {
        if (!this._config.isLive || !this._mediaSource || this._mediaSource.readyState !== 'open') {
            return;
        }
        if (typeof this._mediaSource.setLiveSeekableRange !== 'function') {
            return;
        }
        for (let type in this._sourceBuffers) {
            let sb = this._sourceBuffers[type];
            if (sb && sb.updating) {
                return;
            }
        }

        let range = this._getLiveBufferedRange();
        if (!range) {
            this._clearLiveSeekableRange();
            return;
        }

        let start = Math.max(0, range.start);
        let end = range.end;
        if (end <= start) {
            this._clearLiveSeekableRange();
            return;
        }

        let last = this._lastLiveSeekableRange;
        if (Math.abs(last.start - start) < 0.25 && Math.abs(last.end - end) < 0.25) {
            return;
        }

        try {
            this._mediaSource.setLiveSeekableRange(start, end);
            last.start = start;
            last.end = end;
        } catch (error) {
            Log.w(this.TAG, `Failed to update live seekable range: ${error.message}`);
        }
    }

    _clearLiveSeekableRange() {
        if (!this._mediaSource ||
            this._mediaSource.readyState !== 'open' ||
            typeof this._mediaSource.clearLiveSeekableRange !== 'function') {
            return;
        }

        try {
            this._mediaSource.clearLiveSeekableRange();
            this._lastLiveSeekableRange.start = NaN;
            this._lastLiveSeekableRange.end = NaN;
        } catch (error) {
            Log.w(this.TAG, `Failed to clear live seekable range: ${error.message}`);
        }
    }

    _doRemoveRanges() {
        for (let type in this._pendingRemoveRanges) {
            if (!this._sourceBuffers[type] || this._sourceBuffers[type].updating) {
                continue;
            }
            let sb = this._sourceBuffers[type];
            let ranges = this._pendingRemoveRanges[type];
            while (ranges.length && !sb.updating) {
                let range = ranges.shift();
                sb.remove(range.start, range.end);
            }
        }
    }

    _isBatchableMediaSegment(segment) {
        return segment &&
            segment.info &&
            segment.data &&
            segment.data.byteLength > 0 &&
            segment.timestampOffset == null &&
            !segment.resetParserState;
    }

    _getMediaSegmentTimelineBegin(segment) {
        const info = segment.info;
        let begin = Infinity;
        if (isFinite(info.beginDts)) {
            begin = Math.min(begin, info.beginDts);
        }
        if (isFinite(info.beginPts)) {
            begin = Math.min(begin, info.beginPts);
        }
        if (info.firstSample) {
            if (isFinite(info.firstSample.dts)) {
                begin = Math.min(begin, info.firstSample.dts);
            }
            if (isFinite(info.firstSample.pts)) {
                begin = Math.min(begin, info.firstSample.pts);
            }
        }
        return begin / 1000;
    }

    _getMediaSegmentTimelineEnd(segment) {
        const info = segment.info;
        let end = -Infinity;
        if (isFinite(info.endDts)) {
            end = Math.max(end, info.endDts);
        }
        if (isFinite(info.endPts)) {
            end = Math.max(end, info.endPts);
        }
        if (info.lastSample) {
            if (isFinite(info.lastSample.dts) && isFinite(info.lastSample.duration)) {
                end = Math.max(end, info.lastSample.dts + info.lastSample.duration);
            }
            if (isFinite(info.lastSample.pts) && isFinite(info.lastSample.duration)) {
                end = Math.max(end, info.lastSample.pts + info.lastSample.duration);
            }
        }
        return end / 1000;
    }

    _recordAppendedMediaSegment(type, segment) {
        if (!this._bufferedSegmentRecords[type] ||
            !this._isBatchableMediaSegment(segment)) {
            return;
        }

        const begin = this._getMediaSegmentTimelineBegin(segment);
        const end = this._getMediaSegmentTimelineEnd(segment);
        if (!isFinite(begin) || !isFinite(end) || end <= begin) {
            return;
        }

        this._bufferedSegmentRecords[type].push({
            begin,
            end,
            byteLength: segment.data.byteLength,
            pending: true
        });
    }

    getForwardBufferInfo(currentTime) {
        if (typeof currentTime !== 'number' || !isFinite(currentTime)) {
            return {
                currentTime: 0,
                forwardBytes: 0,
                audioForwardBytes: 0,
                videoForwardBytes: 0
            };
        }

        this._syncBufferedSegmentRecords();
        const audioForwardBytes = this._getTypeForwardBufferBytes('audio', currentTime);
        const videoForwardBytes = this._getTypeForwardBufferBytes('video', currentTime);
        const audioBufferedBytes = this._getTypeBufferedBytes('audio');
        const videoBufferedBytes = this._getTypeBufferedBytes('video');
        const audioForwardDuration = this._getTypeForwardBufferDuration('audio', currentTime);
        const videoForwardDuration = this._getTypeForwardBufferDuration('video', currentTime);

        return {
            currentTime,
            forwardBytes: audioForwardBytes + videoForwardBytes,
            audioForwardBytes,
            videoForwardBytes,
            audioBufferedBytes,
            videoBufferedBytes,
            forwardDuration: Math.min(audioForwardDuration, videoForwardDuration),
            audioForwardDuration,
            videoForwardDuration
        };
    }

    _syncBufferedSegmentRecords() {
        for (let type in this._bufferedSegmentRecords) {
            const records = this._bufferedSegmentRecords[type];
            const sb = this._sourceBuffers[type];
            if (!records || !sb) {
                continue;
            }
            if (records.length === 0) {
                continue;
            }

            const buffered = sb.buffered;
            const clippedRecords = [];
            for (let readIndex = 0; readIndex < records.length; readIndex++) {
                const record = records[readIndex];
                if (record.pending === true) {
                    clippedRecords.push(record);
                    continue;
                }
                this._appendBufferedRecordIntersections(clippedRecords, record, buffered);
            }
            records.splice(0, records.length, ...clippedRecords);
        }
    }

    _appendBufferedRecordIntersections(output, record, ranges) {
        const duration = record.end - record.begin;
        if (!isFinite(duration) || duration <= 0 || !isFinite(record.byteLength) || record.byteLength <= 0) {
            return;
        }

        for (let i = 0; i < ranges.length; i++) {
            const start = Math.max(record.begin, ranges.start(i));
            const end = Math.min(record.end, ranges.end(i));
            if (end <= start) {
                continue;
            }

            output.push({
                begin: start,
                end,
                byteLength: Math.ceil(record.byteLength * ((end - start) / duration))
            });
        }
    }

    _getTypeForwardBufferBytes(type, currentTime) {
        const records = this._bufferedSegmentRecords[type];
        if (!records || records.length === 0) {
            return 0;
        }

        let bytes = 0;
        for (let record of records) {
            if (record.end <= currentTime) {
                continue;
            }

            const overlapStart = Math.max(record.begin, currentTime);
            const overlapEnd = record.end;
            if (overlapEnd <= overlapStart) {
                continue;
            }

            const duration = record.end - record.begin;
            bytes += duration > 0 ?
                record.byteLength * ((overlapEnd - overlapStart) / duration) :
                record.byteLength;
        }
        return Math.ceil(bytes);
    }

    _getTypeBufferedBytes(type) {
        const records = this._bufferedSegmentRecords[type];
        if (!records || records.length === 0) {
            return 0;
        }

        let bytes = 0;
        for (let record of records) {
            if (isFinite(record.byteLength) && record.byteLength > 0) {
                bytes += record.byteLength;
            }
        }
        return Math.ceil(bytes);
    }

    _getTypeForwardBufferDuration(type, currentTime) {
        const end = this._getTypeForwardBufferedRecordEnd(type, currentTime);
        return isFinite(end) ? Math.max(0, end - currentTime) : 0;
    }

    _getTypeForwardBufferedRecordEnd(type, currentTime) {
        const records = this._bufferedSegmentRecords[type];
        if (!records || records.length === 0) {
            return NaN;
        }

        const mergeGap = 0.12;
        const forwardRecords = [];
        for (let record of records) {
            if (!isFinite(record.begin) || !isFinite(record.end) || record.end <= currentTime) {
                continue;
            }
            forwardRecords.push(record);
        }
        if (forwardRecords.length === 0) {
            return NaN;
        }

        forwardRecords.sort((a, b) => {
            if (a.begin === b.begin) {
                return a.end - b.end;
            }
            return a.begin - b.begin;
        });

        let end = NaN;
        for (let record of forwardRecords) {
            if (record.pending === true) {
                continue;
            }
            if (!isFinite(end)) {
                if (record.begin > currentTime + mergeGap) {
                    break;
                }
                end = record.end;
                continue;
            }
            if (record.begin > end + mergeGap) {
                break;
            }
            end = Math.max(end, record.end);
        }
        return end;
    }

    _markAppendedMediaSegmentRecordsComplete(type) {
        const records = this._bufferedSegmentRecords[type];
        if (!records) {
            return;
        }
        for (let record of records) {
            if (record.pending === true) {
                record.pending = false;
            }
        }
    }

    _emitFatalMediaError(error) {
        if (this._hasFatalMediaError) {
            return;
        }

        this._hasFatalMediaError = true;
        Log.e(this.TAG, error.message);
        this._emitter.emit(MSEEvents.ERROR, {code: error.code, msg: error.message});
    }

    _onSourceOpen() {
        Log.v(this.TAG, 'MediaSource onSourceOpen');
        this._mediaSource.removeEventListener('sourceopen', this.e.onSourceOpen);
        if (this._config.isLive) {
            try {
                this._mediaSource.duration = Infinity;
                this._clearLiveSeekableRange();
            } catch (error) {
                Log.e(this.TAG, error.message);
            }
        }
        if (this._requireSetMediaDuration) {
            this._updateMediaSourceDuration();
        }
        this._emitter.emit(MSEEvents.SOURCE_OPEN);
    }

    _onStartStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onStartStreaming');
        this._emitter.emit(MSEEvents.START_STREAMING);
    }

    _onEndStreaming() {
        Log.v(this.TAG, 'ManagedMediaSource onEndStreaming');
        this._emitter.emit(MSEEvents.END_STREAMING);
    }

    _onQualityChange() {
        Log.v(this.TAG, 'ManagedMediaSource onQualityChange');
    }

    _onSourceEnded() {
        // fired on endOfStream
        Log.v(this.TAG, 'MediaSource onSourceEnded');
    }

    _onSourceClose() {
        // fired on detaching from media element
        Log.v(this.TAG, 'MediaSource onSourceClose');
        if (this._mediaSource && this.e != null) {
            this._mediaSource.removeEventListener('sourceopen', this.e.onSourceOpen);
            this._mediaSource.removeEventListener('sourceended', this.e.onSourceEnded);
            this._mediaSource.removeEventListener('sourceclose', this.e.onSourceClose);
            if (this._useManagedMediaSource) {
                this._mediaSource.removeEventListener('startstreaming', this.e.onStartStreaming);
                this._mediaSource.removeEventListener('endstreaming', this.e.onEndStreaming);
                this._mediaSource.removeEventListener('qualitychange', this.e.onQualityChange);
            }
        }
    }

    _hasPendingRemoveRanges() {
        let prr = this._pendingRemoveRanges;
        return prr.video.length > 0 || prr.audio.length > 0;
    }

    _onSourceBufferUpdateEnd(e) {
        if (this._requireSetMediaDuration) {
            this._updateMediaSourceDuration();
        } else if (this._hasPendingRemoveRanges()) {
            this._doRemoveRanges();
        } else if (this._hasPendingEos) {
            this.endOfStream();
        }
        this._updateLiveSeekableRange();
        let type = undefined;
        if (e && e.target) {
            for (let mediaType in this._sourceBuffers) {
                if (this._sourceBuffers[mediaType] === e.target) {
                    type = mediaType;
                    break;
                }
            }
        }
        if (type !== undefined) {
            this._markAppendedMediaSegmentRecordsComplete(type);
        }
        this._emitter.emit(MSEEvents.UPDATE_END, type);
    }

    _onSourceBufferError(e) {
        Log.e(this.TAG, `SourceBuffer Error: ${e}`);
        // this error might not always be fatal, just ignore it
    }

}

export default MSEController;

/*
 * Copyright (C) 2023 zheng qian. All Rights Reserved.
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

import Browser from '../utils/browser';
import { IDRSampleList } from '../core/media-segment-info';

class SeekingHandler {

    private readonly TAG: string = 'SeekingHandler';

    private _config: any = null;
    private _media_element: HTMLMediaElement = null;
    private _always_seek_keyframe: boolean = false;
    private _on_unbuffered_seek: (milliseconds: number) => void = null;
    private _on_seek_request?: (seconds: number, source: string) => boolean = null;

    private _request_set_current_time: boolean = false;
    private _seek_request_record_clocktime?: number = null;
    private _controlled_media_seek_timer?: number = null;
    private _controlled_media_seek_target?: number = null;
    private _idr_sample_list: IDRSampleList = new IDRSampleList();

    private e?: any = null;

    public constructor(
        config: any,
        media_element: HTMLMediaElement,
        on_unbuffered_seek: (milliseconds: number) => void,
        on_seek_request?: (seconds: number, source: string) => boolean
    ) {
        this._config = config;
        this._media_element = media_element;
        this._on_unbuffered_seek = on_unbuffered_seek;
        this._on_seek_request = on_seek_request || null;

        this.e = {
            onMediaSeeking: this._onMediaSeeking.bind(this),
        };

        let chrome_need_idr_fix = (Browser.chrome &&
                                  (Browser.version.major < 50 ||
                                  (Browser.version.major === 50 && Browser.version.build < 2661)));
        this._always_seek_keyframe = (chrome_need_idr_fix || Browser.msedge || Browser.msie) ? true : false;
        if (this._always_seek_keyframe) {
            this._config.accurateSeek = false;
        }

        this._media_element.addEventListener('seeking', this.e.onMediaSeeking);
    }

    public destroy(): void {
        this._cancelControlledMediaSeek();
        this._idr_sample_list.clear();
        this._idr_sample_list = null;
        this._media_element.removeEventListener('seeking', this.e.onMediaSeeking);
        this._media_element = null;
        this._on_unbuffered_seek = null;
        this._on_seek_request = null;
    }

    public seek(seconds: number): void {
        this._cancelControlledMediaSeek();
        if (!this._config.isLive && this._requestControlledSeek(seconds, 'api')) {
            return;
        }

        if (this._config.isLive) {
            const liveTarget = this._clampLiveSeekTarget(seconds);
            if (liveTarget != null) {
                this.directSeek(liveTarget);
            }
            return;
        }

        const direct_seek: boolean = this._isPositionBuffered(seconds);
        let direct_seek_to_video_begin: boolean = false;

        if (seconds < 1.0 && this._media_element.buffered.length > 0) {
            const video_begin_time = this._media_element.buffered.start(0);
            if ((video_begin_time < 1.0 && seconds < video_begin_time) || Browser.safari) {
                direct_seek_to_video_begin = true;
                // Workaround for Safari: Seek to 0 may cause video stuck, use 0.1 to avoid
                seconds = Browser.safari ? 0.1 : video_begin_time;
            }
        }

        if (direct_seek_to_video_begin) {
            this.directSeek(seconds);
        } else if (direct_seek) {
            if (!this._always_seek_keyframe) {
                this.directSeek(seconds);
            } else {
                // For some old browsers we have to seek to keyframe
                // Seek to nearest keyframe if possible
                const idr = this._getNearestKeyframe(Math.floor(seconds * 1000));
                if (idr != null) {
                    seconds = idr.dts / 1000;
                }
                this.directSeek(seconds);
            }
        } else {
            this._idr_sample_list.clear();
            this._on_unbuffered_seek(Math.round(seconds * 1000000) / 1000);  // In milliseconds
            if (this._config.accurateSeek) {
                this.directSeek(seconds);
            }
            // else: Wait for recommend_seekpoint callback
        }
    }

    public directSeek(seconds: number): void {
        if (this._media_element &&
            typeof this._media_element.currentTime === 'number' &&
            isFinite(this._media_element.currentTime) &&
            Math.abs(this._media_element.currentTime - seconds) < 0.001) {
            return;
        }
        this._request_set_current_time = true;
        this._media_element.currentTime = seconds;
    }

    public appendSyncPoints(syncpoints: any[]): void {
        this._idr_sample_list.appendArray(syncpoints);
    }

    // Handle seeking request from browser's progress bar or HTMLMediaElement.currentTime setter
    private _onMediaSeeking(e: Event): void {
        if (this._request_set_current_time) {
            this._request_set_current_time = false;
            return;
        }

        let target: number = this._media_element.currentTime;

        if (this._shouldCoalesceControlledMediaSeek()) {
            this._scheduleControlledMediaSeek(target);
            return;
        }

        if (!this._config.isLive && this._requestControlledSeek(target, 'media')) {
            return;
        }

        this._applyMediaSeeking(target);
    }

    private _applyMediaSeeking(target: number, deferUnbufferedSeek: boolean = true): void {
        const buffered: TimeRanges = this._media_element.buffered;

        if (this._config.isLive) {
            const liveTarget = this._clampLiveSeekTarget(target);
            if (liveTarget != null && Math.abs(liveTarget - target) > 0.01) {
                this.directSeek(liveTarget);
            }
            return;
        }

        // Handle seeking to video begin (near 0.0s)
        if (target < 1.0 && buffered.length > 0) {
            let video_begin_time = buffered.start(0);
            if ((video_begin_time < 1.0 && target < video_begin_time) || Browser.safari) {
                // Safari may get stuck if currentTime set to 0, use 0.1 to avoid
                let target: number = Browser.safari ? 0.1 : video_begin_time;
                this.directSeek(target);
                return;
            }
        }

        // Handle in-buffer seeking (usually nothing to do)
        if (this._isPositionBuffered(target)) {
            if (this._always_seek_keyframe) {
                const idr = this._getNearestKeyframe(Math.floor(target * 1000));
                if (idr != null) {
                    target = idr.dts / 1000;
                    this.directSeek(target);
                }
            }
            return;
        }

        if (deferUnbufferedSeek) {
            // else: Prepare for unbuffered seeking
            // Defer the unbuffered seeking since the seeking bar maybe still being draged
            this._seek_request_record_clocktime = SeekingHandler._getClockTime();
            window.setTimeout(this._pollAndApplyUnbufferedSeek.bind(this), 50);
        } else {
            this._applyUnbufferedSeek(target);
        }

    }

    private _shouldCoalesceControlledMediaSeek(): boolean {
        return this._config.isMMTS === true &&
            this._config.isLive !== true &&
            this._on_seek_request != null;
    }

    private _scheduleControlledMediaSeek(target: number): void {
        this._cancelControlledMediaSeek();
        this._controlled_media_seek_target = target;
        this._controlled_media_seek_timer = window.setTimeout(() => {
            this._controlled_media_seek_timer = null;
            const pendingTarget = this._controlled_media_seek_target;
            this._controlled_media_seek_target = null;
            if (pendingTarget == null || this._media_element == null) {
                return;
            }
            if (!this._requestControlledSeek(pendingTarget, 'media')) {
                this._applyMediaSeeking(pendingTarget, false);
            }
        }, this._getControlledSeekDebounceInterval());
    }


    private _getControlledSeekDebounceInterval(): number {
        const configured = this._config && this._config.mmtsSeekDebounceInterval;
        return typeof configured === 'number' && isFinite(configured) && configured >= 0 ?
            configured : 100;
    }

    private _cancelControlledMediaSeek(): void {
        if (this._controlled_media_seek_timer != null) {
            window.clearTimeout(this._controlled_media_seek_timer);
            this._controlled_media_seek_timer = null;
        }
        this._controlled_media_seek_target = null;
    }

    private _pollAndApplyUnbufferedSeek(): void {
        if (this._seek_request_record_clocktime == null) {
            return;
        }

        const record_time: number = this._seek_request_record_clocktime;
        if (record_time <= SeekingHandler._getClockTime() - 100) {
            const target = this._media_element.currentTime;
            this._seek_request_record_clocktime = null;
            this._applyUnbufferedSeek(target);
        } else {
            window.setTimeout(this._pollAndApplyUnbufferedSeek.bind(this), 50);
        }
    }

    private _applyUnbufferedSeek(target: number): void {
        if (!this._isPositionBuffered(target)) {
            this._idr_sample_list.clear();
            this._on_unbuffered_seek(Math.round(target * 1000000) / 1000);  // In milliseconds
            // Update currentTime if using accurateSeek, or wait for recommend_seekpoint callback
            if (this._config.accurateSeek) {
                this.directSeek(target);
            }
        }
    }

    private _isPositionBuffered(seconds: number): boolean {
        const buffered = this._media_element.buffered;

        for (let i = 0; i < buffered.length; i++) {
            const from = buffered.start(i);
            const to = buffered.end(i);
            if (seconds >= from && seconds < to) {
                return true;
            }
        }

        return false;
    }

    private _requestControlledSeek(seconds: number, source: string): boolean {
        if (!this._on_seek_request || typeof seconds !== 'number' || !isFinite(seconds)) {
            return false;
        }
        return this._on_seek_request(seconds, source) === true;
    }

    private _clampLiveSeekTarget(seconds: number): number | null {
        const range = this._getLiveSeekableRange();
        if (range == null) {
            return null;
        }

        if (seconds < range.start) {
            return range.start;
        }

        if (seconds >= range.end) {
            return Math.max(range.start, range.end - 0.05);
        }

        return seconds;
    }

    private _getLiveSeekableRange(): {start: number, end: number} | null {
        const seekable = this._media_element.seekable;
        const seekableRange = this._getLastValidRange(seekable);
        if (seekableRange != null) {
            return seekableRange;
        }

        return this._getLastValidRange(this._media_element.buffered);
    }

    private _getLastValidRange(ranges: TimeRanges): {start: number, end: number} | null {
        for (let i = ranges.length - 1; i >= 0; i--) {
            const start = ranges.start(i);
            const end = ranges.end(i);
            if (isFinite(start) && isFinite(end) && end > start) {
                return {start, end};
            }
        }

        return null;
    }

    private _getNearestKeyframe(dts: number): any {
        return this._idr_sample_list.getLastSyncPointBeforeDts(dts);
    }

    private static _getClockTime(): number {
        if (self.performance && self.performance.now) {
            return self.performance.now();
        } else {
            return Date.now();
        }
    }

}

export default SeekingHandler;

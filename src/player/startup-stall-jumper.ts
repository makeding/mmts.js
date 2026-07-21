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

import Log from '../utils/logger';
import BufferWindow, {BufferWindowInfo} from './buffer-window';

class StartupStallJumper {

    private readonly TAG: string = 'StartupStallJumper';

    private _media_element: HTMLMediaElement = null;
    private _on_direct_seek: (target: number) => boolean | void = null;
    private _canplay_received: boolean = false;
    private _last_jump_target: number = -1;
    private _last_jump_clock: number = 0;
    private _stall_check_timer: number | null = null;
    private _stall_check_time: number = 0;
    private _max_jump_gap: number = 0.75;
    private _min_jump_buffer: number = 0.05;
    private _allow_range_gap_jump: boolean = true;
    private _use_buffered_jump: boolean = true;
    private _defer_stalled_jump: boolean = false;
    private _conservative_in_range_recovery: boolean = false;
    private _on_continuous_buffer_stall: (() => void) | null = null;

    private e: any = null;

    public constructor(
        media_element: HTMLMediaElement,
        on_direct_seek: (target: number) => boolean | void,
        max_jump_gap?: number,
        min_jump_buffer?: number,
        allow_range_gap_jump?: boolean,
        use_buffered_jump?: boolean,
        defer_stalled_jump?: boolean,
        conservative_in_range_recovery?: boolean,
        on_continuous_buffer_stall?: () => void
    ) {
        this._media_element = media_element;
        this._on_direct_seek = on_direct_seek;
        if (typeof max_jump_gap === 'number' && isFinite(max_jump_gap) && max_jump_gap > 0) {
            this._max_jump_gap = max_jump_gap;
        }
        if (typeof min_jump_buffer === 'number' && isFinite(min_jump_buffer) && min_jump_buffer > 0) {
            this._min_jump_buffer = min_jump_buffer;
        }
        if (typeof allow_range_gap_jump === 'boolean') {
            this._allow_range_gap_jump = allow_range_gap_jump;
        }
        if (typeof use_buffered_jump === 'boolean') {
            this._use_buffered_jump = use_buffered_jump;
        }
        if (typeof defer_stalled_jump === 'boolean') {
            this._defer_stalled_jump = defer_stalled_jump;
        }
        if (typeof conservative_in_range_recovery === 'boolean') {
            this._conservative_in_range_recovery = conservative_in_range_recovery;
        }
        if (typeof on_continuous_buffer_stall === 'function') {
            this._on_continuous_buffer_stall = on_continuous_buffer_stall;
        }

        this.e = {
            onMediaCanPlay: this._onMediaCanPlay.bind(this),
            onMediaPlaying: this._onMediaPlaying.bind(this),
            onMediaStalled: this._onMediaStalled.bind(this),
            onMediaWaiting: this._onMediaWaiting.bind(this),
            onMediaProgress: this._onMediaProgress.bind(this),
        };

        this._media_element.addEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.addEventListener('playing', this.e.onMediaPlaying);
        this._media_element.addEventListener('stalled', this.e.onMediaStalled);
        this._media_element.addEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.addEventListener('progress', this.e.onMediaProgress);
    }

    public destroy(): void {
        this._clearStallCheckTimer();
        this._media_element.removeEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.removeEventListener('playing', this.e.onMediaPlaying);
        this._media_element.removeEventListener('stalled', this.e.onMediaStalled);
        this._media_element.removeEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.removeEventListener('progress', this.e.onMediaProgress);
        this._media_element = null;
        this._on_direct_seek = null;
        this._on_continuous_buffer_stall = null;
    }

    private _onMediaCanPlay(e: Event): void {
        this._canplay_received = true;
        // Remove canplay listener since it will be fired multiple times
        this._media_element.removeEventListener('canplay', this.e.onMediaCanPlay);
    }

    private _onMediaPlaying(e: Event): void {
        this._scheduleStallCheck();
    }

    private _onMediaStalled(e: Event): void {
        if (!this._defer_stalled_jump) {
            this._detectAndFixStuckPlayback(true);
        }
        this._scheduleStallCheck();
    }

    private _onMediaWaiting(e: Event): void {
        if (!this._defer_stalled_jump) {
            this._detectAndFixStuckPlayback(true);
        }
        this._scheduleStallCheck();
    }

    private _onMediaProgress(e: Event): void {
        this._detectAndFixStuckPlayback();
    }

    private _detectAndFixStuckPlayback(is_stalled?: boolean): void {
        const media = this._media_element;

        if (is_stalled || !this._canplay_received || media.readyState < 2) {  // HAVE_CURRENT_DATA
            const target = this._findJumpTarget(media, false);
            if (target != null && this._shouldJumpTo(target)) {
                Log.w(this.TAG, `Playback seems stuck at ${media.currentTime}, seek to ${target}`);
                if (this._requestJump(target)) {
                    this._media_element.removeEventListener('progress', this.e.onMediaProgress);
                }
            }
        } else {
            // Playback doesn't stuck, remove progress event listener
            this._media_element.removeEventListener('progress', this.e.onMediaProgress);
        }
    }

    private _findJumpTarget(media: HTMLMediaElement, allowSmallForwardJump: boolean): number | null {
        if (!this._use_buffered_jump) {
            return media.currentTime + 0.35;
        }
        return this._findBufferedJumpTarget(media) ||
            (allowSmallForwardJump ? this._findSmallForwardJumpTarget(media) : null);
    }

    private _findBufferedJumpTarget(media: HTMLMediaElement): number | null {
        const current = media.currentTime;
        const tolerance = 0.05;
        const window = BufferWindow.inspect(media.buffered, current, {
            tolerance,
            mergeGap: 0.12,
            edgeTolerance: 0.2,
        });

        if (window.currentRangeIndex < 0) {
            if (window.nextRangeStart !== undefined) {
                if (window.nextRangeStart <= tolerance) {
                    return window.nextRangeStart;
                }
                if (!this._allow_range_gap_jump) {
                    return null;
                }
                return this._getRangeGapJumpTarget(window);
            }
            return null;
        }

        if (window.atCurrentRangeEnd && window.nextRangeStart !== undefined) {
            if (!this._allow_range_gap_jump) {
                return null;
            }
            return this._getRangeGapJumpTarget(window);
        }

        return null;
    }

    private _getRangeGapJumpTarget(window: BufferWindowInfo): number | null {
        if (window.nextRangeStart === undefined ||
            window.nextRangeEnd === undefined ||
            window.nextRangeGap === undefined) {
            return null;
        }

        if (window.nextRangeGap > this._max_jump_gap) {
            return null;
        }

        if (window.nextRangeEnd < window.nextRangeStart + this._min_jump_buffer) {
            return null;
        }

        return window.nextRangeStart;
    }

    private _scheduleStallCheck(preserveStart?: boolean): void {
        const media = this._media_element;
        if (media == null || media.paused || media.ended || media.seeking) {
            return;
        }

        this._clearStallCheckTimer();
        if (!preserveStart) {
            this._stall_check_time = media.currentTime;
        }
        this._stall_check_timer = window.setTimeout(this._onStallCheckTimer.bind(this), 1200);
    }

    private _clearStallCheckTimer(): void {
        if (this._stall_check_timer == null) {
            return;
        }

        window.clearTimeout(this._stall_check_timer);
        this._stall_check_timer = null;
    }

    private _onStallCheckTimer(): void {
        this._stall_check_timer = null;

        const media = this._media_element;
        if (media == null || media.paused || media.ended || media.seeking) {
            return;
        }

        if (media.currentTime > this._stall_check_time + 0.05) {
            return;
        }

        const bufferedTarget = this._findBufferedJumpTarget(media);
        if (bufferedTarget != null) {
            if (!this._shouldJumpTo(bufferedTarget)) {
                this._scheduleStallCheck(true);
                return;
            }
            Log.w(this.TAG, `Playback still stuck at ${media.currentTime}, fast-forward to ${bufferedTarget}`);
            this._requestJump(bufferedTarget);
            return;
        }

        if (this._conservative_in_range_recovery) {
            // A continuous MMTS VOD range is not a seek gap. Safari/AirPlay can
            // keep currentTime still while it asks MSE for a larger remote
            // playback queue. Notify the buffer owner and keep checking; a
            // speculative seek would only restart that queue.
            this._on_continuous_buffer_stall?.();
            this._scheduleStallCheck(true);
            return;
        }

        const target = this._findSmallForwardJumpTarget(media);
        if (target == null) {
            return;
        }

        if (!this._shouldJumpTo(target)) {
            this._scheduleStallCheck();
            return;
        }

        Log.w(this.TAG, `Playback still stuck at ${media.currentTime}, fast-forward to ${target}`);
        this._requestJump(target);
    }

    private _findSmallForwardJumpTarget(media: HTMLMediaElement): number | null {
        const current = media.currentTime;
        const target = current + 0.35;
        const buffered = media.buffered;
        const tolerance = 0.05;
        const min_forward_buffer = 0.35;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (current >= start - tolerance && current + min_forward_buffer < end - tolerance) {
                return Math.min(target, end - tolerance);
            }
        }

        return null;
    }

    private _shouldJumpTo(target: number): boolean {
        const now = StartupStallJumper._getClockTime();
        return Math.abs(target - this._last_jump_target) > 0.01 || now - this._last_jump_clock > 1000;
    }

    private _requestJump(target: number): boolean {
        const accepted = this._on_direct_seek(target);
        if (accepted === false) {
            return false;
        }
        this._last_jump_target = target;
        this._last_jump_clock = StartupStallJumper._getClockTime();
        return true;
    }

    private static _getClockTime(): number {
        return self.performance && self.performance.now ? self.performance.now() : Date.now();
    }

}

export default StartupStallJumper;

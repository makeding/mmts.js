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

class StartupStallJumper {

    private readonly TAG: string = 'StartupStallJumper';

    private _media_element: HTMLMediaElement = null;
    private _on_direct_seek: (target: number) => void = null;
    private _canplay_received: boolean = false;
    private _last_jump_target: number = -1;
    private _last_jump_clock: number = 0;
    private _stall_check_timer: number | null = null;
    private _stall_check_time: number = 0;

    private e: any = null;

    public constructor(media_element: HTMLMediaElement, on_direct_seek: (target: number) => void) {
        this._media_element = media_element;
        this._on_direct_seek = on_direct_seek;

        this.e = {
            onMediaCanPlay: this._onMediaCanPlay.bind(this),
            onMediaStalled: this._onMediaStalled.bind(this),
            onMediaWaiting: this._onMediaWaiting.bind(this),
            onMediaProgress: this._onMediaProgress.bind(this),
        };

        this._media_element.addEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.addEventListener('stalled', this.e.onMediaStalled);
        this._media_element.addEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.addEventListener('progress', this.e.onMediaProgress);
    }

    public destroy(): void {
        this._clearStallCheckTimer();
        this._media_element.removeEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.removeEventListener('stalled', this.e.onMediaStalled);
        this._media_element.removeEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.removeEventListener('progress', this.e.onMediaProgress);
        this._media_element = null;
        this._on_direct_seek = null;
    }

    private _onMediaCanPlay(e: Event): void {
        this._canplay_received = true;
        // Remove canplay listener since it will be fired multiple times
        this._media_element.removeEventListener('canplay', this.e.onMediaCanPlay);
    }

    private _onMediaStalled(e: Event): void {
        this._detectAndFixStuckPlayback(true);
        this._scheduleStallCheck();
    }

    private _onMediaWaiting(e: Event): void {
        this._detectAndFixStuckPlayback(true);
        this._scheduleStallCheck();
    }

    private _onMediaProgress(e: Event): void {
        this._detectAndFixStuckPlayback();
    }

    private _detectAndFixStuckPlayback(is_stalled?: boolean): void {
        const media = this._media_element;
        const buffered = media.buffered;

        if (is_stalled || !this._canplay_received || media.readyState < 2) {  // HAVE_CURRENT_DATA
            const target = this._findBufferedJumpTarget(media);
            if (target != null && this._shouldJumpTo(target)) {
                Log.w(this.TAG, `Playback seems stuck at ${media.currentTime}, seek to ${target}`);
                this._last_jump_target = target;
                this._last_jump_clock = StartupStallJumper._getClockTime();
                this._on_direct_seek(target);
                this._media_element.removeEventListener('progress', this.e.onMediaProgress);
            }
        } else {
            // Playback doesn't stuck, remove progress event listener
            this._media_element.removeEventListener('progress', this.e.onMediaProgress);
        }
    }

    private _findBufferedJumpTarget(media: HTMLMediaElement): number | null {
        const buffered = media.buffered;
        const current = media.currentTime;
        const tolerance = 0.05;
        const edge_tolerance = 0.2;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);

            if (current < start - tolerance) {
                return start;
            }

            if (current >= start - tolerance && current <= end + tolerance) {
                if (current >= end - edge_tolerance && i + 1 < buffered.length) {
                    const next_start = buffered.start(i + 1);
                    if (next_start > current + tolerance) {
                        return next_start;
                    }
                }
                return null;
            }
        }

        return null;
    }

    private _scheduleStallCheck(): void {
        const media = this._media_element;
        if (media == null || media.paused || media.ended || media.seeking) {
            return;
        }

        this._clearStallCheckTimer();
        this._stall_check_time = media.currentTime;
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

        const target = this._findBufferedJumpTarget(media) || this._findSmallForwardJumpTarget(media);
        if (target == null || !this._shouldJumpTo(target)) {
            return;
        }

        Log.w(this.TAG, `Playback still stuck at ${media.currentTime}, fast-forward to ${target}`);
        this._last_jump_target = target;
        this._last_jump_clock = StartupStallJumper._getClockTime();
        this._on_direct_seek(target);
    }

    private _findSmallForwardJumpTarget(media: HTMLMediaElement): number | null {
        const current = media.currentTime;
        const target = current + 0.35;
        const buffered = media.buffered;
        const tolerance = 0.05;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (current >= start - tolerance && current < end - tolerance) {
                return Math.min(target, end - tolerance);
            }
        }

        if (buffered.length === 0 && media.readyState >= 2) {
            return target;
        }

        return null;
    }

    private _shouldJumpTo(target: number): boolean {
        const now = StartupStallJumper._getClockTime();
        return Math.abs(target - this._last_jump_target) > 0.01 || now - this._last_jump_clock > 1000;
    }

    private static _getClockTime(): number {
        return self.performance && self.performance.now ? self.performance.now() : Date.now();
    }

}

export default StartupStallJumper;

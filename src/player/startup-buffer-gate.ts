/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
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

class StartupBufferGate {

    private readonly TAG: string = 'StartupBufferGate';

    private _media_element: HTMLMediaElement = null;
    private _min_forward_buffer: number = 0;
    private _get_forward_buffer_duration?: () => number = null;
    private _on_startup_jump?: (target: number) => boolean | void = null;
    private _requires_startup_group: boolean = false;
    private _startup_group_released: boolean = false;
    private _released: boolean = false;
    private _resume_requested: boolean = false;
    private _holding_playback: boolean = false;
    private _hold_logged: boolean = false;
    private _play_request_id: number = 0;
    private _activation_play_pending: boolean = false;
    private _activation_hold_abort_expected: boolean = false;
    private _last_startup_jump_target: number = -1;
    private _deferred_play_promise?: Promise<void> = null;
    private _resolve_deferred_play?: () => void = null;
    private _reject_deferred_play?: (reason?: any) => void = null;

    private e: any = null;

    public constructor(media_element: HTMLMediaElement,
                       min_forward_buffer: number,
                       get_forward_buffer_duration?: () => number,
                       require_startup_group: boolean = false,
                       on_startup_jump?: (target: number) => boolean | void) {
        this._media_element = media_element;
        this._min_forward_buffer = Math.max(0, min_forward_buffer || 0);
        this._get_forward_buffer_duration = get_forward_buffer_duration || null;
        this._requires_startup_group = require_startup_group === true;
        this._on_startup_jump = on_startup_jump || null;

        this.e = {
            onMediaPlay: this._onMediaPlay.bind(this),
            onMediaPause: this._onMediaPause.bind(this),
            onMediaCanPlay: this._onBufferedRangeUpdate.bind(this),
            onMediaLoadedData: this._onBufferedRangeUpdate.bind(this),
            onMediaProgress: this._onBufferedRangeUpdate.bind(this),
            onMediaSeeked: this._onBufferedRangeUpdate.bind(this),
            onMediaWaiting: this._onBufferedRangeUpdate.bind(this),
        };

        this._media_element.addEventListener('play', this.e.onMediaPlay);
        this._media_element.addEventListener('pause', this.e.onMediaPause);
        this._media_element.addEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.addEventListener('loadeddata', this.e.onMediaLoadedData);
        this._media_element.addEventListener('progress', this.e.onMediaProgress);
        this._media_element.addEventListener('seeked', this.e.onMediaSeeked);
        this._media_element.addEventListener('waiting', this.e.onMediaWaiting);
    }

    public destroy(): void {
        this._media_element.removeEventListener('play', this.e.onMediaPlay);
        this._media_element.removeEventListener('pause', this.e.onMediaPause);
        this._media_element.removeEventListener('canplay', this.e.onMediaCanPlay);
        this._media_element.removeEventListener('loadeddata', this.e.onMediaLoadedData);
        this._media_element.removeEventListener('progress', this.e.onMediaProgress);
        this._media_element.removeEventListener('seeked', this.e.onMediaSeeked);
        this._media_element.removeEventListener('waiting', this.e.onMediaWaiting);
        this.cancelPendingPlay();
        this.e = null;
        this._media_element = null;
        this._on_startup_jump = null;
    }

    public requestPlay(): Promise<void> {
        if (!this._isEnabled()) {
            return this._media_element.play();
        }

        if (this._released || this._hasEnoughInitialBuffer()) {
            this._released = true;
            return this._media_element.play();
        }

        this._resume_requested = true;
        const promise = this._ensureDeferredPlayPromise();
        const requestId = ++this._play_request_id;
        this._activation_play_pending = true;
        this._activation_hold_abort_expected = false;
        let activationPlay: any = null;
        try {
            activationPlay = this._media_element.play();
        } catch (error) {
            if (this._play_request_id === requestId) {
                this._handleActivationPlayFailure(error);
            }
            return promise;
        }
        if (activationPlay && activationPlay.then) {
            activationPlay.then(
                () => {
                    if (this._play_request_id !== requestId) {
                        return;
                    }
                    this._activation_play_pending = false;
                    this._activation_hold_abort_expected = false;
                    this._tryRelease();
                },
                (error) => {
                    if (this._play_request_id !== requestId) {
                        return;
                    }
                    const ignoreHoldAbort = this._activation_hold_abort_expected && this._isAbortError(error);
                    this._activation_play_pending = false;
                    this._activation_hold_abort_expected = false;
                    if (ignoreHoldAbort) {
                        this._tryRelease();
                        return;
                    }
                    this._handleActivationPlayFailure(error);
                }
            );
        } else {
            this._activation_play_pending = false;
        }
        this._holdPlaybackIfNeeded();
        this._tryRelease();
        return promise;
    }

    public cancelPendingPlay(): void {
        this._play_request_id++;
        this._activation_play_pending = false;
        this._activation_hold_abort_expected = false;
        this._resume_requested = false;
        this._rejectDeferredPlay(this._createAbortError());
    }

    public notifyBufferedRangeUpdate(): void {
        this._holdPlaybackIfNeeded();
        this._tryRelease();
    }

    public releaseStartupGroup(): void {
        if (!this._requires_startup_group) {
            return;
        }
        this._startup_group_released = true;
        this._tryRelease();
    }

    private _isEnabled(): boolean {
        return (this._requires_startup_group || this._min_forward_buffer > 0) && this._media_element != null;
    }

    private _onMediaPlay(e: Event): void {
        if (!this._isEnabled() || this._released) {
            return;
        }

        if (this._hasEnoughInitialBuffer()) {
            this._released = true;
            this._resolveDeferredPlay();
            return;
        }

        this._resume_requested = true;
        this._holdPlaybackIfNeeded();
    }

    private _onMediaPause(e: Event): void {
        if (this._holding_playback) {
            this._holding_playback = false;
            return;
        }

        if (!this._released) {
            this.cancelPendingPlay();
        }
    }

    private _onBufferedRangeUpdate(e: Event): void {
        this.notifyBufferedRangeUpdate();
    }

    private _holdPlaybackIfNeeded(): void {
        if (!this._isEnabled() || this._released || this._hasEnoughInitialBuffer() || this._media_element.paused) {
            return;
        }

        this._holding_playback = true;
        if (this._activation_play_pending) {
            this._activation_hold_abort_expected = true;
        }
        this._media_element.pause();
        if (!this._hold_logged) {
            Log.v(
                this.TAG,
                `Hold startup playback until ${this._min_forward_buffer.toFixed(3)}s forward buffer is available`
            );
            this._hold_logged = true;
        }
    }

    private _tryRelease(): void {
        if (!this._isEnabled() ||
            this._released ||
            this._activation_play_pending ||
            !this._resume_requested ||
            !this._hasEnoughInitialBuffer()) {
            return;
        }

        this._released = true;
        this._resume_requested = false;
        const requestId = ++this._play_request_id;
        let playPromise: any = null;
        try {
            playPromise = this._media_element.play();
        } catch (error) {
            if (this._play_request_id === requestId) {
                this._rejectDeferredPlay(error);
            }
            return;
        }
        if (playPromise && playPromise.then) {
            playPromise.then(
                () => {
                    if (this._play_request_id === requestId) {
                        this._resolveDeferredPlay();
                    }
                },
                (error) => {
                    if (this._play_request_id === requestId) {
                        this._rejectDeferredPlay(error);
                    }
                }
            );
        } else {
            this._resolveDeferredPlay();
        }
    }

    private _hasEnoughInitialBuffer(): boolean {
        if (this._requires_startup_group && !this._startup_group_released) {
            return false;
        }
        const forward = this._getForwardBufferDuration();
        if (forward >= this._min_forward_buffer && (!this._requires_startup_group || forward > 0)) {
            return true;
        }
        if (!this._requires_startup_group || !this._moveToBufferedStartupRange()) {
            return false;
        }
        const moved_forward = this._getForwardBufferDuration();
        return moved_forward > 0 && moved_forward >= this._min_forward_buffer;
    }

    private _moveToBufferedStartupRange(): boolean {
        const media = this._media_element;
        const current = media.currentTime;
        const buffered = media.buffered;
        const tolerance = 0.05;
        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (!isFinite(start) || !isFinite(end) ||
                start <= current + tolerance ||
                end - start < this._min_forward_buffer) {
                continue;
            }
            if (Math.abs(start - this._last_startup_jump_target) <= 0.01) {
                return false;
            }
            this._last_startup_jump_target = start;
            Log.v(this.TAG, `Move MMTS startup to buffered range ${start.toFixed(3)}-${end.toFixed(3)}`);
            if (this._on_startup_jump) {
                this._on_startup_jump(start);
            } else {
                media.currentTime = start;
            }
            return true;
        }
        return false;
    }

    private _getForwardBufferDuration(): number {
        if (this._get_forward_buffer_duration) {
            const duration = this._get_forward_buffer_duration();
            return typeof duration === 'number' && isFinite(duration) && duration > 0 ? duration : 0;
        }

        const media = this._media_element;
        const buffered = media.buffered;
        const current = media.currentTime;
        const tolerance = 0.05;
        const merge_gap = 0.12;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);
            if (current < start - tolerance) {
                return 0;
            } else if (current >= start - tolerance && current < end) {
                let contiguous_end = end;
                for (let j = i + 1; j < buffered.length; j++) {
                    const next_start = buffered.start(j);
                    if (next_start > contiguous_end + merge_gap) {
                        break;
                    }
                    contiguous_end = Math.max(contiguous_end, buffered.end(j));
                }
                return contiguous_end - Math.max(current, start);
            }
        }

        return 0;
    }

    private _handleActivationPlayFailure(error: any): void {
        this._activation_play_pending = false;
        this._activation_hold_abort_expected = false;
        this._resume_requested = false;
        this._holding_playback = false;
        this._rejectDeferredPlay(error);
    }

    private _isAbortError(error: any): boolean {
        return error && error.name === 'AbortError';
    }

    private _ensureDeferredPlayPromise(): Promise<void> {
        if (this._deferred_play_promise) {
            return this._deferred_play_promise;
        }

        this._deferred_play_promise = new Promise((resolve, reject) => {
            this._resolve_deferred_play = resolve;
            this._reject_deferred_play = reject;
        });
        return this._deferred_play_promise;
    }

    private _resolveDeferredPlay(): void {
        const resolve = this._resolve_deferred_play;
        this._deferred_play_promise = null;
        this._resolve_deferred_play = null;
        this._reject_deferred_play = null;
        if (resolve) {
            resolve();
        }
    }

    private _rejectDeferredPlay(reason?: any): void {
        const reject = this._reject_deferred_play;
        this._deferred_play_promise = null;
        this._resolve_deferred_play = null;
        this._reject_deferred_play = null;
        if (reject) {
            reject(reason);
        }
    }

    private _createAbortError(): Error {
        const error = new Error('Playback startup was cancelled');
        error.name = 'AbortError';
        return error;
    }

}

export default StartupBufferGate;

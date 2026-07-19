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

import BufferWindow, {BufferWindowInfo} from './buffer-window';

export type ForwardBufferInfo = {
    currentTime: number,
    forwardDuration?: number,
    audioForwardDuration?: number,
    videoForwardDuration?: number,
    forwardBytes: number,
    audioForwardBytes?: number,
    videoForwardBytes?: number,
};

export type ForwardBufferInfoProvider = () => ForwardBufferInfo | null;

class LoadingController {

    private _config: any = null;
    private _media_element: HTMLMediaElement = null;
    private _on_pause_transmuxer: () => void = null;
    private _on_resume_transmuxer: () => void = null;
    private _get_forward_buffer_info?: ForwardBufferInfoProvider = null;

    private _paused: boolean = false;
    private _suspend_due_to_duration: boolean = false;
    private _suspend_due_to_bytes: boolean = false;

    private e?: any = null;

    public constructor(
        config: any,
        media_element: HTMLMediaElement,
        on_pause_transmuxer: () => void,
        on_resume_transmuxer: () => void,
        get_forward_buffer_info?: ForwardBufferInfoProvider
    ) {
        this._config = config;
        this._media_element = media_element;
        this._on_pause_transmuxer = on_pause_transmuxer;
        this._on_resume_transmuxer = on_resume_transmuxer;
        this._get_forward_buffer_info = get_forward_buffer_info || null;

        this.e = {
            onMediaTimeUpdate: this._onMediaTimeUpdate.bind(this),
            onMediaSeeking: this._onMediaWaitingOrStalled.bind(this),
            onMediaWaiting: this._onMediaWaitingOrStalled.bind(this),
            onMediaStalled: this._onMediaWaitingOrStalled.bind(this),
        };

        this._media_element.addEventListener('seeking', this.e.onMediaSeeking);
        this._media_element.addEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.addEventListener('stalled', this.e.onMediaStalled);
    }

    public destroy(): void {
        this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        this._media_element.removeEventListener('seeking', this.e.onMediaSeeking);
        this._media_element.removeEventListener('waiting', this.e.onMediaWaiting);
        this._media_element.removeEventListener('stalled', this.e.onMediaStalled);
        this.e = null;
        this._media_element = null;
        this._config = null;
        this._on_pause_transmuxer = null;
        this._on_resume_transmuxer = null;
        this._get_forward_buffer_info = null;
    }

    // _buffered_position is kept for existing call sites; decisions use mediaElement.buffered.
    public notifyBufferedPositionChanged(_buffered_position?: number): void {
        if (this._usesMSEBufferStateMachine()) {
            return;
        }
        if (!this._isLazyLoadEnabled()) {
            return;
        }

        if (this._paused) {
            this._resumeTransmuxerIfNeeded();
            return;
        }

        this._suspendTransmuxerIfNeeded();
    }

    private _onMediaWaitingOrStalled(e: Event): void {
        if (this._usesMSEBufferStateMachine()) {
            return;
        }
        if (this._paused) {
            this._resumeTransmuxerIfNeeded();
        }
    }

    private _onMediaTimeUpdate(e: Event): void {
        if (this._usesMSEBufferStateMachine()) {
            return;
        }
        if (this._paused) {
            this._resumeTransmuxerIfNeeded();
        }
    }

    private _suspendTransmuxerIfNeeded() {
        if (this._paused) {
            return;
        }

        const forward_window = this._getForwardBufferWindow();
        const forward_info = this._getForwardBufferInfo();
        const forward_horizon_duration = this._getForwardBufferHorizonDuration(forward_window, forward_info);
        const max_duration = this._getLazyLoadMaxDuration();
        const max_bytes = this._getLazyLoadMaxBytes();
        const forward_bytes = this._getVideoForwardBytes(forward_info);

        const duration_reached = max_duration > 0 && forward_horizon_duration >= max_duration;
        const bytes_reached = max_bytes > 0 &&
            typeof forward_bytes === 'number' &&
            isFinite(forward_bytes) &&
            forward_bytes >= max_bytes;

        if (duration_reached || bytes_reached) {
            this._suspend_due_to_duration = duration_reached;
            this._suspend_due_to_bytes = bytes_reached;
            this.suspendTransmuxerUntilRecover();
        }
    }

    private _getForwardBufferWindow(): BufferWindowInfo {
        return BufferWindow.inspect(
            this._media_element.buffered,
            this._media_element.currentTime
        );
    }

    private _getForwardBufferHorizonDuration(forward_window: BufferWindowInfo,
                                             forward_info: ForwardBufferInfo | null): number {
        const forward_duration = this._getVideoForwardDuration(forward_info);
        if (typeof forward_duration === 'number') {
            return forward_duration;
        }

        if (typeof forward_window.nextRangeEnd === 'number' &&
            isFinite(forward_window.nextRangeEnd) &&
            forward_window.nextRangeEnd > forward_window.currentTime) {
            return forward_window.nextRangeEnd - forward_window.currentTime;
        }
        return forward_window.forwardDuration;
    }

    private _isLazyLoadEnabled(): boolean {
        return this._config.lazyLoad && (!this._config.isLive || this._config.lazyLoadOnLive);
    }

    private _usesMSEBufferStateMachine(): boolean {
        return this._config && this._config.isMMTS === true;
    }

    private _getForwardBufferInfo(): ForwardBufferInfo | null {
        if (!this._get_forward_buffer_info) {
            return null;
        }

        const info = this._get_forward_buffer_info();
        if (!info ||
            typeof info.forwardBytes !== 'number' ||
            !isFinite(info.forwardBytes) ||
            info.forwardBytes < 0) {
            return null;
        }
        if (!this._isOptionalForwardBytesValid(info.audioForwardBytes) ||
            !this._isOptionalForwardBytesValid(info.videoForwardBytes) ||
            !this._isOptionalForwardDurationValid(info.forwardDuration) ||
            !this._isOptionalForwardDurationValid(info.audioForwardDuration) ||
            !this._isOptionalForwardDurationValid(info.videoForwardDuration)) {
            return null;
        }

        if (typeof info.currentTime === 'number' &&
            isFinite(info.currentTime) &&
            Math.abs(info.currentTime - this._media_element.currentTime) > 0.75) {
            return null;
        }

        return info;
    }

    private _isOptionalForwardBytesValid(value: any): boolean {
        return value == null ||
            (typeof value === 'number' && isFinite(value) && value >= 0);
    }

    private _isOptionalForwardDurationValid(value: any): boolean {
        return value == null ||
            (typeof value === 'number' && isFinite(value) && value >= 0);
    }

    private _getVideoForwardBytes(info: ForwardBufferInfo | null): number | undefined {
        if (!info) {
            return undefined;
        }
        return typeof info.videoForwardBytes === 'number' ? info.videoForwardBytes : info.forwardBytes;
    }

    private _getVideoForwardDuration(info: ForwardBufferInfo | null): number | undefined {
        if (!info) {
            return undefined;
        }
        if (typeof info.videoForwardDuration === 'number') {
            return info.videoForwardDuration;
        }
        return typeof info.forwardDuration === 'number' ? info.forwardDuration : undefined;
    }

    private _getLazyLoadMaxDuration(): number {
        const max_duration = this._config.lazyLoadMaxDuration;
        if (typeof max_duration !== 'number' || !isFinite(max_duration) || max_duration <= 0) {
            return 0;
        }
        return max_duration;
    }

    private _getLazyLoadRecoverDuration(): number {
        const recover_duration = this._config.lazyLoadRecoverDuration;
        if (typeof recover_duration !== 'number' || !isFinite(recover_duration) || recover_duration < 0) {
            return -1;
        }
        return recover_duration;
    }

    private _getLazyLoadMaxBytes(): number {
        return this._normalizeByteLimit(this._config.lazyLoadMaxBytes);
    }

    private _getLazyLoadRecoverBytes(): number {
        return this._normalizeByteLimit(this._config.lazyLoadRecoverBytes);
    }

    private _normalizeByteLimit(value: any): number {
        if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
            return 0;
        }
        return value;
    }

    public suspendTransmuxer(): void {
        if (this._paused) {
            return;
        }

        this._paused = true;
        this._on_pause_transmuxer();
    }

    public suspendTransmuxerUntilRecover(): void {
        this.suspendTransmuxer();
        this._media_element.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
    }

    private _resumeTransmuxerIfNeeded(): void {
        const recover_duration = this._getLazyLoadRecoverDuration();
        const forward_window = this._getForwardBufferWindow();
        const forward_info = this._getForwardBufferInfo();
        const forward_horizon_duration = this._getForwardBufferHorizonDuration(forward_window, forward_info);
        const recover_bytes = this._getLazyLoadRecoverBytes();
        const forward_bytes = this._getVideoForwardBytes(forward_info);

        const duration_recovered = recover_duration < 0 || forward_horizon_duration <= recover_duration;
        const bytes_recovered = recover_bytes <= 0 ||
            typeof forward_bytes !== 'number' ||
            !isFinite(forward_bytes) ||
            forward_bytes <= recover_bytes;

        let recovered: boolean;
        if (this._suspend_due_to_duration || this._suspend_due_to_bytes) {
            recovered = true;
            if (this._suspend_due_to_duration) {
                recovered = recovered && duration_recovered;
            }
            if (this._suspend_due_to_bytes) {
                recovered = recovered && bytes_recovered;
            }
        } else {
            recovered = duration_recovered || bytes_recovered;
        }

        if (recovered) {
            this.resumeTransmuxer();
        }
    }

    public resumeTransmuxer(): void {
        if (!this._paused) {
            return;
        }

        this._paused = false;
        this._suspend_due_to_duration = false;
        this._suspend_due_to_bytes = false;
        this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
        this._on_resume_transmuxer();
    }

}

export default LoadingController;

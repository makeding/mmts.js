/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackOperation,
    PlaybackOperation,
} from './playback-operation';

export type MMTSPlaybackOutputPhase = 'READY' | 'SEEK_PREROLL';

export type MMTSPlaybackOutputRelease = {
    operation: PlaybackOperation,
    audioSegments: any[],
};

/**
 * Coordinates elementary-stream output around an MMTS VOD seek landing.
 *
 * Video owns the transition out of SEEK_PREROLL because only a verified RAP
 * proves the new timeline is usable.  Audio is retained until that transition;
 * subtitle MFUs seen while scanning the byte lookback are discarded because
 * arrival-timed subtitles cannot be mapped safely before the new video clock.
 */
export default class MMTSPlaybackOutputState {

    private phase_: MMTSPlaybackOutputPhase = 'READY';
    private operation_: PlaybackOperation | null = null;
    private audio_operation_: PlaybackOperation | null = null;
    private audio_segments_: any[] = [];

    public get phase(): MMTSPlaybackOutputPhase {
        return this.phase_;
    }

    public get pendingAudioSegments(): readonly any[] {
        return this.audio_segments_;
    }

    public beginSeekPreroll(operation: PlaybackOperation): void {
        if (!isPlaybackOperation(operation)) {
            throw new TypeError('MMTS seek preroll requires a playback operation');
        }
        this.phase_ = 'SEEK_PREROLL';
        this.operation_ = clonePlaybackOperation(operation);
        this.audio_operation_ = null;
        this.audio_segments_ = [];
    }

    public reset(): void {
        this.phase_ = 'READY';
        this.operation_ = null;
        this.audio_operation_ = null;
        this.audio_segments_ = [];
    }

    public isSeekPreroll(operation: PlaybackOperation | null | undefined): boolean {
        return this.phase_ === 'SEEK_PREROLL' &&
            isPlaybackOperation(operation) &&
            isPlaybackOperation(this.operation_) &&
            isSamePlaybackOperation(operation, this.operation_);
    }

    public queueAudio(segment: any, operation: PlaybackOperation): boolean {
        if (!this.isSeekPreroll(operation)) {
            return false;
        }
        if (this.audio_operation_ === null) {
            this.audio_operation_ = clonePlaybackOperation(operation);
        } else if (!isSamePlaybackOperation(this.audio_operation_, operation)) {
            return false;
        }
        this.audio_segments_.push(segment);
        return true;
    }

    public shouldPublishSubtitle(operation: PlaybackOperation | null | undefined): boolean {
        if (!isPlaybackOperation(operation)) {
            return false;
        }
        if (this.phase_ === 'SEEK_PREROLL') {
            return false;
        }
        return this.operation_ === null || isSamePlaybackOperation(operation, this.operation_);
    }

    public acceptVideoLanding(operation: PlaybackOperation): MMTSPlaybackOutputRelease | null {
        if (!this.isSeekPreroll(operation)) {
            return null;
        }
        const audioSegments = this.audio_operation_ !== null &&
            isSamePlaybackOperation(this.audio_operation_, operation) ?
            this.audio_segments_.slice() : [];
        const release = {
            operation: clonePlaybackOperation(operation),
            audioSegments,
        };
        this.phase_ = 'READY';
        this.operation_ = clonePlaybackOperation(operation);
        this.audio_operation_ = null;
        this.audio_segments_ = [];
        return release;
    }
}

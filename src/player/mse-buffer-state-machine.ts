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
import {
    canAdvancePlaybackOperation,
    clonePlaybackOperation,
    doesPlaybackSwitchIdentityMatchOperation,
    isPlaybackOperation,
    isPlaybackSwitchIdentity,
    isSamePlaybackAttempt,
    isSamePlaybackTransaction,
    type PlaybackSwitchIdentity,
    type PlaybackOperation,
} from '../core/playback-operation';
import {
    createMMTSStartupGroupFailure,
    isMMTSStartupGroupFailure,
    resolveMMTSStartupGroupTimeout,
    type MMTSStartupGroupFailure,
} from '../core/mmts-startup-group-lifecycle';
import {
    isMMTSRandomAccessSafeVideoSegment,
    validateMMTSTrackSwitchSegmentPrefix,
} from './mmts-track-switch-window';

export type MSEBufferTrackType = 'video' | 'audio';

export type MSEStartupGroup = {
    playbackOperation?: PlaybackOperation,
    mseBufferGeneration?: number,
    videoInitSegment: any,
    audioInitSegment?: any,
    videoMediaSegment: any,
    audioMediaSegment?: any,
    startupTime: number,
    videoDecodeStart: number,
    videoCompositionStart: number,
    audioStart?: number,
    audioEnd?: number,
    syncPoint: number,
    playableStart: number,
    playableEnd: number,
    hasAudio: boolean,
    hasVideo: boolean,
};

export type MSEBufferMainState =
    'DETACHED' |
    'OPENING' |
    'PRIMING' |
    'STEADY' |
    'BACKPRESSURE' |
    'EVICTING' |
    'RECOVERING' |
    'SEEKING' |
    'TRACK_SWITCHING' |
    'DRAINING_EOS' |
    'ENDED' |
    'FATAL';

export type MSEBufferTrackState =
    'NO_SOURCEBUFFER' |
    'NEED_INIT' |
    'READY' |
    'APPENDING' |
    'REMOVING' |
    'BLOCKED_BY_BUDGET' |
    'BLOCKED_BY_LEAD' |
    'BLOCKED_BY_QUOTA' |
    'RESETTING_PARSER';

type MSEBufferOperationResult = {
    ok?: boolean,
    blocked?: boolean,
    quota?: boolean,
    fatal?: boolean,
    empty?: boolean,
    error?: any,
};

type MSEVideoRandomAccessPoint = {
    dts: number,
    pts: number,
};

type MSEBufferInflightOperation = {
    kind: 'init' | 'media' | 'remove',
    segment: any,
};

type MSEMediaBatch = {
    segment: any,
    count: number,
};

type MSEBufferRange = {
    start: number,
    end: number,
    kind?: 'cleanup' | 'flush',
};

type MMTSMediaSourceIdentity = {
    packetId?: number,
    mpuSequenceNumber?: number,
    sampleNumber?: number,
    filePosition?: number,
    rawDts?: number,
    rawPts?: number,
    dts?: number,
    pts?: number,
};

type AcceptedMMTSSourceIdentity = {
    generation: number,
    timelineBegin: number,
    timelineEnd: number,
    source: MMTSMediaSourceIdentity,
};

type MSEBufferForwardInfo = {
    currentTime: number,
    forwardBytes: number,
    forwardDuration?: number,
    audioForwardBytes?: number,
    videoForwardBytes?: number,
    audioBufferedBytes?: number,
    videoBufferedBytes?: number,
    audioForwardDuration?: number,
    videoForwardDuration?: number,
    playableEnd?: number,
};

type MSEBufferMediaSourceState = {
    readyState: string,
    streaming?: boolean,
    hasFatalMediaError?: boolean,
    hasPendingRemoveRanges?: boolean,
    sourceBuffers: {
        video?: {exists: boolean, updating: boolean},
        audio?: {exists: boolean, updating: boolean},
    },
};

type MSEVideoTrackSwitch = PlaybackSwitchIdentity & {
    packetId: number,
    videoDecodeStart: number,
    videoCompositionStart: number,
    syncPoint: number,
    playableStart: number,
    playableEnd: number,
};

export type MSEAudioTrackSwitchRebuildPlan = {
    type: 'audio_track_switch',
    operation: PlaybackOperation,
    replaceMediaSource: boolean,
    preserveVideoBuffer: boolean,
    switchTime: number,
    seekTime: number,
    resumePlayback: boolean,
    videoInitSegment: any,
    audioInitSegment: any,
    videoSegments: any[],
    audioSegments: any[],
    transactionId: number,
};

export type MSETrackSwitchFailurePhase =
    'plan-validation' |
    'rebuild-media-source' |
    'reset-parser-state' |
    'append-init' |
    'append-media' |
    'mse-fatal';

export type MSETrackSwitchFailure = {
    kind: 'audio-switch' | 'video-switch',
    operation: PlaybackOperation,
    transactionKey: string,
    attemptKey: string,
    transactionId: number,
    phase: MSETrackSwitchFailurePhase,
    error: any,
};

type MSESeekRebuildPlan = {
    kind: 'seek',
    targetTime: number,
    resumePlayback: boolean,
};

type MSETrackSwitchTransactionContext = {
    kind: 'audio-switch' | 'video-switch',
    operation: PlaybackOperation,
    transactionId: number,
    stage: 'requested' | 'rebuild-pending' | 'rebuilding' | 'commit-pending' |
        'appending-media' | 'trimming-tail',
    videoBufferReplaced?: boolean,
};

export type MSEBufferStateMachineOutput = {
    ensureSourceBuffer?: (type: MSEBufferTrackType, segment: any) => MSEBufferOperationResult,
    appendInit: (type: MSEBufferTrackType, segment: any) => MSEBufferOperationResult,
    appendMedia: (type: MSEBufferTrackType, segment: any) => MSEBufferOperationResult,
    removeRange: (type: MSEBufferTrackType, start: number, end: number) => MSEBufferOperationResult,
    resetParserState: (type: MSEBufferTrackType, mimeType: string) => MSEBufferOperationResult,
    rebuildMediaSource: (plan: MSEAudioTrackSwitchRebuildPlan | MSESeekRebuildPlan) => boolean,
    pauseTransmuxer: (reason: string) => void,
    resumeTransmuxer: (reason: string) => void,
    flushPending: (type?: MSEBufferTrackType) => void,
    emitFatal: (error: any) => void,
    onStartupGroupAppended?: (startupGroup: MSEStartupGroup) => void,
    onAudioTrackSwitchRebuildComplete?: (operation: PlaybackOperation) => void,
    onAudioTrackSwitchRebuildFailed?: (failure: MSETrackSwitchFailure) => void,
    onVideoTrackSwitchComplete?: (operation: PlaybackOperation) => void,
    onVideoTrackSwitchFailed?: (failure: MSETrackSwitchFailure) => void,
    onPlaybackOperationComplete?: (
        operation: PlaybackOperation,
        details?: {committedTimeMilliseconds?: number}
    ) => void,
    onPlaybackOperationFailed?: (operation: PlaybackOperation, error: any) => void,
    seekMedia?: (targetTime: number, reason: string) => void,
    seekTransmuxer?: (milliseconds: number, reason: string, operation?: PlaybackOperation) => void,
    endOfStream?: () => MSEBufferOperationResult,
    getMediaSourceState?: () => MSEBufferMediaSourceState,
    getForwardBufferInfo?: (currentTime: number) => MSEBufferForwardInfo,
    getBufferedRanges?: (type: MSEBufferTrackType) => MSEBufferRange[],
};

class MSEBufferStateMachine {

    private readonly TAG: string = 'MSEBufferStateMachine';

    private _config: any;
    private _output: MSEBufferStateMachineOutput;
    private _main_state: MSEBufferMainState = 'DETACHED';

    public get isFatal(): boolean {
        return this._main_state === 'FATAL';
    }
    private _track_state: {[type: string]: MSEBufferTrackState} = {
        video: 'NO_SOURCEBUFFER',
        audio: 'NO_SOURCEBUFFER',
    };
    private _pending_init_segments: {[type: string]: any[]} = {
        video: [],
        audio: [],
    };
    private _pending_media_segments: {[type: string]: any[]} = {
        video: [],
        audio: [],
    };
    private _pending_remove_ranges: {[type: string]: MSEBufferRange[]} = {
        video: [],
        audio: [],
    };
    private _pending_full_track_flush: {[type: string]: boolean} = {
        video: false,
        audio: false,
    };
    private _pending_track_flush_from: {[type: string]: number | null} = {
        video: null,
        audio: null,
    };
    private _pending_video_parameter_set_recovery_time: number | null = null;
    private _video_parameter_set_recovery_flush_started: boolean = false;
    private _current_time: number = 0;
    private _ready_state: number = 0;
    private _source_opened: boolean = false;
    private _transmuxer_paused: boolean = false;
    private _transmuxer_pause_reason: string | null = null;
    private _backpressure_stall_prefetch_active: boolean = false;
    private _backpressure_stall_prefetch_start_time: number | null = null;
    private _pending_eos: boolean = false;
    private _inflight_operations: {[type: string]: MSEBufferInflightOperation | null} = {
        video: null,
        audio: null,
    };
    private _seek_generation: number = 0;
    private _playback_operation: PlaybackOperation | null = null;
    private _last_quota_type: MSEBufferTrackType | null = null;
    private _media_info: any = null;
    private _pending_media_seek_target: number | null = null;
    private _pending_media_seek_reason: string | null = null;
    private _pending_media_seek_min_forward: number = 0;
    private _pending_transmuxer_seek_milliseconds: number | null = null;
    private _pending_transmuxer_seek_reason: string | null = null;
    private _timeline_seek_target_time: number | null = null;
    private _awaiting_media_seek_completion: boolean = false;
    private _track_switch_needs_data: boolean = false;
    private _live_audio_track_switch_collection_hold: boolean = false;
    private _pending_audio_rebuild_plan: MSEAudioTrackSwitchRebuildPlan | null = null;
    private _pending_audio_rebuild_operation: PlaybackOperation | null = null;
    private _track_switch_transaction: MSETrackSwitchTransactionContext | null = null;
    private _failed_track_switch_transactions: Set<string> = new Set();
    private _last_failed_track_switch: MSETrackSwitchTransactionContext | null = null;
    private _mmts_vod_audio_track_rebuild_active: boolean = false;
    private _pending_startup_group: MSEStartupGroup | null = null;
    private _pending_startup_group_id: number = 0;
    private _pending_startup_group_media: {[type: string]: boolean} = {
        video: false,
        audio: false,
    };
    private _pending_startup_group_timer: ReturnType<typeof setTimeout> | null = null;
    private _startup_group_timeout: number;
    private _last_mmts_source_identity: {[type: string]: AcceptedMMTSSourceIdentity | null} = {
        video: null,
        audio: null,
    };
    private _video_random_access_points: MSEVideoRandomAccessPoint[] = [];

    public constructor(config: any, output: MSEBufferStateMachineOutput) {
        this._startup_group_timeout = resolveMMTSStartupGroupTimeout(config);
        this._config = config;
        this._output = output;
        this._main_state = 'OPENING';
    }

    public destroy(): void {
        this.flushPending();
        this._main_state = 'DETACHED';
        this._output = null;
        this._config = null;
    }

    public onSourceOpen(): void {
        this._source_opened = true;
        this._main_state = 'PRIMING';
        this.tick('source_open');
    }

    public canSetPlaybackOperation(operation: PlaybackOperation): boolean {
        return isPlaybackOperation(operation) &&
            canAdvancePlaybackOperation(this._playback_operation, operation);
    }

    public setPlaybackOperation(operation: PlaybackOperation): boolean {
        if (!this.canSetPlaybackOperation(operation)) {
            return false;
        }

        const previous = this._playback_operation;
        if (this._last_failed_track_switch &&
            !this._isOperationForTransaction(operation, this._last_failed_track_switch.operation)) {
            this._last_failed_track_switch = null;
        }
        if (previous && !isSamePlaybackTransaction(previous, operation)) {
            this._failed_track_switch_transactions.clear();
        }
        this._playback_operation = clonePlaybackOperation(operation);
        this._seek_generation = operation.timelineGeneration;
        if (previous && !this._isOperationForTransaction(operation, previous)) {
            this._pending_eos = false;
        }

        const context = this._track_switch_transaction;
        if (context) {
            if (isSamePlaybackTransaction(context.operation, operation) &&
                context.kind === operation.kind && operation.attempt >= context.operation.attempt) {
                const attemptAdvanced = operation.attempt > context.operation.attempt;
                context.operation = clonePlaybackOperation(operation);
                if (attemptAdvanced) {
                    context.stage = 'requested';
                }
            } else {
                this._clearTrackSwitchTransactionState();
            }
        }
        if (previous && isSamePlaybackTransaction(previous, operation) &&
            operation.attempt > previous.attempt) {
            this._pending_audio_rebuild_plan = null;
            this._pending_audio_rebuild_operation = null;
        }
        this._dropStaleMMTSPendingData();
        return true;
    }

    public onInitSegment(type: MSEBufferTrackType, segment: any): void {
        if (this._main_state === 'FATAL') {
            return;
        }
        if (!this._isMMTSInputForCurrentOperation(segment)) {
            return;
        }
        this._pending_init_segments[type].push(segment);
        if (segment && segment.resetParserState === true) {
            this._track_state[type] = 'RESETTING_PARSER';
        } else if (this._track_state[type] !== 'RESETTING_PARSER') {
            this._track_state[type] = 'NEED_INIT';
        }
        this.tick('init_segment');
    }

    public onMediaSegment(type: MSEBufferTrackType, segment: any): void {
        if (this._main_state === 'FATAL') {
            return;
        }
        if (!this._isMMTSInputForCurrentOperation(segment)) {
            return;
        }
        if (!this._isMediaSegmentTimestampValid(segment)) {
            this._enterRecoveringForInvalidTimestamp(type, segment);
            return;
        }
        if (!this._isSegmentAllowedInCurrentTimeline(segment)) {
            return;
        }
        if (!this._isMMTSSourceIdentityValid(type, segment)) {
            this._enterRecoveringForInvalidMMTSSourceIdentity(type, segment);
            return;
        }
        this._recordMMTSSourceIdentity(type, segment);
        if (type === 'video') {
            this._recordVideoRandomAccessPoints(segment);
            if (segment && segment.mmtsVideoParameterSetRecovery === true) {
                // changeType() alone can leave VideoToolbox attached to the
                // previous HEVC DPB. Hold the recovery init+CRA until playback
                // reaches its boundary: the transmuxer may discover it many
                // seconds ahead, where immediately removing the complete old
                // video range would strand the current playback position.
                const firstSample = segment.info && segment.info.firstSample;
                const recoveryTime = firstSample && this._isFiniteNumber(firstSample.pts) ?
                    firstSample.pts / 1000 : this._getSegmentTimelineBegin(segment);
                if (isFinite(recoveryTime)) {
                    this._pending_video_parameter_set_recovery_time = recoveryTime;
                    this._video_parameter_set_recovery_flush_started = false;
                    this._pauseTransmuxer('VIDEO_PARAMETER_SET_RECOVERY');
                } else {
                    this._video_parameter_set_recovery_flush_started = true;
                    this._pending_full_track_flush.video = true;
                }
            }
        }
        if (!this._isMMTS()) {
            segment.mseBufferGeneration = this._seek_generation;
        }
        this._pending_media_segments[type].push(segment);
        if (this._track_state[type] !== 'APPENDING' && this._track_state[type] !== 'REMOVING') {
            this._track_state[type] = 'READY';
        }
        this.tick('media_segment');
    }

    public onMediaInfo(mediaInfo: any): void {
        this._media_info = mediaInfo || null;
        this.tick('media_info');
    }

    public onStartupGroup(startupGroup: MSEStartupGroup): void {
        if (this._main_state === 'FATAL') {
            return;
        }
        if (!this._isMMTSInputForCurrentOperation(startupGroup) ||
            !this._playback_operation ||
            !this._isExactPlaybackOperation(
                startupGroup.playbackOperation,
                this._playback_operation
            )) {
            return;
        }
        if (!this._isStartupGroupUsable(startupGroup)) {
            this._failStartupGroup(createMMTSStartupGroupFailure(
                startupGroup.playbackOperation as PlaybackOperation,
                'appending',
                'invalid-contract',
                this._getInvalidStartupGroupParts(startupGroup)
            ));
            return;
        }

        this._recordVideoRandomAccessPoints(startupGroup.videoMediaSegment);

        this._clearPendingStartupGroup();
        const groupId = ++this._pending_startup_group_id;
        this._pending_startup_group = startupGroup;
        this._pending_startup_group_media.video = true;
        this._pending_startup_group_media.audio = startupGroup.hasAudio === true;

        this._queueStartupInitSegment('video', startupGroup.videoInitSegment, groupId);
        if (startupGroup.hasAudio) {
            this._queueStartupInitSegment('audio', startupGroup.audioInitSegment, groupId);
        }
        this._queueStartupMediaSegment('video', startupGroup.videoMediaSegment, groupId);
        if (startupGroup.hasAudio) {
            this._queueStartupMediaSegment('audio', startupGroup.audioMediaSegment, groupId);
        }
        this._startStartupGroupAppendWatchdog(groupId, startupGroup.playbackOperation as PlaybackOperation);
        this.tick('startup_group');
    }

    public onStartupGroupFailure(failure: MMTSStartupGroupFailure): void {
        if (this._main_state === 'FATAL' || !this._playback_operation ||
            !isMMTSStartupGroupFailure(failure, this._playback_operation)) {
            return;
        }
        this._failStartupGroup(failure);
    }

    public onUpdateEnd(type?: MSEBufferTrackType): void {
        const completed = this._takeInflightOperation(type);
        const completedType = completed ? completed.type : type;
        const completedSegment = completed && completed.operation.kind !== 'remove' ?
            completed.operation.segment : null;
        this._markTrackReady(completedType);
        this._markStartupGroupMediaAppended(completedSegment);
        this._markAudioTrackSwitchMediaAppended(completedSegment);
        this._markVideoTrackSwitchMediaAppended(completedSegment);
        this._markVideoParameterSetRecoveryAppended(completedSegment);
        this.tick('update_end');
    }

    public onRemoveUpdateEnd(type?: MSEBufferTrackType): void {
        const completed = this._takeInflightOperation(type, 'remove');
        this._markTrackReady(completed ? completed.type : type);
        this.tick('remove_update_end');
    }

    public onQuotaExceeded(type?: MSEBufferTrackType, segment?: any): void {
        const segmentType = segment && (segment.type === 'video' || segment.type === 'audio') ?
            segment.type as MSEBufferTrackType : undefined;
        const inflight = this._getInflightOperation(type || segmentType);
        const quotaType = type || segmentType || (inflight ? inflight.type : null) || 'video';
        const quotaSegment = segment || (inflight ? inflight.operation.segment : null);
        const quotaKind = inflight && inflight.operation.segment === quotaSegment ?
            inflight.operation.kind : (quotaSegment ? 'media' : null);
        if (quotaSegment && quotaKind === 'init') {
            this._pending_init_segments[quotaType].unshift(quotaSegment);
        } else if (quotaSegment && quotaKind === 'media') {
            this._pending_media_segments[quotaType].unshift(quotaSegment);
        }
        this._enterQuotaEviction(quotaType, 'quota_exceeded');
    }

    public onMediaState(currentTime: number, readyState: number, eventType: string): void {
        if (typeof currentTime === 'number' && isFinite(currentTime)) {
            this._current_time = currentTime;
        }
        if (typeof readyState === 'number' && isFinite(readyState)) {
            this._ready_state = readyState;
        }
        if (eventType === 'seeking') {
            this._awaiting_media_seek_completion = true;
        } else if (eventType === 'seeked') {
            this._awaiting_media_seek_completion = false;
        }
        this._updateBackpressureStallPrefetch(eventType || 'media_state');
        this._updateBackpressure();
        this.tick(eventType || 'media_state');
    }

    public onContinuousBufferStall(): boolean {
        if (this._backpressure_stall_prefetch_active) {
            return true;
        }
        return this._tryBeginBackpressureStallPrefetch();
    }

    public onSeek(targetTime: number): void {
        this._clearBackpressureStallPrefetch();
        this._beginTimelineSeek(targetTime, 'SEEK', true);
    }

    public onDirectSeek(targetTime: number): boolean {
        if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
            return false;
        }
        this._clearBackpressureStallPrefetch();
        if (this._isMMTS() && this._expectsVideo()) {
            const randomAccessStart = this._resolveBufferedVideoRandomAccessPoint(targetTime);
            if (randomAccessStart === null) {
                return false;
            }
        }
        this._live_audio_track_switch_collection_hold = false;
        this._main_state = 'SEEKING';
        this._current_time = targetTime;
        if (this._output.seekMedia) {
            this._output.seekMedia(targetTime, 'DIRECT_SEEK');
        }
        this.tick('direct_seek');
        return true;
    }

    public onRecommendedSeekPoint(targetTime: number): void {
        if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
            return;
        }
        if (this._main_state === 'SEEKING' && this._timeline_seek_target_time != null) {
            this._timeline_seek_target_time = targetTime;
        }
        this._requestMediaSeekWhenPlayable(targetTime, 'RECOMMEND_SEEKPOINT', 0.05);
        this._resumeTransmuxer('RECOMMEND_SEEKPOINT_WAIT');
        this.tick('recommend_seekpoint');
    }

    public onUserSeek(targetTime: number, forceMediaSourceRebuild: boolean = false): void {
        if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
            return;
        }
        this._beginTimelineSeek(targetTime, 'USER_SEEK', true, forceMediaSourceRebuild);
    }

    public onMMTSVodAudioTrackRebuild(targetTime: number,
                                      operation?: PlaybackOperation,
                                      transactionId?: number): boolean {
        if (typeof targetTime !== 'number' || !isFinite(targetTime) || targetTime < 0) {
            return false;
        }
        const request = {operation, transactionId};
        const context = this._makeTrackSwitchTransactionContext('audio-switch', request);
        if (context === null || (this._track_switch_transaction !== null &&
            !this._isSameTrackSwitchContext(this._track_switch_transaction, context))) {
            this._rejectTrackSwitchRequest('audio-switch', request, {
                code: -1,
                msg: 'Invalid MMTS VOD audio track rebuild identity',
                operation,
                transactionId,
            });
            return false;
        }
        this._track_switch_transaction = context;
        this._main_state = 'SEEKING';
        this._mmts_vod_audio_track_rebuild_active = true;
        this._current_time = targetTime;
        this._timeline_seek_target_time = targetTime;
        this._pending_init_segments.video.splice(0, this._pending_init_segments.video.length);
        this._pending_init_segments.audio.splice(0, this._pending_init_segments.audio.length);
        this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length);
        this._pending_media_segments.audio.splice(0, this._pending_media_segments.audio.length);
        this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
        this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
        this._pending_full_track_flush.video = false;
        this._pending_full_track_flush.audio = false;
        this._pending_track_flush_from.video = null;
        this._pending_track_flush_from.audio = null;
        this._pending_media_seek_target = null;
        this._pending_media_seek_reason = null;
        this._pending_media_seek_min_forward = 0;
        this._pending_transmuxer_seek_milliseconds = isPlaybackOperation(operation) ?
            operation.requestedTimeMilliseconds :
            Math.round(targetTime * 1000000) / 1000;
        this._pending_transmuxer_seek_reason = 'MMTS_VOD_AUDIO_TRACK_REBUILD';
        this._pending_eos = false;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._pending_audio_rebuild_plan = null;
        this._pending_audio_rebuild_operation = null;
        this._clearAllInflightOperations();
        this._clearPendingStartupGroup();
        this._resetMMTSSourceIdentity();
        this._output.flushPending();
        this._pauseTransmuxer('SEEKING');
        this.tick('mmts_vod_audio_track_rebuild');
        return true;
    }

    public cancelAudioTrackSwitch(operation: PlaybackOperation): boolean {
        const context = this._track_switch_transaction;
        if (!isPlaybackOperation(operation) ||
            !context || context.kind !== 'audio-switch' ||
            context.transactionId !== operation.transactionId ||
            !this._playback_operation ||
            !this._isExactPlaybackOperation(operation, context.operation) ||
            !this._isExactPlaybackOperation(operation, this._playback_operation)) {
            return false;
        }

        const transactionId = operation.transactionId;
        const plan = this._pending_audio_rebuild_plan;
        if (plan && plan.transactionId === transactionId &&
            this._isExactPlaybackOperation(plan.operation, operation)) {
            this._pending_audio_rebuild_plan = null;
        }
        const pendingRebuildOperation = this._pending_audio_rebuild_operation;
        const ownsPendingRebuild = !!pendingRebuildOperation &&
            this._isExactPlaybackOperation(pendingRebuildOperation, operation);
        const ownsRebuildSeek = ownsPendingRebuild ||
            (context.stage === 'rebuilding' &&
                this._isAudioTrackSwitchRebuildReason(this._pending_media_seek_reason));
        if (ownsPendingRebuild) {
            this._pending_audio_rebuild_operation = null;
        }
        if (ownsRebuildSeek) {
            this._pending_media_seek_target = null;
            this._pending_media_seek_reason = null;
            this._pending_media_seek_min_forward = 0;
            this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
            this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
            this._pending_full_track_flush.video = false;
            this._pending_full_track_flush.audio = false;
            this._pending_track_flush_from.video = null;
            this._pending_track_flush_from.audio = null;
        }
        const ownsVodSeek = this._mmts_vod_audio_track_rebuild_active ||
            this._pending_transmuxer_seek_reason === 'MMTS_VOD_AUDIO_TRACK_REBUILD';
        if (this._pending_transmuxer_seek_reason === 'MMTS_VOD_AUDIO_TRACK_REBUILD') {
            this._pending_transmuxer_seek_milliseconds = null;
            this._pending_transmuxer_seek_reason = null;
        }
        if (ownsVodSeek || ownsRebuildSeek) {
            this._timeline_seek_target_time = null;
        }

        const types: MSEBufferTrackType[] = ['video', 'audio'];
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            this._pending_init_segments[type] = this._pending_init_segments[type].filter(
                (segment: any) => !segment ||
                    !this._isOperationForTransaction(segment.playbackOperation, operation)
            );
            this._pending_media_segments[type] = this._pending_media_segments[type].filter(
                (segment: any) => !segment ||
                    !this._isOperationForTransaction(segment.playbackOperation, operation)
            );
        }
        if (this._pending_startup_group && this._isOperationForTransaction(
            this._pending_startup_group.playbackOperation,
            operation
        )) {
            this._clearPendingStartupGroup();
        }
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            const inflight = this._inflight_operations[type];
            if (inflight && inflight.segment && this._isOperationForTransaction(
                inflight.segment.playbackOperation,
                operation
            )) {
                this._clearInflightOperation(type);
            }
        }

        this._mmts_vod_audio_track_rebuild_active = false;
        this._pending_eos = false;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._track_switch_transaction = null;
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            const inflight = this._inflight_operations[type];
            if (inflight) {
                this._track_state[type] = inflight.kind === 'remove' ? 'REMOVING' : 'APPENDING';
                continue;
            }
            const initSegment = this._pending_init_segments[type][0];
            if (initSegment) {
                this._track_state[type] = initSegment.resetParserState === true ?
                    'RESETTING_PARSER' : 'NEED_INIT';
                continue;
            }
            const sourceBuffer = this._getSourceBufferState(type);
            this._track_state[type] = sourceBuffer && sourceBuffer.exists ?
                'READY' : 'NO_SOURCEBUFFER';
        }
        if (this._pending_media_seek_target != null ||
            this._pending_transmuxer_seek_milliseconds != null) {
            this._main_state = 'SEEKING';
        } else if (this._hasPendingRemoveRanges()) {
            this._main_state = 'EVICTING';
        } else {
            this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
        }

        const pauseReason = this._transmuxer_pause_reason;
        if (pauseReason === 'SEEKING') {
            this._resumeTransmuxer('MMTS_VOD_AUDIO_TRACK_REBUILD_CANCELLED');
        } else if (pauseReason && pauseReason.indexOf('TRACK_SWITCHING') === 0) {
            this._resumeTransmuxer('TRACK_SWITCHING_CANCELLED');
        }
        this.tick('audio_track_switch_cancelled');
        return true;
    }

    public cancelMMTSVodAudioTrackRebuild(): void {
        const context = this._track_switch_transaction;
        if (context) {
            if (context.kind === 'audio-switch') {
                this.cancelAudioTrackSwitch(context.operation);
            }
            return;
        }
        if (!this._mmts_vod_audio_track_rebuild_active &&
            this._pending_transmuxer_seek_reason !== 'MMTS_VOD_AUDIO_TRACK_REBUILD' &&
            this._pending_audio_rebuild_plan === null &&
            !this._isAudioTrackSwitchRebuildReason(this._pending_media_seek_reason) &&
            !this._live_audio_track_switch_collection_hold) {
            return;
        }
        const resumeReason = this._transmuxer_pause_reason &&
            this._transmuxer_pause_reason.indexOf('TRACK_SWITCHING') === 0 ?
            'TRACK_SWITCHING_REBUILD_CANCELLED' :
            'MMTS_VOD_AUDIO_TRACK_REBUILD_CANCELLED';
        this._pending_transmuxer_seek_milliseconds = null;
        this._mmts_vod_audio_track_rebuild_active = false;
        this._pending_transmuxer_seek_reason = null;
        this._pending_audio_rebuild_plan = null;
        this._pending_audio_rebuild_operation = null;
        this._pending_media_seek_target = null;
        this._pending_media_seek_reason = null;
        this._pending_media_seek_min_forward = 0;
        this._timeline_seek_target_time = null;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
        this._resumeTransmuxer(resumeReason);
        this.tick('mmts_vod_audio_track_rebuild_cancelled');
    }

    private _beginTimelineSeek(targetTime: number,
                               reason: string,
                               seekTransmuxer: boolean,
                               forceMediaSourceRebuild: boolean = false): void {
        if (!this._isMMTS()) {
            this._seek_generation++;
        }
        this._main_state = 'SEEKING';
        if (typeof targetTime === 'number' && isFinite(targetTime)) {
            this._current_time = targetTime;
            this._timeline_seek_target_time = targetTime;
        }
        this._pending_init_segments.video.splice(0, this._pending_init_segments.video.length);
        this._pending_init_segments.audio.splice(0, this._pending_init_segments.audio.length);
        this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length);
        this._pending_media_segments.audio.splice(0, this._pending_media_segments.audio.length);
        this._video_random_access_points.splice(0, this._video_random_access_points.length);
        this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
        this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
        const videoCodec = this._media_info && typeof this._media_info.videoCodec === 'string' ?
            this._media_info.videoCodec : '';
        const recordedMMTSHEVC = this._isMMTS() && this._config.isLive !== true &&
            /^(?:hev1|hvc1|hevc)(?:\.|$)/i.test(videoCodec);
        const rebuildMediaSource = (forceMediaSourceRebuild || recordedMMTSHEVC ||
            this._config.mseRebuildMediaSourceOnSeek === true) &&
            !!this._output.rebuildMediaSource &&
            this._output.rebuildMediaSource({
                kind: 'seek',
                targetTime,
                resumePlayback: true,
            }) === true;
        this._pending_full_track_flush.video = !rebuildMediaSource;
        this._pending_full_track_flush.audio = !rebuildMediaSource;
        this._pending_track_flush_from.video = null;
        this._pending_track_flush_from.audio = null;
        this._clearPendingVideoParameterSetRecovery();
        if (rebuildMediaSource) {
            this._track_state.video = 'NO_SOURCEBUFFER';
            this._track_state.audio = 'NO_SOURCEBUFFER';
        } else {
            const mediaSourceState = this._getMediaSourceState();
            const videoSourceBuffer = this._getSourceBufferState('video', mediaSourceState);
            const audioSourceBuffer = this._getSourceBufferState('audio', mediaSourceState);
            this._track_state.video = videoSourceBuffer && videoSourceBuffer.exists ?
                'READY' : 'NO_SOURCEBUFFER';
            this._track_state.audio = audioSourceBuffer && audioSourceBuffer.exists ?
                'READY' : 'NO_SOURCEBUFFER';
        }
        this._pending_media_seek_target = null;
        this._pending_media_seek_reason = null;
        this._pending_media_seek_min_forward = 0;
        this._pending_transmuxer_seek_milliseconds = null;
        this._pending_transmuxer_seek_reason = null;
        this._awaiting_media_seek_completion = false;
        this._pending_eos = false;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._pending_audio_rebuild_plan = null;
        this._clearAllInflightOperations();
        this._clearPendingStartupGroup();
        this._resetMMTSSourceIdentity();
        this._output.flushPending();
        this._pauseTransmuxer('SEEKING');
        if (seekTransmuxer && this._output.seekTransmuxer && typeof targetTime === 'number' && isFinite(targetTime)) {
            this._pending_transmuxer_seek_milliseconds = Math.round(targetTime * 1000000) / 1000;
            this._pending_transmuxer_seek_reason = reason;
        }
        this.tick('seek');
    }

    public onAudioTrackSwitch(request: any): boolean {
        const stage = request && request.stage;
        if (stage === 'rebuild_ready') {
            return this._queueAudioTrackSwitchRebuild(request);
        }
        if (stage !== 'request') {
            this._failOrRejectTrackSwitchRequest('audio-switch', request, {
                code: -1,
                msg: 'Invalid MMTS audio track switch stage',
                request,
            });
            return false;
        }
        const context = this._makeTrackSwitchTransactionContext('audio-switch', request);
        if (context === null || (this._track_switch_transaction !== null &&
            !this._isSameTrackSwitchContext(this._track_switch_transaction, context))) {
            this._rejectTrackSwitchRequest('audio-switch', request, {
                code: -1,
                msg: 'Invalid MMTS audio track switch request identity',
                request,
            });
            return false;
        }
        this._track_switch_transaction = context;
        this._main_state = 'TRACK_SWITCHING';
        this._pending_init_segments.audio.splice(0, this._pending_init_segments.audio.length);
        this._pending_media_segments.audio.splice(0, this._pending_media_segments.audio.length);
        this._resetMMTSSourceIdentity('audio');
        this._pauseTransmuxer('TRACK_SWITCHING');
        this._track_switch_needs_data = true;
        this._live_audio_track_switch_collection_hold =
            request.mode === 'live' || request.mode === 'vod-forward';
        this.tick('audio_track_switch');
        return true;
    }

    public onVideoTrackSwitch(request: any): boolean {
        const stage = request && request.stage;
        if (stage === 'commit_ready') {
            return this._queueVideoTrackSwitchCommit(request);
        }
        if (stage !== 'request') {
            this._failOrRejectTrackSwitchRequest('video-switch', request, {
                code: -1,
                msg: 'Invalid MMTS video track switch stage',
                request,
            });
            return false;
        }
        const context = this._makeTrackSwitchTransactionContext('video-switch', request);
        if (context === null || (this._track_switch_transaction !== null &&
            !this._isSameTrackSwitchContext(this._track_switch_transaction, context))) {
            this._rejectTrackSwitchRequest('video-switch', request, {
                code: -1,
                msg: 'Invalid MMTS video track switch request identity',
                request,
            });
            return false;
        }
        this._track_switch_transaction = context;
        this._main_state = 'TRACK_SWITCHING';
        this._live_audio_track_switch_collection_hold = false;
        this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length);
        this._resetMMTSSourceIdentity('video');
        this._pauseTransmuxer('TRACK_SWITCHING');
        this._track_switch_needs_data = true;
        this.tick('video_track_switch');
        return true;
    }

    public cancelVideoTrackSwitch(operation: PlaybackOperation): boolean {
        const context = this._track_switch_transaction;
        if (!isPlaybackOperation(operation) || !context || context.kind !== 'video-switch' ||
            !this._isExactPlaybackOperation(context.operation, operation) ||
            !this._playback_operation ||
            !this._isExactPlaybackOperation(this._playback_operation, operation)) {
            return false;
        }
        const transactionId = operation.transactionId;
        this._pending_init_segments.video = this._pending_init_segments.video.filter(
            (segment: any) => segment && segment.mseVideoTrackSwitchTransactionId !== transactionId
        );
        this._pending_media_segments.video = this._pending_media_segments.video.filter(
            (segment: any) => segment && segment.mseVideoTrackSwitchTransactionId !== transactionId
        );
        this._pending_track_flush_from.video = null;
        this._track_switch_needs_data = false;
        this._track_switch_transaction = null;
        const videoSourceBuffer = this._getSourceBufferState('video');
        this._track_state.video = videoSourceBuffer && videoSourceBuffer.exists ?
            'READY' : 'NO_SOURCEBUFFER';
        this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
        this._resumeTransmuxer('TRACK_SWITCHING_CANCELLED');
        this.tick('video_track_switch_cancelled');
        return true;
    }

    private _getVideoTrackSwitch(value: any): MSEVideoTrackSwitch | null {
        // Keep the media-window payload as an un-narrowed object.  The identity
        // guard deliberately only describes the common transaction fields.
        const raw: any = value;
        const hasIdentity = isPlaybackSwitchIdentity(value);
        if (!raw || !hasIdentity || raw.kind !== 'video-switch' ||
            !Number.isInteger(raw.packetId) || raw.packetId < 0 ||
            !this._isFiniteNumber(raw.videoDecodeStart) ||
            !this._isFiniteNumber(raw.videoCompositionStart) ||
            !this._isFiniteNumber(raw.syncPoint) || raw.syncPoint < 0 ||
            !this._isFiniteNumber(raw.playableStart) || raw.playableStart < 0 ||
            !this._isFiniteNumber(raw.playableEnd) || raw.playableEnd <= raw.playableStart) {
            return null;
        }
        return {
            scopeId: raw.scopeId,
            transactionKey: raw.transactionKey,
            attemptKey: raw.attemptKey,
            kind: raw.kind,
            id: raw.id,
            transactionId: raw.transactionId,
            attempt: raw.attempt,
            packetId: raw.packetId,
            videoDecodeStart: raw.videoDecodeStart,
            videoCompositionStart: raw.videoCompositionStart,
            syncPoint: raw.syncPoint,
            playableStart: raw.playableStart,
            playableEnd: raw.playableEnd,
        };
    }

    private _queueVideoTrackSwitchCommit(request: any): boolean {
        const context = this._track_switch_transaction;
        const operation = request && request.operation;
        const videoSwitch = this._getVideoTrackSwitch(request && request.videoSwitch);
        const initSegment = request && request.videoInitSegment;
        const mediaSegment = request && request.videoMediaSegment;
        const matchesActiveTransaction = !!context && context.kind === 'video-switch' &&
            context.stage === 'requested' && this._isTrackSwitchRequestCurrent(context, request);
        if (!matchesActiveTransaction) {
            return false;
        }
        const valid =
            this._isCurrentPlaybackOperation(operation) && videoSwitch !== null &&
            doesPlaybackSwitchIdentityMatchOperation(videoSwitch, context.operation) &&
            videoSwitch.packetId === context.operation.packetId &&
            this._isMMTSInputForOperation(initSegment, operation) &&
            this._isMMTSInputForOperation(mediaSegment, operation) &&
            this._isRebuildInitSegment(initSegment, 'video') &&
            this._isRebuildMediaSegment(mediaSegment, 'video') &&
            isMMTSRandomAccessSafeVideoSegment(mediaSegment) &&
            this._doesVideoRebuildStartAtSyncPoint(mediaSegment) &&
            this._isVideoTrackSwitchIdentity(initSegment.mmtsVideoTrackSwitch, videoSwitch) &&
            this._isExactVideoTrackSwitch(mediaSegment.mmtsVideoTrackSwitch, videoSwitch) &&
            this._doesVideoSwitchMatchMediaWindow(videoSwitch, mediaSegment);
        if (!valid) {
            this._failTrackSwitch(context, 'plan-validation', {
                code: -1,
                msg: 'Invalid MMTS video track switch commit contract',
                request,
            });
            return false;
        }

        const transactionId = context.transactionId;
        const queuedInit = Object.assign({}, initSegment, {
            playbackOperation: clonePlaybackOperation(initSegment.playbackOperation),
            mmtsVideoTrackSwitch: Object.assign({}, initSegment.mmtsVideoTrackSwitch),
            resetParserState: true,
            mseVideoTrackSwitchTransactionId: transactionId,
        });
        const queuedMedia = Object.assign({}, mediaSegment, {
            playbackOperation: clonePlaybackOperation(mediaSegment.playbackOperation),
            mmtsVideoTrackSwitch: Object.assign({}, videoSwitch),
            mseVideoTrackSwitchTransactionId: transactionId,
        });

        this._main_state = 'TRACK_SWITCHING';
        this._live_audio_track_switch_collection_hold = false;
        this._pending_init_segments.video.splice(0, this._pending_init_segments.video.length, queuedInit);
        this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length, queuedMedia);
        // Reusing the old HEVC coded frames across a track's VPS/SPS/PPS
        // boundary can leave VideoToolbox attached to the previous DPB and
        // fail with kVTVideoDecoderReferenceMissingErr. Remove the complete
        // old video range before resetParserState + the new init/CRA. Audio is
        // retained so the switch remains an in-place video-only operation.
        this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
        this._pending_full_track_flush.video = true;
        this._pending_track_flush_from.video = null;
        context.videoBufferReplaced = true;
        this._resetMMTSSourceIdentity('video');
        this._pauseTransmuxer('TRACK_SWITCHING_COMMIT');
        this._track_switch_needs_data = false;
        this._track_state.video = 'RESETTING_PARSER';
        context.stage = 'commit-pending';
        this.tick('video_track_switch_commit_ready');
        return true;
    }

    private _doesVideoSwitchMatchMediaWindow(videoSwitch: MSEVideoTrackSwitch,
                                             segment: any): boolean {
        const tolerance = 0.08;
        const begin = this._getSegmentTimelineBegin(segment);
        const end = this._getSegmentTimelineEnd(segment);
        const firstSample = segment && segment.info && segment.info.firstSample;
        const firstDts = firstSample && this._isFiniteNumber(firstSample.dts) ?
            firstSample.dts / 1000 : NaN;
        const firstPts = firstSample && this._isFiniteNumber(firstSample.pts) ?
            firstSample.pts / 1000 : NaN;
        return isFinite(begin) && isFinite(end) &&
            videoSwitch.playableStart >= begin - tolerance &&
            videoSwitch.playableEnd <= end + tolerance &&
            videoSwitch.syncPoint >= begin - tolerance &&
            videoSwitch.syncPoint <= videoSwitch.playableEnd + tolerance &&
            videoSwitch.playableStart >= videoSwitch.syncPoint - tolerance &&
            isFinite(firstDts) && Math.abs(firstDts - videoSwitch.videoDecodeStart) <= tolerance &&
            isFinite(firstPts) && Math.abs(firstPts - videoSwitch.videoCompositionStart) <= tolerance;
    }

    private _isExactVideoTrackSwitch(value: any, expected: MSEVideoTrackSwitch): boolean {
        const actual = this._getVideoTrackSwitch(value);
        return actual !== null &&
            actual.transactionKey === expected.transactionKey &&
            actual.attemptKey === expected.attemptKey &&
            actual.packetId === expected.packetId &&
            actual.videoDecodeStart === expected.videoDecodeStart &&
            actual.videoCompositionStart === expected.videoCompositionStart &&
            actual.syncPoint === expected.syncPoint &&
            actual.playableStart === expected.playableStart &&
            actual.playableEnd === expected.playableEnd;
    }

    private _isVideoTrackSwitchIdentity(value: any, expected: MSEVideoTrackSwitch): boolean {
        const payload: any = value;
        return isPlaybackSwitchIdentity(value) &&
            value.transactionKey === expected.transactionKey &&
            value.attemptKey === expected.attemptKey &&
            Number.isInteger(payload.packetId) && payload.packetId >= 0 &&
                payload.packetId === expected.packetId;
    }

    private _makeTrackSwitchTransactionContext(
        kind: 'audio-switch' | 'video-switch',
        request: any
    ): MSETrackSwitchTransactionContext | null {
        const operation = request && request.operation;
        if (!this._isCurrentPlaybackOperation(operation) || operation.kind !== kind ||
            !Number.isInteger(request.transactionId) ||
            request.transactionId !== operation.transactionId) {
            return null;
        }
        return {
            kind,
            operation: clonePlaybackOperation(operation),
            transactionId: request.transactionId,
            stage: 'requested',
        };
    }

    private _isSameTrackSwitchContext(left: MSETrackSwitchTransactionContext,
                                      right: MSETrackSwitchTransactionContext): boolean {
        return left.kind === right.kind && left.transactionId === right.transactionId &&
            isSamePlaybackAttempt(left.operation, right.operation);
    }

    private _isTrackSwitchRequestCurrent(context: MSETrackSwitchTransactionContext,
                                         request: any): boolean {
        return !!request && request.transactionId === context.transactionId &&
            this._isOperationForTransaction(request.operation, context.operation);
    }

    private _rejectTrackSwitchRequest(kind: 'audio-switch' | 'video-switch',
                                      request: any,
                                      error: any): void {
        const transactionId = request && request.transactionId;
        const operation = request && request.operation;
        if (!Number.isInteger(transactionId) || transactionId < 0 ||
            !isPlaybackOperation(operation) || operation.kind !== kind ||
            transactionId !== operation.transactionId) {
            this._enterFatal(error);
            return;
        }
        const failure: MSETrackSwitchFailure = {
            kind,
            operation: clonePlaybackOperation(operation),
            transactionKey: operation.transactionKey,
            attemptKey: operation.attemptKey,
            transactionId,
            phase: 'plan-validation',
            error,
        };
        const key = this._trackSwitchFailureKey(operation);
        if (this._failed_track_switch_transactions.has(key)) {
            return;
        }
        this._failed_track_switch_transactions.add(key);
        const callback = kind === 'audio-switch' ?
            this._output.onAudioTrackSwitchRebuildFailed :
            this._output.onVideoTrackSwitchFailed;
        if (callback) {
            callback(failure);
        } else {
            this._enterFatal(error);
        }
    }

    private _failOrRejectTrackSwitchRequest(kind: 'audio-switch' | 'video-switch',
                                            request: any,
                                            error: any): void {
        const context = this._track_switch_transaction;
        if (context && context.kind === kind && this._isTrackSwitchRequestCurrent(context, request)) {
            this._failTrackSwitch(context, 'plan-validation', error);
            return;
        }
        this._rejectTrackSwitchRequest(kind, request, error);
    }

    private _failTrackSwitch(context: MSETrackSwitchTransactionContext,
                             phase: MSETrackSwitchFailurePhase,
                             error: any): void {
        if (this._track_switch_transaction !== context) {
            return;
        }
        const key = this._trackSwitchFailureKey(context.operation);
        if (this._failed_track_switch_transactions.has(key)) {
            return;
        }
        this._failed_track_switch_transactions.add(key);
        const failure: MSETrackSwitchFailure = {
            kind: context.kind,
            operation: clonePlaybackOperation(context.operation),
            transactionKey: context.operation.transactionKey,
            attemptKey: context.operation.attemptKey,
            transactionId: context.transactionId,
            phase,
            error,
        };
        const callback = context.kind === 'audio-switch' ?
            this._output.onAudioTrackSwitchRebuildFailed :
            this._output.onVideoTrackSwitchFailed;

        this._last_failed_track_switch = {
            kind: context.kind,
            operation: clonePlaybackOperation(context.operation),
            transactionId: context.transactionId,
            stage: context.stage,
        };
        this._clearTrackSwitchTransactionState();
        this._live_audio_track_switch_collection_hold = false;
        this._track_switch_needs_data = false;
        this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
        this._resumeTransmuxer('TRACK_SWITCHING_FAILED');
        if (callback) {
            callback(failure);
        } else {
            this._enterFatal(error);
        }
    }

    private _clearTrackSwitchTransactionState(): void {
        const context = this._track_switch_transaction;
        const transactionId = context && context.transactionId;
        const ownsAudioRebuildFlush = !!context && context.kind === 'audio-switch' &&
            context.stage === 'rebuilding' && !!this._pending_audio_rebuild_operation &&
            this._isExactPlaybackOperation(
                this._pending_audio_rebuild_operation,
                context.operation
            );
        if (transactionId !== null && transactionId !== undefined) {
            const types: MSEBufferTrackType[] = ['video', 'audio'];
            for (let i = 0; i < types.length; i++) {
                const type = types[i];
                this._pending_init_segments[type] = this._pending_init_segments[type].filter(
                    (segment: any) => !!segment &&
                        segment.mseVideoTrackSwitchTransactionId !== transactionId &&
                        (!context || !this._isOperationForTransaction(
                            segment.playbackOperation,
                            context.operation
                        ))
                );
                this._pending_media_segments[type] = this._pending_media_segments[type].filter(
                    (segment: any) => !!segment &&
                        segment.mseVideoTrackSwitchTransactionId !== transactionId &&
                        (!context || !this._isOperationForTransaction(
                            segment.playbackOperation,
                            context.operation
                        ))
                );
            }
        }
        this._pending_audio_rebuild_plan = null;
        this._pending_audio_rebuild_operation = null;
        if (this._isAudioTrackSwitchRebuildReason(this._pending_media_seek_reason)) {
            this._pending_media_seek_target = null;
            this._pending_media_seek_reason = null;
            this._pending_media_seek_min_forward = 0;
        }
        if (ownsAudioRebuildFlush) {
            this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
            this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
            this._pending_full_track_flush.video = false;
            this._pending_full_track_flush.audio = false;
            this._pending_track_flush_from.video = null;
            this._pending_track_flush_from.audio = null;
        }
        this._pending_track_flush_from.video = null;
        this._pending_track_flush_from.audio = null;
        this._track_switch_transaction = null;
    }

    private _trackSwitchFailureKey(operation: PlaybackOperation): string {
        return operation.attemptKey;
    }

    private _enterFatal(error: any): void {
        if (this._main_state === 'FATAL') {
            return;
        }
        this._live_audio_track_switch_collection_hold = false;
        this._main_state = 'FATAL';
        this._pending_eos = false;
        this.flushPending();
        this._clearAllInflightOperations();
        this._pauseTransmuxer('FATAL');
        this._output.emitFatal(error);
    }

    public onMediaElementError(error: any): void {
        this._enterFatal(Object.assign({
            code: error && error.code,
            msg: error && (error.msg || error.message) || 'HTMLMediaElement entered a fatal state',
            source: 'media-element',
        }, error || {}));
    }

    public onEndOfStream(operation?: PlaybackOperation): void {
        if (this._isMMTS() && !this._isCurrentPlaybackOperation(operation)) {
            return;
        }
        this._pending_eos = true;
        this.tick('eos');
    }

    public onFatal(error: any): void {
        if (this._pending_startup_group && this._playback_operation) {
            if (isMMTSStartupGroupFailure(error)) {
                if (!isMMTSStartupGroupFailure(error, this._playback_operation)) {
                    return;
                }
                this._failStartupGroup(error);
                return;
            }
            const failure = createMMTSStartupGroupFailure(
                this._playback_operation,
                'appending',
                'mse-fatal',
                this._getPendingStartupGroupParts(this._pending_startup_group_id),
                error
            );
            this._failStartupGroup(failure);
            return;
        }
        const context = this._track_switch_transaction;
        if (context) {
            this._failTrackSwitch(context, 'mse-fatal', error);
            return;
        }
        this._enterFatal(error);
    }

    public onExternalMSEError(error: any): void {
        const operation = error && error.playbackOperation;
        const kind = error && error.kind;
        const transactionId = error && error.transactionId;
        if (this._pending_startup_group && this._playback_operation) {
            if (operation !== undefined && !this._isExactPlaybackOperation(
                operation,
                this._playback_operation
            )) {
                return;
            }
            this._failStartupGroup(createMMTSStartupGroupFailure(
                this._playback_operation,
                'appending',
                'mse-fatal',
                this._getPendingStartupGroupParts(this._pending_startup_group_id),
                error
            ));
            return;
        }
        if ((kind === 'audio-switch' || kind === 'video-switch') &&
            isPlaybackOperation(operation) &&
            this._failed_track_switch_transactions.has(this._trackSwitchFailureKey(operation))) {
            return;
        }
        const context = this._track_switch_transaction;
        if (context) {
            if ((kind === 'audio-switch' || kind === 'video-switch') && kind !== context.kind) {
                return;
            }
            if (Number.isInteger(transactionId) && transactionId !== context.transactionId) {
                return;
            }
            if (operation !== undefined &&
                !this._isOperationForTransaction(operation, context.operation)) {
                return;
            }
            this._failTrackSwitch(context, 'mse-fatal', error);
            return;
        }
        const failed = this._last_failed_track_switch;
        if (failed &&
            (kind === undefined || kind === failed.kind) &&
            (!Number.isInteger(transactionId) || transactionId === failed.transactionId) &&
            (operation === undefined ||
                this._isOperationForTransaction(operation, failed.operation))) {
            return;
        }
        this._enterFatal(error);
    }

    public tick(reason: string): void {
        if (!this._output || this._main_state === 'DETACHED' || this._main_state === 'FATAL') {
            return;
        }

        this._updateBackpressure();

        if (this._hasFatalMediaError()) {
            this.onExternalMSEError({
                code: -1,
                msg: 'MediaSource entered a fatal state',
                playbackOperation: this._playback_operation ?
                    clonePlaybackOperation(this._playback_operation) : undefined,
            });
            return;
        }

        if (this._runPendingAudioTrackSwitchRebuild()) {
            return;
        }

        if (!this._isMediaSourceOperational()) {
            return;
        }

        if (this._runPendingRemove()) {
            return;
        }

        if (this._finishVideoTrackSwitchTailTrimIfReady()) {
            return;
        }

        if (this._runPendingTransmuxerSeek()) {
            return;
        }

        if (this._runPendingParserReset()) {
            return;
        }

        if (this._appendRequiredInit()) {
            return;
        }

        if (this._appendMedia('video')) {
            return;
        }

        if (this._appendMedia('audio')) {
            return;
        }

        if (this._applyPendingMediaSeekIfReady()) {
            return;
        }

        this._resumeTrackSwitchDataRequestIfReady();

        if (this._pending_eos && this._queuesEmpty() && this._allSourceBuffersIdle()) {
            this._main_state = 'DRAINING_EOS';
            if (this._output.endOfStream) {
                const result = this._output.endOfStream();
                if (result && result.ok === false && result.blocked) {
                    return;
                }
            }
            this._pending_eos = false;
            this._main_state = 'ENDED';
        } else if (this._main_state === 'PRIMING' || this._canLeaveTransientState()) {
            this._main_state = 'STEADY';
        }

        if (reason === 'waiting' || reason === 'stalled' || reason === 'canplay' || reason === 'progress') {
            this._resumeIfRecovered();
        }
    }

    public flushPending(type?: MSEBufferTrackType): void {
        if (type) {
            this._pending_init_segments[type].splice(0, this._pending_init_segments[type].length);
            this._pending_media_segments[type].splice(0, this._pending_media_segments[type].length);
            this._pending_remove_ranges[type].splice(0, this._pending_remove_ranges[type].length);
            this._pending_full_track_flush[type] = false;
            this._pending_track_flush_from[type] = null;
            this._resetMMTSSourceIdentity(type);
            if (type === 'video') {
                this._video_random_access_points.splice(0, this._video_random_access_points.length);
                this._clearPendingVideoParameterSetRecovery();
            }
            if (this._pending_media_segments.video.length === 0 && this._pending_media_segments.audio.length === 0) {
                this._timeline_seek_target_time = null;
            }
            this._clearPendingStartupGroup();
            this._output && this._output.flushPending(type);
            return;
        }

        this._pending_init_segments.video.splice(0, this._pending_init_segments.video.length);
        this._pending_init_segments.audio.splice(0, this._pending_init_segments.audio.length);
        this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length);
        this._pending_media_segments.audio.splice(0, this._pending_media_segments.audio.length);
        this._video_random_access_points.splice(0, this._video_random_access_points.length);
        this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
        this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
        this._pending_full_track_flush.video = false;
        this._pending_full_track_flush.audio = false;
        this._pending_track_flush_from.video = null;
        this._pending_track_flush_from.audio = null;
        this._clearPendingVideoParameterSetRecovery();
        this._pending_media_seek_target = null;
        this._pending_media_seek_reason = null;
        this._pending_media_seek_min_forward = 0;
        this._pending_transmuxer_seek_milliseconds = null;
        this._pending_transmuxer_seek_reason = null;
        this._timeline_seek_target_time = null;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._pending_audio_rebuild_plan = null;
        this._pending_audio_rebuild_operation = null;
        this._track_switch_transaction = null;
        this._clearPendingStartupGroup();
        this._resetMMTSSourceIdentity();
        this._output && this._output.flushPending();
    }

    private _queueStartupInitSegment(type: MSEBufferTrackType,
                                     segment: any,
                                     groupId: number): void {
        const operation = this._pending_startup_group &&
            this._pending_startup_group.playbackOperation;
        const resetParserState = isPlaybackOperation(operation) && operation.kind === 'seek';
        const queuedSegment = Object.assign({}, segment, {
            mseStartupGroupId: groupId,
            mseStartupGroupPart: 'init',
            resetParserState: resetParserState || segment.resetParserState === true,
        });
        this._pending_init_segments[type].push(queuedSegment);
        this._track_state[type] = queuedSegment.resetParserState === true ?
            'RESETTING_PARSER' : 'NEED_INIT';
    }

    private _queueStartupMediaSegment(type: MSEBufferTrackType, segment: any, groupId: number): void {
        this._pending_media_segments[type].push(Object.assign({}, segment, {
            mseStartupGroupId: groupId,
            mseStartupGroupPart: 'media',
        }));
    }

    private _isStartupGroupUsable(startupGroup: MSEStartupGroup): boolean {
        if (!startupGroup || startupGroup.hasVideo !== true ||
            typeof startupGroup.hasAudio !== 'boolean' ||
            !this._isFiniteNumber(startupGroup.startupTime) ||
            !this._isFiniteNumber(startupGroup.videoDecodeStart) ||
            !this._isFiniteNumber(startupGroup.videoCompositionStart) ||
            !this._isFiniteNumber(startupGroup.syncPoint) || startupGroup.syncPoint < 0 ||
            !this._isFiniteNumber(startupGroup.playableStart) || startupGroup.playableStart < 0 ||
            !this._isFiniteNumber(startupGroup.playableEnd) ||
            startupGroup.playableEnd <= startupGroup.playableStart ||
            !this._isRebuildInitSegment(startupGroup.videoInitSegment, 'video') ||
            !this._isRebuildMediaSegment(startupGroup.videoMediaSegment, 'video') ||
            !this._doesVideoRebuildStartAtSyncPoint(startupGroup.videoMediaSegment) ||
            !this._isStartupGroupOperationConsistent(startupGroup) ||
            !this._doesStartupVideoCoverPlayableWindow(startupGroup)) {
            return false;
        }
        if (!startupGroup.hasAudio) {
            return true;
        }
        if (!this._isFiniteNumber(startupGroup.audioStart) ||
            !this._isFiniteNumber(startupGroup.audioEnd) ||
            startupGroup.audioEnd <= startupGroup.audioStart ||
            !this._isRebuildInitSegment(startupGroup.audioInitSegment, 'audio') ||
            !this._isRebuildMediaSegment(startupGroup.audioMediaSegment, 'audio')) {
            return false;
        }
        const videoStart = this._getSegmentTimelineBegin(startupGroup.videoMediaSegment);
        const videoEnd = this._getSegmentTimelineEnd(startupGroup.videoMediaSegment);
        const audioStart = this._getSegmentTimelineBegin(startupGroup.audioMediaSegment);
        const audioEnd = this._getSegmentTimelineEnd(startupGroup.audioMediaSegment);
        const overlapStart = Math.max(videoStart, audioStart);
        const overlapEnd = Math.min(videoEnd, audioEnd);
        const tolerance = 0.08;
        return isFinite(overlapStart) && isFinite(overlapEnd) && overlapEnd > overlapStart &&
            startupGroup.playableStart >= overlapStart - tolerance &&
            startupGroup.playableEnd <= overlapEnd + tolerance;
    }

    private _isStartupGroupOperationConsistent(startupGroup: MSEStartupGroup): boolean {
        const operation = startupGroup.playbackOperation;
        if (!isPlaybackOperation(operation) ||
            startupGroup.mseBufferGeneration !== operation.timelineGeneration) {
            return false;
        }
        const segments = [
            startupGroup.videoInitSegment,
            startupGroup.videoMediaSegment,
        ];
        if (startupGroup.hasAudio) {
            segments.push(startupGroup.audioInitSegment, startupGroup.audioMediaSegment);
        }
        return segments.every((segment: any) => !!segment &&
            this._isExactPlaybackOperation(segment.playbackOperation, operation) &&
            segment.mseBufferGeneration === operation.timelineGeneration);
    }

    private _doesStartupVideoCoverPlayableWindow(startupGroup: MSEStartupGroup): boolean {
        const begin = this._getSegmentTimelineBegin(startupGroup.videoMediaSegment);
        const end = this._getSegmentTimelineEnd(startupGroup.videoMediaSegment);
        const tolerance = 0.08;
        return isFinite(begin) && isFinite(end) &&
            startupGroup.syncPoint >= begin - tolerance &&
            startupGroup.syncPoint <= startupGroup.playableEnd + tolerance &&
            startupGroup.playableStart >= begin - tolerance &&
            startupGroup.playableEnd <= end + tolerance &&
            startupGroup.startupTime >= startupGroup.playableStart - tolerance &&
            startupGroup.startupTime <= startupGroup.playableEnd + tolerance;
    }

    private _markStartupGroupMediaAppended(segment: any): void {
        if (!segment || !this._pending_startup_group ||
            segment.mseStartupGroupId !== this._pending_startup_group_id ||
            segment.mseStartupGroupPart !== 'media' ||
            !this._isExactPlaybackOperation(
                segment.playbackOperation,
                this._pending_startup_group.playbackOperation as PlaybackOperation
            )) {
            return;
        }
        const type = segment.type as MSEBufferTrackType;
        if (type !== 'video' && type !== 'audio') {
            return;
        }
        this._pending_startup_group_media[type] = false;
        if (this._pending_startup_group_media.video || this._pending_startup_group_media.audio) {
            return;
        }

        const startupGroup = this._pending_startup_group;
        const startupTime = this._resolveStartupSeekTime(startupGroup);
        const operation = startupGroup.playbackOperation;
        const seekOperation = isPlaybackOperation(operation) && operation.kind === 'seek' ?
            operation : null;
        const appendedGroup = startupTime === startupGroup.startupTime ?
            startupGroup :
            Object.assign({}, startupGroup, {startupTime});
        if (startupTime !== startupGroup.startupTime) {
            Log.v(
                this.TAG,
                `Move MMTS startup from ${startupGroup.startupTime.toFixed(3)} to buffered intersection ${startupTime.toFixed(3)}`
            );
        }
        this._clearPendingStartupGroup();
        if (seekOperation !== null) {
            if (this._pending_media_seek_target == null) {
                const requestedTarget = seekOperation.requestedTimeMilliseconds / 1000;
                this._pending_media_seek_target = requestedTarget;
                this._pending_media_seek_reason = 'RECOMMEND_SEEKPOINT';
                this._pending_media_seek_min_forward = 0.05;
            }
            this._main_state = 'SEEKING';
        } else {
            // SourceBuffer updateend says the append algorithm finished, but
            // WebKit may not expose the new A/V ranges synchronously.  Do not
            // put HTMLMediaElement into `seeking` until both tracks confirm a
            // playable intersection at the startup point.  The pending seek
            // is retried by the normal state-machine tick path and committed
            // only once.
            this._requestMediaSeekWhenPlayable(startupTime, 'STARTUP_GROUP', 0.05);
        }
        if (this._output.onStartupGroupAppended) {
            this._output.onStartupGroupAppended(appendedGroup);
        }
        if (isPlaybackOperation(operation) &&
            operation.kind === 'startup') {
            this._output.onPlaybackOperationComplete?.(operation, {
                committedTimeMilliseconds: startupTime * 1000,
            });
        }
    }

    private _markVideoTrackSwitchMediaAppended(segment: any): void {
        const context = this._track_switch_transaction;
        if (!segment || !context || context.kind !== 'video-switch' ||
            context.stage !== 'appending-media' ||
            segment.mseVideoTrackSwitchTransactionId !== context.transactionId ||
            !this._isOperationForTransaction(segment.playbackOperation, context.operation)) {
            return;
        }
        const appendedEnd = this._getSegmentTimelineEnd(segment);
        if (isFinite(appendedEnd) && context.videoBufferReplaced !== true) {
            // Keep playback continuous through the target window, then discard the stale old-track tail.
            this._pending_track_flush_from.video = appendedEnd;
        }
        context.stage = 'trimming-tail';
    }

    private _markVideoParameterSetRecoveryAppended(segment: any): void {
        if (!segment || segment.type !== 'video' ||
            segment.mmtsVideoParameterSetRecovery !== true ||
            this._pending_video_parameter_set_recovery_time === null) {
            return;
        }
        const recoveryTime = this._pending_video_parameter_set_recovery_time;
        this._clearPendingVideoParameterSetRecovery();
        this._requestMediaSeekWhenPlayable(
            recoveryTime,
            'VIDEO_PARAMETER_SET_RECOVERY',
            0.05
        );
        this._resumeTransmuxer('VIDEO_PARAMETER_SET_RECOVERY');
    }

    private _markAudioTrackSwitchMediaAppended(segment: any): void {
        const context = this._track_switch_transaction;
        if (!segment || segment.type !== 'audio' || !context || context.kind !== 'audio-switch' ||
            context.stage !== 'rebuilding' ||
            this._pending_media_seek_reason !== 'AUDIO_TRACK_SWITCH_IN_PLACE' ||
            this._pending_media_segments.audio.length !== 0 ||
            !this._isOperationForTransaction(segment.playbackOperation, context.operation)) {
            return;
        }
        const appendedEnd = this._getSegmentTimelineEnd(segment);
        if (isFinite(appendedEnd)) {
            // Trimming before this append would expose a gap at the active playback position.
            this._pending_track_flush_from.audio = appendedEnd;
        }
    }

    private _finishVideoTrackSwitchTailTrimIfReady(): boolean {
        const context = this._track_switch_transaction;
        if (!context || context.kind !== 'video-switch' || context.stage !== 'trimming-tail' ||
            this._hasPendingTrackFlush() || this._hasPendingRemoveRanges() ||
            !this._allSourceBuffersIdle()) {
            return false;
        }
        const operation = clonePlaybackOperation(context.operation);
        this._track_switch_transaction = null;
        this._track_switch_needs_data = false;
        this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
        this._resumeTransmuxer('TRACK_SWITCHING_COMPLETE');
        this._output.onVideoTrackSwitchComplete?.(operation);
        return true;
    }

    private _resolveStartupSeekTime(startupGroup: MSEStartupGroup): number {
        const target = startupGroup.startupTime;
        if (!this._output.getBufferedRanges) {
            return target;
        }

        const videoRanges = this._output.getBufferedRanges('video');
        if (startupGroup.hasAudio !== true) {
            return this._findFirstRangeTime(videoRanges, target);
        }

        const audioRanges = this._output.getBufferedRanges('audio');
        const tolerance = 0.08;
        let videoIndex = 0;
        let audioIndex = 0;
        while (videoIndex < videoRanges.length && audioIndex < audioRanges.length) {
            const video = videoRanges[videoIndex];
            const audio = audioRanges[audioIndex];
            const start = Math.max(video.start, audio.start);
            const end = Math.min(video.end, audio.end);
            if (isFinite(start) && isFinite(end) && end > start && end >= target - tolerance) {
                if (target >= start - tolerance && target < end) {
                    return Math.max(target, start);
                }
                if (start > target) {
                    return start;
                }
            }
            if (video.end <= audio.end) {
                videoIndex++;
            } else {
                audioIndex++;
            }
        }
        return target;
    }

    private _findFirstRangeTime(ranges: MSEBufferRange[], target: number): number {
        const tolerance = 0.08;
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end) || range.end <= range.start) {
                continue;
            }
            if (target >= range.start - tolerance && target < range.end) {
                return Math.max(target, range.start);
            }
            if (range.start > target) {
                return range.start;
            }
        }
        return target;
    }

    private _clearPendingStartupGroup(): void {
        const groupId = this._pending_startup_group ? this._pending_startup_group_id : null;
        this._clearStartupGroupAppendWatchdog();
        if (groupId !== null) {
            const types: MSEBufferTrackType[] = ['video', 'audio'];
            for (let i = 0; i < types.length; i++) {
                const type = types[i];
                this._pending_init_segments[type] = this._pending_init_segments[type].filter(
                    (segment: any) => !segment || segment.mseStartupGroupId !== groupId
                );
                this._pending_media_segments[type] = this._pending_media_segments[type].filter(
                    (segment: any) => !segment || segment.mseStartupGroupId !== groupId
                );
            }
        }
        this._pending_startup_group = null;
        this._pending_startup_group_media.video = false;
        this._pending_startup_group_media.audio = false;
    }

    private _startStartupGroupAppendWatchdog(groupId: number,
                                             operation: PlaybackOperation): void {
        this._clearStartupGroupAppendWatchdog();
        const expectedOperation = clonePlaybackOperation(operation);
        this._pending_startup_group_timer = setTimeout(() => {
            if (!this._pending_startup_group || groupId !== this._pending_startup_group_id ||
                !this._playback_operation ||
                !this._isExactPlaybackOperation(expectedOperation, this._playback_operation) ||
                !this._isExactPlaybackOperation(
                    this._pending_startup_group.playbackOperation,
                    expectedOperation
                )) {
                return;
            }
            this._pending_startup_group_timer = null;
            this._failStartupGroup(createMMTSStartupGroupFailure(
                expectedOperation,
                'appending',
                'append-timeout',
                this._getPendingStartupGroupParts(groupId)
            ));
        }, this._startup_group_timeout);
        (this._pending_startup_group_timer as any).unref?.();
    }

    private _clearStartupGroupAppendWatchdog(): void {
        if (this._pending_startup_group_timer !== null) {
            clearTimeout(this._pending_startup_group_timer);
            this._pending_startup_group_timer = null;
        }
    }

    private _getPendingStartupGroupParts(groupId: number): string[] {
        const missing: string[] = [];
        const group = this._pending_startup_group;
        if (!group || groupId !== this._pending_startup_group_id) {
            return ['startup-group'];
        }
        const types: MSEBufferTrackType[] = group.hasAudio ? ['video', 'audio'] : ['video'];
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            const inflight = this._inflight_operations[type];
            const initPending = this._pending_init_segments[type].some(
                (segment: any) => segment && segment.mseStartupGroupId === groupId
            ) || !!(inflight && inflight.segment &&
                inflight.segment.mseStartupGroupId === groupId &&
                inflight.segment.type === type &&
                inflight.segment.mseStartupGroupPart === 'init');
            if (initPending) {
                missing.push(`${type}-init`);
            }
            if (this._pending_startup_group_media[type]) {
                missing.push(`${type}-media`);
            }
        }
        return missing.length > 0 ? missing : ['startup-group'];
    }

    private _getInvalidStartupGroupParts(startupGroup: MSEStartupGroup): string[] {
        const invalid: string[] = [];
        if (!startupGroup || startupGroup.hasVideo !== true) invalid.push('video');
        if (!startupGroup || typeof startupGroup.hasAudio !== 'boolean') invalid.push('audio-presence');
        if (!startupGroup || !this._isRebuildInitSegment(startupGroup.videoInitSegment, 'video')) {
            invalid.push('video-init');
        }
        if (!startupGroup || !this._isRebuildMediaSegment(startupGroup.videoMediaSegment, 'video') ||
            !this._doesVideoRebuildStartAtSyncPoint(startupGroup.videoMediaSegment)) {
            invalid.push('video-media');
        }
        if (startupGroup && startupGroup.hasAudio === true) {
            if (!this._isRebuildInitSegment(startupGroup.audioInitSegment, 'audio')) {
                invalid.push('audio-init');
            }
            if (!this._isRebuildMediaSegment(startupGroup.audioMediaSegment, 'audio')) {
                invalid.push('audio-media');
            }
        }
        if (startupGroup && !this._isStartupGroupOperationConsistent(startupGroup)) {
            invalid.push('playback-operation');
        }
        if (invalid.length === 0) invalid.push('timeline-contract');
        return invalid;
    }

    private _failStartupGroup(failure: MMTSStartupGroupFailure): void {
        if (this._main_state === 'FATAL' || !this._playback_operation ||
            !isMMTSStartupGroupFailure(failure, this._playback_operation)) {
            return;
        }
        const groupId = this._pending_startup_group ? this._pending_startup_group_id : null;
        this._clearPendingStartupGroup();
        if (groupId !== null) {
            const types: MSEBufferTrackType[] = ['video', 'audio'];
            for (let i = 0; i < types.length; i++) {
                const type = types[i];
                const inflight = this._inflight_operations[type];
                if (inflight && inflight.segment &&
                    inflight.segment.mseStartupGroupId === groupId) {
                    this._clearInflightOperation(type);
                }
            }
        }
        const operation = clonePlaybackOperation(failure.playbackOperation);
        this._output.onPlaybackOperationFailed?.(operation, failure);
        this._enterFatal(failure);
    }

    private _failStartupGroupForSegment(segment: any,
                                        reason: string,
                                        error: any): boolean {
        const group = this._pending_startup_group;
        if (!group || !segment ||
            segment.mseStartupGroupId !== this._pending_startup_group_id ||
            !this._isExactPlaybackOperation(
                segment.playbackOperation,
                group.playbackOperation as PlaybackOperation
            )) {
            return false;
        }
        const part = segment.type === 'video' || segment.type === 'audio' ?
            `${segment.type}-${segment.mseStartupGroupPart || 'segment'}` : 'startup-group';
        const missing = this._getPendingStartupGroupParts(this._pending_startup_group_id);
        if (missing.indexOf(part) < 0) missing.unshift(part);
        this._failStartupGroup(createMMTSStartupGroupFailure(
            group.playbackOperation as PlaybackOperation,
            'appending',
            reason,
            missing,
            error
        ));
        return true;
    }

    public getForwardBufferInfo(currentTime: number): MSEBufferForwardInfo {
        const base = this._output && this._output.getForwardBufferInfo ?
            this._output.getForwardBufferInfo(currentTime) :
            {
                currentTime,
                forwardBytes: 0,
                audioForwardBytes: 0,
                videoForwardBytes: 0,
                audioForwardDuration: 0,
                videoForwardDuration: 0,
        };
        const audioPendingBytes = this._getPendingForwardBytes('audio', currentTime);
        const videoPendingBytes = this._getPendingForwardBytes('video', currentTime);
        // The producer can outrun SourceBuffer updateend by hundreds of
        // seconds after a VOD range seek.  Pending bytes alone are not a
        // useful horizon for low-bitrate tracks: the byte cap may represent
        // minutes of media.  Extend each buffered track horizon through its
        // inflight and queued media so the configured duration cap applies to
        // the whole pipeline, not just data already committed to MSE.
        const videoForwardDuration = this._getPipelineForwardDuration(
            'video', currentTime, base.videoForwardDuration || 0
        );
        const audioForwardDuration = this._getPipelineForwardDuration(
            'audio', currentTime, base.audioForwardDuration || 0
        );
        const forwardDuration = this._getPlayableForwardDuration(currentTime, audioForwardDuration, videoForwardDuration);
        return {
            currentTime,
            forwardBytes: (base.forwardBytes || 0) + audioPendingBytes + videoPendingBytes,
            audioForwardBytes: (base.audioForwardBytes || 0) + audioPendingBytes,
            videoForwardBytes: (base.videoForwardBytes || 0) + videoPendingBytes,
            audioBufferedBytes: base.audioBufferedBytes,
            videoBufferedBytes: base.videoBufferedBytes,
            forwardDuration,
            audioForwardDuration,
            videoForwardDuration,
            playableEnd: currentTime + forwardDuration,
        };
    }

    private _getBufferedForwardBufferInfo(currentTime: number): MSEBufferForwardInfo {
        const base = this._output && this._output.getForwardBufferInfo ?
            this._output.getForwardBufferInfo(currentTime) :
            {
                currentTime,
                forwardBytes: 0,
                audioForwardBytes: 0,
                videoForwardBytes: 0,
                audioForwardDuration: 0,
                videoForwardDuration: 0,
            };
        const videoForwardDuration = base.videoForwardDuration || 0;
        const audioForwardDuration = base.audioForwardDuration || 0;
        const forwardDuration = this._getPlayableForwardDuration(currentTime, audioForwardDuration, videoForwardDuration);
        return {
            currentTime,
            forwardBytes: base.forwardBytes || 0,
            audioForwardBytes: base.audioForwardBytes || 0,
            videoForwardBytes: base.videoForwardBytes || 0,
            audioBufferedBytes: base.audioBufferedBytes,
            videoBufferedBytes: base.videoBufferedBytes,
            audioForwardDuration,
            videoForwardDuration,
            forwardDuration,
            playableEnd: currentTime + forwardDuration,
        };
    }

    private _appendRequiredInit(): boolean {
        const type = this._selectInitTrack();
        if (!type) {
            return false;
        }
        const sourceBuffer = this._getSourceBufferState(type);
        if ((!sourceBuffer || !sourceBuffer.exists) && this._output.ensureSourceBuffer) {
            const segment = this._pending_init_segments[type][0];
            let result: MSEBufferOperationResult;
            try {
                result = this._output.ensureSourceBuffer(type, segment);
            } catch (error) {
                this.onFatal(error);
                return true;
            }
            if (result && result.ok) {
                // Keep the init queued.  Creating every known SourceBuffer
                // before appending the first initialization segment preserves
                // the ordering used by upstream mpegts.js and avoids Chromium
                // locking the MediaSource to a one-track topology.
                return true;
            }
            if (result && (result.error || result.fatal)) {
                this.onFatal(result.error || result);
                return true;
            }
            return true;
        }
        if ((!sourceBuffer || !sourceBuffer.exists) && !this._allSourceBuffersIdle()) {
            // Chromium may reject addSourceBuffer() while the other track is
            // still appending its initialization segment.  Keep the second
            // init queued until updateend instead of turning an ordinary
            // audio+video MPEG-TS stream into a duplicate-SourceBuffer fatal.
            return true;
        }
        if (!this._canOperateOnType(type)) {
            return false;
        }

        let segment = this._pending_init_segments[type].shift();
        if (segment && segment.resetParserState === true) {
            segment = Object.assign({}, segment);
            delete segment.resetParserState;
            delete segment.rebuildSourceBuffer;
            delete segment.mimeType;
        }
        let result: MSEBufferOperationResult;
        try {
            result = this._output.appendInit(type, segment);
        } catch (error) {
            if (this._failStartupGroupForSegment(segment, 'append-init', error)) {
                return true;
            }
            const context = this._getTrackSwitchContextForSegment(segment);
            if (context) {
                this._failTrackSwitch(context, 'append-init', error);
            } else {
                this.onFatal(error);
            }
            return true;
        }
        if (result && result.ok) {
            this._track_state[type] = result.empty ? 'READY' : 'APPENDING';
            if (result.empty) {
                this._clearInflightOperation(type);
            } else {
                this._setInflightOperation(type, 'init', segment);
            }
            if (this._transmuxer_pause_reason === 'QUOTA') {
                this._resumeTransmuxer('QUOTA_RECOVERED');
            }
            return !result.empty;
        }
        if (result && result.quota) {
            this._pending_init_segments[type].unshift(segment);
            this._enterQuotaEviction(type, 'init_quota_exceeded');
            return true;
        }
        if (result && (result.error || result.fatal)) {
            const error = result.error || result;
            if (this._failStartupGroupForSegment(segment, 'append-init', error)) {
                return true;
            }
            const context = this._getTrackSwitchContextForSegment(segment);
            if (context) {
                this._failTrackSwitch(context, 'append-init', error);
            } else {
                this._pending_init_segments[type].unshift(segment);
                this.onFatal(error);
            }
            return true;
        }
        this._pending_init_segments[type].unshift(segment);
        return false;
    }

    private _runPendingParserReset(): boolean {
        const types: MSEBufferTrackType[] = ['audio', 'video'];
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            const segment = this._pending_init_segments[type][0];
            const needsReset = this._track_state[type] === 'RESETTING_PARSER' ||
                !!(segment && segment.resetParserState === true);
            if (!needsReset) {
                continue;
            }
            if (!segment) {
                continue;
            }
            if (type === 'video' && segment.mmtsVideoParameterSetRecovery === true &&
                !this._video_parameter_set_recovery_flush_started) {
                return true;
            }
            const sourceBuffer = this._getSourceBufferState(type);
            if (!sourceBuffer || !sourceBuffer.exists) {
                this._track_state[type] = 'NEED_INIT';
                continue;
            }
            if (!this._canOperateOnType(type)) {
                return true;
            }
            const mimeType = this._makeSegmentMimeType(segment);
            if (!mimeType) {
                const error = {
                    code: -1,
                    msg: `Missing ${type} init segment mimeType for parser reset`,
                    segmentInfo: segment ? segment.info : null,
                };
                if (this._failStartupGroupForSegment(segment, 'parser-reset', error)) {
                    return true;
                }
                const context = this._getTrackSwitchContextForSegment(segment);
                if (context) {
                    this._failTrackSwitch(context, 'reset-parser-state', error);
                } else {
                    this.onFatal(error);
                }
                return true;
            }
            let result: MSEBufferOperationResult;
            try {
                result = this._output.resetParserState(type, mimeType);
            } catch (error) {
                if (this._failStartupGroupForSegment(segment, 'parser-reset', error)) {
                    return true;
                }
                const context = this._getTrackSwitchContextForSegment(segment);
                if (context) {
                    this._failTrackSwitch(context, 'reset-parser-state', error);
                } else {
                    this.onFatal(error);
                }
                return true;
            }
            if (result && result.ok) {
                delete segment.resetParserState;
                delete segment.rebuildSourceBuffer;
                delete segment.mimeType;
                this._track_state[type] = 'NEED_INIT';
                continue;
            }
            if (result && (result.error || result.fatal)) {
                const error = result.error || result;
                if (this._failStartupGroupForSegment(segment, 'parser-reset', error)) {
                    return true;
                }
                const context = this._getTrackSwitchContextForSegment(segment);
                if (context) {
                    this._failTrackSwitch(context, 'reset-parser-state', error);
                } else {
                    this.onFatal(error);
                }
            }
            return true;
        }
        return false;
    }

    private _appendMedia(type: MSEBufferTrackType): boolean {
        const queue = this._pending_media_segments[type];
        if (queue.length === 0 || !this._canAppendMediaToType(type)) {
            return false;
        }

        const firstSegment = queue[0];
        if (firstSegment.mseBufferGeneration !== this._seek_generation) {
            queue.shift();
            return this._appendMedia(type);
        }
        const batch = this._peekMediaBatch(type);
        const segment = batch.segment;

        if (this._track_state[type] === 'BLOCKED_BY_QUOTA' && !this._hasPendingRemoveRanges()) {
            this._schedulePressureCleanup(type);
            if (!this._hasPendingRemoveRanges()) {
                return false;
            }
            return this._runPendingRemove();
        }

        if (this._needsBudgetEviction(type, segment)) {
            this._track_state[type] = 'BLOCKED_BY_BUDGET';
            this._main_state = 'EVICTING';
            this._schedulePressureCleanup(type);
            if (this._hasPendingRemoveRanges()) {
                return this._runPendingRemove();
            }
            this._main_state = 'BACKPRESSURE';
            this._pauseTransmuxer('BACKPRESSURE');
            return false;
        }

        if (type === 'video' &&
            segment.mseStartupGroupId !== this._pending_startup_group_id &&
            !segment.mmtsVideoTrackSwitch &&
            this._isVideoBlockedByAudioLead(segment)) {
            this._track_state.video = 'BLOCKED_BY_LEAD';
            return false;
        }

        if (type === 'audio' &&
            segment.mseStartupGroupId !== this._pending_startup_group_id &&
            !segment.mmtsAudioTrackSwitch &&
            this._isAudioBlockedByVideoLead(segment)) {
            this._track_state.audio = 'BLOCKED_BY_LEAD';
            return false;
        }

        queue.splice(0, batch.count);
        const transactionContext = this._getTrackSwitchContextForSegment(segment);
        if (transactionContext && transactionContext.kind === 'video-switch') {
            transactionContext.stage = 'appending-media';
        }
        let result: MSEBufferOperationResult;
        try {
            result = this._output.appendMedia(type, segment);
        } catch (error) {
            if (this._failStartupGroupForSegment(segment, 'append-media', error)) {
                return true;
            }
            if (transactionContext) {
                this._failTrackSwitch(transactionContext, 'append-media', error);
            } else {
                this.onFatal(error);
            }
            return true;
        }
        if (result && result.ok) {
            this._track_state[type] = result.empty ? 'READY' : 'APPENDING';
            if (result.empty) {
                this._clearInflightOperation(type);
            } else {
                this._setInflightOperation(type, 'media', segment);
            }
            if (result.empty) {
                this._markStartupGroupMediaAppended(segment);
                this._markAudioTrackSwitchMediaAppended(segment);
                this._markVideoTrackSwitchMediaAppended(segment);
            }
            if (this._transmuxer_pause_reason === 'QUOTA') {
                this._resumeTransmuxer('QUOTA_RECOVERED');
            }
            return !result.empty;
        }
        if (result && result.quota) {
            if (transactionContext && transactionContext.kind === 'video-switch' &&
                this._track_switch_transaction === transactionContext) {
                transactionContext.stage = 'commit-pending';
            }
            this.onQuotaExceeded(type, segment);
            return true;
        }
        if (result && (result.error || result.fatal)) {
            const error = result.error || result;
            if (this._failStartupGroupForSegment(segment, 'append-media', error)) {
                return true;
            }
            if (transactionContext) {
                this._failTrackSwitch(transactionContext, 'append-media', error);
            } else {
                queue.unshift(segment);
                this.onFatal(error);
            }
            return true;
        }
        if (transactionContext && transactionContext.kind === 'video-switch' &&
            this._track_switch_transaction === transactionContext) {
            transactionContext.stage = 'commit-pending';
        }
        queue.unshift(segment);
        return false;
    }

    private _peekMediaBatch(type: MSEBufferTrackType): MSEMediaBatch {
        const queue = this._pending_media_segments[type];
        const first = queue[0];
        const maxDuration = this._getAppendBatchDuration();
        if (!first || maxDuration <= 0 || this._isMediaBatchBoundary(first)) {
            return {segment: first, count: 1};
        }

        const begin = this._getSegmentTimelineBegin(first);
        let end = this._getSegmentTimelineEnd(first);
        if (!isFinite(begin) || !isFinite(end)) {
            return {segment: first, count: 1};
        }

        let count = 1;
        while (count < queue.length) {
            const next = queue[count];
            if (!next || next.mseBufferGeneration !== this._seek_generation ||
                this._isMediaBatchBoundary(next) ||
                next.type !== first.type ||
                next.container !== first.container ||
                next.codec !== first.codec) {
                break;
            }
            const nextBegin = this._getSegmentTimelineBegin(next);
            const nextEnd = this._getSegmentTimelineEnd(next);
            if (!isFinite(nextBegin) || !isFinite(nextEnd) ||
                nextBegin > end + 0.12 ||
                Math.max(end, nextEnd) - begin > maxDuration + 0.001) {
                break;
            }
            end = Math.max(end, nextEnd);
            count++;
        }

        return count > 1 ?
            {segment: this._mergeMediaBatch(queue.slice(0, count)), count} :
            {segment: first, count: 1};
    }

    private _isMediaBatchBoundary(segment: any): boolean {
        return !segment ||
            segment.resetParserState === true ||
            segment.timestampOffset != null ||
            segment.mseStartupGroupId != null ||
            !!segment.mmtsAudioTrackSwitch ||
            !!segment.mmtsVideoTrackSwitch;
    }

    private _mergeMediaBatch(segments: any[]): any {
        const first = segments[0];
        const last = segments[segments.length - 1];
        let byteLength = 0;
        let sampleCount = 0;
        let beginDts = first.info.beginDts;
        let beginPts = first.info.beginPts;
        let endDts = first.info.endDts;
        let endPts = first.info.endPts;
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            byteLength += this._getSegmentBytes(segment);
            sampleCount += segment.sampleCount || 0;
            beginDts = Math.min(beginDts, segment.info.beginDts);
            beginPts = Math.min(beginPts, segment.info.beginPts);
            endDts = Math.max(endDts, segment.info.endDts);
            endPts = Math.max(endPts, segment.info.endPts);
        }

        const data = new Uint8Array(byteLength);
        let offset = 0;
        for (let i = 0; i < segments.length; i++) {
            const bytes = this._getSegmentData(segments[i]);
            data.set(bytes, offset);
            offset += bytes.byteLength;
        }

        const info = Object.assign({}, first.info);
        info.beginDts = beginDts;
        info.beginPts = beginPts;
        info.endDts = endDts;
        info.endPts = endPts;
        info.firstSample = first.info.firstSample;
        info.lastSample = last.info.lastSample;
        info.syncPoints = [];
        for (let i = 0; i < segments.length; i++) {
            if (Array.isArray(segments[i].info.syncPoints)) {
                info.syncPoints.push(...segments[i].info.syncPoints);
            }
        }

        const merged = Object.assign({}, first, {
            data: data.buffer,
            sampleCount,
            info,
        });
        const firstSource = this._getSegmentMMTSSourceBegin(first);
        const lastSource = this._getSegmentMMTSSourceEnd(last);
        if (firstSource !== null && lastSource !== null) {
            merged.mmtsSourceInfo = Object.assign({}, first.mmtsSourceInfo, {
                firstSample: firstSource,
                lastSample: lastSource,
            });
        }
        return merged;
    }

    private _getSegmentData(segment: any): Uint8Array {
        const data = segment && segment.data;
        if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
            return new Uint8Array(data);
        }
        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        return new Uint8Array(0);
    }

    private _runPendingRemove(): boolean {
        this._startVideoParameterSetRecoveryFlushIfDue();
        if (this._hasPendingTrackFlush()) {
            if (!this._allSourceBuffersIdle()) {
                return true;
            }
            this._materializePendingTrackFlush();
        }

        const type = this._pending_remove_ranges.video.length > 0 ? 'video' :
            (this._pending_remove_ranges.audio.length > 0 ? 'audio' : null);
        if (!type) {
            return false;
        }
        if (!this._canOperateOnType(type)) {
            return true;
        }

        const range = this._pending_remove_ranges[type].shift();
        const result = this._output.removeRange(type, range.start, range.end);
        if (result && result.ok) {
            this._track_state[type] = 'REMOVING';
            this._setInflightOperation(type, 'remove', null);
            return true;
        }
        this._pending_remove_ranges[type].unshift(range);
        if (result && result.error) {
            this.onFatal(result.error);
            return true;
        }
        return true;
    }

    private _startVideoParameterSetRecoveryFlushIfDue(): void {
        const recoveryTime = this._pending_video_parameter_set_recovery_time;
        if (recoveryTime === null || this._video_parameter_set_recovery_flush_started ||
            this._current_time < recoveryTime - 1) {
            return;
        }
        // At the boundary, replace the complete video coded-frame set before
        // resetParserState + init + CRA. The following updateend seeks across
        // the quarantined GOP to the first newly playable composition time.
        this._video_parameter_set_recovery_flush_started = true;
        this._pending_full_track_flush.video = true;
        this._pending_track_flush_from.video = null;
    }

    private _clearPendingVideoParameterSetRecovery(): void {
        this._pending_video_parameter_set_recovery_time = null;
        this._video_parameter_set_recovery_flush_started = false;
    }

    private _runPendingTransmuxerSeek(): boolean {
        if (this._pending_transmuxer_seek_milliseconds == null ||
            this._pending_transmuxer_seek_reason == null) {
            return false;
        }
        if (this._hasPendingRemoveRanges() || !this._allSourceBuffersIdle()) {
            return false;
        }
        const milliseconds = this._pending_transmuxer_seek_milliseconds;
        const reason = this._pending_transmuxer_seek_reason;
        this._pending_transmuxer_seek_milliseconds = null;
        this._pending_transmuxer_seek_reason = null;
        if (this._output.seekTransmuxer) {
            const operation = this._playback_operation ?
                clonePlaybackOperation(this._playback_operation) : undefined;
            this._output.seekTransmuxer(milliseconds, reason, operation);
            this._resumeTransmuxer(reason);
        }
        return true;
    }

    private _queueAudioTrackSwitchRebuild(request: any): boolean {
        const context = this._track_switch_transaction;
        if (!context || context.kind !== 'audio-switch' ||
            context.stage !== 'requested' || !this._isTrackSwitchRequestCurrent(context, request)) {
            return false;
        }
        const plan = this._makeAudioTrackSwitchRebuildPlan(request);
        if (plan === null) {
            this._failTrackSwitch(context, 'plan-validation', {
                code: -1,
                msg: 'Invalid MMTS audio track switch MediaSource rebuild plan',
                request,
            });
            return false;
        }

        this._main_state = 'TRACK_SWITCHING';
        if (!plan.preserveVideoBuffer) {
            this._pending_init_segments.video.splice(0, this._pending_init_segments.video.length);
            this._pending_media_segments.video.splice(0, this._pending_media_segments.video.length);
        }
        this._pending_init_segments.audio.splice(0, this._pending_init_segments.audio.length);
        this._pending_media_segments.audio.splice(0, this._pending_media_segments.audio.length);
        this._pending_remove_ranges.video.splice(0, this._pending_remove_ranges.video.length);
        this._pending_remove_ranges.audio.splice(0, this._pending_remove_ranges.audio.length);
        this._pending_full_track_flush.video = false;
        this._pending_full_track_flush.audio = false;
        this._pending_track_flush_from.video = null;
        this._pending_track_flush_from.audio = null;
        this._pending_media_seek_target = null;
        this._pending_media_seek_reason = null;
        this._pending_media_seek_min_forward = 0;
        this._pending_transmuxer_seek_milliseconds = null;
        this._pending_transmuxer_seek_reason = null;
        this._timeline_seek_target_time = null;
        this._pending_eos = false;
        this._track_switch_needs_data = false;
        this._live_audio_track_switch_collection_hold = false;
        this._pending_audio_rebuild_plan = plan;
        context.stage = 'rebuild-pending';
        this._clearPendingStartupGroup();
        if (plan.preserveVideoBuffer) {
            this._resetMMTSSourceIdentity('audio');
            this._output.flushPending('audio');
        } else {
            this._resetMMTSSourceIdentity();
            this._output.flushPending();
        }
        this._pauseTransmuxer('TRACK_SWITCHING_REBUILD');
        this.tick('audio_track_switch_rebuild_ready');
        return true;
    }

    private _runPendingAudioTrackSwitchRebuild(): boolean {
        const plan = this._pending_audio_rebuild_plan;
        if (plan === null) {
            return false;
        }
        const context = this._track_switch_transaction;
        if (!context || context.kind !== 'audio-switch' ||
            context.transactionId !== plan.transactionId ||
            !this._isOperationForTransaction(plan.operation, context.operation)) {
            this._pending_audio_rebuild_plan = null;
            return false;
        }
        if (!this._allSourceBuffersIdle()) {
            return true;
        }
        if (plan.replaceMediaSource) {
            let rebuilt = false;
            try {
                rebuilt = this._output.rebuildMediaSource(plan);
            } catch (error) {
                this._failTrackSwitch(context, 'rebuild-media-source', error);
                return true;
            }
            if (!rebuilt) {
                this._failTrackSwitch(context, 'rebuild-media-source', {
                    code: -1,
                    msg: 'Failed to rebuild MediaSource for MMTS audio track switch',
                });
                return true;
            }
        } else {
            const mediaSourceState = this._getMediaSourceState();
            const videoSourceBuffer = this._getSourceBufferState('video', mediaSourceState);
            const audioSourceBuffer = this._getSourceBufferState('audio', mediaSourceState);
            if (!videoSourceBuffer || !videoSourceBuffer.exists ||
                !audioSourceBuffer || !audioSourceBuffer.exists) {
                this._failTrackSwitch(context, 'rebuild-media-source', {
                    code: -1,
                    msg: 'Cannot rebuild MMTS audio track switch in place without existing SourceBuffers',
                });
                return true;
            }
        }

        this._pending_audio_rebuild_plan = null;
        this._mmts_vod_audio_track_rebuild_active = false;
        this._pending_audio_rebuild_operation = clonePlaybackOperation(plan.operation);
        context.stage = 'rebuilding';
        if (!plan.preserveVideoBuffer) {
            this._pending_init_segments.video.splice(
                0,
                this._pending_init_segments.video.length,
                plan.videoInitSegment
            );
            this._pending_media_segments.video.splice(
                0,
                this._pending_media_segments.video.length,
                ...plan.videoSegments
            );
        }
        this._pending_init_segments.audio.splice(
            0,
            this._pending_init_segments.audio.length,
            plan.replaceMediaSource ? plan.audioInitSegment : Object.assign({}, plan.audioInitSegment, {
                resetParserState: true,
            })
        );
        this._pending_media_segments.audio.splice(
            0,
            this._pending_media_segments.audio.length,
            ...plan.audioSegments
        );
        if (plan.replaceMediaSource) {
            this._source_opened = false;
            this._track_state.video = 'NEED_INIT';
            this._track_state.audio = 'NEED_INIT';
            this._main_state = 'OPENING';
        } else if (plan.preserveVideoBuffer) {
            this._track_state.audio = 'RESETTING_PARSER';
            this._main_state = 'TRACK_SWITCHING';
            Log.v(
                this.TAG,
                `Rebuild MMTS audio switch in place while preserving video, ` +
                `transaction=${plan.transactionId}`
            );
        } else {
            this._pending_full_track_flush.video = true;
            this._pending_full_track_flush.audio = true;
            this._track_state.video = 'NEED_INIT';
            this._track_state.audio = 'RESETTING_PARSER';
            this._main_state = 'TRACK_SWITCHING';
            Log.v(
                this.TAG,
                `Rebuild MMTS audio switch in existing MediaSource, transaction=${plan.transactionId}`
            );
        }
        this._pending_media_seek_target = plan.seekTime;
        this._pending_media_seek_reason = plan.preserveVideoBuffer ?
            'AUDIO_TRACK_SWITCH_IN_PLACE' : 'AUDIO_TRACK_SWITCH_REBUILD';
        this._pending_media_seek_min_forward = 0.05;
        this._clearAllInflightOperations();
        if (plan.preserveVideoBuffer) {
            this._resetMMTSSourceIdentity('audio');
        } else {
            this._resetMMTSSourceIdentity();
        }
        return plan.replaceMediaSource;
    }

    private _makeAudioTrackSwitchRebuildPlan(request: any): MSEAudioTrackSwitchRebuildPlan | null {
        const context = this._track_switch_transaction;
        const operation = request && request.operation;
        const preserveVideoBuffer = !!request && request.preserveVideoBuffer === true;
        const validVideoPlan = preserveVideoBuffer ?
            request.replaceMediaSource === false &&
                request.videoInitSegment == null &&
                Array.isArray(request.videoSegments) && request.videoSegments.length === 0 :
            this._isRebuildInitSegment(request && request.videoInitSegment, 'video') &&
                this._isMMTSInputForOperation(request.videoInitSegment, operation) &&
                Array.isArray(request.videoSegments) && request.videoSegments.length > 0 &&
                request.videoSegments.every((segment: any) =>
                    this._isRebuildMediaSegment(segment, 'video') &&
                    this._isMMTSInputForOperation(segment, operation)) &&
                isMMTSRandomAccessSafeVideoSegment(request.videoSegments[0]) &&
                this._doesVideoRebuildStartAtSyncPoint(request.videoSegments[0]) &&
                validateMMTSTrackSwitchSegmentPrefix(
                    request.videoSegments,
                    'video',
                    request.seekTime,
                    0.05
                );
        if (!request || !context || context.kind !== 'audio-switch' ||
            context.stage !== 'requested' || !this._isTrackSwitchRequestCurrent(context, request) ||
            !this._isCurrentPlaybackOperation(operation) ||
            typeof request.replaceMediaSource !== 'boolean' ||
            !this._isFiniteNumber(request.switchTime) || request.switchTime < 0 ||
            !this._isFiniteNumber(request.seekTime) || request.seekTime < 0 ||
            !Number.isInteger(request.transactionId) || request.transactionId < 0 ||
            !this._isRebuildInitSegment(request.audioInitSegment, 'audio') ||
            !this._isMMTSInputForOperation(request.audioInitSegment, operation) ||
            !Array.isArray(request.audioSegments) || request.audioSegments.length === 0 ||
            !request.audioSegments.every((segment: any) =>
                this._isRebuildMediaSegment(segment, 'audio') &&
                this._isMMTSInputForOperation(segment, operation)) ||
            !validVideoPlan ||
            !validateMMTSTrackSwitchSegmentPrefix(
                request.audioSegments,
                'audio',
                request.seekTime,
                preserveVideoBuffer ? 0.25 : 0.05
            )) {
            return null;
        }

        return {
            type: 'audio_track_switch',
            operation: clonePlaybackOperation(operation),
            replaceMediaSource: request.replaceMediaSource,
            preserveVideoBuffer,
            switchTime: request.switchTime,
            seekTime: request.seekTime,
            resumePlayback: request.resumePlayback === true,
            videoInitSegment: preserveVideoBuffer ? null :
                this._cloneRebuildInitSegment(request.videoInitSegment),
            audioInitSegment: this._cloneRebuildInitSegment(request.audioInitSegment),
            videoSegments: preserveVideoBuffer ? [] :
                request.videoSegments.map((segment: any) => this._cloneRebuildMediaSegment(segment)),
            audioSegments: request.audioSegments.map((segment: any) => this._cloneRebuildMediaSegment(segment)),
            transactionId: request.transactionId,
        };
    }

    private _isRebuildInitSegment(segment: any, type: MSEBufferTrackType): boolean {
        return !!segment &&
            segment.type === type &&
            typeof segment.container === 'string' &&
            !!segment.data && segment.data.byteLength > 0;
    }

    private _isRebuildMediaSegment(segment: any, type: MSEBufferTrackType): boolean {
        return !!segment &&
            segment.type === type &&
            !!segment.data && segment.data.byteLength > 0 &&
            this._isMediaSegmentTimestampValid(segment);
    }

    private _doesVideoRebuildStartAtSyncPoint(segment: any): boolean {
        const firstSample = segment && segment.info && segment.info.firstSample;
        return !!firstSample && firstSample.isSyncPoint === true;
    }

    private _cloneRebuildInitSegment(segment: any): any {
        const clone = Object.assign({}, segment, {
            playbackOperation: clonePlaybackOperation(segment.playbackOperation),
        });
        delete clone.resetParserState;
        delete clone.rebuildSourceBuffer;
        delete clone.mimeType;
        return clone;
    }

    private _cloneRebuildMediaSegment(segment: any): any {
        const clone = Object.assign({}, segment, {
            playbackOperation: clonePlaybackOperation(segment.playbackOperation),
        });
        delete clone.resetParserState;
        delete clone.rebuildSourceBuffer;
        delete clone.mimeType;
        delete clone.mseStartupGroupId;
        return clone;
    }

    private _resetMMTSSourceIdentity(type?: MSEBufferTrackType): void {
        if (type) {
            this._last_mmts_source_identity[type] = null;
            return;
        }
        this._last_mmts_source_identity.video = null;
        this._last_mmts_source_identity.audio = null;
    }

    private _isMMTSSourceIdentityValid(type: MSEBufferTrackType, segment: any): boolean {
        if (!this._shouldValidateMMTSSourceIdentity()) {
            return true;
        }
        const current = this._getSegmentMMTSSourceBegin(segment);
        if (current === null) {
            return true;
        }
        const last = this._last_mmts_source_identity[type];
        if (last === null || last.generation !== this._seek_generation) {
            return true;
        }
        const begin = this._getSegmentTimelineBegin(segment);
        const timelineForward = isFinite(begin) && begin >= last.timelineEnd - 0.05;
        if (!timelineForward) {
            return true;
        }
        return !this._hasStaleMMTSSourceIdentity(current, last.source);
    }

    private _recordMMTSSourceIdentity(type: MSEBufferTrackType, segment: any): void {
        if (!this._shouldValidateMMTSSourceIdentity()) {
            return;
        }
        const source = this._getSegmentMMTSSourceEnd(segment);
        if (source === null) {
            return;
        }
        this._last_mmts_source_identity[type] = {
            generation: this._seek_generation,
            timelineBegin: this._getSegmentTimelineBegin(segment),
            timelineEnd: this._getSegmentTimelineEnd(segment),
            source,
        };
    }

    private _shouldValidateMMTSSourceIdentity(): boolean {
        return this._config && this._config.isMMTS === true && this._config.isLive !== true;
    }

    private _getSegmentMMTSSourceBegin(segment: any): MMTSMediaSourceIdentity | null {
        const sourceInfo = segment && segment.mmtsSourceInfo;
        if (!sourceInfo) {
            return null;
        }
        return sourceInfo.firstSample || sourceInfo;
    }

    private _getSegmentMMTSSourceEnd(segment: any): MMTSMediaSourceIdentity | null {
        const sourceInfo = segment && segment.mmtsSourceInfo;
        if (!sourceInfo) {
            return null;
        }
        return sourceInfo.lastSample || sourceInfo;
    }

    private _hasBackwardFilePosition(current: MMTSMediaSourceIdentity,
                                     last: MMTSMediaSourceIdentity): boolean {
        if (!this._isFiniteNumber(current.filePosition) || !this._isFiniteNumber(last.filePosition)) {
            return false;
        }
        return current.filePosition + 188 * 16 < last.filePosition;
    }

    private _hasStaleMMTSSourceIdentity(current: MMTSMediaSourceIdentity,
                                        last: MMTSMediaSourceIdentity): boolean {
        const fileBackward = this._hasBackwardFilePosition(current, last);
        const mpuBackward = this._hasBackwardMpuSequence(current, last);
        const repeatedSample = this._hasRepeatedSampleInSameMpu(current, last);
        const rawDtsBackward = this._hasSevereBackwardRawDts(current, last);

        if (rawDtsBackward && (fileBackward || mpuBackward || repeatedSample)) {
            return true;
        }
        if (mpuBackward && fileBackward) {
            return true;
        }
        return repeatedSample && fileBackward;
    }

    private _hasBackwardMpuSequence(current: MMTSMediaSourceIdentity,
                                    last: MMTSMediaSourceIdentity): boolean {
        if (!this._isSameMMTSPacket(current, last)) {
            return false;
        }
        if (!this._isFiniteNumber(current.mpuSequenceNumber) ||
            !this._isFiniteNumber(last.mpuSequenceNumber)) {
            return false;
        }
        return current.mpuSequenceNumber < last.mpuSequenceNumber;
    }

    private _hasRepeatedSampleInSameMpu(current: MMTSMediaSourceIdentity,
                                        last: MMTSMediaSourceIdentity): boolean {
        if (!this._isSameMMTSPacket(current, last) ||
            !this._isFiniteNumber(current.mpuSequenceNumber) ||
            !this._isFiniteNumber(last.mpuSequenceNumber) ||
            current.mpuSequenceNumber !== last.mpuSequenceNumber) {
            return false;
        }
        if (this._isFiniteNumber(current.sampleNumber) && this._isFiniteNumber(last.sampleNumber)) {
            return current.sampleNumber <= last.sampleNumber;
        }
        return false;
    }

    private _isSameMMTSPacket(current: MMTSMediaSourceIdentity,
                              last: MMTSMediaSourceIdentity): boolean {
        return !this._isFiniteNumber(current.packetId) ||
            !this._isFiniteNumber(last.packetId) ||
            current.packetId === last.packetId;
    }

    private _hasSevereBackwardRawDts(current: MMTSMediaSourceIdentity,
                                     last: MMTSMediaSourceIdentity): boolean {
        if (!this._isFiniteNumber(current.rawDts) || !this._isFiniteNumber(last.rawDts)) {
            return false;
        }
        return current.rawDts + 1000 < last.rawDts;
    }

    private _enterRecoveringForInvalidMMTSSourceIdentity(type: MSEBufferTrackType, segment: any): void {
        this._main_state = 'RECOVERING';
        this._track_state[type] = 'READY';
        this._pending_media_segments[type].splice(0, this._pending_media_segments[type].length);
        this._scheduleTrackFlush(type);
        if (this._output.seekTransmuxer) {
            this._pending_transmuxer_seek_milliseconds =
                Math.round(Math.max(0, this._current_time) * 1000000) / 1000;
            this._pending_transmuxer_seek_reason = 'MMTS_SOURCE_IDENTITY';
        }
        this._pauseTransmuxer('MMTS_SOURCE_IDENTITY');
        Log.w(this.TAG, `Reject stale MMTS ${type} segment source identity`);
        this.tick('invalid_mmts_source_identity');
    }

    private _isFiniteNumber(value: any): boolean {
        return typeof value === 'number' && isFinite(value);
    }

    private _isMMTS(): boolean {
        return !!this._config && this._config.isMMTS === true;
    }

    private _isMMTSInputForCurrentOperation(value: any): boolean {
        if (!this._isMMTS()) {
            return true;
        }
        return !!this._playback_operation &&
            this._isMMTSInputForOperation(value, this._playback_operation);
    }

    private _isMMTSInputForOperation(value: any, operation: PlaybackOperation): boolean {
        return !!value && isPlaybackOperation(operation) &&
            this._isExactPlaybackOperation(value.playbackOperation, operation) &&
            value.mseBufferGeneration === operation.timelineGeneration;
    }

    private _isCurrentPlaybackOperation(operation: any): operation is PlaybackOperation {
        return !!this._playback_operation &&
            this._isExactPlaybackOperation(operation, this._playback_operation);
    }

    private _isOperationForTransaction(value: any, expected: PlaybackOperation): boolean {
        return isPlaybackOperation(value) && isPlaybackOperation(expected) &&
            isSamePlaybackAttempt(value, expected);
    }

    private _isExactPlaybackOperation(value: any, expected: PlaybackOperation): boolean {
        return isPlaybackOperation(value) && isPlaybackOperation(expected) &&
            isSamePlaybackAttempt(value, expected) &&
            value.timelineGeneration === expected.timelineGeneration &&
            value.intentTimeMicroseconds === expected.intentTimeMicroseconds &&
            value.requestedTimeMicroseconds === expected.requestedTimeMicroseconds &&
            value.packetId === expected.packetId;
    }

    private _getTrackSwitchContextForSegment(segment: any): MSETrackSwitchTransactionContext | null {
        const context = this._track_switch_transaction;
        if (!context || !segment ||
            !this._isOperationForTransaction(segment.playbackOperation, context.operation)) {
            return null;
        }
        if (context.kind === 'video-switch' &&
            segment.mseVideoTrackSwitchTransactionId !== context.transactionId) {
            return null;
        }
        return context;
    }

    private _dropStaleMMTSPendingData(): void {
        if (!this._isMMTS()) {
            return;
        }
        const types: MSEBufferTrackType[] = ['video', 'audio'];
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            this._pending_init_segments[type] = this._pending_init_segments[type].filter(
                (segment: any) => this._isMMTSInputForCurrentOperation(segment)
            );
            this._pending_media_segments[type] = this._pending_media_segments[type].filter(
                (segment: any) => this._isMMTSInputForCurrentOperation(segment)
            );
        }
        if (this._pending_startup_group &&
            (!this._playback_operation || !this._isExactPlaybackOperation(
                this._pending_startup_group.playbackOperation,
                this._playback_operation
            ))) {
            this._clearPendingStartupGroup();
        }
    }

    private _enterQuotaEviction(type: MSEBufferTrackType, reason: string): void {
        this._last_quota_type = type;
        this._track_state[type] = 'BLOCKED_BY_QUOTA';
        this._main_state = 'EVICTING';
        this._schedulePressureCleanup(type);
        if (this._hasPendingRemoveRanges()) {
            this.tick(reason);
        } else {
            this._pauseTransmuxer('QUOTA');
        }
    }

    private _selectInitTrack(): MSEBufferTrackType | null {
        const videoPending = this._pending_init_segments.video.length > 0;
        const audioPending = this._pending_init_segments.audio.length > 0;
        if (!videoPending && !audioPending) {
            return null;
        }
        if (this._output.ensureSourceBuffer) {
            const videoState = this._getSourceBufferState('video');
            const audioState = this._getSourceBufferState('audio');
            if (videoPending && (!videoState || !videoState.exists)) {
                return 'video';
            }
            if (audioPending && (!audioState || !audioState.exists)) {
                return 'audio';
            }
        }
        const waitForAudio = videoPending &&
            this._shouldDeferVideoInitUntilAudio(this._pending_init_segments.video[0]);
        if (audioPending && (!videoPending || waitForAudio)) {
            return 'audio';
        }
        if (waitForAudio) {
            return null;
        }
        return videoPending ? 'video' : 'audio';
    }

    private _shouldDeferVideoInitUntilAudio(segment: any): boolean {
        if (!segment ||
            this._config.isMMTS !== true ||
            !this._config.mmtsDeferHevcVideoInitUntilAudio ||
            segment.type !== 'video' ||
            segment.container !== 'video/mp4') {
            return false;
        }
        const audioState = this._getSourceBufferState('audio');
        if (audioState && audioState.exists) {
            return false;
        }
        const codec = segment.codec || '';
        if (!codec || (codec.indexOf('hvc1.') !== 0 && codec.indexOf('hev1.') !== 0)) {
            return false;
        }
        const level = /\.L(\d+)/.exec(codec);
        if (level !== null && parseInt(level[1], 10) < 180) {
            return false;
        }
        return this._expectsAudio();
    }

    private _needsBudgetEviction(type: MSEBufferTrackType, segment: any): boolean {
        const info = this._getBufferedForwardBufferInfo(this._current_time);
        const nextBytes = this._getSegmentBytes(segment);
        if (type === 'video') {
            const hard = this._getByteLimit('mseBufferVideoHardLimitBytes', 145 * 1024 * 1024);
            const bufferedBytes = info.videoBufferedBytes !== undefined ?
                info.videoBufferedBytes :
                (info.videoForwardBytes || 0);
            return bufferedBytes + nextBytes > hard;
        }

        const hard = this._getByteLimit('mseBufferAudioHardLimitBytes', 18 * 1024 * 1024);
        const bufferedBytes = info.audioBufferedBytes !== undefined ?
            info.audioBufferedBytes :
            (info.audioForwardBytes || 0);
        return bufferedBytes + nextBytes > hard;
    }

    private _schedulePressureCleanup(type: MSEBufferTrackType): void {
        const keep = this._getPressureBackwardKeepDuration();
        this._scheduleBackwardCleanup(type, keep);
        this._scheduleBackwardCleanup(type === 'video' ? 'audio' : 'video', keep);
    }

    private _scheduleNormalCleanup(): void {
        const keep = this._getNormalBackwardKeepDuration();
        this._scheduleBackwardCleanup('video', keep);
        this._scheduleBackwardCleanup('audio', keep);
    }

    private _scheduleBackwardCleanup(type: MSEBufferTrackType, keepDuration: number): void {
        if (!this._output.getBufferedRanges) {
            return;
        }
        let removeEndLimit = this._current_time - keepDuration;
        if (type === 'video' && this._video_random_access_points.length > 0) {
            // Removing the verified decoder root makes Firefox evict every
            // dependent HEVC sample up to the next sync point.  Align cleanup
            // to the latest retained random-access point at/before currentTime
            // so the interval end remains a decodable root (remove() excludes
            // the sample exactly at its end time).
            let decoderRoot = null;
            for (let i = this._video_random_access_points.length - 1; i >= 0; i--) {
                const point = this._video_random_access_points[i];
                const pointTime = point.pts / 1000;
                if (isFinite(pointTime) && pointTime <= this._current_time + 0.08) {
                    decoderRoot = pointTime;
                    break;
                }
            }
            if (decoderRoot !== null) {
                removeEndLimit = Math.min(removeEndLimit, decoderRoot);
            }
        }
        if (!isFinite(removeEndLimit) || removeEndLimit <= 0) {
            return;
        }
        const ranges = this._output.getBufferedRanges(type);
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end)) {
                continue;
            }
            const removeEnd = Math.min(range.end, removeEndLimit);
            if (removeEnd > range.start) {
                this._appendRemoveRange(type, range.start, removeEnd, 'cleanup');
            }
        }
    }

    private _scheduleTrackFlush(type: MSEBufferTrackType): void {
        if (!this._output.getBufferedRanges) {
            return;
        }
        const ranges = this._output.getBufferedRanges(type);
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end) || range.end <= range.start) {
                continue;
            }
            this._appendRemoveRange(type, range.start, range.end, 'flush');
        }
    }

    private _materializePendingTrackFlush(): void {
        const types: MSEBufferTrackType[] = ['video', 'audio'];
        for (let i = 0; i < types.length; i++) {
            const type = types[i];
            const flushAll = this._pending_full_track_flush[type];
            const flushFrom = this._pending_track_flush_from[type];
            this._pending_full_track_flush[type] = false;
            this._pending_track_flush_from[type] = null;
            if (flushAll) {
                this._scheduleTrackFlush(type);
            } else if (flushFrom != null) {
                this._scheduleTrackFlushFrom(type, flushFrom);
            }
        }
    }

    private _scheduleTrackFlushFrom(type: MSEBufferTrackType, start: number): void {
        if (!this._output.getBufferedRanges || !isFinite(start)) {
            return;
        }
        const ranges = this._output.getBufferedRanges(type);
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end)) {
                continue;
            }
            const removeStart = Math.max(start, range.start);
            if (range.end > removeStart) {
                this._appendRemoveRange(type, removeStart, range.end, 'flush');
            }
        }
    }

    private _appendRemoveRange(type: MSEBufferTrackType,
                               start: number,
                               end: number,
                               kind: 'cleanup' | 'flush'): void {
        const ranges = this._pending_remove_ranges[type];
        const protectedRange = kind === 'cleanup' ? this._getCurrentPlayableRange() : null;
        if (protectedRange && end > protectedRange.start && start < protectedRange.end) {
            if (start < protectedRange.start) {
                this._appendRemoveRange(type, start, Math.min(end, protectedRange.start), kind);
            }
            if (end > protectedRange.end) {
                this._appendRemoveRange(type, Math.max(start, protectedRange.end), end, kind);
            }
            return;
        }
        for (let i = 0; i < ranges.length; i++) {
            if (Math.abs(ranges[i].start - start) < 0.01 && Math.abs(ranges[i].end - end) < 0.01) {
                return;
            }
        }
        if (end > start) {
            ranges.push({start, end, kind});
        }
    }

    private _getCurrentPlayableRange(): MSEBufferRange | null {
        if (!this._output.getBufferedRanges) {
            return null;
        }
        if (!this._expectsAudio()) {
            const videoRange = this._findRangeCoveringCurrentTime(this._output.getBufferedRanges('video'));
            return videoRange ? this._makeCurrentTimeProtectionRange(videoRange) : null;
        }
        const videoRange = this._findRangeCoveringCurrentTime(this._output.getBufferedRanges('video'));
        const audioRange = this._findRangeCoveringCurrentTime(this._output.getBufferedRanges('audio'));
        if (!videoRange || !audioRange) {
            return null;
        }
        const start = Math.max(videoRange.start, audioRange.start);
        const end = Math.min(videoRange.end, audioRange.end);
        return this._makeCurrentTimeProtectionRange({start, end});
    }

    private _makeCurrentTimeProtectionRange(range: MSEBufferRange): MSEBufferRange | null {
        const start = range.start;
        const end = range.end;
        if (end <= start || this._current_time < start || this._current_time >= end) {
            return null;
        }
        return {
            start: Math.max(start, this._current_time - 0.05),
            end: Math.min(end, this._current_time + 0.25),
        };
    }

    private _findRangeCoveringCurrentTime(ranges: MSEBufferRange[]): MSEBufferRange | null {
        const tolerance = 0.08;
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end)) {
                continue;
            }
            if (this._current_time >= range.start - tolerance && this._current_time < range.end + tolerance) {
                return range;
            }
        }
        return null;
    }

    private _updateBackpressure(): void {
        if (!this._output) {
            return;
        }
        const info = this.getForwardBufferInfo(this._current_time);
        const seeking = this._main_state === 'SEEKING';
        const videoSoft = seeking ?
            Math.min(this._getByteLimit('mseBufferVideoSoftLimitBytes', 120 * 1024 * 1024), 32 * 1024 * 1024) :
            this._getByteLimit('mseBufferVideoSoftLimitBytes', 120 * 1024 * 1024);
        const audioSoft = seeking ?
            Math.min(this._getByteLimit('mseBufferAudioSoftLimitBytes', 12 * 1024 * 1024), 4 * 1024 * 1024) :
            this._getByteLimit('mseBufferAudioSoftLimitBytes', 12 * 1024 * 1024);
        const recoverVideoBytes = this._getRecoverVideoBytes(videoSoft);
        const recoverAudioBytes = this._getRecoverAudioBytes(audioSoft);
        const forwardTargetDuration = seeking ?
            Math.min(this._getForwardTargetDuration(), 8) : this._getForwardTargetDuration();
        const recoverForwardDuration = this._getRecoverForwardDuration(forwardTargetDuration);
        const videoBytes = info.videoForwardBytes || 0;
        const audioBytes = info.audioForwardBytes || 0;
        const videoDuration = info.videoForwardDuration || 0;
        const audioDuration = info.audioForwardDuration || 0;
        const playableDuration = info.forwardDuration || 0;

        this._scheduleAudioCleanupIfNeeded(info);

        if (!this._canBackpressureControlTransmuxer()) {
            return;
        }

        // Each elementary stream owns an independent producer budget.  Do not
        // wait for an A/V intersection before enforcing it: after a seek a
        // corrupt or temporarily missing AAC stream used to disable all
        // backpressure and let video/subtitle demux run through minutes of the
        // file.  A normal interleaved MMTS stream has ample room to expose the
        // other track before these limits are reached.
        const videoLimitReached = this._expectsVideo() &&
            (videoBytes >= videoSoft || videoDuration >= forwardTargetDuration);
        const audioLimitReached = this._expectsAudio() &&
            (audioBytes >= audioSoft || audioDuration >= forwardTargetDuration);
        const playableLimitReached = this._isBackpressureReady(info) &&
            playableDuration >= forwardTargetDuration;

        if (videoLimitReached || audioLimitReached || playableLimitReached) {
            if (this._main_state !== 'FATAL' && this._main_state !== 'SEEKING') {
                this._main_state = 'BACKPRESSURE';
            }
            this._scheduleNormalCleanup();
            this._pauseTransmuxer('BACKPRESSURE');
        } else if (this._transmuxer_paused &&
            videoBytes <= recoverVideoBytes &&
            audioBytes <= recoverAudioBytes &&
            videoDuration <= recoverForwardDuration &&
            audioDuration <= recoverForwardDuration &&
            playableDuration <= recoverForwardDuration) {
            this._resumeTransmuxer('RECOVERED');
            if (this._main_state === 'BACKPRESSURE') {
                this._main_state = 'STEADY';
            }
        }
    }

    private _updateBackpressureStallPrefetch(eventType: string): void {
        if (this._backpressure_stall_prefetch_active) {
            const startTime = this._backpressure_stall_prefetch_start_time;
            if (startTime != null &&
                (this._current_time > startTime + 0.5 || this._current_time < startTime - 1)) {
                this._clearBackpressureStallPrefetch();
            }
            return;
        }

        if (eventType !== 'waiting' && eventType !== 'stalled') {
            return;
        }

        this._tryBeginBackpressureStallPrefetch();
    }

    private _tryBeginBackpressureStallPrefetch(): boolean {
        if (this._config.isMMTS !== true || this._config.isLive === true ||
            !this._transmuxer_paused || this._transmuxer_pause_reason !== 'BACKPRESSURE' ||
            this._main_state !== 'BACKPRESSURE') {
            return false;
        }

        const info = this.getForwardBufferInfo(this._current_time);
        const videoSoft = this._getBaseByteLimit('mseBufferVideoSoftLimitBytes', 120 * 1024 * 1024);
        const videoBytes = info.videoForwardBytes || 0;
        const playableDuration = info.forwardDuration || 0;
        if (videoBytes < videoSoft * 0.9 || playableDuration < 5) {
            return false;
        }

        // Safari/AirPlay may wait for a larger remote playback queue before it
        // starts advancing currentTime.  A byte-based VOD cap can otherwise
        // deadlock with that demand: playback waits for data while backpressure
        // waits for playback.  Temporarily let the configured duration target
        // own the forward horizon; normal byte limits return after real progress.
        this._backpressure_stall_prefetch_active = true;
        this._backpressure_stall_prefetch_start_time = this._current_time;
        Log.w(
            this.TAG,
            `Resume MMTS VOD stalled prefetch at ${this._current_time.toFixed(3)}, ` +
            `forward=${playableDuration.toFixed(3)}s, video_bytes=${Math.round(videoBytes)}`
        );
        this._resumeTransmuxer('RECOVERED');
        this._main_state = 'STEADY';
        return true;
    }

    private _clearBackpressureStallPrefetch(): void {
        this._backpressure_stall_prefetch_active = false;
        this._backpressure_stall_prefetch_start_time = null;
    }

    private _resumeIfRecovered(): void {
        if (!this._canBackpressureControlTransmuxer()) {
            return;
        }
        const info = this.getForwardBufferInfo(this._current_time);
        const videoSoft = this._getByteLimit('mseBufferVideoSoftLimitBytes', 120 * 1024 * 1024);
        const audioSoft = this._getByteLimit('mseBufferAudioSoftLimitBytes', 12 * 1024 * 1024);
        const forwardTargetDuration = this._getForwardTargetDuration();
        if ((info.videoForwardBytes || 0) <= this._getRecoverVideoBytes(videoSoft) &&
            (info.audioForwardBytes || 0) <= this._getRecoverAudioBytes(audioSoft) &&
            (info.forwardDuration || 0) <= this._getRecoverForwardDuration(forwardTargetDuration)) {
            this._resumeTransmuxer('RECOVERED');
        }
    }

    private _canBackpressureControlTransmuxer(): boolean {
        // Existing ranges still belong to the prior track while the new startup group is collected.
        // Using them for backpressure would starve this transaction until that old buffer drains.
        if (this._mmts_vod_audio_track_rebuild_active) {
            return false;
        }
        return this._main_state === 'PRIMING' ||
            this._main_state === 'STEADY' ||
            this._main_state === 'BACKPRESSURE' ||
            this._main_state === 'SEEKING';
    }

    private _isBackpressureReady(info: MSEBufferForwardInfo): boolean {
        const expectsAudio = this._expectsAudio();
        const expectsVideo = this._expectsVideo();
        const videoReady = (info.videoForwardBytes || 0) > 0 ||
            (info.videoForwardDuration || 0) > 0;
        const audioReady = (info.audioForwardBytes || 0) > 0 ||
            (info.audioForwardDuration || 0) > 0;
        if (expectsAudio && expectsVideo) {
            return this._hasAudioSourceOrPending() && videoReady && audioReady;
        }
        if (expectsVideo) {
            return videoReady;
        }
        if (expectsAudio) {
            return this._hasAudioSourceOrPending() && audioReady;
        }
        return false;
    }

    private _scheduleAudioCleanupIfNeeded(info: MSEBufferForwardInfo): void {
        const audioSoft = this._getByteLimit('mseBufferAudioSoftLimitBytes', 12 * 1024 * 1024);
        if ((info.audioForwardBytes || 0) >= audioSoft) {
            this._scheduleBackwardCleanup('audio', this._getPressureBackwardKeepDuration());
        }
    }

    private _isVideoBlockedByAudioLead(segment: any): boolean {
        if (!this._expectsAudio() || !this._hasAudioSourceOrPending()) {
            return false;
        }
        const leadLimit = this._getTrackLeadLimit();
        if (leadLimit <= 0) {
            return false;
        }
        const info = this.getForwardBufferInfo(this._current_time);
        const audioEnd = this._getTrackLeadReferenceEnd(
            'audio',
            segment,
            info.audioForwardDuration || 0,
            leadLimit
        );
        if (!isFinite(audioEnd) || audioEnd <= this._current_time) {
            const videoEnd = this._getTrackLeadReferenceEnd(
                'video',
                segment,
                info.videoForwardDuration || 0,
                leadLimit
            );
            return videoEnd > this._current_time &&
                this._pending_media_segments.audio.length > 0;
        }
        const videoBegin = this._getSegmentTimelineBegin(segment);
        const videoEnd = this._getSegmentTimelineEnd(segment);
        if (isFinite(videoBegin) && videoBegin <= this._current_time + 0.25) {
            return false;
        }
        return isFinite(videoEnd) && videoEnd > audioEnd + leadLimit;
    }

    private _isAudioBlockedByVideoLead(segment: any): boolean {
        if (!this._expectsVideo()) {
            return false;
        }
        const leadLimit = this._getTrackLeadLimit();
        if (leadLimit <= 0) {
            return false;
        }
        const info = this.getForwardBufferInfo(this._current_time);
        const videoEnd = this._getTrackLeadReferenceEnd(
            'video',
            segment,
            info.videoForwardDuration || 0,
            leadLimit
        );
        if (!isFinite(videoEnd) || videoEnd <= this._current_time) {
            return true;
        }
        const audioBegin = this._getSegmentTimelineBegin(segment);
        const audioEnd = this._getSegmentTimelineEnd(segment);
        if (isFinite(audioBegin) && audioBegin <= this._current_time + 0.25) {
            return false;
        }
        return isFinite(audioEnd) && audioEnd > videoEnd + leadLimit;
    }

    private _getTrackLeadReferenceEnd(type: MSEBufferTrackType,
                                      segment: any,
                                      forwardDuration: number,
                                      leadLimit: number): number {
        let end = this._current_time + Math.max(0, forwardDuration || 0);
        if (!this._output.getBufferedRanges) {
            return end;
        }

        const segmentBegin = this._getSegmentTimelineBegin(segment);
        const segmentEnd = this._getSegmentTimelineEnd(segment);
        if (!isFinite(segmentBegin) || !isFinite(segmentEnd)) {
            return end;
        }

        const tolerance = Math.max(0.25, leadLimit);
        const ranges = this._output.getBufferedRanges(type);
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end) ||
                range.end <= this._current_time ||
                range.start > segmentEnd + tolerance ||
                range.end < segmentBegin - tolerance) {
                continue;
            }
            end = Math.max(end, range.end);
        }
        return end;
    }

    private _getPlayableForwardDuration(currentTime: number,
                                        audioForwardDuration: number,
                                        videoForwardDuration: number): number {
        const expectsAudio = this._expectsAudio();
        const expectsVideo = this._expectsVideo();
        if (expectsAudio && expectsVideo) {
            if (!this._hasAudioSourceOrPending()) {
                return 0;
            }
            return Math.max(0, Math.min(audioForwardDuration, videoForwardDuration));
        }
        if (expectsVideo) {
            return videoForwardDuration;
        }
        if (expectsAudio) {
            return this._hasAudioSourceOrPending() ? audioForwardDuration : 0;
        }
        return 0;
    }

    private _recordVideoRandomAccessPoints(segment: any): void {
        if (!this._isMMTS() || !segment || !segment.info ||
            !Array.isArray(segment.info.syncPoints)) {
            return;
        }
        for (let i = 0; i < segment.info.syncPoints.length; i++) {
            const syncPoint = segment.info.syncPoints[i];
            if (!syncPoint || !this._isFiniteNumber(syncPoint.dts) ||
                !this._isFiniteNumber(syncPoint.pts) || syncPoint.pts < 0) {
                continue;
            }
            const duplicate = this._video_random_access_points.some(
                (point: MSEVideoRandomAccessPoint) =>
                    point.dts === syncPoint.dts && point.pts === syncPoint.pts
            );
            if (!duplicate) {
                this._video_random_access_points.push({
                    dts: syncPoint.dts,
                    pts: syncPoint.pts,
                });
            }
        }
        this._video_random_access_points.sort((a, b) => {
            if (a.pts !== b.pts) {
                return a.pts - b.pts;
            }
            return a.dts - b.dts;
        });
    }

    private _resolveBufferedVideoRandomAccessPoint(targetTime: number): number | null {
        const tolerance = 0.01;
        // A direct seek still needs audio and video at the requested position,
        // but audio does not need to cover the video's decode preroll.  MMTS
        // streams can leave a short audio-only SourceBuffer hole while video
        // remains continuous.  Requiring the A/V intersection from the
        // preceding RAP through targetTime rejects the exact jump that is
        // needed to cross that hole.
        if (!this._hasPlayableRangeAt(targetTime, 0.05)) {
            return null;
        }
        for (let i = this._video_random_access_points.length - 1; i >= 0; i--) {
            const point = this._video_random_access_points[i];
            const pointTime = point.pts / 1000;
            if (pointTime > targetTime + tolerance ||
                !this._isRangeCovered(
                    'video',
                    pointTime,
                    targetTime + 0.05,
                    0.08
                )) {
                continue;
            }
            return pointTime;
        }
        return null;
    }

    private _hasPlayableRangeAt(targetTime: number, minForwardDuration: number): boolean {
        if (!this._output.getBufferedRanges) {
            return false;
        }
        const end = targetTime + Math.max(minForwardDuration, 0.05);
        const expectsAudio = this._expectsAudio();
        const expectsVideo = this._expectsVideo();
        if (expectsAudio && expectsVideo) {
            return this._isRangeCovered('video', targetTime, end, 0.08) &&
                this._isRangeCovered('audio', targetTime, end, 0.08);
        }
        if (expectsVideo) {
            return this._isRangeCovered('video', targetTime, end, 0.08);
        }
        if (expectsAudio) {
            return this._isRangeCovered('audio', targetTime, end, 0.08);
        }
        return false;
    }

    private _requestMediaSeekWhenPlayable(targetTime: number, reason: string, minForwardDuration: number): boolean {
        const seekAtNextPlayableIntersection = reason === 'STARTUP_GROUP' ||
            reason === 'RECOMMEND_SEEKPOINT' ||
            reason === 'AUDIO_TRACK_SWITCH_REBUILD' ||
            reason === 'VIDEO_PARAMETER_SET_RECOVERY';
        const playableTarget = seekAtNextPlayableIntersection ?
            this._findPlayableSeekTimeAtOrAfter(targetTime, minForwardDuration) :
            (this._hasPlayableRangeAt(targetTime, minForwardDuration) ? targetTime : null);
        if (playableTarget !== null) {
            if (playableTarget > targetTime + 0.001) {
                Log.v(
                    this.TAG,
                    `Move ${reason} from ${targetTime.toFixed(3)} to playable intersection ${playableTarget.toFixed(3)}`
                );
            }
            this._main_state = 'SEEKING';
            this._current_time = playableTarget;
            this._pending_media_seek_target = null;
            this._pending_media_seek_reason = null;
            this._pending_media_seek_min_forward = 0;
            this._timeline_seek_target_time = null;
            if (this._output.seekMedia) {
                this._awaiting_media_seek_completion = true;
                this._output.seekMedia(playableTarget, reason);
            }
            const operation = this._playback_operation;
            if (reason === 'RECOMMEND_SEEKPOINT' &&
                isPlaybackOperation(operation) && operation.kind === 'seek') {
                this._output.onPlaybackOperationComplete?.(operation, {
                    committedTimeMilliseconds: playableTarget * 1000,
                });
            }
            if (reason === 'AUDIO_TRACK_SWITCH_REBUILD') {
                const pendingOperation = this._pending_audio_rebuild_operation;
                const context = this._track_switch_transaction;
                this._pending_audio_rebuild_operation = null;
                if (pendingOperation && context && context.kind === 'audio-switch' &&
                    context.stage === 'rebuilding' &&
                    this._isExactPlaybackOperation(pendingOperation, context.operation)) {
                    const operation = clonePlaybackOperation(context.operation);
                    this._track_switch_transaction = null;
                    this._resumeTransmuxer('TRACK_SWITCHING_REBUILD_COMPLETE');
                    this._output.onAudioTrackSwitchRebuildComplete?.(operation);
                }
            }
            return true;
        }

        this._pending_media_seek_target = targetTime;
        this._pending_media_seek_reason = reason;
        this._pending_media_seek_min_forward = minForwardDuration;
        this._main_state = 'SEEKING';
        return false;
    }

    private _findPlayableSeekTimeAtOrAfter(targetTime: number, minForwardDuration: number): number | null {
        if (!this._output.getBufferedRanges) {
            return null;
        }
        const minimum = Math.max(minForwardDuration, 0.05);
        const videoRanges = this._expectsVideo() ? this._output.getBufferedRanges('video') : [];
        const audioRanges = this._expectsAudio() ? this._output.getBufferedRanges('audio') : [];

        if (this._expectsVideo() && this._expectsAudio()) {
            let videoIndex = 0;
            let audioIndex = 0;
            while (videoIndex < videoRanges.length && audioIndex < audioRanges.length) {
                const video = videoRanges[videoIndex];
                const audio = audioRanges[audioIndex];
                const start = Math.max(video.start, audio.start, targetTime);
                const end = Math.min(video.end, audio.end);
                if (isFinite(start) && isFinite(end) && end - start >= minimum) {
                    return start;
                }
                if (video.end <= audio.end) {
                    videoIndex++;
                } else {
                    audioIndex++;
                }
            }
            return null;
        }

        const ranges = this._expectsVideo() ? videoRanges : audioRanges;
        for (let i = 0; i < ranges.length; i++) {
            const start = Math.max(ranges[i].start, targetTime);
            const end = ranges[i].end;
            if (isFinite(start) && isFinite(end) && end - start >= minimum) {
                return start;
            }
        }
        return null;
    }

    private _applyPendingMediaSeekIfReady(): boolean {
        if (this._pending_media_seek_target == null || this._pending_media_seek_reason == null) {
            return false;
        }
        if (!this._allSourceBuffersIdle()) {
            return false;
        }
        if (this._pending_media_seek_reason === 'AUDIO_TRACK_SWITCH_IN_PLACE') {
            const targetTime = Math.max(this._pending_media_seek_target, this._current_time);
            if (!this._hasPlayableRangeAt(targetTime, this._pending_media_seek_min_forward)) {
                return false;
            }
            const pendingOperation = this._pending_audio_rebuild_operation;
            const context = this._track_switch_transaction;
            this._pending_audio_rebuild_operation = null;
            this._pending_media_seek_target = null;
            this._pending_media_seek_reason = null;
            this._pending_media_seek_min_forward = 0;
            this._timeline_seek_target_time = null;
            this._main_state = this._source_opened ? 'STEADY' : 'OPENING';
            if (pendingOperation && context && context.kind === 'audio-switch' &&
                context.stage === 'rebuilding' &&
                this._isExactPlaybackOperation(pendingOperation, context.operation)) {
                const operation = clonePlaybackOperation(context.operation);
                this._track_switch_transaction = null;
                this._resumeTransmuxer('TRACK_SWITCHING_REBUILD_COMPLETE');
                this._output.onAudioTrackSwitchRebuildComplete?.(operation);
            }
            return true;
        }
        return this._requestMediaSeekWhenPlayable(
            this._pending_media_seek_target,
            this._pending_media_seek_reason,
            this._pending_media_seek_min_forward
        );
    }

    private _isAudioTrackSwitchRebuildReason(reason: string | null): boolean {
        return reason === 'AUDIO_TRACK_SWITCH_REBUILD' ||
            reason === 'AUDIO_TRACK_SWITCH_IN_PLACE';
    }

    private _resumeTrackSwitchDataRequestIfReady(): void {
        if (!this._track_switch_needs_data || this._main_state !== 'TRACK_SWITCHING') {
            return;
        }
        if (this._hasPendingRemoveRanges() || !this._allSourceBuffersIdle()) {
            return;
        }
        this._track_switch_needs_data = false;
        this._resumeTransmuxer('TRACK_SWITCHING_DATA_REQUEST');
    }

    private _canLeaveTransientState(): boolean {
        if (this._main_state === 'TRACK_SWITCHING') {
            return !this._live_audio_track_switch_collection_hold &&
                !this._track_switch_needs_data &&
                !this._hasPendingRemoveRanges();
        }
        if (this._main_state === 'EVICTING' || this._main_state === 'RECOVERING') {
            return !this._hasPendingRemoveRanges() &&
                this._pending_transmuxer_seek_milliseconds == null &&
                this._allSourceBuffersIdle();
        }
        if (this._main_state !== 'SEEKING') {
            return false;
        }
        if (this._awaiting_media_seek_completion) {
            return false;
        }
        if (this._pending_media_seek_target != null) {
            return false;
        }
        if (this._timeline_seek_target_time == null) {
            return true;
        }
        if (!this._hasPlayableRangeAt(this._timeline_seek_target_time, 0.05)) {
            return false;
        }
        this._timeline_seek_target_time = null;
        return true;
    }

    private _isSegmentAllowedInCurrentTimeline(segment: any): boolean {
        if (this._main_state !== 'SEEKING' || this._timeline_seek_target_time == null) {
            return true;
        }
        const end = this._getSegmentTimelineEnd(segment);
        if (!isFinite(end)) {
            return false;
        }
        return end >= this._timeline_seek_target_time - this._getSeekPrerollKeepDuration();
    }

    private _isRangeCovered(type: MSEBufferTrackType, start: number, end: number, tolerance: number): boolean {
        const ranges = this._output.getBufferedRanges(type);
        let coveredEnd = NaN;
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            if (!isFinite(range.start) || !isFinite(range.end)) {
                continue;
            }
            if (!isFinite(coveredEnd)) {
                if (start >= range.start - tolerance && start <= range.end + tolerance) {
                    coveredEnd = range.end;
                }
            } else if (range.start <= coveredEnd + tolerance) {
                coveredEnd = Math.max(coveredEnd, range.end);
            }
            if (isFinite(coveredEnd) && end <= coveredEnd + tolerance) {
                return true;
            }
        }
        return false;
    }

    private _expectsAudio(): boolean {
        if (this._media_info && this._media_info.hasAudio === false) {
            return false;
        }
        if (this._media_info && this._media_info.hasAudio === true) {
            return true;
        }
        return this._config && this._config.isMMTS === true;
    }

    private _expectsVideo(): boolean {
        if (this._media_info && this._media_info.hasVideo === false) {
            return false;
        }
        return true;
    }

    private _hasAudioSourceOrPending(): boolean {
        const audioState = this._getSourceBufferState('audio');
        return !!(audioState && audioState.exists) ||
            this._pending_init_segments.audio.length > 0 ||
            this._pending_media_segments.audio.length > 0;
    }

    private _getSeekPrerollKeepDuration(): number {
        const value = this._config && this._config.mseSeekPrerollKeepDuration;
        return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 6;
    }

    private _isMediaSourceOperational(): boolean {
        const state = this._getMediaSourceState();
        return this._source_opened &&
            this._isOperationalMediaSourceState(state) &&
            state.streaming !== false;
    }

    private _isOperationalMediaSourceState(state: MSEBufferMediaSourceState): boolean {
        return state.readyState === 'open' || state.readyState === 'ended';
    }

    private _hasFatalMediaError(): boolean {
        return !!this._getMediaSourceState().hasFatalMediaError;
    }

    private _canOperateOnType(type: MSEBufferTrackType): boolean {
        const state = this._getMediaSourceState();
        const sourceBuffer = this._getSourceBufferState(type, state);
        return this._isOperationalMediaSourceState(state) &&
            state.streaming !== false &&
            !state.hasFatalMediaError &&
            this._inflight_operations[type] === null &&
            (!sourceBuffer || !sourceBuffer.updating);
    }

    private _canAppendMediaToType(type: MSEBufferTrackType): boolean {
        const state = this._getMediaSourceState();
        const sourceBuffer = this._getSourceBufferState(type, state);
        return this._isOperationalMediaSourceState(state) &&
            state.streaming !== false &&
            !state.hasFatalMediaError &&
            this._inflight_operations[type] === null &&
            !!(sourceBuffer && sourceBuffer.exists) &&
            !sourceBuffer.updating;
    }

    private _allSourceBuffersIdle(): boolean {
        const state = this._getMediaSourceState();
        const video = this._getSourceBufferState('video', state);
        const audio = this._getSourceBufferState('audio', state);
        return (!video || !video.updating) && (!audio || !audio.updating);
    }

    private _getMediaSourceState(): MSEBufferMediaSourceState {
        if (this._output && this._output.getMediaSourceState) {
            return this._output.getMediaSourceState();
        }
        return {
            readyState: 'closed',
            sourceBuffers: {},
        };
    }

    private _getSourceBufferState(type: MSEBufferTrackType, state?: MSEBufferMediaSourceState): {exists: boolean, updating: boolean} {
        const mediaState = state || this._getMediaSourceState();
        return mediaState.sourceBuffers[type];
    }

    private _setInflightOperation(type: MSEBufferTrackType,
                                  kind: 'init' | 'media' | 'remove',
                                  segment: any): void {
        const operation: MSEBufferInflightOperation = {
            kind,
            segment,
        };
        this._inflight_operations[type] = operation;
    }

    private _getInflightOperation(type?: MSEBufferTrackType): {
        type: MSEBufferTrackType,
        operation: MSEBufferInflightOperation,
    } | null {
        if (type) {
            const operation = this._inflight_operations[type];
            return operation ? {type, operation} : null;
        }

        const types: MSEBufferTrackType[] = ['video', 'audio'];
        const active = types.filter((candidate: MSEBufferTrackType) =>
            this._inflight_operations[candidate] !== null
        );
        if (active.length === 1) {
            const resolvedType = active[0];
            const operation = this._inflight_operations[resolvedType];
            return operation ? {type: resolvedType, operation} : null;
        }
        if (active.length !== 2) {
            return null;
        }

        const state = this._getMediaSourceState();
        const completed = active.filter((candidate: MSEBufferTrackType) => {
            const sourceBuffer = this._getSourceBufferState(candidate, state);
            return !!sourceBuffer && sourceBuffer.updating === false;
        });
        if (completed.length !== 1) {
            return null;
        }
        const resolvedType = completed[0];
        const operation = this._inflight_operations[resolvedType];
        return operation ? {type: resolvedType, operation} : null;
    }

    private _takeInflightOperation(type?: MSEBufferTrackType,
                                   kind?: 'init' | 'media' | 'remove'): {
        type: MSEBufferTrackType,
        operation: MSEBufferInflightOperation,
    } | null {
        const inflight = this._getInflightOperation(type);
        if (!inflight || (kind && inflight.operation.kind !== kind)) {
            return null;
        }
        this._clearInflightOperation(inflight.type);
        return inflight;
    }

    private _clearInflightOperation(type: MSEBufferTrackType): void {
        this._inflight_operations[type] = null;
    }

    private _clearAllInflightOperations(): void {
        this._inflight_operations.video = null;
        this._inflight_operations.audio = null;
    }

    private _markTrackReady(type?: MSEBufferTrackType): void {
        if (type) {
            if (this._track_state[type] === 'APPENDING' || this._track_state[type] === 'REMOVING') {
                this._track_state[type] = 'READY';
            }
            return;
        }
        const inflight = this._getInflightOperation();
        if (inflight) {
            this._track_state[inflight.type] = 'READY';
        }
    }

    private _queuesEmpty(): boolean {
        return this._pending_init_segments.video.length === 0 &&
            this._pending_init_segments.audio.length === 0 &&
            this._pending_media_segments.video.length === 0 &&
            this._pending_media_segments.audio.length === 0 &&
            this._pending_remove_ranges.video.length === 0 &&
            this._pending_remove_ranges.audio.length === 0 &&
            !this._hasPendingTrackFlush();
    }

    private _hasPendingRemoveRanges(): boolean {
        return this._pending_remove_ranges.video.length > 0 ||
            this._pending_remove_ranges.audio.length > 0 ||
            this._hasPendingTrackFlush();
    }

    private _hasPendingTrackFlush(): boolean {
        return this._pending_full_track_flush.video ||
            this._pending_full_track_flush.audio ||
            this._pending_track_flush_from.video != null ||
            this._pending_track_flush_from.audio != null;
    }

    private _pauseTransmuxer(reason: string): void {
        if (this._transmuxer_paused) {
            if (this._shouldReplacePauseReason(reason)) {
                this._transmuxer_pause_reason = reason;
            }
            return;
        }
        this._transmuxer_paused = true;
        this._transmuxer_pause_reason = reason;
        Log.v(this.TAG, `Pause transmuxer: ${reason}`);
        this._output.pauseTransmuxer(reason);
    }

    private _resumeTransmuxer(reason: string): void {
        if (!this._transmuxer_paused) {
            return;
        }
        if (!this._canResumeTransmuxer(reason)) {
            return;
        }
        this._transmuxer_paused = false;
        this._transmuxer_pause_reason = null;
        Log.v(this.TAG, `Resume transmuxer: ${reason}`);
        this._output.resumeTransmuxer(reason);
    }

    private _shouldReplacePauseReason(reason: string): boolean {
        if (reason === 'FATAL' || reason === 'SEEKING' ||
            reason.indexOf('TRACK_SWITCHING') === 0 || reason === 'QUOTA') {
            return true;
        }
        return this._transmuxer_pause_reason === 'BACKPRESSURE';
    }

    private _canResumeTransmuxer(reason: string): boolean {
        const pauseReason = this._transmuxer_pause_reason;
        if (!pauseReason) {
            return true;
        }
        if (pauseReason === 'FATAL') {
            return false;
        }
        if (pauseReason === 'BACKPRESSURE') {
            return reason === 'RECOVERED' ||
                reason === 'STARTUP_JUMP_WAIT' ||
                reason === 'RECOMMEND_SEEKPOINT_WAIT' ||
                reason === 'USER_SEEK' ||
                reason === 'SEEK';
        }
        if (pauseReason === 'SEEKING') {
            return reason === 'USER_SEEK' ||
                reason === 'SEEK' ||
                reason === 'MMTS_VOD_AUDIO_TRACK_REBUILD' ||
                reason === 'MMTS_VOD_AUDIO_TRACK_REBUILD_CANCELLED';
        }
        if (pauseReason === 'QUOTA') {
            return reason === 'QUOTA_RECOVERED' || reason === 'RECOVERING';
        }
        if (pauseReason.indexOf('TRACK_SWITCHING') === 0) {
            return reason.indexOf('TRACK_SWITCHING') === 0;
        }
        return pauseReason === reason;
    }

    private _getTrackLeadLimit(): number {
        const value = this._config.mseAppendTrackLeadLimit;
        return typeof value === 'number' && isFinite(value) && value > 0 ? value : (this._config.isLive ? 1.5 : 2);
    }

    private _getAppendBatchDuration(): number {
        const value = this._config.mseAppendBatchDuration;
        return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0;
    }

    private _getBaseByteLimit(field: string, fallback: number): number {
        const value = this._config[field];
        return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
    }

    private _getByteLimit(field: string, fallback: number): number {
        const limit = this._getBaseByteLimit(field, fallback);
        if (this._backpressure_stall_prefetch_active &&
            (field === 'mseBufferVideoSoftLimitBytes' || field === 'mseBufferVideoHardLimitBytes')) {
            return limit * 3;
        }
        return limit;
    }

    private _getRecoverVideoBytes(videoSoftLimit: number): number {
        const value = this._config.lazyLoadRecoverBytes;
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            return Math.min(value, videoSoftLimit);
        }
        return Math.floor(videoSoftLimit * 0.5);
    }

    private _getRecoverAudioBytes(audioSoftLimit: number): number {
        return Math.floor(audioSoftLimit * 0.5);
    }

    private _getForwardTargetDuration(): number {
        const value = this._config.mseBufferForwardTargetDuration;
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            return value;
        }
        const lazyLoadMaxDuration = this._config.lazyLoadMaxDuration;
        if (typeof lazyLoadMaxDuration === 'number' && isFinite(lazyLoadMaxDuration) && lazyLoadMaxDuration > 0) {
            return lazyLoadMaxDuration;
        }
        return this._config.isLive ? 18 : 60;
    }

    private _getRecoverForwardDuration(forwardTargetDuration: number): number {
        const value = this._config.mseBufferRecoverForwardDuration;
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            return Math.min(value, forwardTargetDuration);
        }
        const lazyLoadRecoverDuration = this._config.lazyLoadRecoverDuration;
        if (typeof lazyLoadRecoverDuration === 'number' && isFinite(lazyLoadRecoverDuration) && lazyLoadRecoverDuration > 0) {
            return Math.min(lazyLoadRecoverDuration, forwardTargetDuration);
        }
        return Math.min(this._config.isLive ? 8 : 20, forwardTargetDuration);
    }

    private _getNormalBackwardKeepDuration(): number {
        const value = this._config.autoCleanupMaxBackwardDuration;
        if (typeof value === 'number' && isFinite(value) && value > 0) {
            return value;
        }
        return this._config.isLive ? 6 : 12;
    }

    private _getPressureBackwardKeepDuration(): number {
        const maximum = this._config.isLive ? 4 : 2;
        const value = this._config.autoCleanupMinBackwardDuration;
        if (typeof value === 'number' && isFinite(value) && value >= 0) {
            return Math.min(value, maximum);
        }
        return maximum;
    }

    private _isMediaSegmentTimestampValid(segment: any): boolean {
        if (!segment || !segment.info) {
            return false;
        }
        const begin = this._getSegmentTimelineBegin(segment);
        const end = this._getSegmentTimelineEnd(segment);
        return isFinite(begin) && isFinite(end) && end > begin;
    }

    private _enterRecoveringForInvalidTimestamp(type: MSEBufferTrackType, segment: any): void {
        this._main_state = 'RECOVERING';
        this._track_state[type] = 'BLOCKED_BY_QUOTA';
        Log.e(this.TAG, `Invalid ${type} media segment timestamp, enter recovery`);
        this.onFatal({
            code: -1,
            msg: `Invalid ${type} media segment timestamp`,
            segmentInfo: segment ? segment.info : null,
        });
    }

    private _getPendingForwardBytes(type: MSEBufferTrackType, currentTime: number): number {
        const queue = this._pending_media_segments[type];
        let bytes = 0;
        for (let i = 0; i < queue.length; i++) {
            const segment = queue[i];
            const begin = this._getSegmentTimelineBegin(segment);
            const end = this._getSegmentTimelineEnd(segment);
            if (!isFinite(begin) || !isFinite(end) || end <= currentTime) {
                continue;
            }
            const overlapStart = Math.max(begin, currentTime);
            const duration = end - begin;
            const byteLength = this._getSegmentBytes(segment);
            bytes += duration > 0 ?
                byteLength * ((end - overlapStart) / duration) :
                byteLength;
        }
        return Math.ceil(bytes);
    }

    private _getPipelineForwardDuration(type: MSEBufferTrackType,
                                        currentTime: number,
                                        bufferedForwardDuration: number): number {
        const tolerance = 0.12;
        let coveredEnd = currentTime + Math.max(0, bufferedForwardDuration || 0);
        const segments = this._pending_media_segments[type].slice();
        const inflight = this._inflight_operations[type];
        if (inflight && inflight.kind === 'media' && inflight.segment) {
            segments.push(inflight.segment);
        }
        segments.sort((a: any, b: any) =>
            this._getSegmentTimelineBegin(a) - this._getSegmentTimelineBegin(b)
        );
        for (let i = 0; i < segments.length; i++) {
            const begin = this._getSegmentTimelineBegin(segments[i]);
            const end = this._getSegmentTimelineEnd(segments[i]);
            if (!isFinite(begin) || !isFinite(end) || end <= currentTime ||
                begin > coveredEnd + tolerance) {
                continue;
            }
            coveredEnd = Math.max(coveredEnd, end);
        }
        return Math.max(0, coveredEnd - currentTime);
    }

    private _getSegmentBytes(segment: any): number {
        return segment && segment.data && segment.data.byteLength ? segment.data.byteLength : 0;
    }

    private _makeSegmentMimeType(segment: any): string | null {
        if (!segment || !segment.container) {
            return null;
        }
        let mimeType = `${segment.container}`;
        if (segment.codec) {
            mimeType += `;codecs=${segment.codec}`;
        }
        return mimeType;
    }

    private _getSegmentTimelineBegin(segment: any): number {
        const info = segment && segment.info;
        if (!info) {
            return NaN;
        }
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

    private _getSegmentTimelineEnd(segment: any): number {
        const info = segment && segment.info;
        if (!info) {
            return NaN;
        }
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

}

export default MSEBufferStateMachine;

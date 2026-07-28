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

import * as EventEmitter from 'events';
import type PlayerEngine from './player-engine';
import Browser from '../utils/browser';
import Log from '../utils/logger';
import { applyMediaDataSourceConfig, createDefaultConfig } from '../config';
import MSEController from '../core/mse-controller';
import PlayerEvents from './player-events';
import Transmuxer from '../core/transmuxer';
import MediaInfo from '../core/media-info';
import MSEEvents from '../core/mse-events';
import { ErrorTypes, ErrorDetails } from './player-errors';
import { IllegalStateException } from '../utils/exception';
import TransmuxingEvents from '../core/transmuxing-events';
import SeekingHandler from './seeking-handler';
import LoadingController from './loading-controller';
import MSEBufferStateMachine from './mse-buffer-state-machine';
import StartupBufferGate from './startup-buffer-gate';
import StartupStallJumper from './startup-stall-jumper';
import LiveLatencyChaser from './live-latency-chaser';
import LiveLatencySynchronizer from './live-latency-synchronizer';
import { findPreferredAudioTrack, isMMTSAudioTrackSelectable } from '../utils/mmts-demuxer-utils';
import {
    clonePlaybackOperation,
    createNextPlaybackAttempt,
    createPlaybackOperation,
    createPlaybackScopeId,
    createPlaybackSwitchIdentity,
    doesPlaybackSwitchIdentityMatchOperation,
    isPlaybackOperation,
    isPlaybackOperationRetryRequest,
    isPlaybackSwitchIdentity,
    isSamePlaybackAttempt,
    isSamePlaybackOperation,
    isSamePlaybackTransaction,
    rebindReservedPlaybackOperation,
    type PlaybackOperation,
    type PlaybackOperationRetryRequest,
} from '../core/playback-operation';
import PlaybackOperationResultRegistry, {
    type PlaybackOperationResult,
} from './playback-operation-result';
import PlaybackOperationScheduler, {
    type ScheduledPlaybackIntent,
} from './playback-operation-scheduler';
import {
    isMMTSStartupGroupFailure,
    type MMTSStartupGroupFailure,
} from '../core/mmts-startup-group-lifecycle';
import MMTSAudioTrackSwitchCoordinator, {
    type MMTSAudioTrackSwitchReservation,
    type MMTSAudioTrackSwitchStrategy,
    type MMTSAudioTrackSwitchTransaction,
    type MMTSVodAudioStartupGroupApplyResult,
} from './mmts-audio-track-switch-transaction';
import MMTSVideoTrackSwitchCoordinator, {
    type MMTSVideoTrackSwitchReservation,
    type MMTSVideoTrackSwitchTransaction,
} from './mmts-video-track-switch-transaction';
import {
    canAppendMMTSLiveVideoContinuation,
    getMMTSFirstPlayableWindow,
    getMMTSSegmentDecodeRange,
    isMMTSRandomAccessSafeVideoSegment,
    selectMMTSTrackSwitchSegmentPrefix,
} from './mmts-track-switch-window';

const MMTS_VOD_AUDIO_TRACK_REBUILD_REASON = 'MMTS_VOD_AUDIO_TRACK_REBUILD';
const MMTS_TRACK_SWITCH_VIDEO_CACHE_LIMIT = 12;
const MMTS_TRACK_SWITCH_AUDIO_CACHE_LIMIT = 12;
const MMTS_VOD_TRACK_SWITCH_SEGMENT_LIMIT = 64;
const MMTS_VOD_AUDIO_TRACK_SWITCH_PREPARATION_TIMEOUT = 10000;
const MMTS_VOD_AUDIO_TRACK_SWITCH_REBUILD_TIMEOUT = 45000;
const MMTS_VOD_AUDIO_TRACK_SWITCH_MAX_RETRIES = 1;
const MMTS_VIDEO_TRACK_SWITCH_SELECTION_TIMEOUT = 10000;
const MMTS_VIDEO_TRACK_SWITCH_DATA_TIMEOUT = 45000;

type MMTSVodAudioTrackSwitchAction =
    | {type: 'primary'}
    | {type: 'secondary'}
    | {type: 'select', packetId: number};

type MMTSSeekIntentPayload = {
    type: 'seek',
    targetSeconds: number,
    source: string,
};

type MMTSAudioSwitchIntentPayload = {
    type: 'audio-switch',
    reservation: MMTSAudioTrackSwitchReservation,
};

type MMTSVideoSwitchIntentPayload = {
    type: 'video-switch',
    reservation: MMTSVideoTrackSwitchReservation,
};

type MMTSInteractiveIntentPayload =
    MMTSSeekIntentPayload | MMTSAudioSwitchIntentPayload | MMTSVideoSwitchIntentPayload;

type PendingMMTSSeekRequest = {
    operation: PlaybackOperation,
    targetSeconds: number,
    source: string,
};

type PlaybackRecoveryRoot = {
    operation: PlaybackOperation,
    reason: string,
};

type MMTSVodAudioTrackSwitchTransaction = {
    operation: PlaybackOperation,
    requestedTime: number,
    expectedPacketId: number,
    resumePlayback: boolean,
    generation: number,
    stage: 'preparing' | 'selecting' | 'waiting_startup' | 'extending' | 'submitted' | 'rebuilding',
    selectionIssued: boolean,
    confirmedPacketId?: number,
    confirmedTracks?: any[],
    confirmedAudioTracks?: any,
    resolvedSeekTime?: number,
    retryCount: number,
    pendingMediaInfo?: MediaInfo,
    rebuildWindow?: MMTSVodAudioTrackSwitchRebuildWindow,
};

type MMTSVodAudioTrackSwitchRequest = {
    operation: PlaybackOperation,
    requestedTime: number,
    expectedPacketId: number,
    resumePlayback: boolean,
    retryCount?: number,
};

type MMTSVodAudioTrackSwitchRebuildWindow = {
    videoInitSegment: any,
    audioInitSegment: any,
    audioSwitch: any,
    videoSegments: any[],
    audioSegments: any[],
};

type MMTSLiveVideoRebuildWindow = {
    playableStart: number,
    segments: any[],
};

class PlayerEngineMainThread implements PlayerEngine {

    private readonly TAG: string = 'PlayerEngineMainThread';

    private _emitter: EventEmitter = new EventEmitter();
    private _media_data_source: any;
    private _config: any;

    private _media_element?: HTMLMediaElement = null;

    private _mse_controller?: MSEController = null;
    private _mse_buffer_state_machine?: MSEBufferStateMachine = null;
    private _transmuxer?: Transmuxer = null;

    private _pending_seek_time?: number = null;

    private _seeking_handler?: SeekingHandler = null;
    private _loading_controller?: LoadingController = null;
    private _startup_buffer_gate?: StartupBufferGate = null;
    private _startup_stall_jumper?: StartupStallJumper = null;
    private _live_latency_chaser?: LiveLatencyChaser = null;
    private _live_latency_synchronizer?: LiveLatencySynchronizer = null;

    private _mse_source_opened: boolean = false;
    private _has_pending_load: boolean = false;
    private _loaded_metadata_received: boolean = false;
    private _pending_video_track_switch_init_segment?: any = null;
    private _pending_video_track_switch_media_segment?: any = null;
    private _selected_mmts_video_packet_id?: number = null;
    private _desired_mmts_video_packet_id?: number = null;
    private _mmts_video_tracks: any[] = [];
    private _pending_audio_track_switch_request_time?: number = null;
    private _pending_audio_track_switch_expected_packet_id?: number = null;
    private _accepted_audio_track_switch_time?: number = null;
    private _pending_audio_track_switch_init_segment?: any = null;
    private _pending_audio_track_switch_media_segments: any[] = [];
    private _pending_audio_track_switch_resume_playback: boolean = false;
    private _resume_playback_after_audio_track_switch_rebuild: boolean = false;
    private _mmts_audio_track_switch_rebuild_in_progress: boolean = false;
    private _mmts_live_video_rebuild_window?: MMTSLiveVideoRebuildWindow = null;
    private _selected_mmts_audio_packet_id?: number = null;
    private _desired_mmts_audio_packet_id?: number = null;
    private _mmts_audio_tracks: any[] = [];
    private _pending_mmts_vod_audio_track_switch?: MMTSVodAudioTrackSwitchTransaction = null;
    private _last_mse_buffer_full_log_time: number = 0;
    private _audio_track_switch_coordinator: MMTSAudioTrackSwitchCoordinator;
    private _video_track_switch_coordinator: MMTSVideoTrackSwitchCoordinator;
    private _playback_scope_id: string;
    private _playback_timeline_generation: number = 0;
    private _playback_transaction_id: number = 0;
    private _active_playback_operation?: PlaybackOperation = null;
    private _operation_results: PlaybackOperationResultRegistry;
    private _operation_scheduler: PlaybackOperationScheduler<MMTSInteractiveIntentPayload> =
        new PlaybackOperationScheduler<MMTSInteractiveIntentPayload>();
    private _pending_mmts_seek?: PendingMMTSSeekRequest = null;
    private _pending_mmts_seek_timer?: any = null;
    private _playback_recovery_roots: Map<string, PlaybackRecoveryRoot> = new Map();
    private _handling_external_mse_error: boolean = false;
    private _external_mse_error_reported: boolean = false;

    private _media_info?: MediaInfo = null;
    private _statistics_info?: any = null;

    private e?: any = null;

    public constructor(mediaDataSource: any, config: any) {
        this._media_data_source = mediaDataSource;
        this._config = createDefaultConfig();

        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        applyMediaDataSourceConfig(this._config, mediaDataSource, config);

        this._playback_scope_id = createPlaybackScopeId('mmts-main');
        this._operation_results = new PlaybackOperationResultRegistry((event) => {
            this._emitter.emit(PlayerEvents.MMTS_OPERATION_STATE, event);
            if (event.terminal) {
                this._emitter.emit(PlayerEvents.MMTS_OPERATION_RESULT, event);
            }
        });

        this._audio_track_switch_coordinator = new MMTSAudioTrackSwitchCoordinator({
            onTimeout: (transaction) => this._onUnifiedAudioTrackSwitchTimeout(transaction),
            stageTimeout: (stage) => ['requested', 'preparing', 'selecting'].includes(stage) ?
                MMTS_VOD_AUDIO_TRACK_SWITCH_PREPARATION_TIMEOUT :
                MMTS_VOD_AUDIO_TRACK_SWITCH_REBUILD_TIMEOUT,
        });
        this._video_track_switch_coordinator = new MMTSVideoTrackSwitchCoordinator({
            onTimeout: (transaction) => this._failUnifiedMMTSVideoTrackSwitch(
                transaction.operation,
                `timeout:${transaction.stage}`
            ),
            stageTimeout: (stage) => stage === 'requested' || stage === 'selecting' ?
                MMTS_VIDEO_TRACK_SWITCH_SELECTION_TIMEOUT :
                MMTS_VIDEO_TRACK_SWITCH_DATA_TIMEOUT,
        });

        this.e = {
            onMediaLoadedMetadata: this._onMediaLoadedMetadata.bind(this),
            onMediaTimeUpdate: this._onMediaTimeUpdate.bind(this),
            onMediaStateChange: this._onMediaStateChange.bind(this),
        };
    }

    public destroy(): void {
        this._emitter.emit(PlayerEvents.DESTROYING);
        if (this._transmuxer) {
            this.unload();
        }
        if (this._media_element) {
            this.detachMediaElement();
        }
        this.e = null;
        this._media_data_source = null;
        this._cancelPendingMMTSSeek('player-destroyed');
        this._settleAndClearScheduledOperations('cancelled', 'player-destroyed');
        this._operation_results.destroy('player-destroyed');
        this._playback_recovery_roots.clear();

        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    public on(event: string, listener: (...args: any[]) => void): void {
        this._emitter.addListener(event, listener);
        // For media_info / statistics_info event, trigger it immediately
        if (event === PlayerEvents.MEDIA_INFO && this._media_info) {
            Promise.resolve().then(() => this._emitter.emit(PlayerEvents.MEDIA_INFO, this.mediaInfo));
        } else if (event == PlayerEvents.STATISTICS_INFO && this._statistics_info) {
            Promise.resolve().then(() => this._emitter.emit(PlayerEvents.STATISTICS_INFO, this.statisticsInfo));
        }
    }

    public off(event: string, listener: (...args: any[]) => void): void {
        this._emitter.removeListener(event, listener);
    }

    public attachMediaElement(mediaElement: HTMLMediaElement): void {
        this._media_element = mediaElement;

        // Remove src / srcObject of HTMLMediaElement for cleanup
        mediaElement.src = '';
        mediaElement.removeAttribute('src');
        mediaElement.srcObject = null;
        mediaElement.load();

        mediaElement.addEventListener('loadedmetadata', this.e.onMediaLoadedMetadata);
        mediaElement.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
        mediaElement.addEventListener('waiting', this.e.onMediaStateChange);
        mediaElement.addEventListener('stalled', this.e.onMediaStateChange);
        mediaElement.addEventListener('progress', this.e.onMediaStateChange);
        mediaElement.addEventListener('canplay', this.e.onMediaStateChange);
        mediaElement.addEventListener('loadeddata', this.e.onMediaStateChange);

        this._mse_controller = this._createMSEController();

        // Attach media source into media element
        this._attachMSEControllerToMediaElement(this._mse_controller);
    }

    private _createMSEController(): MSEController {
        const mseController = new MSEController(this._config);
        mseController.on(MSEEvents.UPDATE_END, this._onMSEUpdateEnd.bind(this));
        mseController.on(MSEEvents.BUFFER_FULL, this._onMSEBufferFull.bind(this));
        mseController.on(MSEEvents.SOURCE_OPEN, this._onMSESourceOpen.bind(this));
        mseController.on(MSEEvents.ERROR, this._onMSEError.bind(this));
        mseController.on(MSEEvents.START_STREAMING, this._onMSEStartStreaming.bind(this));
        mseController.on(MSEEvents.END_STREAMING, this._onMSEEndStreaming.bind(this));
        mseController.initialize({
            getCurrentTime: () => this._media_element.currentTime,
            getReadyState: () => this._media_element.readyState,
        });
        return mseController;
    }

    private _createMSEBufferStateMachine(): MSEBufferStateMachine {
        return new MSEBufferStateMachine(this._config, {
            ensureSourceBuffer: (_type: any, segment: any) => {
                return this._mse_controller.ensureSourceBufferDirect(segment);
            },
            appendInit: (_type: any, segment: any) => {
                return this._mse_controller.appendInitSegmentDirect(
                    segment,
                    segment && segment.resetParserState === true
                );
            },
            appendMedia: (_type: any, segment: any) => {
                return this._mse_controller.appendMediaSegmentDirect(segment);
            },
            removeRange: (type: any, start: number, end: number) => {
                return this._mse_controller.removeRangeDirect(type, start, end);
            },
            resetParserState: (type: any, mimeType: string) => {
                return this._mse_controller.resetParserStateDirect(type, mimeType);
            },
            pauseTransmuxer: (_reason: string) => {
                this._loading_controller ?
                    this._loading_controller.suspendTransmuxer() :
                    this._transmuxer?.pause();
            },
            resumeTransmuxer: (_reason: string) => {
                this._loading_controller ?
                    this._loading_controller.resumeTransmuxer() :
                    this._transmuxer?.resume();
            },
            flushPending: (_type?: any) => {},
            emitFatal: (error: any) => {
                this._emitMSEError(error);
            },
            onStartupGroupAppended: (startupGroup: any) => {
                this._startup_buffer_gate?.releaseStartupGroup();
                Log.v(this.TAG, `Append MMTS startup group at ${startupGroup.startupTime.toFixed(3)}s`);
            },
            seekMedia: (targetTime: number, reason: string) => {
                this._seeking_handler?.directSeek(targetTime);
            },
            onAudioTrackSwitchRebuildComplete: (operation: PlaybackOperation) => {
                if (this._pending_mmts_vod_audio_track_switch) {
                    this._finishMMTSVodAudioTrackSwitch(operation);
                } else {
                    this._finishUnifiedLiveAudioTrackSwitch(operation);
                }
            },
            onAudioTrackSwitchRebuildFailed: (failure: any) => {
                const active = this._audio_track_switch_coordinator.active;
                if (active && failure && failure.kind === 'audio-switch' &&
                    isPlaybackOperation(failure.operation) &&
                    isSamePlaybackAttempt(active.operation, failure.operation)) {
                    this._failUnifiedMMTSAudioTrackSwitch(
                        active.operation,
                        `rebuild-failed:${failure.phase}`
                    );
                }
            },
            onVideoTrackSwitchComplete: (operation: PlaybackOperation) => {
                this._finishUnifiedMMTSVideoTrackSwitch(operation);
            },
            onVideoTrackSwitchFailed: (failure: any) => {
                const active = this._video_track_switch_coordinator.active;
                if (active && failure && failure.kind === 'video-switch' &&
                    isPlaybackOperation(failure.operation) &&
                    isSamePlaybackAttempt(active.operation, failure.operation)) {
                    this._failUnifiedMMTSVideoTrackSwitch(
                        active.operation,
                        `mse-failed:${failure.phase}`
                    );
                }
            },
            onPlaybackOperationComplete: (operation: PlaybackOperation, details?: any) => {
                if (operation.kind === 'seek') {
                    this._completeScheduledOperation(
                        operation,
                        'committed',
                        'startup-group-appended',
                        details || {}
                    );
                }
            },
            onPlaybackOperationFailed: (operation: PlaybackOperation, error: any) => {
                if (operation.kind === 'seek') {
                    this._completeScheduledOperation(
                        operation,
                        'failed',
                        'startup-group-failed',
                        {error}
                    );
                }
            },
            seekTransmuxer: (
                milliseconds: number,
                reason: string,
                operation?: PlaybackOperation
            ) => {
                // MSE is a transaction participant. It must return the exact
                // attempt that scheduled this seek instead of asking the owner
                // to recover identity from a floating-point timestamp.
                if (!isPlaybackOperation(operation) || !this._adoptPlaybackOperation(operation)) {
                    Log.w(this.TAG, `Reject MSE transmuxer seek without current operation: ${reason}`);
                    return;
                }
                if (reason === MMTS_VOD_AUDIO_TRACK_REBUILD_REASON) {
                    if (operation.kind !== 'audio-switch') {
                        Log.w(this.TAG, 'Reject audio rebuild seek with non-audio operation');
                        return;
                    }
                    this._issueMMTSVodAudioTrackSelection(milliseconds);
                } else {
                    this._transmuxer?.seek(milliseconds, operation);
                }
            },
            endOfStream: () => {
                this._mse_controller.endOfStream();
                return {ok: true};
            },
            getMediaSourceState: () => {
                return this._mse_controller.getMediaSourceState();
            },
            getForwardBufferInfo: (currentTime: number) => {
                return this._mse_controller.getForwardBufferInfo(currentTime);
            },
            getBufferedRanges: (type: any) => {
                return this._mse_controller.getBufferedRanges(type);
            },
            rebuildMediaSource: (plan: any) => {
                return this._executeMMTSAudioTrackSwitchMediaSourceRebuild(plan);
            },
        });
    }

    private _attachMSEControllerToMediaElement(mseController: MSEController): void {
        if (mseController.isManagedMediaSource()) {
            this._media_element['disableRemotePlayback'] = true;
            this._media_element.srcObject = mseController.getObject();
        } else {
            this._media_element.src = mseController.getObjectURL();
        }
    }

    private _executeMMTSAudioTrackSwitchMediaSourceRebuild(plan: any): boolean {
        if (!plan || !this._media_element || !this._mse_controller) {
            return false;
        }

        const previousController = this._mse_controller;
        let replacementController: MSEController;
        try {
            const resumePlayback = plan.resumePlayback === true &&
                this._media_element.paused === false && this._media_element.ended !== true;
            replacementController = this._createMSEController();
            const transaction = this._pending_mmts_vod_audio_track_switch;
            if (transaction && transaction.stage === 'submitted') {
                transaction.stage = 'rebuilding';
                this._audio_track_switch_coordinator.transition(
                    transaction.operation,
                    'submitted',
                    'rebuilding'
                );
            }
            previousController.abandon();
            this._mse_controller = replacementController;
            this._mse_source_opened = false;
            this._resume_playback_after_audio_track_switch_rebuild = resumePlayback;
            this._attachMSEControllerToMediaElement(replacementController);
            previousController.revokeObjectURL();
            if (!this._config.isLive && this._media_info &&
                this._media_info.duration > 0 && isFinite(this._media_info.duration)) {
                replacementController.setMediaDuration(this._media_info.duration / 1000);
            }
            return true;
        } catch (error) {
            Log.e(this.TAG, `Failed to rebuild MediaSource for MMTS audio switch: ${error.message}`);
            return false;
        }
    }

    private _resumePlaybackAfterMMTSAudioTrackSwitchRebuild(): void {
        const resumePlayback = this._resume_playback_after_audio_track_switch_rebuild;
        this._resume_playback_after_audio_track_switch_rebuild = false;
        if (!resumePlayback || !this._media_element) {
            return;
        }

        const promise = this._media_element.play();
        if (promise && typeof promise.catch === 'function') {
            promise.catch((error: any) => {
                Log.w(this.TAG, `Failed to resume after MMTS audio switch: ${error.message}`);
            });
        }
    }

    public detachMediaElement(): void {
        if (this._media_element) {
            this._mse_controller.shutdown();

            // Remove all appended event listeners
            this._media_element.removeEventListener('loadedmetadata', this.e.onMediaLoadedMetadata);
            this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
            this._media_element.removeEventListener('waiting', this.e.onMediaStateChange);
            this._media_element.removeEventListener('stalled', this.e.onMediaStateChange);
            this._media_element.removeEventListener('progress', this.e.onMediaStateChange);
            this._media_element.removeEventListener('canplay', this.e.onMediaStateChange);
            this._media_element.removeEventListener('loadeddata', this.e.onMediaStateChange);

            // Detach media source from media element
            this._media_element.src = '';
            this._media_element.removeAttribute('src');
            this._media_element.srcObject = null;
            this._media_element.load();
            this._media_element = null;

            this._mse_controller.revokeObjectURL();
        }
        if (this._mse_controller) {
            this._mse_controller.destroy();
            this._mse_controller = null;
        }
    }

    public load(): void {
        if (!this._media_element) {
            throw new IllegalStateException('HTMLMediaElement must be attached before load()!');
        }
        if (this._transmuxer) {
            throw new IllegalStateException('load() has been called, please call unload() first!');
        }
        if (this._has_pending_load) {
            // Defer load operation until MSE source open
            return;
        }

        if (this._config.deferLoadAfterSourceOpen && !this._mse_source_opened) {
            this._has_pending_load = true;
            return;
        }

        this._transmuxer = new Transmuxer(this._media_data_source, this._config);
        const startupOperation = this._config.isMMTS ?
            this._beginPlaybackOperation('startup', 0, 'loading') : undefined;
        this._mse_buffer_state_machine = this._createMSEBufferStateMachine();
        if (startupOperation &&
            !this._mse_buffer_state_machine.setPlaybackOperation(startupOperation)) {
            throw new IllegalStateException('Failed to initialize MMTS MSE playback operation');
        }
        if (this._mse_source_opened) {
            this._mse_buffer_state_machine.onSourceOpen();
        }

        this._transmuxer.on(TransmuxingEvents.INIT_SEGMENT, (type: string, is: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            if (this._pending_mmts_vod_audio_track_switch != null) {
                return;
            }
            const videoTransaction = this._video_track_switch_coordinator.active;
            if (this._config.isMMTS && !this._config.isLive && type === 'audio' &&
                videoTransaction && isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                return;
            }
            if (this._config.isMMTS && type === 'audio' &&
                this._consumeMMTSLiveAudioTrackSwitchInit(is, operation)) {
                return;
            }
            if (this._config.isMMTS && type === 'video' &&
                is && is.mmtsVideoTrackSwitch) {
                this._consumeMMTSVideoTrackSwitchInit(is, operation);
                return;
            }
            this._mse_buffer_state_machine.onInitSegment(type as any, is);
        });
        this._transmuxer.on(TransmuxingEvents.STARTUP_GROUP, (startupGroup: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            if (this._pending_mmts_vod_audio_track_switch != null) {
                const result = this._applyMMTSVodAudioTrackSwitchStartupGroup(
                    startupGroup,
                    operation
                );
                if (result.status === 'invalid') {
                    Log.w(
                        this.TAG,
                        `Reject MMTS VOD audio startup group: ${result.reason}, ` +
                        `attempt=${operation.attemptKey}`
                    );
                    this._failUnifiedMMTSAudioTrackSwitch(
                        operation,
                        `startup-group:validation:${result.reason}`
                    );
                }
                return;
            }
            this._mse_buffer_state_machine.onStartupGroup(startupGroup);
            const videoSegment = startupGroup.videoMediaSegment;
            if (videoSegment) {
                if (this._config.isMMTS && this._config.isLive) {
                    this._cacheMMTSVideoMediaSegment(videoSegment);
                }
                if (!this._config.isLive && videoSegment.data && videoSegment.data.byteLength > 0 && videoSegment.info) {
                    this._seeking_handler.appendSyncPoints(videoSegment.info.syncPoints);
                }
            }
            this._notifyMediaStateChanged('startup_group_queued');
        });
        this._transmuxer.on(TransmuxingEvents.STARTUP_GROUP_FAILED,
            (failure: MMTSStartupGroupFailure, operation: PlaybackOperation) => {
                this._onMMTSStartupGroupFailure(failure, operation);
            }
        );
        this._transmuxer.on(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
            (request: PlaybackOperationRetryRequest, operation: PlaybackOperation) => {
                this._onPlaybackOperationRetryRequired(request, operation);
            }
        );
        this._transmuxer.on(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED,
            (
                request: PlaybackOperationRetryRequest,
                retryOperation: PlaybackOperation,
                sourceOperation: PlaybackOperation
            ) => {
                this._onPlaybackOperationRetryRejected(
                    request,
                    retryOperation,
                    sourceOperation
                );
            }
        );
        this._transmuxer.on(TransmuxingEvents.MEDIA_SEGMENT, (type: string, ms: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            const videoTransaction = this._video_track_switch_coordinator.active;
            if (this._config.isMMTS && !this._config.isLive && type === 'audio' &&
                videoTransaction && isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                return;
            }
            if (this._config.isMMTS && type === 'video' &&
                ms && ms.mmtsVideoTrackSwitch) {
                this._consumeMMTSVideoTrackSwitchMedia(ms, operation);
                return;
            }
            if (this._config.isMMTS && this._config.isLive && type === 'video') {
                this._cacheMMTSVideoMediaSegment(ms);
                if (this._tryApplyMMTSLiveAudioTrackSwitchRebuild()) {
                    return;
                }
            }
            if (this._pending_mmts_vod_audio_track_switch != null) {
                if (type === 'video' || type === 'audio') {
                    this._collectMMTSVodAudioTrackSwitchMedia(type, ms);
                    this._tryApplyMMTSVodAudioTrackSwitchRebuild();
                }
                return;
            }
            if (this._config.isMMTS && type === 'audio' &&
                this._consumeMMTSLiveAudioTrackSwitchMedia(ms, operation)) {
                return;
            }
            this._mse_buffer_state_machine.onMediaSegment(type as any, ms);
            if (!this._config.isLive && type === 'video' && ms.data && ms.data.byteLength > 0 && ('info' in ms)) {
                this._seeking_handler.appendSyncPoints(ms.info.syncPoints);
            }
            this._notifyMediaStateChanged('segment_queued');
        });
        this._transmuxer.on(TransmuxingEvents.LOADING_COMPLETE, (operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            this._mse_buffer_state_machine.onEndOfStream(operation);
            this._emitter.emit(PlayerEvents.LOADING_COMPLETE);
        });
        this._transmuxer.on(TransmuxingEvents.RECOVERED_EARLY_EOF, (operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            this._emitter.emit(PlayerEvents.RECOVERED_EARLY_EOF);
        });
        this._transmuxer.on(TransmuxingEvents.IO_ERROR, (detail: any, info: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.NETWORK_ERROR, detail, info);
        });
        this._transmuxer.on(TransmuxingEvents.DEMUX_ERROR, (detail: any, info: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.MEDIA_ERROR, detail, info);
        });
        this._transmuxer.on(TransmuxingEvents.MEDIA_INFO, (mediaInfo: MediaInfo, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            const videoTransaction = this._video_track_switch_coordinator.active;
            if (videoTransaction &&
                isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                this._video_track_switch_coordinator.setPendingMediaInfo(operation, mediaInfo);
                return;
            }
            const coordinatorTransaction = this._audio_track_switch_coordinator.active;
            if (coordinatorTransaction &&
                isSamePlaybackTransaction(operation, coordinatorTransaction.operation)) {
                this._audio_track_switch_coordinator.setPendingMediaInfo(operation, mediaInfo);
            }
            const transaction = this._pending_mmts_vod_audio_track_switch;
            if (transaction) {
                transaction.pendingMediaInfo = mediaInfo;
                return;
            }
            if (coordinatorTransaction) {
                return;
            }
            this._media_info = mediaInfo;
            this._mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!this._config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                this._mse_controller.setMediaDuration(mediaInfo.duration / 1000);
            }
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        });
        this._transmuxer.on(TransmuxingEvents.STATISTICS_INFO, (statInfo: any, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            this._statistics_info = this._fillStatisticsInfo(statInfo);
            this._emitter.emit(PlayerEvents.STATISTICS_INFO, Object.assign({}, statInfo));
        });
        this._transmuxer.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, (milliseconds: number, operation: PlaybackOperation) => {
            if (!this._adoptPlaybackOperation(operation)) return;
            if (this._handleMMTSVodAudioTrackSwitchRecommendedSeek(milliseconds)) {
                return;
            }
            if (this._media_element && !this._config.accurateSeek) {
                this._mse_buffer_state_machine?.onRecommendedSeekPoint(milliseconds / 1000);
            }
        });
        this._transmuxer.on(TransmuxingEvents.METADATA_ARRIVED,
            (metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.METADATA_ARRIVED, metadata);
            });
        this._transmuxer.on(TransmuxingEvents.SCRIPTDATA_ARRIVED,
            (data: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.SCRIPTDATA_ARRIVED, data);
            });
        this._transmuxer.on(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED,
            (timed_id3_metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.TIMED_ID3_METADATA_ARRIVED, timed_id3_metadata);
            });
        this._transmuxer.on(TransmuxingEvents.PGS_SUBTITLE_ARRIVED,
            (pgs_data: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.PGS_SUBTITLE_ARRIVED, pgs_data);
            });
        this._transmuxer.on(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED,
            (synchronous_klv_metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, synchronous_klv_metadata);
            });
        this._transmuxer.on(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED,
            (asynchronous_klv_metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, asynchronous_klv_metadata);
            });
        this._transmuxer.on(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED,
            (smpte2038_metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.SMPTE2038_METADATA_ARRIVED, smpte2038_metadata);
            });
        this._transmuxer.on(TransmuxingEvents.SEI_ARRIVED,
            (sei_data: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.SEI_ARRIVED, sei_data);
            });
        this._transmuxer.on(TransmuxingEvents.SCTE35_METADATA_ARRIVED,
            (scte35_metadata: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.SCTE35_METADATA_ARRIVED, scte35_metadata);
            });
        this._transmuxer.on(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR,
            (descriptor: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.PES_PRIVATE_DATA_DESCRIPTOR, descriptor);
            });
        this._transmuxer.on(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED,
            (private_data: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.PES_PRIVATE_DATA_ARRIVED, private_data);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_AUDIO_TRACKS,
            (audio_tracks: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                const transaction = this._audio_track_switch_coordinator.active;
                if (transaction && isSamePlaybackOperation(operation, transaction.operation)) {
                    this._audio_track_switch_coordinator.setConfirmedTrackData(operation, audio_tracks);
                    const vodTransaction = this._pending_mmts_vod_audio_track_switch;
                    if (vodTransaction &&
                        isSamePlaybackOperation(operation, vodTransaction.operation)) {
                        vodTransaction.confirmedTracks = audio_tracks && audio_tracks.tracks;
                        vodTransaction.confirmedAudioTracks = audio_tracks;
                    }
                    return;
                }
                if (!this._acceptAudioTrackSwitch(audio_tracks)) {
                    return;
                }
                this._emitter.emit(PlayerEvents.MMTS_AUDIO_TRACKS, audio_tracks);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
            (result: any, operation: PlaybackOperation) => {
                this._onMMTSAudioTrackSelectionResult(result, operation);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_VIDEO_TRACKS,
            (video_tracks: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                const transaction = this._video_track_switch_coordinator.active;
                if (transaction && isSamePlaybackTransaction(operation, transaction.operation)) {
                    this._video_track_switch_coordinator.setConfirmedTrackData(operation, video_tracks);
                    return;
                }
                this._selected_mmts_video_packet_id = video_tracks && video_tracks.selectedPacketId;
                this._mmts_video_tracks = video_tracks && Array.isArray(video_tracks.tracks) ?
                    video_tracks.tracks.slice() : [];
                this._emitter.emit(PlayerEvents.MMTS_VIDEO_TRACKS, video_tracks);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT,
            (result: any, operation: PlaybackOperation) => {
                this._onMMTSVideoTrackSelectionResult(result, operation);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_SUBTITLE_TRACKS,
            (subtitle_tracks: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.MMTS_SUBTITLE_TRACKS, subtitle_tracks);
            });
        this._transmuxer.on(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED,
            (subtitle_data: any, operation: PlaybackOperation) => {
                if (!this._adoptPlaybackOperation(operation)) return;
                this._emitter.emit(PlayerEvents.MMTS_SUBTITLE_DATA_ARRIVED, subtitle_data);
            });

        this._seeking_handler = new SeekingHandler(
            this._config,
            this._media_element,
            this._onRequiredUnbufferedSeek.bind(this),
            this._onControlledSeekRequest.bind(this)
        );

        this._loading_controller = new LoadingController(
            this._config,
            this._media_element,
            this._onRequestPauseTransmuxer.bind(this),
            this._onRequestResumeTransmuxer.bind(this),
            () => this._mse_controller && this._media_element ?
                (this._mse_buffer_state_machine ?
                    this._mse_buffer_state_machine.getForwardBufferInfo(this._media_element.currentTime) :
                    this._mse_controller.getForwardBufferInfo(this._media_element.currentTime)) :
                null
        );

        const startupBufferDuration = this._getStartupBufferDuration();
        if (startupBufferDuration > 0 || this._config.isMMTS) {
            this._startup_buffer_gate = new StartupBufferGate(
                this._media_element,
                startupBufferDuration,
                () => this._getStartupGateForwardBufferDuration(),
                this._config.isMMTS === true,
                this._onRequestDirectSeek.bind(this)
            );
        }

        this._startup_stall_jumper = new StartupStallJumper(
            this._media_element,
            this._onRequestDirectSeek.bind(this),
            this._getStallJumpMaxGap(),
            this._getStallJumpMinBuffer(),
            this._allowStallJumperRangeGapJump(),
            true,
            this._config.isMMTS === true,
            this._config.isMMTS === true,
            () => {
                this._mse_buffer_state_machine?.onContinuousBufferStall();
            }
        );

        if (this._config.isLive && this._config.liveBufferLatencyChasing) {
            this._live_latency_chaser = new LiveLatencyChaser(
                this._config,
                this._media_element,
                this._onRequestDirectSeek.bind(this)
            );
        }

        if (this._config.isLive && this._config.liveSync) {
            this._live_latency_synchronizer = new LiveLatencySynchronizer(
                this._config,
                this._media_element
            );
        }

        // Reset currentTime to 0
        if (this._media_element.readyState > 0) {
            // IE11 may throw InvalidStateError if readyState === 0
            if (this._config.isMMTS && this._mse_buffer_state_machine) {
                this._mse_buffer_state_machine.onRecommendedSeekPoint(0);
            } else {
                this._seeking_handler.directSeek(0);
            }
        }

        this._transmuxer.open(startupOperation);
    }

    public unload(): void {
        this._media_element?.pause();
        this._cancelPendingMMTSSeek('player-unloaded');
        this._settleAndClearScheduledOperations('cancelled', 'player-unloaded');
        this._playback_recovery_roots.clear();
        const activeAudioSwitch = this._audio_track_switch_coordinator.active;
        const abortedAudioSwitch = activeAudioSwitch ?
            this._audio_track_switch_coordinator.abort(activeAudioSwitch.operation) : null;
        if (activeAudioSwitch || this._pending_mmts_vod_audio_track_switch) {
            this._cleanupUnifiedMMTSAudioTrackSwitch(
                activeAudioSwitch ? activeAudioSwitch.strategy : 'vod-reseek',
                abortedAudioSwitch?.operation
            );
        }
        this._active_playback_operation = null;
        this._audio_track_switch_coordinator.clear();
        this._video_track_switch_coordinator.clear();
        this._pending_video_track_switch_init_segment = null;
        this._pending_video_track_switch_media_segment = null;
        this._selected_mmts_video_packet_id = null;
        this._desired_mmts_video_packet_id = null;
        this._mmts_video_tracks = [];
        this._pending_audio_track_switch_request_time = null;
        this._pending_audio_track_switch_expected_packet_id = null;
        this._accepted_audio_track_switch_time = null;
        this._pending_audio_track_switch_init_segment = null;
        this._pending_audio_track_switch_media_segments = [];
        this._pending_audio_track_switch_resume_playback = false;
        this._resume_playback_after_audio_track_switch_rebuild = false;
        this._mmts_audio_track_switch_rebuild_in_progress = false;
        this._mmts_live_video_rebuild_window = null;
        this._pending_mmts_vod_audio_track_switch = null;
        this._selected_mmts_audio_packet_id = null;
        this._desired_mmts_audio_packet_id = null;
        this._mmts_audio_tracks = [];

        this._live_latency_synchronizer?.destroy();
        this._live_latency_synchronizer = null;

        this._live_latency_chaser?.destroy();
        this._live_latency_chaser = null;

        this._startup_stall_jumper?.destroy();
        this._startup_stall_jumper = null;

        this._startup_buffer_gate?.destroy();
        this._startup_buffer_gate = null;

        this._loading_controller?.destroy();
        this._loading_controller = null;

        this._mse_buffer_state_machine?.destroy();
        this._mse_buffer_state_machine = null;

        this._seeking_handler?.destroy();
        this._seeking_handler = null;

        this._mse_controller?.clearBufferedRanges();

        this._transmuxer?.close();
        this._transmuxer?.destroy();
        this._transmuxer = null;
    }

    public play(): Promise<void> {
        return this._startup_buffer_gate ?
            this._startup_buffer_gate.requestPlay() :
            this._media_element.play();
    }

    public pause(): void {
        this._startup_buffer_gate?.cancelPendingPlay();
        this._media_element.pause();
    }

    public seek(seconds: number): Promise<PlaybackOperationResult> {
        if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
            return this._createRejectedOperationResult('seek', 0, undefined, 'invalid-seek-target');
        }
        if (this._config.isMMTS && this._config.isLive !== true) {
            if (this._seeking_handler && this._seeking_handler.isPositionBuffered(seconds)) {
                this._seeking_handler.directSeek(seconds);
                return this._createImmediateOperationResult(
                    'seek', seconds * 1000, undefined, 'committed', 'buffered-seek'
                );
            }
            return this._requestLatestMMTSSeek(seconds, 'api');
        }
        if (this._media_element && this._seeking_handler) {
            this._seeking_handler.seek(seconds);
        } else {
            this._pending_seek_time = seconds;
        }
        return this._createImmediateOperationResult(
            'seek', seconds * 1000, undefined, 'committed', 'legacy-seek-submitted',
            {committedTimeMilliseconds: seconds * 1000}
        );
    }

    public switchPrimaryAudio(): Promise<PlaybackOperationResult> {
        const action: MMTSVodAudioTrackSwitchAction = {type: 'primary'};
        if (this._config.isMMTS) {
            return this._requestUnifiedMMTSAudioTrackSwitch(action);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginForwardAudioTrackSwitch(timelineSeed, this._getMMTSAudioTrackTarget(action));
        this._transmuxer.switchPrimaryAudio(timelineSeed);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, undefined, 'committed', 'legacy-audio-switch-submitted'
        );
    }

    public switchSecondaryAudio(): Promise<PlaybackOperationResult> {
        const action: MMTSVodAudioTrackSwitchAction = {type: 'secondary'};
        if (this._config.isMMTS) {
            return this._requestUnifiedMMTSAudioTrackSwitch(action);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginForwardAudioTrackSwitch(timelineSeed, this._getMMTSAudioTrackTarget(action));
        this._transmuxer.switchSecondaryAudio(timelineSeed);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, undefined, 'committed', 'legacy-audio-switch-submitted'
        );
    }

    public selectAudioTrack(packetId: number): Promise<PlaybackOperationResult> {
        const requestedTime = this._media_element ?
            Math.max(0, this._media_element.currentTime * 1000) : 0;
        if (!Number.isInteger(packetId) || packetId < 0) {
            return this._createRejectedOperationResult(
                'audio-switch', requestedTime, undefined, 'invalid-audio-packet-id'
            );
        }
        const action: MMTSVodAudioTrackSwitchAction = {type: 'select', packetId};
        if (this._config.isMMTS) {
            return this._requestUnifiedMMTSAudioTrackSwitch(action);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginForwardAudioTrackSwitch(timelineSeed, this._getMMTSAudioTrackTarget(action));
        this._transmuxer.selectAudioTrack(packetId, timelineSeed);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, packetId, 'committed', 'legacy-audio-switch-submitted',
            {committedPacketId: packetId}
        );
    }

    public selectVideoTrack(packetId: number): Promise<PlaybackOperationResult> {
        const requestedTime = this._media_element ?
            Math.max(0, this._media_element.currentTime * 1000) : 0;
        if (!Number.isInteger(packetId) || packetId < 0) {
            return this._createRejectedOperationResult(
                'video-switch', requestedTime, undefined, 'invalid-video-packet-id'
            );
        }
        if (!this._config.isMMTS) {
            this._mse_buffer_state_machine?.onVideoTrackSwitch({stage: 'request'});
            this._transmuxer.selectVideoTrack(packetId);
            return this._createImmediateOperationResult(
                'video-switch', requestedTime, packetId, 'committed',
                'legacy-video-switch-submitted', {committedPacketId: packetId}
            );
        }
        if (this._selected_mmts_video_packet_id == null ||
            !this._mmts_video_tracks.some((track) => track && track.packetId === packetId)) {
            return this._createRejectedOperationResult(
                'video-switch', requestedTime, packetId, 'video-track-unavailable'
            );
        }
        this._desired_mmts_video_packet_id = packetId;
        if (this._selected_mmts_video_packet_id === packetId &&
            !this._operation_scheduler.active && this._operation_scheduler.queued.length === 0) {
            return this._createImmediateOperationResult(
                'video-switch', requestedTime, packetId, 'no-op',
                'already-selected', {committedPacketId: packetId}
            );
        }

        const operation = this._reservePlaybackOperation(
            'video-switch', requestedTime, packetId, 'requested'
        );
        const recoveryOperation = this._reservePlaybackOperation(
            'video-switch', requestedTime, this._selected_mmts_video_packet_id,
            'recovery-reserved'
        );
        const reservation: MMTSVideoTrackSwitchReservation = {
            operation,
            priorCommittedPacketId: this._selected_mmts_video_packet_id,
            targetPacketId: packetId,
            recoveryOperation,
        };
        return this._scheduleInteractiveOperation({
            operation,
            payload: {type: 'video-switch', reservation},
        });
    }

    private _startUnifiedMMTSVideoTrackSwitch(
        transaction: MMTSVideoTrackSwitchTransaction
    ): void {
        if (!this._activatePlaybackOperation(transaction.operation)) {
            this._failUnifiedMMTSVideoTrackSwitch(transaction.operation, 'activation-rejected');
            return;
        }
        this._pending_video_track_switch_init_segment = null;
        this._pending_video_track_switch_media_segment = null;
        const accepted = this._mse_buffer_state_machine.onVideoTrackSwitch({
            stage: 'request',
            operation: transaction.operation,
            transactionId: transaction.operation.transactionId,
        });
        if (!accepted || !this._video_track_switch_coordinator.transition(
            transaction.operation,
            'requested',
            'selecting'
        )) {
            this._failUnifiedMMTSVideoTrackSwitch(
                transaction.operation,
                accepted ? 'invalid-transition' : 'mse-request-rejected'
            );
            return;
        }
        const identity = createPlaybackSwitchIdentity(transaction.operation);
        if (this._config.isLive) {
            this._transmuxer.selectVideoTrack(transaction.targetPacketId, identity);
        } else {
            this._transmuxer.seekAndSelectVideoTrack(
                transaction.operation.requestedTimeMilliseconds,
                transaction.operation,
                transaction.targetPacketId,
                identity
            );
        }
    }

    private _onMMTSVideoTrackSelectionResult(result: any,
                                               operation: PlaybackOperation): void {
        if (!this._adoptPlaybackOperation(operation) || !result ||
            !doesPlaybackSwitchIdentityMatchOperation(result, operation)) {
            return;
        }
        const outcome = this._video_track_switch_coordinator.selectionResult(operation, result);
        if (outcome.type === 'stale') {
            return;
        }
        if (outcome.type === 'rejected') {
            this._failUnifiedMMTSVideoTrackSwitch(
                operation,
                `selection:${result.reason}`
            );
            return;
        }
    }

    private _consumeMMTSVideoTrackSwitchInit(segment: any,
        operation: PlaybackOperation): void {
        const transaction = this._video_track_switch_coordinator.active;
        if (!transaction || transaction.stage !== 'waiting-init' ||
            !this._doesMMTSVideoTrackSwitchMatch(segment, transaction, operation) ||
            !segment.data || typeof segment.data.byteLength !== 'number' ||
            segment.data.byteLength <= 0 ||
            !this._video_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-init',
                'waiting-media'
            )) {
            Log.w(this.TAG, 'Drop stale or invalid MMTS video track switch init segment');
            return;
        }
        this._pending_video_track_switch_init_segment = segment;
    }

    private _consumeMMTSVideoTrackSwitchMedia(segment: any,
                                               operation: PlaybackOperation): void {
        const transaction = this._video_track_switch_coordinator.active;
        const initSegment = this._pending_video_track_switch_init_segment;
        const videoSwitch = segment && segment.mmtsVideoTrackSwitch;
        if (!transaction || transaction.stage !== 'waiting-media' || !initSegment ||
            !this._doesMMTSVideoTrackSwitchMatch(segment, transaction, operation) ||
            !this._doesMMTSVideoTrackSwitchMatch(initSegment, transaction, operation) ||
            !segment.data || typeof segment.data.byteLength !== 'number' ||
            segment.data.byteLength <= 0 ||
            !isMMTSRandomAccessSafeVideoSegment(segment) ||
            !this._video_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-media',
                'submitted'
            )) {
            Log.w(this.TAG, 'Drop stale or out-of-order MMTS video track switch media segment');
            return;
        }

        this._pending_video_track_switch_media_segment = segment;
        const accepted = this._mse_buffer_state_machine.onVideoTrackSwitch({
            stage: 'commit_ready',
            operation: transaction.operation,
            transactionId: transaction.operation.transactionId,
            videoSwitch,
            videoInitSegment: initSegment,
            videoMediaSegment: segment,
        });
        if (!accepted) {
            this._failUnifiedMMTSVideoTrackSwitch(
                transaction.operation,
                'mse-commit-rejected'
            );
        }
    }

    private _doesMMTSVideoTrackSwitchMatch(
        segment: any,
        transaction: MMTSVideoTrackSwitchTransaction,
        operation: PlaybackOperation
    ): boolean {
        const videoSwitch = segment && segment.mmtsVideoTrackSwitch;
        const segmentOperation = segment && segment.playbackOperation;
        return !!videoSwitch && isPlaybackOperation(segmentOperation) &&
            doesPlaybackSwitchIdentityMatchOperation(videoSwitch, transaction.operation) &&
            Number.isInteger(videoSwitch.packetId) &&
            videoSwitch.packetId === transaction.targetPacketId &&
            isSamePlaybackAttempt(operation, transaction.operation) &&
            isSamePlaybackAttempt(segmentOperation, transaction.operation) &&
            segment.mseBufferGeneration === transaction.operation.timelineGeneration;
    }

    private _finishUnifiedMMTSVideoTrackSwitch(operation: PlaybackOperation): void {
        const transaction = this._video_track_switch_coordinator.active;
        if (!transaction || transaction.stage !== 'submitted' ||
            !isSamePlaybackAttempt(transaction.operation, operation)) {
            return;
        }
        const committed = this._video_track_switch_coordinator.commit(transaction.operation);
        if (!committed) {
            return;
        }
        const committedMedia = this._pending_video_track_switch_media_segment;
        this._pending_video_track_switch_init_segment = null;
        this._pending_video_track_switch_media_segment = null;
        this._publishUnifiedMMTSVideoTrackSwitch(committed, committedMedia);
    }

    private _publishUnifiedMMTSVideoTrackSwitch(
        committed: MMTSVideoTrackSwitchTransaction,
        committedMedia: any
    ): void {
        const videoTracks = committed.confirmedTrackData;
        const sourceTracks = videoTracks && Array.isArray(videoTracks.tracks) ?
            videoTracks.tracks : this._mmts_video_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === committed.targetPacketId,
        }));
        this._selected_mmts_video_packet_id = committed.targetPacketId;
        this._mmts_video_tracks = tracks;
        if (this._config.isLive && committedMedia) {
            this._cacheMMTSVideoMediaSegment(committedMedia);
        }
        this._emitter.emit(PlayerEvents.MMTS_VIDEO_TRACKS, {
            ...(videoTracks || {}),
            tracks,
            selectedPacketId: committed.targetPacketId,
        });
        if (committed.pendingMediaInfo) {
            const mediaInfo = committed.pendingMediaInfo;
            this._media_info = mediaInfo;
            this._mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!this._config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                this._mse_controller?.setMediaDuration(mediaInfo.duration / 1000);
            }
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        }
        if (!this._completeRecoveryOperation(committed.operation)) {
            this._completeScheduledOperation(
                committed.operation,
                'committed',
                'video-track-committed',
                {committedPacketId: committed.targetPacketId}
            );
        }
    }

    private _promoteUnifiedMMTSVideoTrackSwitch(
        completedOperation: PlaybackOperation
    ): void {
        const transaction = this._video_track_switch_coordinator.promote(
            completedOperation,
            undefined,
            this._selected_mmts_video_packet_id
        );
        if (transaction) {
            this._startUnifiedMMTSVideoTrackSwitch(transaction);
        }
    }

    private _failUnifiedMMTSVideoTrackSwitch(operation: PlaybackOperation,
                                              reason: string): void {
        const failed = this._video_track_switch_coordinator.abort(operation);
        if (!failed) {
            return;
        }
        this._mse_buffer_state_machine?.cancelVideoTrackSwitch(failed.operation);
        this._pending_video_track_switch_init_segment = null;
        this._pending_video_track_switch_media_segment = null;
        const recoveryDepth = failed.recoveryDepth || 0;

        if (recoveryDepth >= 1) {
            this._desired_mmts_video_packet_id = this._selected_mmts_video_packet_id;
            this._video_track_switch_coordinator.clear();
            if (!this._completeRecoveryOperation(
                failed.operation,
                false,
                `video-recovery:${reason}`
            )) {
                this._completeScheduledOperation(
                    failed.operation, 'failed', `video-recovery:${reason}`
                );
            }
            this._recoverMMTSPlaybackAfterTrackSwitchFailure(failed.operation, reason);
            return;
        }

        this._desired_mmts_video_packet_id = failed.priorCommittedPacketId;
        if (!failed.internalSelectionChanged && !failed.selectionMayHaveMutated) {
            this._completeScheduledOperation(failed.operation, 'failed', reason);
            return;
        }

        const targetPacketId = this._selected_mmts_video_packet_id == null ?
            failed.priorCommittedPacketId : this._selected_mmts_video_packet_id;
        const reserved = failed.recoveryOperation;
        if (!reserved) {
            this._video_track_switch_coordinator.clear();
            this._completeScheduledOperation(failed.operation, 'failed', reason);
            this._recoverMMTSPlaybackAfterTrackSwitchFailure(failed.operation, reason);
            return;
        }
        // A failed VOD video switch may already have moved currentTime onto the
        // candidate track's broken timeline. Roll back from the stable switch
        // anchor instead of chasing that transient position.
        const requestedTime = Math.max(0, failed.operation.requestedTimeMilliseconds);
        const recoveryOperation = rebindReservedPlaybackOperation(reserved, {
            phase: 'recovery',
            requestedTimeMilliseconds: requestedTime,
            packetId: targetPacketId,
        });
        this._operation_results.publish(failed.operation, 'recovering', {reason});
        this._registerRecoveryOperation(recoveryOperation, failed.operation, reason);
        const recovery = this._video_track_switch_coordinator.request({
            operation: recoveryOperation,
            priorCommittedPacketId: targetPacketId,
            targetPacketId,
            recoveryDepth: 1,
        });
        if (recovery.type === 'activate') {
            this._startUnifiedMMTSVideoTrackSwitch(recovery.transaction);
            return;
        }
        this._playback_recovery_roots.delete(recoveryOperation.transactionKey);
        this._completeScheduledOperation(failed.operation, 'failed', reason);
    }

    private _recoverMMTSPlaybackAfterTrackSwitchFailure(
        operation: PlaybackOperation,
        reason: string
    ): void {
        if (this._config.isLive || !this._media_element || this._media_element.error) {
            return;
        }
        const currentTime = typeof this._media_element.currentTime === 'number' &&
            isFinite(this._media_element.currentTime) ? this._media_element.currentTime : 0;
        const operationTime = Math.max(0, operation.requestedTimeMilliseconds / 1000);
        const targetTime = Math.max(currentTime, operationTime);
        Log.w(
            this.TAG,
            `Recover MMTS playback after ${operation.kind} failure at ${targetTime.toFixed(3)}s: ${reason}`
        );
        void this._requestLatestMMTSSeek(targetTime, `${operation.kind}-recovery`);
    }

    private _cancelMMTSVideoTrackSwitchForSeek(): void {
        if (!this._config.isMMTS) {
            return;
        }
        const active = this._video_track_switch_coordinator.active;
        if (active) {
            const aborted = this._video_track_switch_coordinator.abort(active.operation);
            if (aborted) {
                this._mse_buffer_state_machine?.cancelVideoTrackSwitch(aborted.operation);
                this._transferMMTSVideoSelectionToSeek(aborted);
            }
        }
        this._video_track_switch_coordinator.clear();
        this._pending_video_track_switch_init_segment = null;
        this._pending_video_track_switch_media_segment = null;
    }

    private _transferMMTSVideoSelectionToSeek(
        transaction: MMTSVideoTrackSwitchTransaction
    ): void {
        if (!transaction.internalSelectionChanged) {
            return;
        }
        const videoTracks = transaction.confirmedTrackData;
        const sourceTracks = videoTracks && Array.isArray(videoTracks.tracks) ?
            videoTracks.tracks : this._mmts_video_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === transaction.targetPacketId,
        }));
        this._selected_mmts_video_packet_id = transaction.targetPacketId;
        this._mmts_video_tracks = tracks;
        this._emitter.emit(PlayerEvents.MMTS_VIDEO_TRACKS, {
            ...(videoTracks || {}),
            tracks,
            selectedPacketId: transaction.targetPacketId,
        });
        if (transaction.pendingMediaInfo) {
            const mediaInfo = transaction.pendingMediaInfo;
            this._media_info = mediaInfo;
            this._mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!this._config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                this._mse_controller?.setMediaDuration(mediaInfo.duration / 1000);
            }
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        }
    }

    public get mediaInfo(): MediaInfo {
        return Object.assign({}, this._media_info);
    }

    public get statisticsInfo(): any {
        return Object.assign({}, this._statistics_info);
    }

    private _getAudioTrackSwitchTimelineSeed(): number {
        return (this._media_element.currentTime + this._getAudioTrackSwitchPrerollTime()) * 1000;
    }

    private _isForwardMMTSAudioTrackSwitch(
        transaction: MMTSAudioTrackSwitchTransaction | null
    ): transaction is MMTSAudioTrackSwitchTransaction {
        return !!transaction &&
            (transaction.strategy === 'live-forward' || transaction.strategy === 'vod-forward');
    }

    private _requestUnifiedMMTSAudioTrackSwitch(
        action: MMTSVodAudioTrackSwitchAction
    ): Promise<PlaybackOperationResult> {
        const requestedTimeMilliseconds = this._config.isLive ?
            this._getAudioTrackSwitchTimelineSeed() :
            (this._media_element ? Math.max(0, this._media_element.currentTime * 1000) : 0);
        const targetPacketId = this._getMMTSAudioTrackTarget(action);
        if (targetPacketId === undefined) {
            return this._createRejectedOperationResult(
                'audio-switch', requestedTimeMilliseconds,
                action.type === 'select' && Number.isInteger(action.packetId) ? action.packetId : undefined,
                'audio-track-unavailable'
            );
        }
        this._desired_mmts_audio_packet_id = targetPacketId;
        if (this._selected_mmts_audio_packet_id === targetPacketId &&
            !this._operation_scheduler.active && this._operation_scheduler.queued.length === 0) {
            return this._createImmediateOperationResult(
                'audio-switch', requestedTimeMilliseconds, targetPacketId,
                'no-op', 'already-selected', {committedPacketId: targetPacketId}
            );
        }

        const priorCommittedPacketId = this._selected_mmts_audio_packet_id == null ?
            targetPacketId : this._selected_mmts_audio_packet_id;
        const operation = this._reservePlaybackOperation(
            'audio-switch', requestedTimeMilliseconds, targetPacketId, 'requested'
        );
        const recoveryOperation = this._reservePlaybackOperation(
            'audio-switch', requestedTimeMilliseconds, priorCommittedPacketId,
            'recovery-reserved'
        );
        const reservation: MMTSAudioTrackSwitchReservation = {
            operation,
            priorCommittedPacketId,
            targetPacketId,
            strategy: this._config.isLive ? 'live-forward' : 'vod-reseek',
            resumeIntent: !!this._media_element && !this._media_element.paused,
            recoveryOperation,
        };
        return this._scheduleInteractiveOperation({
            operation,
            payload: {type: 'audio-switch', reservation},
        });
    }

    private _startUnifiedMMTSAudioTrackSwitch(transaction: MMTSAudioTrackSwitchTransaction): void {
        if (!this._activatePlaybackOperation(transaction.operation)) {
            this._failUnifiedMMTSAudioTrackSwitch(transaction.operation, 'activation-rejected');
            return;
        }
        this._audio_track_switch_coordinator.transition(
            transaction.operation,
            'requested',
            'preparing'
        );
        if (this._isForwardMMTSAudioTrackSwitch(transaction) &&
            !this._mse_buffer_state_machine.onAudioTrackSwitch({
                stage: 'request',
                mode: transaction.strategy === 'live-forward' ? 'live' : 'vod-forward',
                operation: transaction.operation,
                transactionId: transaction.operation.transactionId,
            })) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'mse-request-rejected'
            );
            return;
        }
        if (transaction.strategy === 'vod-reseek') {
            this._startMMTSVodAudioTrackSwitch({
                requestedTime: transaction.operation.requestedTimeMilliseconds / 1000,
                expectedPacketId: transaction.targetPacketId,
                resumePlayback: transaction.resumeIntent,
                operation: transaction.operation,
            });
            return;
        }

        const timelineSeed = transaction.operation.requestedTimeMilliseconds;
        this._beginForwardAudioTrackSwitch(
            timelineSeed,
            transaction.targetPacketId,
            transaction.operation
        );
        this._audio_track_switch_coordinator.transition(
            transaction.operation,
            'preparing',
            'selecting'
        );
        const identity = createPlaybackSwitchIdentity(transaction.operation);
        this._transmuxer.selectAudioTrack(transaction.targetPacketId, timelineSeed, false, identity);
    }

    private _onUnifiedAudioTrackSwitchTimeout(transaction: MMTSAudioTrackSwitchTransaction): void {
        if (transaction.strategy === 'vod-reseek') {
            this._onMMTSVodAudioTrackSwitchTimeout(transaction.operation.transactionId);
            return;
        }
        this._failUnifiedMMTSAudioTrackSwitch(transaction.operation, `timeout:${transaction.stage}`);
    }

    private _onMMTSAudioTrackSelectionResult(result: any, operation: PlaybackOperation): void {
        if (!this._adoptPlaybackOperation(operation) || !result ||
            !doesPlaybackSwitchIdentityMatchOperation(result, operation)) {
            return;
        }
        const outcome = this._audio_track_switch_coordinator.selectionResult(operation, result);
        if (outcome.type === 'stale') {
            return;
        }
        if (outcome.type === 'rejected') {
            this._failUnifiedMMTSAudioTrackSwitch(operation, `selection:${result && result.reason}`);
            return;
        }

        const coordinatorTransaction = outcome.transaction;
        if (!coordinatorTransaction) {
            return;
        }
        const tracks = coordinatorTransaction.confirmedTrackData;
        if (this._pending_mmts_vod_audio_track_switch) {
            const transaction = this._pending_mmts_vod_audio_track_switch;
            transaction.confirmedPacketId = result.selectedPacketId;
            transaction.confirmedTracks = tracks && tracks.tracks;
            transaction.confirmedAudioTracks = tracks;
            transaction.stage = 'waiting_startup';
            this._transmuxer.completeMMTSVodAudioTrackRebuild();
            return;
        }
        this._pending_audio_track_switch_request_time = null;
        this._pending_audio_track_switch_expected_packet_id = null;
        this._accepted_audio_track_switch_time = operation.requestedTimeMilliseconds / 1000;
        if (this._pending_audio_track_switch_init_segment) {
            this._audio_track_switch_coordinator.transition(
                operation,
                'waiting-init',
                'collecting-overlap'
            );
            this._tryApplyMMTSLiveAudioTrackSwitchRebuild();
        }
    }

    private _onMMTSStartupGroupFailure(failure: MMTSStartupGroupFailure,
                                       operation: PlaybackOperation): void {
        if (!isMMTSStartupGroupFailure(failure, operation) ||
            !this._adoptPlaybackOperation(operation)) {
            return;
        }
        const activeOperation = this._active_playback_operation;
        if (!activeOperation || !isSamePlaybackOperation(operation, activeOperation)) return;
        if (operation.kind === 'audio-switch') {
            const transaction = this._audio_track_switch_coordinator.active;
            if (!transaction || !isSamePlaybackOperation(operation, transaction.operation)) {
                return;
            }
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                `startup-group:${failure.phase}:${failure.reason}`
            );
            return;
        }
        if (operation.kind === 'startup' || operation.kind === 'seek') {
            this._mse_buffer_state_machine.onStartupGroupFailure(failure);
            if (operation.kind === 'seek') {
                this._completeScheduledOperation(
                    operation,
                    'failed',
                    `startup-group:${failure.phase}:${failure.reason}`,
                    {error: failure.error}
                );
            }
        }
    }

    private _promoteUnifiedMMTSAudioTrackSwitch(): void {
        const activePlayback = this._active_playback_operation;
        if (!activePlayback) {
            return;
        }
        const queued = this._audio_track_switch_coordinator.queued;
        const requestedTimeMilliseconds = queued && queued.strategy === 'live-forward' ?
            this._getAudioTrackSwitchTimelineSeed() :
            Math.max(0, this._media_element.currentTime * 1000);
        const transaction = this._audio_track_switch_coordinator.promote(
            activePlayback,
            requestedTimeMilliseconds,
            undefined,
            this._selected_mmts_audio_packet_id
        );
        if (transaction) {
            this._startUnifiedMMTSAudioTrackSwitch(transaction);
        }
    }

    private _failUnifiedMMTSAudioTrackSwitch(operation: PlaybackOperation, reason: string): void {
        const failed = this._audio_track_switch_coordinator.abort(operation);
        if (!failed) {
            return;
        }
        this._cleanupUnifiedMMTSAudioTrackSwitch(
            failed.strategy,
            failed.operation
        );
        const requestedTimeMilliseconds = failed.strategy === 'live-forward' ?
            this._getAudioTrackSwitchTimelineSeed() :
            Math.max(0, failed.operation.requestedTimeMilliseconds);
        const recoveryDepth = failed.recoveryDepth || 0;

        if (recoveryDepth >= 1) {
            this._desired_mmts_audio_packet_id = this._selected_mmts_audio_packet_id;
            this._audio_track_switch_coordinator.clear();
            if (!this._completeRecoveryOperation(
                failed.operation,
                false,
                `audio-recovery:${reason}`
            )) {
                this._completeScheduledOperation(
                    failed.operation, 'failed', `audio-recovery:${reason}`
                );
            }
            this._recoverMMTSPlaybackAfterTrackSwitchFailure(failed.operation, reason);
            return;
        }

        this._desired_mmts_audio_packet_id = failed.priorCommittedPacketId;
        if (!failed.internalSelectionChanged && !failed.selectionMayHaveMutated) {
            this._completeScheduledOperation(failed.operation, 'failed', reason);
            return;
        }

        const targetPacketId = failed.priorCommittedPacketId;
        const reservedRecoveryOperation = failed.recoveryOperation;
        if (!reservedRecoveryOperation) {
            this._audio_track_switch_coordinator.clear();
            this._completeScheduledOperation(failed.operation, 'failed', reason);
            this._recoverMMTSPlaybackAfterTrackSwitchFailure(failed.operation, reason);
            return;
        }
        const recoveryOperation = rebindReservedPlaybackOperation(
            reservedRecoveryOperation,
            {
                phase: 'recovery',
                requestedTimeMilliseconds,
                packetId: targetPacketId,
            }
        );
        this._operation_results.publish(failed.operation, 'recovering', {reason});
        this._registerRecoveryOperation(recoveryOperation, failed.operation, reason);
        const recovery = this._audio_track_switch_coordinator.request({
            operation: recoveryOperation,
            priorCommittedPacketId: targetPacketId,
            targetPacketId,
            strategy: failed.strategy,
            resumeIntent: failed.resumeIntent,
            recoveryDepth: 1,
        });
        if (recovery.type === 'activate') {
            this._startUnifiedMMTSAudioTrackSwitch(recovery.transaction);
            return;
        }
        this._playback_recovery_roots.delete(recoveryOperation.transactionKey);
        this._completeScheduledOperation(failed.operation, 'failed', reason);
    }

    private _cleanupUnifiedMMTSAudioTrackSwitch(
        strategy: MMTSAudioTrackSwitchStrategy,
        operation?: PlaybackOperation
    ): void {
        if (strategy === 'vod-reseek') {
            this._transmuxer?.cancelMMTSVodAudioTrackRebuild();
            this._pending_mmts_vod_audio_track_switch = null;
        }
        if (isPlaybackOperation(operation) && operation.kind === 'audio-switch') {
            this._mse_buffer_state_machine?.cancelAudioTrackSwitch(operation);
        }
        this._pending_audio_track_switch_request_time = null;
        this._pending_audio_track_switch_expected_packet_id = null;
        this._accepted_audio_track_switch_time = null;
        this._pending_audio_track_switch_init_segment = null;
        this._pending_audio_track_switch_media_segments = [];
        this._pending_audio_track_switch_resume_playback = false;
        this._resume_playback_after_audio_track_switch_rebuild = false;
        this._mmts_audio_track_switch_rebuild_in_progress = false;
        this._mmts_live_video_rebuild_window = null;
    }

    private _handleMMTSVodAudioTrackSwitchRecommendedSeek(milliseconds: number): boolean {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        if (!transaction) {
            return false;
        }
        const seconds = milliseconds / 1000;
        if ((transaction.stage === 'waiting_startup' || transaction.stage === 'extending') &&
            isFinite(seconds) && seconds >= 0) {
            transaction.resolvedSeekTime = Math.max(transaction.requestedTime, seconds);
        }
        return true;
    }

    private _beginForwardAudioTrackSwitch(timelineSeed: number,
                                          expectedPacketId?: number,
                                          operation?: PlaybackOperation): void {
        const isMMTSLiveSwitch = this._config.isMMTS === true && this._config.isLive === true;
        if (operation === undefined) {
            this._mse_buffer_state_machine?.onAudioTrackSwitch(isMMTSLiveSwitch ?
            {
                stage: 'request',
                mode: 'live',
            } :
            {stage: 'request'});
        }
        this._pending_audio_track_switch_request_time = timelineSeed / 1000;
        this._pending_audio_track_switch_expected_packet_id = expectedPacketId;
        this._accepted_audio_track_switch_time = null;
        this._pending_audio_track_switch_init_segment = null;
        this._pending_audio_track_switch_media_segments = [];
        if (isMMTSLiveSwitch && operation) {
            this._mmts_live_video_rebuild_window = null;
        }
        this._pending_audio_track_switch_resume_playback = isMMTSLiveSwitch &&
            !!this._media_element && this._media_element.paused === false;
    }

    private _startMMTSVodAudioTrackSwitch(request: MMTSVodAudioTrackSwitchRequest): void {
        this._pending_audio_track_switch_request_time = null;
        this._pending_audio_track_switch_expected_packet_id = null;
        this._accepted_audio_track_switch_time = null;
        this._pending_audio_track_switch_init_segment = null;
        this._pending_audio_track_switch_media_segments = [];
        this._pending_mmts_vod_audio_track_switch = {
            ...request,
            operation: request.operation,
            generation: request.operation.transactionId,
            stage: 'preparing',
            retryCount: request.retryCount || 0,
            selectionIssued: false,
            rebuildWindow: null,
        };
        this._transmuxer.beginMMTSVodAudioTrackRebuild();
        if (!this._mse_buffer_state_machine.onMMTSVodAudioTrackRebuild(
            request.requestedTime,
            request.operation,
            request.operation.transactionId
        )) {
            this._failUnifiedMMTSAudioTrackSwitch(
                request.operation,
                'mse-vod-request-rejected'
            );
        }
    }

    private _onMMTSVodAudioTrackSwitchTimeout(generation: number): void {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.generation !== generation) {
            return;
        }
        if (transaction.stage === 'preparing' && transaction.selectionIssued === false) {
            Log.w(this.TAG, `Cancel stalled MMTS VOD audio switch generation=${generation}`);
            this._failUnifiedMMTSAudioTrackSwitch(transaction.operation, 'timeout:preparing');
            return;
        }
        const stage = transaction.stage;
        const retryCount = transaction.retryCount;
        const currentTime = this._media_element && this._media_element.currentTime;
        if (stage !== 'rebuilding' && retryCount < MMTS_VOD_AUDIO_TRACK_SWITCH_MAX_RETRIES &&
            typeof currentTime === 'number' && isFinite(currentTime) && currentTime >= 0) {
            const requestedTime = Math.round(currentTime * 1000000) / 1000000;
            const sourceOperation = transaction.operation;
            const retryOperation = createNextPlaybackAttempt(sourceOperation, {
                phase: 'preparing',
                requestedTimeMilliseconds: requestedTime * 1000,
            });
            if (!this._activateOwnerRetryAttempt(
                sourceOperation,
                retryOperation,
                'audio-switch-timeout-retry'
            )) {
                this._failUnifiedMMTSAudioTrackSwitch(
                    this._getOwnerRetryFailureOperation(
                        sourceOperation,
                        retryOperation
                    ),
                    'retry-activation-rejected'
                );
                return;
            }
            transaction.operation = retryOperation;
            transaction.requestedTime = requestedTime;
            transaction.retryCount = retryCount + 1;
            transaction.stage = 'preparing';
            transaction.selectionIssued = false;
            transaction.rebuildWindow = null;
            this._transmuxer.beginMMTSVodAudioTrackRebuild();
            if (!this._mse_buffer_state_machine.onMMTSVodAudioTrackRebuild(
                requestedTime,
                retryOperation,
                retryOperation.transactionId
            )) {
                this._failUnifiedMMTSAudioTrackSwitch(
                    retryOperation,
                    'mse-vod-retry-rejected'
                );
            }
            return;
        }
        this._failUnifiedMMTSAudioTrackSwitch(
            transaction.operation,
            `timeout:${transaction.stage}`
        );
    }

    private _getMMTSAudioTrackTarget(action: MMTSVodAudioTrackSwitchAction): number | undefined {
        if (!Array.isArray(this._mmts_audio_tracks) || this._mmts_audio_tracks.length === 0) {
            return undefined;
        }

        if (action.type === 'select') {
            const track = this._mmts_audio_tracks.find((item) => item && item.packetId === action.packetId);
            return track && isMMTSAudioTrackSelectable(track) ? track.packetId : undefined;
        }

        if (action.type === 'primary') {
            const primary = findPreferredAudioTrack(this._mmts_audio_tracks, false);
            return primary ? primary.packetId : undefined;
        }

        const tracks = this._mmts_audio_tracks.slice()
            .sort((left, right) => left.packetId - right.packetId)
            .filter((track) => isMMTSAudioTrackSelectable(track));
        if (tracks.length === 0) {
            return undefined;
        }
        const currentIndex = tracks.findIndex((track) => track.packetId === this._selected_mmts_audio_packet_id);
        return tracks[currentIndex >= 0 ? (currentIndex + 1) % tracks.length : 0].packetId;
    }

    private _issueMMTSVodAudioTrackSelection(seekMilliseconds?: number): void {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.selectionIssued || !this._transmuxer) {
            return;
        }

        transaction.selectionIssued = true;
        transaction.stage = 'selecting';
        this._audio_track_switch_coordinator.transition(
            transaction.operation,
            'preparing',
            'selecting'
        );
        // Keep the transaction timestamp byte-for-byte consistent across the
        // player, transmuxer and demuxer. Rounding here makes a valid startup
        // group fail the requestedStart contract for fractional milliseconds.
        const timelineSeed = transaction.operation.requestedTimeMilliseconds;
        const switchIdentity = createPlaybackSwitchIdentity(transaction.operation);
        if (seekMilliseconds !== undefined) {
            this._transmuxer.seekAndSelectAudioTrack(
                seekMilliseconds,
                transaction.operation,
                transaction.expectedPacketId,
                timelineSeed,
                switchIdentity
            );
        } else {
            this._transmuxer.selectAudioTrack(
                transaction.expectedPacketId, timelineSeed, true, switchIdentity
            );
        }
    }

    private _cancelMMTSAudioTrackSwitchForSeek(): void {
        if (!this._config.isMMTS) {
            return;
        }
        const coordinatorActive = this._audio_track_switch_coordinator.active;
        const strategy = coordinatorActive ? coordinatorActive.strategy :
            this._pending_mmts_vod_audio_track_switch ? 'vod-reseek' : 'live-forward';
        let abortedTransaction: MMTSAudioTrackSwitchTransaction | null = null;
        if (coordinatorActive) {
            abortedTransaction = this._audio_track_switch_coordinator.abort(
                coordinatorActive.operation
            );
        }
        if (abortedTransaction) {
            this._transferMMTSAudioSelectionToSeek(abortedTransaction);
        }
        this._audio_track_switch_coordinator.clear();

        const hasPendingSwitch = coordinatorActive != null ||
            this._pending_mmts_vod_audio_track_switch != null ||
            this._pending_audio_track_switch_request_time != null ||
            this._pending_audio_track_switch_expected_packet_id != null ||
            this._accepted_audio_track_switch_time != null ||
            this._pending_audio_track_switch_init_segment != null ||
            this._pending_audio_track_switch_media_segments.length > 0 ||
            this._pending_audio_track_switch_resume_playback ||
            this._resume_playback_after_audio_track_switch_rebuild ||
            this._mmts_audio_track_switch_rebuild_in_progress ||
            this._mmts_live_video_rebuild_window != null;
        if (hasPendingSwitch) {
            this._cleanupUnifiedMMTSAudioTrackSwitch(
                strategy,
                abortedTransaction?.operation
            );
        }
    }

    private _transferMMTSAudioSelectionToSeek(
        transaction: MMTSAudioTrackSwitchTransaction
    ): void {
        if (!transaction.internalSelectionChanged) {
            return;
        }
        const audioTracks = transaction.confirmedTrackData;
        const sourceTracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks : this._mmts_audio_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === transaction.targetPacketId,
        }));
        this._selected_mmts_audio_packet_id = transaction.targetPacketId;
        this._mmts_audio_tracks = tracks;
        this._emitter.emit(PlayerEvents.MMTS_AUDIO_TRACKS, {
            ...(audioTracks || {}),
            tracks,
            selectedPacketId: transaction.targetPacketId,
        });
        if (transaction.pendingMediaInfo) {
            const mediaInfo = transaction.pendingMediaInfo;
            this._media_info = mediaInfo;
            this._mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!this._config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                this._mse_controller?.setMediaDuration(mediaInfo.duration / 1000);
            }
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
        }
    }

    private _cancelMMTSVodAudioTrackSwitch(): void {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        const abortedTransaction = transaction ?
            this._audio_track_switch_coordinator.abort(transaction.operation) : null;
        this._audio_track_switch_coordinator.clear();
        this._cleanupUnifiedMMTSAudioTrackSwitch(
            'vod-reseek',
            abortedTransaction?.operation
        );
    }

    private _finishMMTSVodAudioTrackSwitch(operation: PlaybackOperation): void {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'rebuilding' ||
            transaction.confirmedPacketId === undefined ||
            !isSamePlaybackAttempt(transaction.operation, operation)) {
            return;
        }
        const committed = this._audio_track_switch_coordinator.commit(transaction.operation);
        if (!committed) {
            return;
        }
        this._selected_mmts_audio_packet_id = transaction.confirmedPacketId;
        if (transaction.confirmedTracks) {
            this._mmts_audio_tracks = transaction.confirmedTracks;
        }
        const confirmedAudioTracks = transaction.confirmedAudioTracks || {
            tracks: this._mmts_audio_tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === transaction.confirmedPacketId,
            })),
            selectedPacketId: transaction.confirmedPacketId,
        };
        this._mmts_audio_tracks = confirmedAudioTracks.tracks;
        this._pending_mmts_vod_audio_track_switch = null;
        this._mmts_audio_track_switch_rebuild_in_progress = false;
        this._emitter.emit(PlayerEvents.MMTS_AUDIO_TRACKS, confirmedAudioTracks);
        this._commitMMTSVodAudioTrackMediaInfo(transaction);
        this._resumePlaybackAfterMMTSAudioTrackSwitchRebuild();
        if (!this._completeRecoveryOperation(committed.operation)) {
            this._completeScheduledOperation(
                committed.operation,
                'committed',
                'audio-track-committed',
                {committedPacketId: committed.targetPacketId}
            );
        }
    }

    private _finishUnifiedLiveAudioTrackSwitch(operation: PlaybackOperation): void {
        const transaction = this._audio_track_switch_coordinator.active;
        if (!this._isForwardMMTSAudioTrackSwitch(transaction) ||
            transaction.stage !== 'rebuilding' ||
            !isSamePlaybackAttempt(transaction.operation, operation)) {
            return;
        }
        const committed = this._audio_track_switch_coordinator.commit(transaction.operation);
        if (!committed) {
            return;
        }
        const audioTracks = committed.confirmedTrackData;
        const tracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === committed.targetPacketId,
            })) : this._mmts_audio_tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === committed.targetPacketId,
            }));
        this._selected_mmts_audio_packet_id = committed.targetPacketId;
        this._mmts_audio_tracks = tracks;
        this._mmts_audio_track_switch_rebuild_in_progress = false;
        this._emitter.emit(PlayerEvents.MMTS_AUDIO_TRACKS, {
            ...(audioTracks || {}),
            tracks,
            selectedPacketId: committed.targetPacketId,
        });
        if (committed.pendingMediaInfo) {
            this._media_info = committed.pendingMediaInfo;
            this._mse_buffer_state_machine?.onMediaInfo(committed.pendingMediaInfo);
            if (!this._config.isLive && committed.pendingMediaInfo.duration > 0 &&
                isFinite(committed.pendingMediaInfo.duration)) {
                this._mse_controller?.setMediaDuration(committed.pendingMediaInfo.duration / 1000);
            }
            this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, committed.pendingMediaInfo));
        }
        this._resumePlaybackAfterMMTSAudioTrackSwitchRebuild();
        if (!this._completeRecoveryOperation(committed.operation)) {
            this._completeScheduledOperation(
                committed.operation,
                'committed',
                'audio-track-committed',
                {committedPacketId: committed.targetPacketId}
            );
        }
    }

    private _commitMMTSVodAudioTrackMediaInfo(transaction: MMTSVodAudioTrackSwitchTransaction): void {
        const mediaInfo = transaction.pendingMediaInfo;
        if (!mediaInfo) {
            return;
        }
        this._media_info = mediaInfo;
        this._mse_buffer_state_machine?.onMediaInfo(mediaInfo);
        if (!this._config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
            this._mse_controller?.setMediaDuration(mediaInfo.duration / 1000);
        }
        this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, mediaInfo));
    }

    private _getAudioTrackSwitchPrerollTime(): number {
        return 0.5;
    }

    private _getStartupBufferDuration(): number {
        if (this._config.startupBufferDuration !== undefined) {
            const duration = this._config.startupBufferDuration;
            if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
                return 0;
            }
            return duration;
        }

        const duration = this._config.mmtsLiveInitialBufferDuration;
        if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
            return 0;
        }
        return duration;
    }

    private _getStartupGateForwardBufferDuration(): number {
        if (!this._mse_buffer_state_machine || !this._media_element) {
            return 0;
        }

        const currentTime = this._media_element.currentTime;
        const info = this._mse_buffer_state_machine.getForwardBufferInfo(currentTime);
        return info.forwardDuration || 0;
    }

    private _getStallJumpMaxGap(): number | undefined {
        // Recorded MMTS damage can leave a few seconds between the recovery
        // RAP and the next decodable buffered range. Prefer skipping that hole
        // to leaving playback parked forever on an otherwise healthy MSE.
        return this._config.isMMTS ? 5 : undefined;
    }

    private _getStallJumpMinBuffer(): number | undefined {
        return this._media_data_source && this._media_data_source.type === 'mmts' ? 1 : undefined;
    }

    private _allowStallJumperRangeGapJump(): boolean {
        return true;
    }

    private _applyMMTSVodAudioTrackSwitchStartupGroup(
        startupGroup: any,
        operation?: PlaybackOperation
    ): MMTSVodAudioStartupGroupApplyResult {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'waiting_startup' || transaction.rebuildWindow) {
            return {status: 'stale'};
        }
        if (operation && !isSamePlaybackOperation(operation, transaction.operation)) {
            return {status: 'stale'};
        }
        if (transaction.confirmedPacketId === undefined) {
            return {status: 'invalid', reason: 'selection-not-confirmed'};
        }
        if (!startupGroup || startupGroup.hasVideo !== true || startupGroup.hasAudio !== true ||
            !startupGroup.videoInitSegment || !startupGroup.audioInitSegment ||
            !startupGroup.videoMediaSegment || !startupGroup.audioMediaSegment) {
            return {status: 'invalid', reason: 'missing-segment'};
        }
        if (startupGroup.videoInitSegment.type !== 'video' ||
            startupGroup.audioInitSegment.type !== 'audio' ||
            startupGroup.videoMediaSegment.type !== 'video' ||
            startupGroup.audioMediaSegment.type !== 'audio') {
            return {status: 'invalid', reason: 'invalid-segment-type'};
        }

        const initSwitch = startupGroup.audioInitSegment.mmtsAudioTrackSwitch;
        const mediaSwitch = startupGroup.audioMediaSegment.mmtsAudioTrackSwitch;
        if (!initSwitch || !mediaSwitch) {
            return {status: 'invalid', reason: 'missing-audio-switch'};
        }
        const initMatches = this._doesMMTSVodAudioTrackSwitchMatch(initSwitch, transaction);
        const mediaMatches = this._doesMMTSVodAudioTrackSwitchMatch(mediaSwitch, transaction);
        if (!initMatches && !mediaMatches) {
            const sameStaleAttempt = isPlaybackSwitchIdentity(initSwitch) &&
                isPlaybackSwitchIdentity(mediaSwitch) &&
                initSwitch.transactionKey === mediaSwitch.transactionKey &&
                initSwitch.attemptKey === mediaSwitch.attemptKey;
            return sameStaleAttempt ?
                {status: 'stale'} :
                {status: 'invalid', reason: 'mixed-operation'};
        }
        if (!initMatches || !mediaMatches) {
            return {status: 'invalid', reason: 'mixed-operation'};
        }
        if (initSwitch.attemptKey !== mediaSwitch.attemptKey) {
            return {status: 'invalid', reason: 'mixed-attempt'};
        }
        if (!this._isMMTSAudioTrackSwitchMediaValid(mediaSwitch)) {
            return {status: 'invalid', reason: 'invalid-audio-window'};
        }
        const videoWindow = this._getMMTSFirstPlayableWindow(startupGroup.videoMediaSegment);
        if (!videoWindow) {
            return {status: 'invalid', reason: 'missing-video-window'};
        }
        const audioRange = this._getMMTSMediaSegmentRange(startupGroup.audioMediaSegment);
        if (!audioRange) {
            return {status: 'invalid', reason: 'invalid-audio-window'};
        }
        const firstVideoSample = startupGroup.videoMediaSegment.info &&
            startupGroup.videoMediaSegment.info.firstSample;
        if (!isMMTSRandomAccessSafeVideoSegment(startupGroup.videoMediaSegment)) {
            return {status: 'invalid', reason: 'video-not-random-access'};
        }
        if (!firstVideoSample || firstVideoSample.isSyncPoint !== true) {
            return {status: 'invalid', reason: 'video-not-sync'};
        }

        const audioPlayableStart = Math.max(audioRange.start, mediaSwitch.audioStart);
        const intersectionStart = Math.max(videoWindow.playableStart, audioPlayableStart);
        transaction.resolvedSeekTime = Math.max(
            transaction.requestedTime,
            transaction.resolvedSeekTime || 0,
            intersectionStart
        );

        transaction.rebuildWindow = {
            videoInitSegment: startupGroup.videoInitSegment,
            audioInitSegment: startupGroup.audioInitSegment,
            audioSwitch: mediaSwitch,
            videoSegments: [startupGroup.videoMediaSegment],
            audioSegments: [startupGroup.audioMediaSegment],
        };
        if (!this._audio_track_switch_coordinator.transition(
            transaction.operation,
            'waiting-init',
            'collecting-overlap'
        )) {
            return {status: 'invalid', reason: 'coordinator-transition-rejected'};
        }
        transaction.stage = 'extending';
        this._transmuxer.acknowledgeMMTSVodAudioTrackStartup(initSwitch);
        this._tryApplyMMTSVodAudioTrackSwitchRebuild();
        return {status: 'accepted'};
    }

    private _collectMMTSVodAudioTrackSwitchMedia(type: string, mediaSegment: any): boolean {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        const rebuildWindow = transaction && transaction.rebuildWindow;
        if (!transaction || transaction.stage !== 'extending' || !rebuildWindow ||
            (type !== 'video' && type !== 'audio')) {
            return false;
        }

        const segments = type === 'video' ? rebuildWindow.videoSegments : rebuildWindow.audioSegments;
        if (segments.length >= MMTS_VOD_TRACK_SWITCH_SEGMENT_LIMIT) {
            return false;
        }
        const segmentRange = this._getMMTSMediaSegmentRange(mediaSegment);
        const previousRange = this._getMMTSMediaSegmentRange(segments[segments.length - 1]);
        if (!segmentRange || !previousRange ||
            Math.abs(segmentRange.start - previousRange.end) > 0.1 ||
            segmentRange.end <= previousRange.end) {
            return false;
        }

        if (type === 'audio' && mediaSegment && mediaSegment.mmtsAudioTrackSwitch) {
            const audioSwitch = mediaSegment.mmtsAudioTrackSwitch;
            if (!this._doesMMTSVodAudioTrackSwitchMatch(audioSwitch, transaction) ||
                audioSwitch.transactionKey !== rebuildWindow.audioSwitch.transactionKey ||
                audioSwitch.attemptKey !== rebuildWindow.audioSwitch.attemptKey ||
                !this._isMMTSAudioTrackSwitchMediaValid(audioSwitch)) {
                return false;
            }
        }

        segments.push(mediaSegment);
        return true;
    }

    private _tryApplyMMTSVodAudioTrackSwitchRebuild(): boolean {
        const transaction = this._pending_mmts_vod_audio_track_switch;
        const rebuildWindow = transaction && transaction.rebuildWindow;
        if (!transaction || transaction.stage !== 'extending' || !rebuildWindow ||
            !this._mse_buffer_state_machine) {
            return false;
        }

        const resolvedSeekTime = transaction.resolvedSeekTime !== undefined ?
            transaction.resolvedSeekTime : transaction.requestedTime;
        const currentTime = this._media_element && typeof this._media_element.currentTime === 'number' &&
            isFinite(this._media_element.currentTime) ? this._media_element.currentTime : resolvedSeekTime;
        const preserveVideoBuffer = Browser.firefox !== true;
        const seekTime = preserveVideoBuffer ?
            Math.max(resolvedSeekTime, currentTime) : resolvedSeekTime;
        const videoSegments = preserveVideoBuffer ? [] : selectMMTSTrackSwitchSegmentPrefix(
            rebuildWindow.videoSegments,
            'video',
            seekTime,
            0.05
        );
        const audioSegments = selectMMTSTrackSwitchSegmentPrefix(
            rebuildWindow.audioSegments,
            'audio',
            seekTime,
            preserveVideoBuffer ? 0.25 : 0.05
        );
        if ((!preserveVideoBuffer && videoSegments.length === 0) || audioSegments.length === 0) {
            return false;
        }
        const replaceMediaSource = !preserveVideoBuffer;

        transaction.stage = 'submitted';
        this._audio_track_switch_coordinator.transition(
            transaction.operation,
            'collecting-overlap',
            'submitted'
        );
        const accepted = this._mse_buffer_state_machine.onAudioTrackSwitch({
            stage: 'rebuild_ready',
            mode: preserveVideoBuffer ? 'vod-forward' : 'vod',
            operation: transaction.operation,
            replaceMediaSource,
            preserveVideoBuffer,
            switchTime: transaction.requestedTime,
            seekTime,
            resumePlayback: transaction.resumePlayback,
            videoInitSegment: preserveVideoBuffer ? null : rebuildWindow.videoInitSegment,
            audioInitSegment: rebuildWindow.audioInitSegment,
            videoSegments,
            audioSegments,
            transactionId: transaction.generation,
        });
        if (!accepted) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'mse-submit-rejected'
            );
            return false;
        }
        const currentTransaction = this._audio_track_switch_coordinator.active;
        if (!currentTransaction || !['submitted', 'rebuilding'].includes(currentTransaction.stage) ||
            !isSamePlaybackAttempt(currentTransaction.operation, transaction.operation)) {
            return false;
        }
        if (!replaceMediaSource &&
            (currentTransaction.stage !== 'submitted' ||
                !this._audio_track_switch_coordinator.transition(
                    transaction.operation,
                    'submitted',
                    'rebuilding'
                ))) {
            return false;
        }
        if (!replaceMediaSource) {
            transaction.stage = 'rebuilding';
        }
        this._mmts_audio_track_switch_rebuild_in_progress = true;

        Log.v(
            this.TAG,
            `Rebuild MMTS VOD audio switch at ${seekTime.toFixed(3)}, ` +
            `request_time=${transaction.requestedTime.toFixed(3)}, ` +
            `packet_id=0x${rebuildWindow.audioSwitch.packetId.toString(16)}, ` +
            `strategy=${replaceMediaSource ? 'replace-media-source' : 'in-place'}`
        );
        return true;
    }

    private _doesMMTSVodAudioTrackSwitchMatch(audioSwitch: any,
                                                transaction: MMTSVodAudioTrackSwitchTransaction): boolean {
        return !!audioSwitch &&
            doesPlaybackSwitchIdentityMatchOperation(audioSwitch, transaction.operation) &&
            typeof audioSwitch.packetId === 'number' && isFinite(audioSwitch.packetId) &&
            Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
            audioSwitch.requestedStartMicroseconds ===
                transaction.operation.requestedTimeMicroseconds &&
            transaction.confirmedPacketId !== undefined &&
            audioSwitch.packetId === transaction.confirmedPacketId;
    }

    private _isMMTSAudioTrackSwitchMediaValid(audioSwitch: any): boolean {
        return !!audioSwitch &&
            typeof audioSwitch.audioDecodeStart === 'number' && isFinite(audioSwitch.audioDecodeStart) &&
            typeof audioSwitch.audioStart === 'number' && isFinite(audioSwitch.audioStart) &&
            audioSwitch.audioStart >= 0 &&
            typeof audioSwitch.audioEnd === 'number' && isFinite(audioSwitch.audioEnd) &&
            audioSwitch.audioEnd > audioSwitch.audioStart;
    }

    private _cacheMMTSVideoMediaSegment(mediaSegment: any): void {
        const transaction = this._audio_track_switch_coordinator.active;
        if (transaction && transaction.strategy === 'live-forward' &&
            (!isSamePlaybackOperation(mediaSegment && mediaSegment.playbackOperation,
                transaction.operation) ||
            mediaSegment.mseBufferGeneration !== transaction.operation.timelineGeneration)) {
            return;
        }
        const playableWindow = this._getMMTSFirstPlayableWindow(mediaSegment);
        if (playableWindow && isMMTSRandomAccessSafeVideoSegment(mediaSegment)) {
            this._mmts_live_video_rebuild_window = {
                playableStart: playableWindow.playableStart,
                segments: [mediaSegment],
            };
            return;
        }
        const window = this._mmts_live_video_rebuild_window;
        const previousSegment = window && window.segments[window.segments.length - 1];
        if (!window || !canAppendMMTSLiveVideoContinuation(previousSegment, mediaSegment)) {
            return;
        }
        if (window.segments.length >= MMTS_TRACK_SWITCH_VIDEO_CACHE_LIMIT) {
            this._mmts_live_video_rebuild_window = null;
            return;
        }
        window.segments.push(mediaSegment);
    }

    private _getMMTSFirstPlayableWindow(mediaSegment: any): any | null {
        return getMMTSFirstPlayableWindow(mediaSegment);
    }

    private _getMMTSMediaSegmentRange(mediaSegment: any): {start: number, end: number} | null {
        return getMMTSSegmentDecodeRange(mediaSegment);
    }

    private _consumeMMTSLiveAudioTrackSwitchInit(
        initSegment: any,
        operation: PlaybackOperation
    ): boolean {
        const audioSwitch = initSegment && initSegment.mmtsAudioTrackSwitch;
        const transaction = this._audio_track_switch_coordinator.active;
        const collecting = this._isForwardMMTSAudioTrackSwitch(transaction) &&
            ['selecting', 'waiting-init', 'collecting-overlap'].includes(transaction.stage) &&
            isSamePlaybackOperation(operation, transaction.operation);
        if (!audioSwitch) {
            return collecting;
        }
        if (!collecting ||
            !this._doesMMTSLiveAudioTrackSwitchIdentityMatch(audioSwitch, transaction)) {
            return true;
        }
        if (!this._isMMTSLiveAudioTrackSwitchInitValid(initSegment)) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'live-data:invalid-init'
            );
            return true;
        }
        if (!this._pending_audio_track_switch_init_segment) {
            this._pending_audio_track_switch_init_segment = initSegment;
        }
        if (transaction.stage === 'waiting-init') {
            this._audio_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-init',
                'collecting-overlap'
            );
        }
        this._tryApplyMMTSLiveAudioTrackSwitchRebuild();
        return true;
    }

    private _consumeMMTSLiveAudioTrackSwitchMedia(
        mediaSegment: any,
        operation: PlaybackOperation
    ): boolean {
        const audioSwitch = mediaSegment && mediaSegment.mmtsAudioTrackSwitch;
        const transaction = this._audio_track_switch_coordinator.active;
        const collecting = this._isForwardMMTSAudioTrackSwitch(transaction) &&
            ['selecting', 'waiting-init', 'collecting-overlap'].includes(transaction.stage) &&
            isSamePlaybackOperation(operation, transaction.operation);
        if (audioSwitch && (!collecting ||
            !this._doesMMTSLiveAudioTrackSwitchIdentityMatch(audioSwitch, transaction))) {
            return true;
        }
        if (!collecting) {
            return !!audioSwitch;
        }

        const segments = this._pending_audio_track_switch_media_segments;
        if (segments.length === 0) {
            if (!audioSwitch) {
                return true;
            }
            if (!this._isMMTSLiveAudioTrackSwitchMediaValid(mediaSegment, true)) {
                this._failUnifiedMMTSAudioTrackSwitch(
                    transaction.operation,
                    'live-data:invalid-first-media'
                );
                return true;
            }
            segments.push(mediaSegment);
            this._tryApplyMMTSLiveAudioTrackSwitchRebuild();
            return true;
        }

        if (!this._isMMTSLiveAudioTrackSwitchMediaValid(mediaSegment, !!audioSwitch)) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                audioSwitch ? 'live-data:invalid-first-media' :
                    'live-data:invalid-continuation'
            );
            return true;
        }
        const segmentRange = this._getMMTSMediaSegmentRange(mediaSegment);
        const previousRange = this._getMMTSMediaSegmentRange(segments[segments.length - 1]);
        if (!segmentRange || !previousRange) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'live-data:invalid-continuation'
            );
            return true;
        }
        if (segmentRange.end <= previousRange.end) {
            return true;
        }
        if (segmentRange.start > previousRange.end + 0.1) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'live-data:forward-gap'
            );
            return true;
        }
        if (audioSwitch) {
            return true;
        }
        if (segments.length >= MMTS_TRACK_SWITCH_AUDIO_CACHE_LIMIT) {
            this._failUnifiedMMTSAudioTrackSwitch(
                transaction.operation,
                'live-data:overflow'
            );
            return true;
        }
        segments.push(mediaSegment);
        this._tryApplyMMTSLiveAudioTrackSwitchRebuild();
        return true;
    }

    private _doesMMTSLiveAudioTrackSwitchIdentityMatch(
        audioSwitch: any,
        transaction: MMTSAudioTrackSwitchTransaction
    ): boolean {
        return !!audioSwitch &&
            doesPlaybackSwitchIdentityMatchOperation(audioSwitch, transaction.operation) &&
            Number.isInteger(audioSwitch.packetId) &&
            audioSwitch.packetId === transaction.targetPacketId &&
            Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
            audioSwitch.requestedStartMicroseconds ===
                transaction.operation.requestedTimeMicroseconds;
    }

    private _isMMTSLiveAudioTrackSwitchInitValid(initSegment: any): boolean {
        return !!initSegment && initSegment.type === 'audio' &&
            typeof initSegment.container === 'string' && initSegment.container.length > 0 &&
            typeof initSegment.codec === 'string' && initSegment.codec.length > 0 &&
            !!initSegment.data && typeof initSegment.data.byteLength === 'number' &&
            initSegment.data.byteLength > 0;
    }

    private _isMMTSLiveAudioTrackSwitchMediaValid(
        mediaSegment: any,
        requireSwitchSchema: boolean
    ): boolean {
        const range = this._getMMTSMediaSegmentRange(mediaSegment);
        if (!mediaSegment || mediaSegment.type !== 'audio' || !range ||
            !mediaSegment.data || typeof mediaSegment.data.byteLength !== 'number' ||
            mediaSegment.data.byteLength <= 0) {
            return false;
        }
        return !requireSwitchSchema ||
            this._isMMTSAudioTrackSwitchMediaValid(mediaSegment.mmtsAudioTrackSwitch);
    }

    private _tryApplyMMTSLiveAudioTrackSwitchRebuild(): boolean {
        const coordinatorTransaction = this._audio_track_switch_coordinator.active;
        if (!this._config.isMMTS ||
            !this._isForwardMMTSAudioTrackSwitch(coordinatorTransaction) ||
            this._accepted_audio_track_switch_time == null ||
            !this._pending_audio_track_switch_init_segment ||
            this._pending_audio_track_switch_media_segments.length === 0 ||
            !this._mse_buffer_state_machine) {
            return false;
        }
        const preserveVideoBuffer = Browser.firefox !== true;
        const initSwitch = this._pending_audio_track_switch_init_segment.mmtsAudioTrackSwitch;
        const requestedTime = this._accepted_audio_track_switch_time;
        const currentTime = this._media_element && typeof this._media_element.currentTime === 'number' &&
            isFinite(this._media_element.currentTime) ? this._media_element.currentTime : requestedTime;
        const targetTime = Math.max(requestedTime, currentTime);
        const firstAudioSegment = this._pending_audio_track_switch_media_segments[0];
        const audioSwitch = firstAudioSegment.mmtsAudioTrackSwitch;
        const firstAudioRange = this._getMMTSMediaSegmentRange(firstAudioSegment);
        if (!initSwitch || !firstAudioRange ||
            audioSwitch.attemptKey !== initSwitch.attemptKey) {
            return false;
        }
        const audioStart = Math.max(firstAudioRange.start, audioSwitch.audioStart);
        let seekTime = Math.max(targetTime, audioStart);
        let videoInitSegment: any = null;
        let videoSegments: any[] = [];
        let replaceMediaSource = false;
        if (!preserveVideoBuffer) {
            const videoWindow = this._mmts_live_video_rebuild_window;
            const authoritativeVideoInitSegment = this._mse_controller?.getLastInitSegment('video');
            if (!videoWindow || !authoritativeVideoInitSegment) {
                return false;
            }
            seekTime = Math.max(seekTime, videoWindow.playableStart);
            videoSegments = selectMMTSTrackSwitchSegmentPrefix(
                videoWindow.segments,
                'video',
                seekTime,
                0.05
            );
            if (videoSegments.length === 0) {
                return false;
            }
            videoInitSegment = Object.assign({}, authoritativeVideoInitSegment, {
                playbackOperation: clonePlaybackOperation(coordinatorTransaction.operation),
                mseBufferGeneration: coordinatorTransaction.operation.timelineGeneration,
            });
            replaceMediaSource = true;
        }
        const audioSegments = selectMMTSTrackSwitchSegmentPrefix(
            this._pending_audio_track_switch_media_segments,
            'audio',
            seekTime,
            preserveVideoBuffer ? 0.25 : 0.05
        );
        if (audioSegments.length === 0) {
            return false;
        }

        if (!this._audio_track_switch_coordinator.transition(
                coordinatorTransaction.operation,
                'collecting-overlap',
                'submitted'
            )) {
            return false;
        }
        const accepted = this._mse_buffer_state_machine.onAudioTrackSwitch({
            stage: 'rebuild_ready',
            mode: coordinatorTransaction.strategy === 'live-forward' ? 'live' : 'vod-forward',
            operation: coordinatorTransaction.operation,
            replaceMediaSource,
            preserveVideoBuffer,
            switchTime: requestedTime,
            seekTime,
            resumePlayback: this._pending_audio_track_switch_resume_playback,
            videoInitSegment,
            audioInitSegment: this._pending_audio_track_switch_init_segment,
            videoSegments,
            audioSegments,
            transactionId: coordinatorTransaction.operation.transactionId,
        });
        if (!accepted) {
            this._failUnifiedMMTSAudioTrackSwitch(
                coordinatorTransaction.operation,
                'mse-submit-rejected'
            );
            return false;
        }
        const currentTransaction = this._audio_track_switch_coordinator.active;
        if (!currentTransaction || currentTransaction.stage !== 'submitted' ||
            !isSamePlaybackAttempt(
                currentTransaction.operation,
                coordinatorTransaction.operation
            ) ||
            !this._audio_track_switch_coordinator.transition(
            coordinatorTransaction.operation,
            'submitted',
            'rebuilding'
            )) {
            return false;
        }
        this._mmts_audio_track_switch_rebuild_in_progress = true;

        Log.v(
            this.TAG,
            `Rebuild MMTS forward audio switch at ${seekTime.toFixed(3)}, ` +
            `request_time=${requestedTime.toFixed(3)}, ` +
            `packet_id=0x${audioSwitch.packetId.toString(16)}, ` +
            `strategy=${preserveVideoBuffer ? 'audio-only-in-place' :
                (replaceMediaSource ? 'replace-media-source' : 'in-place')}`
        );
        this._accepted_audio_track_switch_time = null;
        this._pending_audio_track_switch_init_segment = null;
        this._pending_audio_track_switch_media_segments = [];
        this._pending_audio_track_switch_resume_playback = false;
        this._mmts_live_video_rebuild_window = null;
        return true;
    }

    private _acceptAudioTrackSwitch(audioTracks: any): boolean {
        const selectedPacketId = audioTracks && audioTracks.selectedPacketId;
        const previousPacketId = this._selected_mmts_audio_packet_id;
        const tracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks.slice() : [];

        const vodTransaction = this._pending_mmts_vod_audio_track_switch;
        if (vodTransaction != null) {
            if (!vodTransaction.selectionIssued || vodTransaction.stage !== 'selecting' ||
                vodTransaction.confirmedPacketId !== undefined ||
                typeof selectedPacketId !== 'number' || !isFinite(selectedPacketId) ||
                selectedPacketId !== vodTransaction.expectedPacketId) {
                return false;
            }

            this._mmts_audio_tracks = tracks;
            vodTransaction.confirmedPacketId = selectedPacketId;
            vodTransaction.confirmedTracks = tracks;
            vodTransaction.confirmedAudioTracks = audioTracks;
            vodTransaction.stage = 'waiting_startup';
            this._transmuxer.completeMMTSVodAudioTrackRebuild();
            Log.v(
                this.TAG,
                `Accepted MMTS VOD audio switch packet_id=0x${selectedPacketId.toString(16)}, ` +
                `request_time=${vodTransaction.requestedTime.toFixed(3)}`
            );
            return true;
        }

        if (this._pending_audio_track_switch_request_time == null) {
            this._mmts_audio_tracks = tracks;
            this._selected_mmts_audio_packet_id = selectedPacketId;
            return true;
        }

        const expectedPacketId = this._pending_audio_track_switch_expected_packet_id;
        if (typeof expectedPacketId === 'number' && isFinite(expectedPacketId) &&
            selectedPacketId !== expectedPacketId) {
            return false;
        }

        const switchTime = this._pending_audio_track_switch_request_time;
        this._pending_audio_track_switch_request_time = null;
        this._pending_audio_track_switch_expected_packet_id = null;
        if (selectedPacketId === undefined || selectedPacketId === previousPacketId) {
            return false;
        }

        this._mmts_audio_tracks = tracks;
        this._selected_mmts_audio_packet_id = selectedPacketId;
        this._accepted_audio_track_switch_time = switchTime;
        Log.v(
            this.TAG,
            `Accepted MMTS audio switch packet_id=0x${selectedPacketId.toString(16)}, ` +
            `request_time=${switchTime.toFixed(3)}`
        );
        return true;
    }

    private _isWaitingForAudioTrackSwitchMediaSegment(): boolean {
        return this._accepted_audio_track_switch_time != null;
    }

    private _onMSESourceOpen(): void {
        this._mse_source_opened = true;
        this._mse_buffer_state_machine?.onSourceOpen();
        if (this._has_pending_load) {
            this._has_pending_load = false;
            this.load();
        }
    }

    private _onMSEUpdateEnd(type?: any): void {
        this._mse_buffer_state_machine?.onUpdateEnd(type);

        if (this._config.isLive && this._config.liveBufferLatencyChasing && this._live_latency_chaser) {
            this._live_latency_chaser.notifyBufferedRangeUpdate();
        }

        this._startup_buffer_gate?.notifyBufferedRangeUpdate();

        this._notifyMediaStateChanged('mse_update_end');
    }

    private _onMediaTimeUpdate(): void {
        this._notifyMediaStateChanged('timeupdate');
    }

    private _onMediaStateChange(e?: Event): void {
        this._notifyMediaStateChanged(e ? e.type : 'media_state');
    }

    private _notifyMediaStateChanged(eventType: string = 'media_state'): void {
        if (this._mse_buffer_state_machine && this._media_element) {
            this._mse_buffer_state_machine.onMediaState(
                this._media_element.currentTime,
                this._media_element.readyState,
                eventType
            );
        }
    }

    private _onMSEBufferFull(info?: any): void {
        this._logMSEBufferFull();
        this._mse_buffer_state_machine?.onQuotaExceeded(info ? info.type : undefined, info ? info.segment : undefined);
    }

    private _logMSEBufferFull(): void {
        const now = Date.now();
        if (now - this._last_mse_buffer_full_log_time < 30000) {
            return;
        }
        this._last_mse_buffer_full_log_time = now;
        Log.v(this.TAG, 'MSE SourceBuffer is full, suspend transmuxing task');
    }

    private _onMSEError(info: any): void {
        if (this._handling_external_mse_error) {
            this._emitMSEError(info);
            return;
        }
        this._handling_external_mse_error = true;
        this._external_mse_error_reported = false;
        try {
            this._mse_buffer_state_machine?.onExternalMSEError(info);
            if (!this._external_mse_error_reported) {
                this._emitMSEError(info);
            }
        } finally {
            this._handling_external_mse_error = false;
            this._external_mse_error_reported = false;
        }
    }

    private _emitMSEError(info: any): void {
        if (this._handling_external_mse_error) {
            if (this._external_mse_error_reported) {
                return;
            }
            this._external_mse_error_reported = true;
        }
        this._emitter.emit(PlayerEvents.ERROR, ErrorTypes.MEDIA_ERROR, ErrorDetails.MEDIA_MSE_ERROR, info);
    }

    private _onMSEStartStreaming(): void {
        if (!this._loaded_metadata_received) {
            // Ignore initial startstreaming event since we have started loading data
            return;
        }
        if (this._config.isMMTS && this._mse_buffer_state_machine && this._media_element) {
            this._mse_buffer_state_machine.onMediaState(
                this._media_element.currentTime,
                this._media_element.readyState,
                'start_streaming'
            );
            return;
        }
        if (this._config.isLive) {
            // For live stream, we do not suspend / resume transmuxer
            return;
        }
        Log.v(this.TAG, 'Resume transmuxing task due to ManagedMediaSource onStartStreaming');
        this._loading_controller.resumeTransmuxer();
    }

    private _onMSEEndStreaming(): void {
        if (this._config.isMMTS && this._mse_buffer_state_machine && this._media_element) {
            this._mse_buffer_state_machine.onMediaState(
                this._media_element.currentTime,
                this._media_element.readyState,
                'end_streaming'
            );
            return;
        }
        if (this._config.isLive) {
            // For live stream, we do not suspend / resume transmuxer
            return;
        }
        Log.v(this.TAG, 'Suspend transmuxing task due to ManagedMediaSource onEndStreaming');
        this._loading_controller.suspendTransmuxer();
    }

    private _onMediaLoadedMetadata(e: any): void {
        this._loaded_metadata_received = true;
        if (this._pending_mmts_seek) {
            this._pending_seek_time = null;
            this._schedulePendingMMTSSeek(0);
        } else if (this._pending_seek_time != null) {
            this._seeking_handler.seek(this._pending_seek_time);
            this._pending_seek_time = null;
        }
    }

    private _onRequestDirectSeek(target: number): boolean {
        if (this._mse_buffer_state_machine) {
            return this._mse_buffer_state_machine.onDirectSeek(target);
        }
        this._seeking_handler.directSeek(target);
        return true;
    }

    private _onControlledSeekRequest(target: number, source: string): boolean {
        if (!this._mse_buffer_state_machine || !this._config.isMMTS || this._config.isLive) {
            return false;
        }
        if (source !== 'initial' && this._seeking_handler?.isPositionBuffered(target)) {
            return false;
        }
        this._requestLatestMMTSSeek(target, source);
        return true;
    }

    private _onRequiredUnbufferedSeek(milliseconds: number): void {
        if (this._config.isLive) {
            return;
        }
        if (this._config.isMMTS) {
            this._requestLatestMMTSSeek(milliseconds / 1000, 'unbuffered');
            return;
        }
        this._beginPlaybackOperation('seek', milliseconds, 'requested');
        this._mse_buffer_state_machine?.onSeek(milliseconds / 1000);
    }

    private _requestLatestMMTSSeek(
        targetSeconds: number,
        source: string
    ): Promise<PlaybackOperationResult> {
        const operation = this._reservePlaybackOperation(
            'seek', targetSeconds * 1000, undefined, 'queued'
        );
        const promise = this._operation_results.register(operation, 'queued', {
            reason: 'seek-debounce',
        });
        if (this._pending_mmts_seek) {
            this._operation_results.settle(
                this._pending_mmts_seek.operation,
                'superseded',
                {reason: 'newer-seek-target'}
            );
        }
        this._pending_mmts_seek = {operation, targetSeconds, source};
        if (!this._media_element || !this._mse_buffer_state_machine) {
            this._pending_seek_time = targetSeconds;
            return promise;
        }
        const delay = source === 'media' ? 0 : this._getMMTSSeekDebounceInterval();
        this._schedulePendingMMTSSeek(delay);
        return promise;
    }

    private _schedulePendingMMTSSeek(delay: number): void {
        if (this._pending_mmts_seek_timer != null) {
            window.clearTimeout(this._pending_mmts_seek_timer);
            this._pending_mmts_seek_timer = null;
        }
        this._pending_mmts_seek_timer = window.setTimeout(() => {
            this._pending_mmts_seek_timer = null;
            const pending = this._pending_mmts_seek;
            this._pending_mmts_seek = null;
            if (!pending) return;
            this._scheduleInteractiveOperation({
                operation: pending.operation,
                payload: {
                    type: 'seek',
                    targetSeconds: pending.targetSeconds,
                    source: pending.source,
                },
            }, true);
        }, Math.max(0, delay));
    }

    private _getMMTSSeekDebounceInterval(): number {
        const configured = this._config && this._config.mmtsSeekDebounceInterval;
        return typeof configured === 'number' && isFinite(configured) && configured >= 0 ?
            configured : 100;
    }

    private _cancelPendingMMTSSeek(reason: string): void {
        if (this._pending_mmts_seek_timer != null) {
            window.clearTimeout(this._pending_mmts_seek_timer);
            this._pending_mmts_seek_timer = null;
        }
        if (this._pending_mmts_seek) {
            this._operation_results.settle(
                this._pending_mmts_seek.operation,
                'cancelled',
                {reason}
            );
            this._pending_mmts_seek = null;
        }
    }

    private _scheduleInteractiveOperation(
        intent: ScheduledPlaybackIntent<MMTSInteractiveIntentPayload>,
        alreadyRegistered: boolean = false
    ): Promise<PlaybackOperationResult> {
        const result = this._operation_scheduler.request(intent);
        if (result.type === 'duplicate') {
            // A duplicate is the same transaction being submitted through a
            // second control path (for example, media `seeking` after API seek).
            // Never settle the original Promise from the duplicate path.
            const existing = this._operation_results.promiseFor(result.intent.operation);
            return existing || this._createImmediateOperationResult(
                intent.operation.kind,
                intent.operation.requestedTimeMilliseconds,
                intent.operation.packetId,
                'no-op',
                'duplicate-already-completed',
                {committedPacketId: intent.operation.packetId}
            );
        }

        const promise = alreadyRegistered ?
            this._operation_results.promiseFor(intent.operation) :
            this._operation_results.register(
                intent.operation,
                result.type === 'activate' ? 'running' : 'queued',
                {reason: result.type === 'activate' ? 'timeline-owner-acquired' : 'waiting-for-timeline-owner'}
            );
        const operationPromise = promise || this._operation_results.register(
            intent.operation,
            result.type === 'activate' ? 'running' : 'queued'
        );

        for (let i = 0; i < result.superseded.length; i++) {
            this._operation_results.settle(result.superseded[i].operation, 'superseded', {
                reason: intent.operation.kind === 'seek' ?
                    'superseded-by-seek' : `newer-${intent.operation.kind}-request`,
            });
        }

        if (result.type === 'activate') {
            if (result.interrupted) {
                this._interruptScheduledOperation(result.interrupted, 'superseded-by-seek');
            }
            this._startScheduledInteractiveOperation(result.intent);
        }
        return operationPromise;
    }

    private _interruptScheduledOperation(
        intent: ScheduledPlaybackIntent<MMTSInteractiveIntentPayload>,
        reason: string
    ): void {
        if (intent.operation.kind === 'audio-switch') {
            this._cancelMMTSAudioTrackSwitchForSeek();
        } else if (intent.operation.kind === 'video-switch') {
            this._cancelMMTSVideoTrackSwitchForSeek();
        }
        this._clearRecoveryForRoot(intent.operation);
        this._operation_results.settle(
            intent.operation,
            intent.operation.kind === 'seek' ? 'superseded' : 'cancelled',
            {reason}
        );
    }

    private _startScheduledInteractiveOperation(
        intent: ScheduledPlaybackIntent<MMTSInteractiveIntentPayload>
    ): void {
        const payload = intent.payload;
        if (payload.type === 'seek') {
            const operation = intent.operation;
            this._operation_results.publish(operation, 'running', {reason: 'seek-started'});
            if (!this._activatePlaybackOperation(operation)) {
                this._completeScheduledOperation(operation, 'failed', 'activation-rejected');
                return;
            }
            this._mse_buffer_state_machine?.onUserSeek(payload.targetSeconds);
            return;
        }

        const nowMilliseconds = this._config.isLive ?
            this._getAudioTrackSwitchTimelineSeed() :
            (this._media_element ? Math.max(0, this._media_element.currentTime * 1000) :
                intent.operation.requestedTimeMilliseconds);
        if (payload.type === 'audio-switch') {
            const source = payload.reservation;
            const operation = rebindReservedPlaybackOperation(source.operation, {
                phase: 'requested',
                requestedTimeMilliseconds: nowMilliseconds,
                packetId: source.targetPacketId,
            });
            const recoveryOperation = source.recoveryOperation ?
                rebindReservedPlaybackOperation(source.recoveryOperation, {
                    phase: 'recovery-reserved',
                    requestedTimeMilliseconds: nowMilliseconds,
                    packetId: source.priorCommittedPacketId,
                }) : undefined;
            if (!this._operation_results.replaceReservation(operation)) {
                this._completeScheduledOperation(
                    intent.operation, 'failed', 'audio-result-reservation-rebind-rejected'
                );
                return;
            }
            if (!this._operation_scheduler.replaceActiveReservation(operation)) {
                this._completeScheduledOperation(
                    operation, 'failed', 'audio-scheduler-reservation-rebind-rejected'
                );
                return;
            }
            this._operation_results.publish(operation, 'running', {reason: 'audio-switch-started'});
            const result = this._audio_track_switch_coordinator.request(Object.assign({}, source, {
                operation,
                recoveryOperation,
                resumeIntent: !!this._media_element && !this._media_element.paused,
            }));
            if (result.type === 'activate') {
                this._startUnifiedMMTSAudioTrackSwitch(result.transaction);
            } else {
                this._completeScheduledOperation(
                    operation,
                    result.type === 'same-target' ? 'no-op' : 'failed',
                    result.type === 'same-target' ? 'already-selected' : 'audio-request-not-activated',
                    {committedPacketId: this._selected_mmts_audio_packet_id}
                );
            }
            return;
        }

        const source = payload.reservation;
        const operation = rebindReservedPlaybackOperation(source.operation, {
            phase: 'requested',
            requestedTimeMilliseconds: nowMilliseconds,
            packetId: source.targetPacketId,
        });
        const recoveryOperation = source.recoveryOperation ?
            rebindReservedPlaybackOperation(source.recoveryOperation, {
                phase: 'recovery-reserved',
                requestedTimeMilliseconds: nowMilliseconds,
                packetId: source.priorCommittedPacketId,
            }) : undefined;
        if (!this._operation_results.replaceReservation(operation)) {
            this._completeScheduledOperation(
                intent.operation, 'failed', 'video-result-reservation-rebind-rejected'
            );
            return;
        }
        if (!this._operation_scheduler.replaceActiveReservation(operation)) {
            this._completeScheduledOperation(
                operation, 'failed', 'video-scheduler-reservation-rebind-rejected'
            );
            return;
        }
        this._operation_results.publish(operation, 'running', {reason: 'video-switch-started'});
        const result = this._video_track_switch_coordinator.request(Object.assign({}, source, {
            operation,
            recoveryOperation,
        }));
        if (result.type === 'activate') {
            this._startUnifiedMMTSVideoTrackSwitch(result.transaction);
        } else {
            this._completeScheduledOperation(
                operation,
                result.type === 'same-target' ? 'no-op' : 'failed',
                result.type === 'same-target' ? 'already-selected' : 'video-request-not-activated',
                {committedPacketId: this._selected_mmts_video_packet_id}
            );
        }
    }

    private _completeScheduledOperation(
        operation: PlaybackOperation,
        status: 'committed' | 'no-op' | 'cancelled' | 'superseded' | 'failed',
        reason: string,
        details: {committedPacketId?: number, committedTimeMilliseconds?: number, error?: any} = {}
    ): void {
        this._operation_results.settle(operation, status, Object.assign({reason}, details));
        const active = this._operation_scheduler.active;
        if (!active || !isSamePlaybackTransaction(active.operation, operation)) {
            return;
        }
        const completion = this._operation_scheduler.complete(operation);
        if (completion.next) {
            this._startScheduledInteractiveOperation(completion.next);
            return;
        }
        this._ensureDesiredMMTSTrackState();
    }

    private _registerRecoveryOperation(
        recoveryOperation: PlaybackOperation,
        rootOperation: PlaybackOperation,
        reason: string
    ): void {
        this._playback_recovery_roots.set(recoveryOperation.transactionKey, {
            operation: clonePlaybackOperation(rootOperation),
            reason,
        });
    }

    private _completeRecoveryOperation(
        recoveryOperation: PlaybackOperation,
        recovered: boolean = true,
        failureReason?: string
    ): boolean {
        const root = this._playback_recovery_roots.get(recoveryOperation.transactionKey);
        if (!root) return false;
        this._playback_recovery_roots.delete(recoveryOperation.transactionKey);
        this._operation_results.settle(root.operation, 'failed', {
            reason: recovered ? `${root.reason}:recovered-to-prior-track` :
                (failureReason || `${root.reason}:recovery-failed`),
            committedPacketId: recovered ? recoveryOperation.packetId : undefined,
        });
        const active = this._operation_scheduler.active;
        if (active && isSamePlaybackTransaction(active.operation, root.operation)) {
            const completion = this._operation_scheduler.complete(root.operation);
            if (completion.next) {
                this._startScheduledInteractiveOperation(completion.next);
            } else {
                this._ensureDesiredMMTSTrackState();
            }
        }
        return true;
    }

    private _clearRecoveryForRoot(rootOperation: PlaybackOperation): void {
        this._playback_recovery_roots.forEach((root, key) => {
            if (isSamePlaybackTransaction(root.operation, rootOperation)) {
                this._playback_recovery_roots.delete(key);
            }
        });
    }

    private _ensureDesiredMMTSTrackState(): void {
        if (!this._config.isMMTS || this._operation_scheduler.active) return;
        const desiredAudio = this._desired_mmts_audio_packet_id;
        if (desiredAudio != null && desiredAudio !== this._selected_mmts_audio_packet_id &&
            this._mmts_audio_tracks.some((track) => track.packetId === desiredAudio &&
                isMMTSAudioTrackSelectable(track))) {
            void this.selectAudioTrack(desiredAudio);
        }
        const desiredVideo = this._desired_mmts_video_packet_id;
        if (desiredVideo != null && desiredVideo !== this._selected_mmts_video_packet_id &&
            this._mmts_video_tracks.some((track) => track.packetId === desiredVideo)) {
            void this.selectVideoTrack(desiredVideo);
        }
    }

    private _createImmediateOperationResult(
        kind: 'startup' | 'seek' | 'audio-switch' | 'video-switch',
        requestedTimeMilliseconds: number,
        packetId: number | undefined,
        status: 'committed' | 'no-op' | 'cancelled' | 'superseded' | 'failed',
        reason: string,
        details: {committedPacketId?: number, committedTimeMilliseconds?: number, error?: any} = {}
    ): Promise<PlaybackOperationResult> {
        const operation = this._reservePlaybackOperation(
            kind, requestedTimeMilliseconds, packetId, 'terminal'
        );
        const promise = this._operation_results.register(operation, 'running', {reason});
        this._operation_results.settle(operation, status, Object.assign({reason}, details));
        return promise;
    }

    private _createRejectedOperationResult(
        kind: 'startup' | 'seek' | 'audio-switch' | 'video-switch',
        requestedTimeMilliseconds: number,
        packetId: number | undefined,
        reason: string,
        error?: any
    ): Promise<PlaybackOperationResult> {
        return this._createImmediateOperationResult(
            kind,
            Math.max(0, isFinite(requestedTimeMilliseconds) ? requestedTimeMilliseconds : 0),
            packetId !== undefined && Number.isInteger(packetId) && packetId >= 0 ? packetId : undefined,
            'failed',
            reason,
            {error}
        );
    }

    private _settleAndClearScheduledOperations(
        status: 'cancelled' | 'superseded' | 'failed',
        reason: string
    ): void {
        const removed = this._operation_scheduler.clear();
        for (let i = 0; i < removed.length; i++) {
            if (this._operation_results.has(removed[i].operation)) {
                this._operation_results.settle(removed[i].operation, status, {reason});
            }
        }
    }

    private _beginPlaybackOperation(
        kind: 'startup' | 'seek',
        requestedTime: number,
        phase: string
    ): PlaybackOperation {
        const operation = this._reservePlaybackOperation(kind, requestedTime, undefined, phase);
        this._activatePlaybackOperation(operation);
        return operation;
    }

    private _reservePlaybackOperation(
        kind: 'startup' | 'seek' | 'audio-switch' | 'video-switch',
        requestedTime: number,
        packetId?: number,
        phase: string = 'requested'
    ): PlaybackOperation {
        return createPlaybackOperation({
            scopeId: this._playback_scope_id,
            timelineGeneration: ++this._playback_timeline_generation,
            kind,
            transactionId: ++this._playback_transaction_id,
            phase,
            requestedTimeMilliseconds: requestedTime,
            packetId,
        });
    }

    private _activatePlaybackOperation(operation: PlaybackOperation): boolean {
        if (!isPlaybackOperation(operation) || !this._transmuxer ||
            (this._mse_buffer_state_machine &&
                !this._mse_buffer_state_machine.canSetPlaybackOperation(operation)) ||
            !this._transmuxer.canSetPlaybackOperation(operation)) {
            return false;
        }
        // Both participants are synchronously preflighted before either one is
        // mutated.  Their setters are deterministic for the validated token.
        if (this._mse_buffer_state_machine &&
            !this._mse_buffer_state_machine.setPlaybackOperation(operation)) {
            return false;
        }
        if (!this._transmuxer.setPlaybackOperation(operation)) {
            return false;
        }
        this._active_playback_operation = clonePlaybackOperation(operation);
        return true;
    }

    private _activateOwnerRetryAttempt(
        sourceOperation: PlaybackOperation,
        retryOperation: PlaybackOperation,
        reason: string,
        retryRequest?: PlaybackOperationRetryRequest
    ): boolean {
        const active = this._active_playback_operation;
        if (!this._transmuxer || !active ||
            !isSamePlaybackOperation(active, sourceOperation) ||
            !isSamePlaybackTransaction(sourceOperation, retryOperation) ||
            retryOperation.attempt !== sourceOperation.attempt + 1) {
            return false;
        }

        const schedulerActive = this._operation_scheduler.active;
        const schedulerOwnsTransaction = !!schedulerActive &&
            isSamePlaybackTransaction(schedulerActive.operation, sourceOperation);
        const resultRegistryOwnsTransaction = this._operation_results.has(sourceOperation);
        const audioCanAdopt = retryOperation.kind !== 'audio-switch' ||
            this._audio_track_switch_coordinator.canAdoptAttempt(retryOperation);
        const videoCanAdopt = retryOperation.kind !== 'video-switch' ||
            this._video_track_switch_coordinator.canAdoptAttempt(retryOperation);
        const transmuxerCanAdopt = retryRequest ?
            this._transmuxer.canContinuePlaybackOperationRetry(
                retryOperation,
                retryRequest
            ) : this._transmuxer.canSetPlaybackOperation(retryOperation);

        if (!audioCanAdopt || !videoCanAdopt || !transmuxerCanAdopt ||
            (this._mse_buffer_state_machine &&
                !this._mse_buffer_state_machine.canSetPlaybackOperation(retryOperation)) ||
            (schedulerOwnsTransaction &&
                !this._operation_scheduler.canAdoptAttempt(retryOperation)) ||
            (resultRegistryOwnsTransaction &&
                !this._operation_results.canAdoptAttempt(retryOperation))) {
            return false;
        }

        // All synchronous participants are preflighted before the owner mutates
        // any of them.  The controller is authorized last so it cannot produce
        // data for the new attempt before MSE/coordinators observe the token.
        if (this._mse_buffer_state_machine &&
            !this._mse_buffer_state_machine.setPlaybackOperation(retryOperation)) {
            return false;
        }

        if (retryOperation.kind === 'audio-switch') {
            if (!this._audio_track_switch_coordinator.adoptAttempt(retryOperation)) {
                return false;
            }
            const transaction = this._pending_mmts_vod_audio_track_switch;
            if (transaction &&
                isSamePlaybackTransaction(transaction.operation, retryOperation)) {
                transaction.operation = clonePlaybackOperation(retryOperation);
                if (retryOperation.phase === 'adaptive-retry') {
                    transaction.stage = 'selecting';
                    transaction.selectionIssued = true;
                    transaction.rebuildWindow = null;
                }
            }
        } else if (retryOperation.kind === 'video-switch') {
            if (!this._video_track_switch_coordinator.adoptAttempt(retryOperation)) {
                return false;
            }
            this._pending_video_track_switch_init_segment = null;
            this._pending_video_track_switch_media_segment = null;
        }

        if (schedulerOwnsTransaction &&
            !this._operation_scheduler.adoptAttempt(retryOperation)) {
            return false;
        }
        if (resultRegistryOwnsTransaction &&
            !this._operation_results.adoptAttempt(retryOperation, reason)) {
            return false;
        }

        this._active_playback_operation = clonePlaybackOperation(retryOperation);
        return retryRequest ?
            this._transmuxer.continuePlaybackOperationRetry(
                retryOperation,
                retryRequest
            ) : this._transmuxer.setPlaybackOperation(retryOperation);
    }

    private _getOwnerRetryFailureOperation(
        sourceOperation: PlaybackOperation,
        retryOperation: PlaybackOperation
    ): PlaybackOperation {
        return this._active_playback_operation &&
            isSamePlaybackOperation(this._active_playback_operation, retryOperation) ?
            retryOperation : sourceOperation;
    }

    private _onPlaybackOperationRetryRequired(
        request: PlaybackOperationRetryRequest,
        sourceOperation: PlaybackOperation
    ): void {
        const active = this._active_playback_operation;
        if (!this._transmuxer || !active ||
            !isPlaybackOperationRetryRequest(request, sourceOperation) ||
            !isSamePlaybackOperation(active, sourceOperation)) {
            this._transmuxer?.cancelPlaybackOperationRetry(request);
            return;
        }

        const retryOperation = createNextPlaybackAttempt(active, {
            phase: 'adaptive-retry',
            requestedTimeMilliseconds: request.requestedTimeMilliseconds,
        });
        if (!this._activateOwnerRetryAttempt(
            sourceOperation,
            retryOperation,
            request.reason,
            request
        )) {
            this._transmuxer.cancelPlaybackOperationRetry(request);
            this._failOwnerAuthorizedPlaybackRetry(
                this._getOwnerRetryFailureOperation(
                    sourceOperation,
                    retryOperation
                ),
                'adaptive-retry-activation-rejected'
            );
        }
    }

    private _onPlaybackOperationRetryRejected(
        request: PlaybackOperationRetryRequest,
        retryOperation: PlaybackOperation,
        sourceOperation: PlaybackOperation
    ): void {
        if (!isPlaybackOperationRetryRequest(request, sourceOperation) ||
            !isPlaybackOperation(retryOperation) ||
            !this._active_playback_operation ||
            !isSamePlaybackOperation(
                this._active_playback_operation,
                retryOperation
            )) {
            return;
        }
        this._failOwnerAuthorizedPlaybackRetry(
            retryOperation,
            'adaptive-retry-worker-rejected'
        );
    }

    private _failOwnerAuthorizedPlaybackRetry(
        operation: PlaybackOperation,
        reason: string
    ): void {
        Log.e(
            this.TAG,
            `MMTS playback retry failed: kind=${operation.kind}, ` +
            `transaction=${operation.transactionKey}, ` +
            `attempt=${operation.attemptKey}, reason=${reason}`
        );
        if (operation.kind === 'audio-switch') {
            this._failUnifiedMMTSAudioTrackSwitch(operation, reason);
            return;
        }
        if (operation.kind === 'video-switch') {
            this._failUnifiedMMTSVideoTrackSwitch(operation, reason);
            return;
        }
        this._completeScheduledOperation(operation, 'failed', reason);
    }

    private _adoptPlaybackOperation(operation?: PlaybackOperation): boolean {
        if (!this._config.isMMTS) {
            return true;
        }
        return isPlaybackOperation(operation) &&
            !!this._active_playback_operation &&
            isSamePlaybackOperation(operation, this._active_playback_operation);
    }

    private _ensureMMTSSeekOperation(milliseconds: number, phase: string): PlaybackOperation | undefined {
        if (!this._config.isMMTS) {
            return undefined;
        }
        const active = this._active_playback_operation;
        if (active && active.kind === 'seek' && active.requestedTimeMilliseconds != null &&
            Math.abs(active.requestedTimeMilliseconds - milliseconds) < 1) {
            return active;
        }
        return this._beginPlaybackOperation('seek', milliseconds, phase);
    }

    private _onRequestPauseTransmuxer(): void {
        this._transmuxer.pause();
    }

    private _onRequestResumeTransmuxer(): void {
        this._transmuxer.resume();
    }

    private _fillStatisticsInfo(stat_info: any): any {
        stat_info.playerType = 'MSEPlayer';

        if (!(this._media_element instanceof HTMLVideoElement)) {
            return stat_info;
        }

        let has_quality_info = true;
        let decoded = 0;
        let dropped = 0;

        if (this._media_element.getVideoPlaybackQuality) {
            const quality = this._media_element.getVideoPlaybackQuality();
            decoded = quality.totalVideoFrames;
            dropped = quality.droppedVideoFrames;
        } else if (this._media_element['webkitDecodedFrameCount'] != undefined) {
            decoded = this._media_element['webkitDecodedFrameCount'];
            dropped = this._media_element['webkitDroppedFrameCount'];
        } else {
            has_quality_info = false;
        }

        if (has_quality_info) {
            stat_info.decodedFrames = decoded;
            stat_info.droppedFrames = dropped;
        }

        return stat_info;
    }

}

export default PlayerEngineMainThread;

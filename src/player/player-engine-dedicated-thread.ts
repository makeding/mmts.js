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
import * as work from '../utils/webworkify-webpack';
import type PlayerEngine from './player-engine';
import Log from '../utils/logger';
import LoggingControl from '../utils/logging-control.js';
import { applyMediaDataSourceConfig, createDefaultConfig } from '../config';
import MediaInfo from '../core/media-info';
import MSEEvents from '../core/mse-events';
import PlayerEvents from './player-events';
import TransmuxingEvents from '../core/transmuxing-events';
import SeekingHandler from './seeking-handler';
import LoadingController from './loading-controller';
import type { ForwardBufferInfo } from './loading-controller';
import StartupBufferGate from './startup-buffer-gate';
import StartupStallJumper from './startup-stall-jumper';
import LiveLatencyChaser from './live-latency-chaser';
import LiveLatencySynchronizer from './live-latency-synchronizer';
import {
    WorkerCommandPacket,
    WorkerCommandPacketInit,
    WorkerCommandPacketLoggingConfig,
    WorkerCommandPacketTimeUpdate,
    WorkerCommandPacketReadyStateChange,
    WorkerCommandPacketUnbufferedSeek,
    WorkerCommandPacketUserSeek,
    WorkerCommandPacketStartupJump,
    WorkerCommandPacketSwitchAudio,
    WorkerCommandPacketSelectAudioTrack,
    WorkerCommandPacketSelectVideoTrack,
    WorkerCommandPacketInitializeMSE,
    WorkerCommandPacketLoad,
} from './player-engine-worker-cmd-def.js';
import {
    WorkerMessagePacket,
    WorkerMessagePacketBufferedPositionChanged,
    WorkerMessagePacketStartupGroupAppended,
    WorkerMessagePacketLogcatCallback,
    WorkerMessagePacketMSEEvent,
    WorkerMessagePacketMSEInit,
    WorkerMessagePacketPlayerEvent,
    WorkerMessagePacketPlayerEventError,
    WorkerMessagePacketPlayerEventExtraData,
    WorkerMessagePacketTransmuxingEvent,
    WorkerMessagePacketTransmuxingEventInfo,
    WorkerMessagePacketControlledSeek,
    WorkerMessagePacketAudioSwitchReservationsReleased,
    WorkerMessagePacketVideoSwitchReservationsReleased,
    WorkerMessagePacketPlaybackOperationEvent,
} from './player-engine-worker-msg-def.js';
import {
    classifyPlaybackOperationAdvance,
    clonePlaybackOperation,
    createPlaybackOperation,
    createPlaybackScopeId,
    isPlaybackOperation,
    isSamePlaybackAttempt,
    isSamePlaybackOperation,
    isSamePlaybackTransaction,
    rebindReservedPlaybackOperation,
    type PlaybackOperation,
} from '../core/playback-operation';
import PlaybackOperationResultRegistry, {
    type PlaybackOperationEvent,
    type PlaybackOperationResult,
} from './playback-operation-result';
import PlaybackOperationScheduler, {
    type ScheduledPlaybackIntent,
} from './playback-operation-scheduler';
import {findPreferredAudioTrack, isMMTSAudioTrackSelectable} from '../utils/mmts-demuxer-utils';

type DedicatedSeekIntentPayload = {
    type: 'seek',
    targetSeconds: number,
    source: string,
    command: 'user_seek' | 'unbuffered_seek',
};

type DedicatedAudioSwitchIntentPayload = {
    type: 'audio-switch',
    packetId: number,
    recoveryOperation: PlaybackOperation,
};

type DedicatedVideoSwitchIntentPayload = {
    type: 'video-switch',
    packetId: number,
    recoveryOperation: PlaybackOperation,
};

type DedicatedInteractiveIntentPayload =
    DedicatedSeekIntentPayload | DedicatedAudioSwitchIntentPayload | DedicatedVideoSwitchIntentPayload;

type PendingDedicatedSeekRequest = {
    operation: PlaybackOperation,
    targetSeconds: number,
    source: string,
    command: 'user_seek' | 'unbuffered_seek',
};

class PlayerEngineDedicatedThread implements PlayerEngine {

    private readonly TAG: string = 'PlayerEngineDedicatedThread';

    private _emitter: EventEmitter = new EventEmitter();
    private _media_data_source: any;
    private _config: any;

    private _media_element?: HTMLMediaElement = null;

    private _worker: Worker;
    private _worker_destroying: boolean = false;

    private _seeking_handler?: SeekingHandler = null;
    private _loading_controller?: LoadingController = null;
    private _startup_buffer_gate?: StartupBufferGate = null;
    private _startup_stall_jumper?: StartupStallJumper = null;
    private _live_latency_chaser?: LiveLatencyChaser = null;
    private _live_latency_synchronizer?: LiveLatencySynchronizer = null;

    private _pending_seek_time?: number = null;
    private _audio_track_switch_buffer_target?: number = null;
    private _selected_mmts_audio_packet_id?: number = null;
    private _desired_mmts_audio_packet_id?: number = null;
    private _mmts_audio_tracks: any[] = [];
    private _selected_mmts_video_packet_id?: number = null;
    private _desired_mmts_video_packet_id?: number = null;
    private _mmts_video_tracks: any[] = [];
    private _worker_forward_buffer_info?: ForwardBufferInfo = null;
    private _last_mse_buffer_full_log_time: number = 0;
    private _resume_after_audio_track_switch_rebuild?: boolean = null;
    private _playback_scope_id: string;
    private _playback_timeline_generation: number = 0;
    private _playback_transaction_id: number = 0;
    private _active_playback_operation?: PlaybackOperation = null;
    private _operation_results: PlaybackOperationResultRegistry;
    private _operation_scheduler: PlaybackOperationScheduler<DedicatedInteractiveIntentPayload> =
        new PlaybackOperationScheduler<DedicatedInteractiveIntentPayload>();
    private _pending_mmts_seek?: PendingDedicatedSeekRequest = null;
    private _pending_mmts_seek_timer?: any = null;

    private _media_info?: MediaInfo = null;
    private _statistics_info?: any = null;

    private e?: any = null;

    private _prev_ready_state = 0;
    private _prev_ready_state_current_time = NaN;

    public static isSupported(): boolean {
        if (!self.Worker) {
            return false;
        }
        if (self.MediaSource &&
            ('canConstructInDedicatedWorker' in self.MediaSource) &&
            (self.MediaSource['canConstructInDedicatedWorker'] === true)) {
            return true;
        }
        if ((self as any).ManagedMediaSource &&
            ('canConstructInDedicatedWorker' in (self as any).ManagedMediaSource) &&
            ((self as any).ManagedMediaSource['canConstructInDedicatedWorker'] === true)) {
            return true;
        }
        return false;
    }

    public constructor(mediaDataSource: any, config: any) {
        this._media_data_source = mediaDataSource;
        this._config = createDefaultConfig();

        if (typeof config === 'object') {
            Object.assign(this._config, config);
        }

        applyMediaDataSourceConfig(this._config, mediaDataSource, config);

        this._playback_scope_id = createPlaybackScopeId('mmts-dedicated-main');
        this._operation_results = new PlaybackOperationResultRegistry((event) => {
            this._emitter.emit(PlayerEvents.MMTS_OPERATION_STATE, event);
            if (event.terminal) {
                this._emitter.emit(PlayerEvents.MMTS_OPERATION_RESULT, event);
            }
        });

        this.e = {
            onLoggingConfigChanged: this._onLoggingConfigChanged.bind(this),
            onMediaLoadedMetadata: this._onMediaLoadedMetadata.bind(this),
            onMediaTimeUpdate: this._onMediaTimeUpdate.bind(this),
            onMediaReadyStateChanged: this._onMediaReadyStateChange.bind(this),
        };

        LoggingControl.registerListener(this.e.onLoggingConfigChanged);

        this._worker = work(require.resolve('./player-engine-worker'), {all: true}) as Worker;
        this._worker.addEventListener('message', this._onWorkerMessage.bind(this));

        this._worker.postMessage({
            cmd: 'init',
            media_data_source: this._media_data_source,
            config: this._config
        } as WorkerCommandPacketInit);

        this._worker.postMessage({
            cmd: 'logging_config',
            logging_config: LoggingControl.getConfig()
        } as WorkerCommandPacketLoggingConfig);
    }

    public destroy(): void {
        this._emitter.emit(PlayerEvents.DESTROYING);
        this.unload();
        this.detachMediaElement();

        this._worker_destroying = true;
        this._worker.postMessage({
            cmd: 'destroy'
        } as WorkerCommandPacket);

        LoggingControl.removeListener(this.e.onLoggingConfigChanged);
        this.e = null;
        this._media_data_source = null;
        this._cancelPendingMMTSSeek('player-destroyed');
        this._settleAndClearScheduledOperations('cancelled', 'player-destroyed');
        this._operation_results.destroy('player-destroyed');

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
        this._media_element.src = '';
        this._media_element.removeAttribute('src');
        this._media_element.srcObject = null;
        this._media_element.load();

        this._media_element.addEventListener('loadedmetadata', this.e.onMediaLoadedMetadata);
        this._media_element.addEventListener('timeupdate', this.e.onMediaTimeUpdate);
        this._media_element.addEventListener('emptied', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('ended', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('waiting', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('canplay', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('canplaythrough', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('loadstart', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('loadeddata', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('loadedmetadata', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('progress', this.e.onMediaReadyStateChanged);
        this._media_element.addEventListener('stalled', this.e.onMediaReadyStateChanged);

        const startupOperation = this._config.isMMTS ?
            (this._active_playback_operation ||
                this._beginPlaybackOperation('startup', 0, 'initialize-mse')) : undefined;
        this._worker.postMessage({
            cmd: 'initialize_mse',
            playback_operation: startupOperation,
        } as WorkerCommandPacketInitializeMSE)

        // Then wait for 'mse_init' message from worker to receive MediaSource handle
    }

    public detachMediaElement(): void {
        this._cancelPendingMMTSSeek('media-detached');
        this._settleAndClearScheduledOperations('cancelled', 'media-detached');
        this._active_playback_operation = null;
        this._resume_after_audio_track_switch_rebuild = null;
        this._worker.postMessage({
            cmd: 'shutdown_mse',
        });

        if (this._media_element) {
            // Remove all appended event listeners
            this._media_element.removeEventListener('loadedmetadata', this.e.onMediaLoadedMetadata);
            this._media_element.removeEventListener('timeupdate', this.e.onMediaTimeUpdate);
            this._media_element.removeEventListener('emptied', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('ended', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('waiting', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('canplay', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('canplaythrough', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('loadstart', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('loadeddata', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('loadedmetadata', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('progress', this.e.onMediaReadyStateChanged);
            this._media_element.removeEventListener('stalled', this.e.onMediaReadyStateChanged);

            // Detach media source from media element
            this._media_element.src = '';
            this._media_element.removeAttribute('src');
            this._media_element.srcObject = null;
            this._media_element.load();
            this._media_element = null;
        }
    }

    public load(): void {
        const startupOperation = this._config.isMMTS ?
            (this._active_playback_operation ||
                this._beginPlaybackOperation('startup', 0, 'loading')) : undefined;
        this._worker.postMessage({
            cmd: 'load',
            playback_operation: startupOperation,
        } as WorkerCommandPacketLoad);

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
            () => this._worker_forward_buffer_info
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
            this._onContinuousBufferStall.bind(this)
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
            if (this._config.isMMTS) {
                this._onControlledSeekRequest(0, 'initial');
            } else {
                this._seeking_handler.directSeek(0);
            }
        }
    }

    public unload(): void {
        this._media_element?.pause();
        this._cancelPendingMMTSSeek('player-unloaded');
        this._settleAndClearScheduledOperations('cancelled', 'player-unloaded');
        this._active_playback_operation = null;
        this._selected_mmts_audio_packet_id = null;
        this._desired_mmts_audio_packet_id = null;
        this._mmts_audio_tracks = [];
        this._selected_mmts_video_packet_id = null;
        this._desired_mmts_video_packet_id = null;
        this._mmts_video_tracks = [];

        this._worker.postMessage({
            cmd: 'unload',
        } as WorkerCommandPacket);

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
        this._worker_forward_buffer_info = null;
        this._resume_after_audio_track_switch_rebuild = null;

        this._seeking_handler?.destroy();
        this._seeking_handler = null;
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
            return this._requestLatestMMTSSeek(seconds, 'api', 'user_seek');
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
        const targetPacketId = this._getMMTSAudioTrackTarget('primary');
        if (this._config.isMMTS) {
            return this._requestMMTSAudioTrackSwitch(targetPacketId);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginAudioTrackSwitchBufferCatchup(timelineSeed / 1000);
        this._worker.postMessage({
            cmd: 'switch_audio',
            audio_track: 'primary',
            timeline_seed: timelineSeed,
            rebuild_from_seek: false,
        } as WorkerCommandPacketSwitchAudio);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, undefined, 'committed', 'legacy-audio-switch-submitted'
        );
    }

    public switchSecondaryAudio(): Promise<PlaybackOperationResult> {
        const targetPacketId = this._getMMTSAudioTrackTarget('secondary');
        if (this._config.isMMTS) {
            return this._requestMMTSAudioTrackSwitch(targetPacketId);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginAudioTrackSwitchBufferCatchup(timelineSeed / 1000);
        this._worker.postMessage({
            cmd: 'switch_audio',
            audio_track: 'secondary',
            timeline_seed: timelineSeed,
            rebuild_from_seek: false,
        } as WorkerCommandPacketSwitchAudio);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, undefined, 'committed', 'legacy-audio-switch-submitted'
        );
    }

    public selectAudioTrack(packetId: number): Promise<PlaybackOperationResult> {
        const requestedTime = this._currentPlaybackTimeMilliseconds();
        if (!Number.isInteger(packetId) || packetId < 0) {
            return this._createRejectedOperationResult(
                'audio-switch', requestedTime, undefined, 'invalid-audio-packet-id'
            );
        }
        if (this._config.isMMTS) {
            return this._requestMMTSAudioTrackSwitch(packetId);
        }
        const timelineSeed = this._getAudioTrackSwitchTimelineSeed();
        this._beginAudioTrackSwitchBufferCatchup(timelineSeed / 1000);
        this._worker.postMessage({
            cmd: 'select_audio_track',
            packet_id: packetId,
            timeline_seed: timelineSeed,
            rebuild_from_seek: false,
        } as WorkerCommandPacketSelectAudioTrack);
        return this._createImmediateOperationResult(
            'audio-switch', timelineSeed, packetId, 'committed', 'legacy-audio-switch-submitted',
            {committedPacketId: packetId}
        );
    }

    public selectVideoTrack(packetId: number): Promise<PlaybackOperationResult> {
        const requestedTime = this._currentPlaybackTimeMilliseconds();
        if (!Number.isInteger(packetId) || packetId < 0) {
            return this._createRejectedOperationResult(
                'video-switch', requestedTime, undefined, 'invalid-video-packet-id'
            );
        }
        if (!this._config.isMMTS) {
            this._worker.postMessage({
                cmd: 'select_video_track',
                packet_id: packetId,
            } as WorkerCommandPacketSelectVideoTrack);
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
                'video-switch', requestedTime, packetId, 'no-op', 'already-selected',
                {committedPacketId: packetId}
            );
        }
        const operation = this._reservePlaybackOperation(
            'video-switch', requestedTime, packetId, 'queued'
        );
        const recoveryOperation = this._reservePlaybackOperation(
            'video-switch', requestedTime, this._selected_mmts_video_packet_id,
            'recovery-reserved'
        );
        return this._scheduleInteractiveOperation({
            operation,
            payload: {
                type: 'video-switch',
                packetId,
                recoveryOperation,
            },
        });
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

    private _isMMTSVodAudioTrackSwitch(): boolean {
        return this._config.isMMTS === true && this._config.isLive !== true;
    }

    private _getAudioTrackSwitchPrerollTime(): number {
        return 0.5;
    }

    private _currentPlaybackTimeMilliseconds(): number {
        return this._media_element ? Math.max(0, this._media_element.currentTime * 1000) : 0;
    }

    private _getMMTSAudioTrackTarget(action: 'primary' | 'secondary'): number | undefined {
        if (!Array.isArray(this._mmts_audio_tracks) || this._mmts_audio_tracks.length === 0) {
            return undefined;
        }
        if (action === 'primary') {
            const primary = findPreferredAudioTrack(this._mmts_audio_tracks, false);
            return primary && isMMTSAudioTrackSelectable(primary) ? primary.packetId : undefined;
        }
        const tracks = this._mmts_audio_tracks.slice()
            .sort((left, right) => left.packetId - right.packetId)
            .filter((track) => isMMTSAudioTrackSelectable(track));
        const index = tracks.findIndex((track) =>
            track.packetId === this._selected_mmts_audio_packet_id
        );
        return tracks.length > 0 ?
            tracks[index >= 0 ? (index + 1) % tracks.length : 0].packetId : undefined;
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
        if (!this._worker_forward_buffer_info) {
            return 0;
        }
        return this._worker_forward_buffer_info.forwardDuration || 0;
    }

    private _getStallJumpMaxGap(): number | undefined {
        return this._config.isMMTS ? 5 : undefined;
    }

    private _getStallJumpMinBuffer(): number | undefined {
        return this._media_data_source && this._media_data_source.type === 'mmts' ? 1 : undefined;
    }

    private _allowStallJumperRangeGapJump(): boolean {
        return true;
    }

    private _beginAudioTrackSwitchBufferCatchup(switchTime: number): void {
        if (!this._config.lazyLoad || (this._config.isLive && !this._config.lazyLoadOnLive)) {
            this._audio_track_switch_buffer_target = null;
            return;
        }

        const maxDuration = this._config.lazyLoadMaxDuration;
        if (typeof maxDuration !== 'number' || !isFinite(maxDuration) || maxDuration <= 0) {
            this._audio_track_switch_buffer_target = null;
            return;
        }

        this._audio_track_switch_buffer_target = switchTime + maxDuration;
    }

    private _updateAudioTrackSwitchBufferCatchup(bufferedPosition: number): void {
        if (this._audio_track_switch_buffer_target == null) {
            return;
        }

        if (isFinite(bufferedPosition) && bufferedPosition >= this._audio_track_switch_buffer_target) {
            this._audio_track_switch_buffer_target = null;
        }
    }

    public _onLoggingConfigChanged(config: any): void {
        this._worker?.postMessage({
            cmd: 'logging_config',
            logging_config: config,
        } as WorkerCommandPacketLoggingConfig);
    }

    private _onMSEUpdateEnd(): void {
        if (this._config.isLive && this._config.liveBufferLatencyChasing && this._live_latency_chaser) {
            this._live_latency_chaser.notifyBufferedRangeUpdate();
        }

        this._startup_buffer_gate?.notifyBufferedRangeUpdate();

        if (this._audio_track_switch_buffer_target == null) {
            this._loading_controller.notifyBufferedPositionChanged();
        }
    }

    private _onMSEBufferFull(): void {
        this._logMSEBufferFull();
        if (this._config.isMMTS) {
            return;
        }
        this._loading_controller.suspendTransmuxerUntilRecover();
    }

    private _logMSEBufferFull(): void {
        const now = Date.now();
        if (now - this._last_mse_buffer_full_log_time < 30000) {
            return;
        }
        this._last_mse_buffer_full_log_time = now;
        Log.v(this.TAG, 'MSE SourceBuffer is full, suspend transmuxing task');
    }

    private _onMediaLoadedMetadata(e: any): void {
        if (this._pending_mmts_seek) {
            // Preserve the transaction created before metadata became
            // available. Creating another seek here would orphan its Promise.
            this._pending_seek_time = null;
            this._schedulePendingMMTSSeek(0);
            return;
        }
        if (this._pending_seek_time != null) {
            this._seeking_handler.seek(this._pending_seek_time);
            this._pending_seek_time = null;
        }
    }

    private _onRequestDirectSeek(target: number): boolean {
        this._worker.postMessage({
            cmd: 'startup_jump',
            target_time: target,
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacketStartupJump);
        return !this._config.isMMTS;
    }

    private _onControlledSeekRequest(target: number, source: string): boolean {
        if (!this._config.isMMTS || this._config.isLive === true) {
            return false;
        }
        if (source !== 'initial' && this._seeking_handler?.isPositionBuffered(target)) {
            return false;
        }
        void this._requestLatestMMTSSeek(target, source, 'user_seek');
        return true;
    }

    private _onRequiredUnbufferedSeek(milliseconds: number): void {
        if (this._config.isLive || typeof milliseconds !== 'number' ||
            !isFinite(milliseconds) || milliseconds < 0) {
            return;
        }
        void this._requestLatestMMTSSeek(
            milliseconds / 1000,
            'unbuffered',
            'unbuffered_seek'
        );
    }

    private _cancelMMTSAudioTrackSwitchResumeForSeek(): void {
        if (this._config.isMMTS && !this._config.isLive) {
            this._resume_after_audio_track_switch_rebuild = null;
        }
    }

    private _onRequestPauseTransmuxer(): void {
        this._worker.postMessage({
            cmd: 'pause_transmuxer',
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacket);
    }

    private _onRequestResumeTransmuxer(): void {
        this._worker.postMessage({
            cmd: 'resume_transmuxer',
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacket);
    }

    private _onContinuousBufferStall(): void {
        this._worker.postMessage({
            cmd: 'continuous_buffer_stall',
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacket);
    }

    private _onMediaTimeUpdate(e: any): void {
        this._worker.postMessage({
            cmd: 'timeupdate',
            current_time: e.target.currentTime,
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacketTimeUpdate);
    }

    private _onMediaReadyStateChange(e?: Event): void {
        if (this._media_element == null) {
            return;
        }

        const readyState = this._media_element.readyState;
        const currentTime = this._media_element.currentTime;
        const forceNotify = e != null && (e.type === 'waiting' || e.type === 'stalled');
        if (!forceNotify &&
            this._prev_ready_state === readyState &&
            Math.abs(this._prev_ready_state_current_time - currentTime) < 0.25) {
            return;
        }

        this._prev_ready_state = readyState;
        this._prev_ready_state_current_time = currentTime;
        this._worker.postMessage({
            cmd: 'readystatechange',
            ready_state: readyState,
            current_time: currentTime,
            event_type: e ? e.type : 'readystatechange',
            playback_operation: this._active_playback_operation,
        } as WorkerCommandPacketReadyStateChange);
    }

    private _onWorkerMessage(e: MessageEvent): void {
        const message_packet = e.data as WorkerMessagePacket;
        const msg = message_packet.msg;

        if (msg == 'destroyed' || this._worker_destroying) {
            this._worker_destroying = false;
            this._worker?.terminate();
            this._worker = null;
            return;
        }
        if (msg === 'playback_operation_event') {
            const packet = message_packet as WorkerMessagePacketPlaybackOperationEvent;
            const event = packet.event as PlaybackOperationEvent;
            // A locally cancelled/superseded transaction is removed from the
            // registry. Ignore any late Worker event instead of resurrecting it.
            if (!event || !isPlaybackOperation(event.operation) ||
                event.operation.scopeId !== this._playback_scope_id ||
                !this._operation_results.has(event.transactionKey) ||
                !this._operation_results.acceptExternal(event)) {
                return;
            }
            if (!event.terminal) {
                const scheduled = this._operation_scheduler.active;
                if (scheduled && isSamePlaybackTransaction(scheduled.operation, event.operation) &&
                    event.operation.attempt > scheduled.operation.attempt) {
                    this._operation_scheduler.adoptAttempt(event.operation);
                }
                if (this._isExpectedWorkerOperation(event.operation)) {
                    this._active_playback_operation = clonePlaybackOperation(event.operation);
                }
                return;
            }
            if (event.status === 'failed') {
                if (event.kind === 'audio-switch') {
                    this._desired_mmts_audio_packet_id = event.committedPacketId ??
                        this._selected_mmts_audio_packet_id;
                } else if (event.kind === 'video-switch') {
                    this._desired_mmts_video_packet_id = event.committedPacketId ??
                        this._selected_mmts_video_packet_id;
                }
            }
            const recoverPlayback = event.status === 'failed' &&
                (event.kind === 'audio-switch' || event.kind === 'video-switch') &&
                /recovery-(?:failed|reservation-missing)/.test(event.reason || '');
            this._completeScheduledOperation(event.operation);
            if (recoverPlayback && !this._config.isLive && this._media_element &&
                !this._media_element.error) {
                const targetTime = Math.max(
                    this._media_element.currentTime || 0,
                    event.operation.requestedTimeMilliseconds / 1000
                );
                void this._requestLatestMMTSSeek(
                    targetTime,
                    `${event.kind}-recovery`,
                    'user_seek'
                );
            }
            return;
        }
        if (msg === 'playback_operation_started') {
            const operation = message_packet.playback_operation;
            if (!isPlaybackOperation(operation) || !this._isExpectedWorkerOperation(operation)) {
                return;
            }
            this._active_playback_operation = clonePlaybackOperation(operation);
            const scheduled = this._operation_scheduler.active;
            if (scheduled && isSamePlaybackTransaction(scheduled.operation, operation) &&
                operation.attempt > scheduled.operation.attempt) {
                this._operation_scheduler.adoptAttempt(operation);
                this._operation_results.adoptAttempt(operation, 'worker-operation-started');
            }
            this._playback_timeline_generation = Math.max(
                this._playback_timeline_generation, operation.timelineGeneration
            );
            this._playback_transaction_id = Math.max(
                this._playback_transaction_id, operation.transactionId
            );
            return;
        }
        if (msg === 'audio_switch_reservations_released' ||
            msg === 'video_switch_reservations_released') {
            // Reservation lifetime is owned by the scheduler on this thread.
            // These messages are retained for wire compatibility with older workers.
            return;
        }
        if (msg !== 'logcat_callback' &&
            !this._acceptPlaybackOperation(message_packet.playback_operation)) {
            return;
        }

        switch (msg) {
            case 'mse_init': {
                const packet = message_packet as WorkerMessagePacketMSEInit;
                if (packet.rebuild) {
                    this._resume_after_audio_track_switch_rebuild = !!this._media_element &&
                        !this._media_element.paused && !this._media_element.ended;
                }
                // Use ManagedMediaSource only if w3c MediaSource is not available (e.g. iOS Safari)
                const use_managed_media_source = ('ManagedMediaSource' in self) && !('MediaSource' in self);
                if (use_managed_media_source) {
                    // When using ManagedMediaSource, MediaSource will not open unless disableRemotePlayback is set to true
                    this._media_element['disableRemotePlayback'] = true;
                }
                // Attach to HTMLMediaElement by using MediaSource Handle
                this._media_element.srcObject = packet.handle;
                break;
            }
            case 'mse_event': {
                const packet = message_packet as WorkerMessagePacketMSEEvent;
                if (packet.forward_buffer_info) {
                    this._worker_forward_buffer_info = packet.forward_buffer_info;
                }
                if (packet.event == MSEEvents.UPDATE_END) {
                    this._onMSEUpdateEnd();
                } else if (packet.event == MSEEvents.BUFFER_FULL) {
                    this._onMSEBufferFull();
                }
                break;
            }
            case 'transmuxing_event': {
                const packet = message_packet as WorkerMessagePacketTransmuxingEvent;
                if (packet.event == TransmuxingEvents.MEDIA_INFO) {
                    const packet = message_packet as WorkerMessagePacketTransmuxingEventInfo;
                    this._media_info = packet.info;
                    this._emitter.emit(PlayerEvents.MEDIA_INFO, Object.assign({}, packet.info));
                } else if (packet.event == TransmuxingEvents.STATISTICS_INFO) {
                    const packet = message_packet as WorkerMessagePacketTransmuxingEventInfo;
                    this._statistics_info = this._fillStatisticsInfo(packet.info);
                    this._emitter.emit(PlayerEvents.STATISTICS_INFO, Object.assign({}, packet.info));
                } else if (packet.event == TransmuxingEvents.RECOMMEND_SEEKPOINT) {
                    break;
                }
                break;
            }
            case 'player_event': {
                const packet = message_packet as WorkerMessagePacketPlayerEvent;
                if (packet.event == PlayerEvents.ERROR) {
                    const packet = message_packet as WorkerMessagePacketPlayerEventError;
                    this._emitter.emit(PlayerEvents.ERROR, packet.error_type, packet.error_detail, packet.info);
                } else if ('extraData' in packet) {
                    const packet = message_packet as WorkerMessagePacketPlayerEventExtraData;
                    if (packet.event === PlayerEvents.MMTS_AUDIO_TRACKS) {
                        this._selected_mmts_audio_packet_id = packet.extraData && packet.extraData.selectedPacketId;
                        this._mmts_audio_tracks = packet.extraData && Array.isArray(packet.extraData.tracks) ?
                            packet.extraData.tracks.slice() : [];
                    } else if (packet.event === PlayerEvents.MMTS_VIDEO_TRACKS) {
                        this._selected_mmts_video_packet_id = packet.extraData &&
                            packet.extraData.selectedPacketId;
                        this._mmts_video_tracks = packet.extraData &&
                            Array.isArray(packet.extraData.tracks) ?
                                packet.extraData.tracks.slice() : [];
                    }
                    this._emitter.emit(packet.event, packet.extraData);
                }
                break;
            }
            case 'logcat_callback': {
                const packet = message_packet as WorkerMessagePacketLogcatCallback;
                Log.emitter.emit('log', packet.type, packet.logcat);
                break;
            }
            case 'buffered_position_changed': {
                const packet = message_packet as WorkerMessagePacketBufferedPositionChanged;
                if (packet.forward_buffer_info) {
                    this._worker_forward_buffer_info = packet.forward_buffer_info;
                }
                const bufferedPosition = packet.buffered_position_milliseconds / 1000;
                this._updateAudioTrackSwitchBufferCatchup(bufferedPosition);
                this._loading_controller.notifyBufferedPositionChanged(bufferedPosition);
                break;
            }
            case 'startup_group_appended': {
                const packet = message_packet as WorkerMessagePacketStartupGroupAppended;
                this._startup_buffer_gate?.releaseStartupGroup();
                Log.v(this.TAG, `Append MMTS startup group at ${packet.startup_time.toFixed(3)}s`);
                break;
            }
            case 'controlled_seek': {
                const packet = message_packet as WorkerMessagePacketControlledSeek;
                if (this._media_element) {
                    this._seeking_handler?.directSeek(packet.target_time);
                    if (packet.reason === 'AUDIO_TRACK_SWITCH_REBUILD') {
                        const resumePlayback = this._resume_after_audio_track_switch_rebuild === true;
                        this._resume_after_audio_track_switch_rebuild = null;
                        if (resumePlayback) {
                            const playPromise = this._media_element.play();
                            if (playPromise && typeof playPromise.catch === 'function') {
                                playPromise.catch((error) => {
                                    Log.w(this.TAG, `Failed to resume after audio track switch rebuild: ${error.message}`);
                                });
                            }
                        }
                    }
                }
                break;
            }
        }
    }

    private _requestMMTSAudioTrackSwitch(
        targetPacketId?: number
    ): Promise<PlaybackOperationResult> {
        const requestedTime = this._config.isLive ?
            this._getAudioTrackSwitchTimelineSeed() :
            (this._media_element ? Math.max(0, this._media_element.currentTime * 1000) : 0);
        if (targetPacketId === undefined) {
            return this._createRejectedOperationResult(
                'audio-switch', requestedTime, undefined, 'audio-track-unavailable'
            );
        }
        const targetTrack = this._mmts_audio_tracks.find((track) =>
            track && track.packetId === targetPacketId
        );
        if (!targetTrack || !isMMTSAudioTrackSelectable(targetTrack)) {
            return this._createRejectedOperationResult(
                'audio-switch', requestedTime, targetPacketId, 'audio-track-unavailable'
            );
        }
        this._desired_mmts_audio_packet_id = targetPacketId;
        if (this._selected_mmts_audio_packet_id === targetPacketId &&
            !this._operation_scheduler.active && this._operation_scheduler.queued.length === 0) {
            return this._createImmediateOperationResult(
                'audio-switch', requestedTime, targetPacketId, 'no-op', 'already-selected',
                {committedPacketId: targetPacketId}
            );
        }
        const priorPacketId = this._selected_mmts_audio_packet_id == null ?
            targetPacketId : this._selected_mmts_audio_packet_id;
        const operation = this._reservePlaybackOperation(
            'audio-switch', requestedTime, targetPacketId, 'requested'
        );
        const recoveryOperation = this._reservePlaybackOperation(
            'audio-switch', requestedTime, priorPacketId, 'recovery-reserved'
        );
        return this._scheduleInteractiveOperation({
            operation,
            payload: {
                type: 'audio-switch',
                packetId: targetPacketId,
                recoveryOperation,
            },
        });
    }

    private _requestLatestMMTSSeek(
        targetSeconds: number,
        source: string,
        command: 'user_seek' | 'unbuffered_seek'
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
        this._pending_mmts_seek = {operation, targetSeconds, source, command};
        if (!this._media_element || !this._seeking_handler) {
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
                    command: pending.command,
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
        intent: ScheduledPlaybackIntent<DedicatedInteractiveIntentPayload>,
        alreadyRegistered: boolean = false
    ): Promise<PlaybackOperationResult> {
        const result = this._operation_scheduler.request(intent);
        if (result.type === 'duplicate') {
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
                {reason: result.type === 'activate' ?
                    'timeline-owner-acquired' : 'waiting-for-timeline-owner'}
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
        intent: ScheduledPlaybackIntent<DedicatedInteractiveIntentPayload>,
        reason: string
    ): void {
        this._operation_results.settle(
            intent.operation,
            intent.operation.kind === 'seek' ? 'superseded' : 'cancelled',
            {reason}
        );
        this._cancelMMTSAudioTrackSwitchResumeForSeek();
    }

    private _startScheduledInteractiveOperation(
        intent: ScheduledPlaybackIntent<DedicatedInteractiveIntentPayload>
    ): void {
        const payload = intent.payload;
        if (payload.type === 'seek') {
            const operation = rebindReservedPlaybackOperation(intent.operation, {
                phase: 'requested',
                requestedTimeMilliseconds: payload.targetSeconds * 1000,
            });
            if (!this._operation_results.replaceReservation(operation)) {
                this._operation_results.settle(intent.operation, 'failed', {
                    reason: 'seek-result-reservation-rebind-rejected',
                });
                this._completeScheduledOperation(intent.operation);
                return;
            }
            if (!this._operation_scheduler.replaceActiveReservation(operation)) {
                this._operation_results.settle(operation, 'failed', {
                    reason: 'seek-scheduler-reservation-rebind-rejected',
                });
                this._completeScheduledOperation(operation);
                return;
            }
            this._operation_results.publish(operation, 'running', {reason: 'seek-started'});
            this._active_playback_operation = clonePlaybackOperation(operation);
            this._cancelMMTSAudioTrackSwitchResumeForSeek();
            if (payload.command === 'unbuffered_seek') {
                this._worker.postMessage({
                    cmd: 'unbuffered_seek',
                    milliseconds: operation.requestedTimeMilliseconds,
                    playback_operation: operation,
                } as WorkerCommandPacketUnbufferedSeek);
            } else {
                this._worker.postMessage({
                    cmd: 'user_seek',
                    target_time: payload.targetSeconds,
                    source: payload.source,
                    playback_operation: operation,
                } as WorkerCommandPacketUserSeek);
            }
            return;
        }

        const nowMilliseconds = this._config.isLive ?
            this._getAudioTrackSwitchTimelineSeed() :
            (this._media_element ? Math.max(0, this._media_element.currentTime * 1000) :
                intent.operation.requestedTimeMilliseconds);
        const operation = rebindReservedPlaybackOperation(intent.operation, {
            phase: 'requested',
            requestedTimeMilliseconds: nowMilliseconds,
            packetId: payload.packetId,
        });
        const recoveryPacketId = payload.recoveryOperation.packetId;
        const recoveryOperation = rebindReservedPlaybackOperation(payload.recoveryOperation, {
            phase: 'recovery-reserved',
            requestedTimeMilliseconds: nowMilliseconds,
            packetId: recoveryPacketId,
        });
        if (!this._operation_results.replaceReservation(operation)) {
            this._operation_results.settle(intent.operation, 'failed', {
                reason: `${payload.type}-result-reservation-rebind-rejected`,
            });
            this._completeScheduledOperation(intent.operation);
            return;
        }
        if (!this._operation_scheduler.replaceActiveReservation(operation)) {
            this._operation_results.settle(operation, 'failed', {
                reason: `${payload.type}-scheduler-reservation-rebind-rejected`,
            });
            this._completeScheduledOperation(operation);
            return;
        }
        this._operation_results.publish(operation, 'running', {
            reason: `${payload.type}-started`,
        });
        this._active_playback_operation = clonePlaybackOperation(operation);

        if (payload.type === 'audio-switch') {
            const rebuildFromSeek = this._isMMTSVodAudioTrackSwitch();
            if (!rebuildFromSeek) {
                this._beginAudioTrackSwitchBufferCatchup(nowMilliseconds / 1000);
            }
            this._worker.postMessage({
                cmd: 'select_audio_track',
                packet_id: payload.packetId,
                timeline_seed: nowMilliseconds,
                rebuild_from_seek: rebuildFromSeek,
                playback_operation: operation,
                recovery_playback_operation: recoveryOperation,
            } as WorkerCommandPacketSelectAudioTrack);
            return;
        }

        this._worker.postMessage({
            cmd: 'select_video_track',
            packet_id: payload.packetId,
            playback_operation: operation,
            recovery_playback_operation: recoveryOperation,
        } as WorkerCommandPacketSelectVideoTrack);
    }

    private _completeScheduledOperation(operation: PlaybackOperation): void {
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

    private _ensureDesiredMMTSTrackState(): void {
        if (!this._config.isMMTS || this._operation_scheduler.active) return;
        const desiredAudio = this._desired_mmts_audio_packet_id;
        if (desiredAudio != null && desiredAudio !== this._selected_mmts_audio_packet_id &&
            this._mmts_audio_tracks.some((track) => track && track.packetId === desiredAudio &&
                isMMTSAudioTrackSelectable(track))) {
            void this.selectAudioTrack(desiredAudio);
        }
        const desiredVideo = this._desired_mmts_video_packet_id;
        if (desiredVideo != null && desiredVideo !== this._selected_mmts_video_packet_id &&
            this._mmts_video_tracks.some((track) => track && track.packetId === desiredVideo)) {
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
        this._active_playback_operation = clonePlaybackOperation(operation);
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

    private _isExpectedWorkerOperation(operation: PlaybackOperation): boolean {
        if (!isPlaybackOperation(operation) || operation.scopeId !== this._playback_scope_id) {
            return false;
        }
        const scheduled = this._operation_scheduler.active;
        if (!scheduled) {
            return !!this._active_playback_operation &&
                isSamePlaybackTransaction(this._active_playback_operation, operation);
        }
        if (isSamePlaybackTransaction(scheduled.operation, operation)) {
            return true;
        }
        const payload = scheduled.payload;
        return payload.type !== 'seek' &&
            isSamePlaybackTransaction(payload.recoveryOperation, operation);
    }

    private _acceptPlaybackOperation(operation?: PlaybackOperation): boolean {
        if (!this._config.isMMTS) {
            return true;
        }
        if (!isPlaybackOperation(operation) || !this._isExpectedWorkerOperation(operation)) {
            return false;
        }
        const active = this._active_playback_operation;
        if (!active) {
            this._active_playback_operation = clonePlaybackOperation(operation);
            return true;
        }
        if (isSamePlaybackAttempt(operation, active)) {
            return true;
        }
        const scheduled = this._operation_scheduler.active;
        if (scheduled && scheduled.payload.type !== 'seek' &&
            isSamePlaybackTransaction(scheduled.payload.recoveryOperation, operation)) {
            this._active_playback_operation = clonePlaybackOperation(operation);
            return true;
        }
        const advance = classifyPlaybackOperationAdvance(active, operation);
        if (!advance.accepted || advance.kind !== 'next-attempt') {
            return false;
        }
        this._active_playback_operation = clonePlaybackOperation(operation);
        this._operation_scheduler.adoptAttempt(operation);
        this._operation_results.adoptAttempt(operation, 'worker-attempt-adopted');
        return true;
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

export default PlayerEngineDedicatedThread;

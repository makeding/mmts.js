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
import Log from '../utils/logger';
import LoggingControl from '../utils/logging-control';
import { IllegalStateException } from '../utils/exception';
import MediaInfo from '../core/media-info';
import MSEEvents from '../core/mse-events';
import MSEController from '../core/mse-controller';
import Transmuxer from "../core/transmuxer";
import TransmuxingEvents from '../core/transmuxing-events';
import PlayerEvents from './player-events';
import { ErrorTypes } from './player-errors';
import MSEBufferStateMachine from './mse-buffer-state-machine';
import { findPreferredAudioTrack, isMMTSAudioTrackSelectable } from '../utils/mmts-demuxer-utils';
import {
    WorkerCommandPacket,
    WorkerCommandPacketInit,
    WorkerCommandPacketLoggingConfig,
    WorkerCommandPacketUnbufferedSeek,
    WorkerCommandPacketUserSeek,
    WorkerCommandPacketStartupJump,
    WorkerCommandPacketTimeUpdate,
    WorkerCommandPacketReadyStateChange,
    WorkerCommandPacketSwitchAudio,
    WorkerCommandPacketSelectAudioTrack,
    WorkerCommandPacketSelectVideoTrack,
    WorkerCommandPacketInitializeMSE,
    WorkerCommandPacketLoad,
} from './player-engine-worker-cmd-def.js';
import {
    WorkerMessagePacket,
    WorkerMessagePacketMSEInit,
    WorkerMessagePacketMSEEvent,
    WorkerMessagePacketPlayerEvent,
    WorkerMessagePacketPlayerEventError,
    WorkerMessagePacketPlayerEventExtraData,
    WorkerMessagePacketTransmuxingEventInfo,
    WorkerMessagePacketTransmuxingEventRecommendSeekpoint,
    WorkerMessagePacketBufferedPositionChanged,
    WorkerMessagePacketStartupGroupAppended,
    WorkerMessagePacketControlledSeek,
    WorkerMessagePacketAudioSwitchReservationsReleased,
    WorkerMessagePacketVideoSwitchReservationsReleased,
    WorkerMessagePacketPlaybackOperationEvent,
    WorkerMessagePacketLogcatCallback,
} from './player-engine-worker-msg-def.js';
import {
    canAdvancePlaybackOperation,
    clonePlaybackOperation,
    createNextPlaybackAttempt,
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
import {
    createPlaybackOperationEvent,
    type PlaybackOperationSettleDetails,
    type PlaybackOperationStatus,
} from './playback-operation-result';
import {
    isMMTSStartupGroupFailure,
    type MMTSStartupGroupFailure,
} from '../core/mmts-startup-group-lifecycle';
import MMTSAudioTrackSwitchCoordinator, {
    type MMTSAudioTrackSwitchReservation,
    type MMTSAudioTrackSwitchStrategy,
    type MMTSAudioTrackSwitchTransaction as UnifiedAudioSwitchTransaction,
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
const MMTS_LIVE_REBUILD_VIDEO_SEGMENT_LIMIT = 12;
const MMTS_LIVE_REBUILD_AUDIO_SEGMENT_LIMIT = 12;
const MMTS_VOD_REBUILD_SEGMENT_LIMIT = 64;
const MMTS_VOD_AUDIO_TRACK_SWITCH_PREPARATION_TIMEOUT = 10000;
const MMTS_VOD_AUDIO_TRACK_SWITCH_REBUILD_TIMEOUT = 45000;
const MMTS_VOD_AUDIO_TRACK_SWITCH_MAX_RETRIES = 1;
const MMTS_VIDEO_TRACK_SWITCH_SELECTION_TIMEOUT = 10000;
const MMTS_VIDEO_TRACK_SWITCH_DATA_TIMEOUT = 45000;

type MMTSVodAudioTrackSwitchAction =
    | {type: 'primary'}
    | {type: 'secondary'}
    | {type: 'select', packetId: number};

type MMTSVodAudioTrackSwitchTransaction = {
    operation: PlaybackOperation,
    requestedTime: number,
    expectedPacketId: number,
    generation: number,
    stage: 'preparing' | 'selecting' | 'waiting_startup' | 'extending' | 'submitted' | 'rebuilding',
    selectionIssued: boolean,
    confirmedPacketId?: number,
    confirmedTracks?: any[],
    confirmedAudioTracks?: any,
    resolvedSeekTime?: number,
    retryCount: number,
    pendingMediaInfo?: MediaInfo,
    videoInitSegment?: any,
    audioInitSegment?: any,
    videoSegments?: any[],
    audioSegments?: any[],
    videoPlayableStart?: number,
    audioPlayableStart?: number,
};

type MMTSVodAudioTrackSwitchRequest = {
    operation: PlaybackOperation,
    requestedTime: number,
    expectedPacketId: number,
    retryCount?: number,
};

type MMTSLiveVideoRebuildWindow = {
    playableStart: number,
    segments: any[],
};

const PlayerEngineWorker = (self: DedicatedWorkerGlobalScope) => {
    const TAG: string = 'PlayerEngineWorker';

    const logcat_callback: (type: string, str: string) => void = onLogcatCallback.bind(this);

    let media_data_source: any = null;
    let config: any = null;

    let mse_controller: MSEController = null;
    let mse_buffer_state_machine: MSEBufferStateMachine = null;
    let transmuxer: Transmuxer = null;

    let mse_source_opened: boolean = false;
    let has_pending_load: boolean = false;
    let pending_video_track_switch_init_segment: any = null;
    let pending_video_track_switch_media_segment: any = null;
    let selected_mmts_video_packet_id: number | undefined = undefined;
    let mmts_video_tracks: any[] = [];
    let pending_audio_track_switch_request_time: number | null = null;
    let pending_audio_track_switch_expected_packet_id: number | null = null;
    let accepted_audio_track_switch_time: number | null = null;
    let pending_audio_track_switch_init_segment: any = null;
    let pending_audio_track_switch_media_segments: any[] = [];
    let audio_track_switch_rebuild_pending: boolean = false;
    let selected_mmts_audio_packet_id: number | undefined = undefined;
    let mmts_audio_tracks: any[] = [];
    let pending_mmts_vod_audio_track_switch: MMTSVodAudioTrackSwitchTransaction | null = null;
    let latest_mmts_video_init_segment: any = null;
    let mmts_live_video_rebuild_window: MMTSLiveVideoRebuildWindow | null = null;
    let media_duration_seconds: number = 0;

    let media_element_current_time: number = 0;
    let media_element_ready_state: number = 0;
    let last_mse_buffer_full_log_time: number = 0;
    let active_playback_operation: PlaybackOperation | null = null;
    let pending_startup_group_operation: PlaybackOperation | null = null;
    let handling_external_mse_error: boolean = false;
    let external_mse_error_reported: boolean = false;
    const playback_recovery_roots: Map<string, {
        operation: PlaybackOperation,
        reason: string,
    }> = new Map();
    const audio_track_switch_coordinator = new MMTSAudioTrackSwitchCoordinator({
        onTimeout: (transaction) => onUnifiedAudioTrackSwitchTimeout(transaction),
        stageTimeout: (stage) => ['requested', 'preparing', 'selecting'].includes(stage) ?
            MMTS_VOD_AUDIO_TRACK_SWITCH_PREPARATION_TIMEOUT :
            MMTS_VOD_AUDIO_TRACK_SWITCH_REBUILD_TIMEOUT,
    });
    const video_track_switch_coordinator = new MMTSVideoTrackSwitchCoordinator({
        onTimeout: (transaction) => failUnifiedVideoTrackSwitch(
            transaction.operation,
            `timeout:${transaction.stage}`
        ),
        stageTimeout: (stage) => stage === 'requested' || stage === 'selecting' ?
            MMTS_VIDEO_TRACK_SWITCH_SELECTION_TIMEOUT :
            MMTS_VIDEO_TRACK_SWITCH_DATA_TIMEOUT,
    });

    let destroyed = false;

    self.addEventListener('message', (e: MessageEvent) => {
        if (destroyed) {
            return;
        }

        const command_packet = e.data as WorkerCommandPacket;
        const cmd = command_packet.cmd;

        switch (cmd) {
            case 'logging_config': {
                const packet = command_packet as WorkerCommandPacketLoggingConfig;
                LoggingControl.applyConfig(packet.logging_config);

                if (packet.logging_config.enableCallback === true) {
                    LoggingControl.addLogListener(logcat_callback);
                } else {
                    LoggingControl.removeLogListener(logcat_callback);
                }
                break;
            }
            case 'init': {
                const packet = command_packet as WorkerCommandPacketInit;
                media_data_source = packet.media_data_source;
                config = packet.config;
                break;
            }
            case 'destroy':
                destroy();
                break;
            case 'initialize_mse': {
                const packet = command_packet as WorkerCommandPacketInitializeMSE;
                if (!setPlaybackOperation(packet.playback_operation)) break;
                initializeMSE();
                break;
            }
            case 'shutdown_mse':
                shutdownMSE();
                break;
            case 'load': {
                const packet = command_packet as WorkerCommandPacketLoad;
                if (!setPlaybackOperation(packet.playback_operation)) break;
                load();
                break;
            }
            case 'unload':
                unload();
                break;
            case 'unbuffered_seek': {
                const packet = command_packet as WorkerCommandPacketUnbufferedSeek;
                if (!canSetPlaybackOperation(packet.playback_operation)) {
                    postPlaybackOperationEvent(packet.playback_operation, 'failed', {
                        reason: 'seek-activation-rejected',
                    });
                    break;
                }
                cancelMMTSAudioTrackSwitchForSeek();
                cancelMMTSVideoTrackSwitchForSeek();
                if (!setPlaybackOperation(packet.playback_operation)) {
                    postPlaybackOperationEvent(packet.playback_operation, 'failed', {
                        reason: 'seek-activation-rejected',
                    });
                    break;
                }
                postPlaybackOperationEvent(packet.playback_operation, 'running', {
                    reason: 'seek-started',
                });
                media_element_current_time = packet.milliseconds / 1000;
                pending_startup_group_operation = null;
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onSeek(media_element_current_time);
                }
                break;
            }
            case 'user_seek': {
                const packet = command_packet as WorkerCommandPacketUserSeek;
                if (!canSetPlaybackOperation(packet.playback_operation)) {
                    postPlaybackOperationEvent(packet.playback_operation, 'failed', {
                        reason: 'seek-activation-rejected',
                    });
                    break;
                }
                cancelMMTSAudioTrackSwitchForSeek();
                cancelMMTSVideoTrackSwitchForSeek();
                if (!setPlaybackOperation(packet.playback_operation)) {
                    postPlaybackOperationEvent(packet.playback_operation, 'failed', {
                        reason: 'seek-activation-rejected',
                    });
                    break;
                }
                postPlaybackOperationEvent(packet.playback_operation, 'running', {
                    reason: 'seek-started',
                });
                media_element_current_time = packet.target_time;
                pending_startup_group_operation = null;
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onUserSeek(media_element_current_time);
                }
                break;
            }
            case 'startup_jump': {
                const packet = command_packet as WorkerCommandPacketStartupJump;
                if (!acceptPlaybackOperation(packet.playback_operation)) break;
                media_element_current_time = packet.target_time;
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onDirectSeek(media_element_current_time);
                }
                break;
            }
            case 'timeupdate': {
                const packet = command_packet as WorkerCommandPacketTimeUpdate;
                if (!acceptPlaybackOperation(packet.playback_operation)) break;
                media_element_current_time = packet.current_time;
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onMediaState(
                        media_element_current_time,
                        media_element_ready_state,
                        'timeupdate'
                    );
                }
                break;
            }
            case 'readystatechange': {
                const packet = command_packet as WorkerCommandPacketReadyStateChange;
                if (!acceptPlaybackOperation(packet.playback_operation)) break;
                media_element_ready_state = packet.ready_state;
                if (typeof packet.current_time === 'number' && isFinite(packet.current_time)) {
                    media_element_current_time = packet.current_time;
                }
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onMediaState(
                        media_element_current_time,
                        media_element_ready_state,
                        packet.event_type || 'readystatechange'
                    );
                }
                break;
            }
            case 'pause_transmuxer':
                if (!acceptPlaybackOperation(command_packet.playback_operation)) break;
                transmuxer.pause();
                break;
            case 'resume_transmuxer':
                if (!acceptPlaybackOperation(command_packet.playback_operation)) break;
                transmuxer.resume();
                break;
            case 'switch_audio': {
                const packet = command_packet as WorkerCommandPacketSwitchAudio;
                const action: MMTSVodAudioTrackSwitchAction = {type: packet.audio_track};
                const timelineSeed = packet.timeline_seed !== undefined ? packet.timeline_seed :
                    (config && config.isMMTS && !config.isLive ?
                        media_element_current_time * 1000 : getAudioTrackSwitchTimelineSeed());
                if (config && config.isMMTS) {
                    requestUnifiedAudioTrackSwitch(
                        action, timelineSeed, packet.playback_operation, packet.recovery_playback_operation
                    );
                    break;
                }
                if (mse_buffer_state_machine && (!config || !config.isMMTS)) {
                    mse_buffer_state_machine.onAudioTrackSwitch({stage: 'request'});
                }
                pending_audio_track_switch_request_time = timelineSeed / 1000;
                pending_audio_track_switch_expected_packet_id = getMMTSVodAudioTrackTarget(action);
                accepted_audio_track_switch_time = null;
                pending_audio_track_switch_init_segment = null;
                pending_audio_track_switch_media_segments = [];
                if (packet.audio_track === 'primary') {
                    transmuxer.switchPrimaryAudio(timelineSeed);
                } else if (packet.audio_track === 'secondary') {
                    transmuxer.switchSecondaryAudio(timelineSeed);
                }
                break;
            }
            case 'select_audio_track': {
                const packet = command_packet as WorkerCommandPacketSelectAudioTrack;
                const action: MMTSVodAudioTrackSwitchAction = {type: 'select', packetId: packet.packet_id};
                const timelineSeed = packet.timeline_seed !== undefined ? packet.timeline_seed :
                    (config && config.isMMTS && !config.isLive ?
                        media_element_current_time * 1000 : getAudioTrackSwitchTimelineSeed());
                if (config && config.isMMTS) {
                    requestUnifiedAudioTrackSwitch(
                        action, timelineSeed, packet.playback_operation, packet.recovery_playback_operation
                    );
                    break;
                }
                if (mse_buffer_state_machine && (!config || !config.isMMTS)) {
                    mse_buffer_state_machine.onAudioTrackSwitch({stage: 'request'});
                }
                pending_audio_track_switch_request_time = timelineSeed / 1000;
                pending_audio_track_switch_expected_packet_id = getMMTSVodAudioTrackTarget(action);
                accepted_audio_track_switch_time = null;
                pending_audio_track_switch_init_segment = null;
                pending_audio_track_switch_media_segments = [];
                transmuxer.selectAudioTrack(packet.packet_id, timelineSeed);
                break;
            }
            case 'select_video_track': {
                const packet = command_packet as WorkerCommandPacketSelectVideoTrack;
                if (config && config.isMMTS) {
                    requestUnifiedVideoTrackSwitch(
                        packet.packet_id,
                        packet.playback_operation,
                        packet.recovery_playback_operation
                    );
                    break;
                }
                if (mse_buffer_state_machine) {
                    mse_buffer_state_machine.onVideoTrackSwitch({stage: 'request'});
                }
                transmuxer.selectVideoTrack(packet.packet_id);
                break;
            }
        }
    });

    function canSetPlaybackOperation(operation?: PlaybackOperation): boolean {
        if (!config || config.isMMTS !== true) {
            return true;
        }
        if (!isPlaybackOperation(operation) ||
            !['startup', 'seek', 'audio-switch', 'video-switch'].includes(operation.kind)) {
            throw new TypeError('Invalid MMTS playback operation');
        }
        return canAdvancePlaybackOperation(active_playback_operation, operation) &&
            (!mse_buffer_state_machine ||
                mse_buffer_state_machine.canSetPlaybackOperation(operation)) &&
            (!transmuxer || transmuxer.canSetPlaybackOperation(operation));
    }

    function setPlaybackOperation(operation?: PlaybackOperation): boolean {
        if (!canSetPlaybackOperation(operation)) {
            return false;
        }
        if (!config || config.isMMTS !== true) {
            return true;
        }
        const nextOperation = clonePlaybackOperation(operation as PlaybackOperation);
        if (mse_buffer_state_machine &&
            !mse_buffer_state_machine.setPlaybackOperation(nextOperation)) {
            return false;
        }
        if (transmuxer && !transmuxer.setPlaybackOperation(nextOperation)) {
            return false;
        }
        active_playback_operation = clonePlaybackOperation(nextOperation);
        return true;
    }

    function activateOwnerRetryAttempt(
        sourceOperation: PlaybackOperation,
        retryOperation: PlaybackOperation,
        reason: string,
        retryRequest?: PlaybackOperationRetryRequest
    ): boolean {
        if (!transmuxer || !active_playback_operation ||
            !isSamePlaybackOperation(active_playback_operation, sourceOperation) ||
            !isSamePlaybackTransaction(sourceOperation, retryOperation) ||
            retryOperation.attempt !== sourceOperation.attempt + 1) {
            return false;
        }

        const audioCanAdopt = retryOperation.kind !== 'audio-switch' ||
            audio_track_switch_coordinator.canAdoptAttempt(retryOperation);
        const videoCanAdopt = retryOperation.kind !== 'video-switch' ||
            video_track_switch_coordinator.canAdoptAttempt(retryOperation);
        const transmuxerCanAdopt = retryRequest ?
            transmuxer.canContinuePlaybackOperationRetry(
                retryOperation,
                retryRequest
            ) : transmuxer.canSetPlaybackOperation(retryOperation);
        if (!audioCanAdopt || !videoCanAdopt || !transmuxerCanAdopt ||
            (mse_buffer_state_machine &&
                !mse_buffer_state_machine.canSetPlaybackOperation(retryOperation))) {
            return false;
        }

        if (mse_buffer_state_machine &&
            !mse_buffer_state_machine.setPlaybackOperation(retryOperation)) {
            return false;
        }
        if (retryOperation.kind === 'audio-switch') {
            if (!audio_track_switch_coordinator.adoptAttempt(retryOperation)) {
                return false;
            }
            if (pending_mmts_vod_audio_track_switch &&
                isSamePlaybackTransaction(
                    pending_mmts_vod_audio_track_switch.operation,
                    retryOperation
                )) {
                pending_mmts_vod_audio_track_switch.operation =
                    clonePlaybackOperation(retryOperation);
                if (retryOperation.phase === 'adaptive-retry') {
                    pending_mmts_vod_audio_track_switch.stage = 'selecting';
                    pending_mmts_vod_audio_track_switch.selectionIssued = true;
                    pending_mmts_vod_audio_track_switch.videoInitSegment = null;
                    pending_mmts_vod_audio_track_switch.audioInitSegment = null;
                    pending_mmts_vod_audio_track_switch.videoSegments = [];
                    pending_mmts_vod_audio_track_switch.audioSegments = [];
                }
            }
        } else if (retryOperation.kind === 'video-switch') {
            if (!video_track_switch_coordinator.adoptAttempt(retryOperation)) {
                return false;
            }
            pending_video_track_switch_init_segment = null;
            pending_video_track_switch_media_segment = null;
        }

        active_playback_operation = clonePlaybackOperation(retryOperation);
        postPlaybackOperationEvent(retryOperation, 'retrying', {reason});
        postOperationMessage({
            msg: 'playback_operation_started',
        } as WorkerMessagePacket, retryOperation);

        return retryRequest ?
            transmuxer.continuePlaybackOperationRetry(
                retryOperation,
                retryRequest
            ) : transmuxer.setPlaybackOperation(retryOperation);
    }

    function getOwnerRetryFailureOperation(
        sourceOperation: PlaybackOperation,
        retryOperation: PlaybackOperation
    ): PlaybackOperation {
        return active_playback_operation &&
            isSamePlaybackOperation(active_playback_operation, retryOperation) ?
            retryOperation : sourceOperation;
    }

    function onPlaybackOperationRetryRequired(
        request: PlaybackOperationRetryRequest,
        sourceOperation: PlaybackOperation
    ): void {
        const active = active_playback_operation;
        if (!transmuxer || !active ||
            !isPlaybackOperationRetryRequest(request, sourceOperation) ||
            !isSamePlaybackOperation(active, sourceOperation)) {
            transmuxer?.cancelPlaybackOperationRetry(request);
            return;
        }
        const retryOperation = createNextPlaybackAttempt(active, {
            phase: 'adaptive-retry',
            requestedTimeMilliseconds: request.requestedTimeMilliseconds,
        });
        if (!activateOwnerRetryAttempt(
            sourceOperation,
            retryOperation,
            request.reason,
            request
        )) {
            transmuxer.cancelPlaybackOperationRetry(request);
            failOwnerAuthorizedPlaybackRetry(
                getOwnerRetryFailureOperation(
                    sourceOperation,
                    retryOperation
                ),
                'adaptive-retry-activation-rejected'
            );
        }
    }

    function onPlaybackOperationRetryRejected(
        request: PlaybackOperationRetryRequest,
        retryOperation: PlaybackOperation,
        sourceOperation: PlaybackOperation
    ): void {
        if (!isPlaybackOperationRetryRequest(request, sourceOperation) ||
            !isPlaybackOperation(retryOperation) ||
            !active_playback_operation ||
            !isSamePlaybackOperation(active_playback_operation, retryOperation)) {
            return;
        }
        failOwnerAuthorizedPlaybackRetry(
            retryOperation,
            'adaptive-retry-transmuxing-worker-rejected'
        );
    }

    function failOwnerAuthorizedPlaybackRetry(
        operation: PlaybackOperation,
        reason: string
    ): void {
        Log.e(
            TAG,
            `MMTS playback retry failed: kind=${operation.kind}, ` +
            `transaction=${operation.transactionKey}, ` +
            `attempt=${operation.attemptKey}, reason=${reason}`
        );
        if (operation.kind === 'audio-switch') {
            failUnifiedAudioTrackSwitch(operation, reason);
            return;
        }
        if (operation.kind === 'video-switch') {
            failUnifiedVideoTrackSwitch(operation, reason);
            return;
        }
        pending_startup_group_operation = null;
        postPlaybackOperationEvent(operation, 'failed', {reason});
    }

    function acceptPlaybackOperation(operation?: PlaybackOperation | null): boolean {
        if (!config || config.isMMTS !== true) {
            return true;
        }
        return isPlaybackOperation(operation) &&
            !!active_playback_operation &&
            isSamePlaybackOperation(operation, active_playback_operation);
    }

    function requestUnifiedVideoTrackSwitch(
        packetId: number,
        operation?: PlaybackOperation,
        recoveryOperation?: PlaybackOperation
    ): void {
        if (audio_track_switch_coordinator.active) {
            if (isPlaybackOperation(operation)) {
                postPlaybackOperationEvent(operation, 'failed', {
                    reason: 'timeline-owner-conflict:audio-switch',
                });
            }
            releaseVideoSwitchOperationPair(operation, recoveryOperation);
            return;
        }
        const priorCommittedPacketId = selected_mmts_video_packet_id;
        if (!Number.isInteger(packetId) || packetId < 0 ||
            priorCommittedPacketId === undefined ||
            !isPlaybackOperation(operation) || operation.kind !== 'video-switch' ||
            operation.phase !== 'requested' || operation.attempt !== 0 ||
            operation.packetId !== packetId ||
            !isPlaybackOperation(recoveryOperation) ||
            recoveryOperation.kind !== 'video-switch' ||
            recoveryOperation.phase !== 'recovery-reserved' ||
            recoveryOperation.attempt !== 0 ||
            recoveryOperation.packetId !== priorCommittedPacketId ||
            recoveryOperation.timelineGeneration <= operation.timelineGeneration ||
            recoveryOperation.transactionId <= operation.transactionId) {
            if (isPlaybackOperation(operation)) {
                postPlaybackOperationEvent(operation, 'failed', {
                    reason: 'invalid-video-switch-reservation',
                });
            }
            releaseVideoSwitchOperationPair(operation, recoveryOperation);
            return;
        }
        const reservation: MMTSVideoTrackSwitchReservation = {
            operation,
            priorCommittedPacketId,
            targetPacketId: packetId,
            recoveryOperation,
        };
        const previousQueued = video_track_switch_coordinator.queued;
        const result = video_track_switch_coordinator.request(reservation);
        if (previousQueued && (result.type !== 'queued' ||
            !isSamePlaybackTransaction(previousQueued.operation, operation))) {
            releaseVideoSwitchReservations(previousQueued);
        }
        if (result.type === 'same-target') {
            releaseVideoSwitchReservations(reservation);
            postPlaybackOperationEvent(operation, 'no-op', {
                reason: 'already-selected',
                committedPacketId: packetId,
            });
        } else if (result.type === 'activate') {
            startUnifiedVideoTrackSwitch(result.transaction);
        }
    }

    function releaseVideoSwitchReservations(
        reservation: MMTSVideoTrackSwitchReservation,
        includeRecovery: boolean = true
    ): void {
        releaseVideoSwitchOperationPair(
            reservation.operation,
            includeRecovery ? reservation.recoveryOperation : undefined
        );
    }

    function releaseVideoSwitchOperationPair(
        operation?: PlaybackOperation,
        recoveryOperation?: PlaybackOperation
    ): void {
        const transactionKeys: string[] = [];
        if (isPlaybackOperation(operation) && operation.kind === 'video-switch') {
            transactionKeys.push(operation.transactionKey);
        }
        if (isPlaybackOperation(recoveryOperation) && recoveryOperation.kind === 'video-switch') {
            transactionKeys.push(recoveryOperation.transactionKey);
        }
        if (transactionKeys.length === 0) return;
        self.postMessage({
            msg: 'video_switch_reservations_released',
            transaction_keys: transactionKeys,
        } as WorkerMessagePacketVideoSwitchReservationsReleased);
    }

    function startUnifiedVideoTrackSwitch(
        transaction: MMTSVideoTrackSwitchTransaction
    ): void {
        if (!setPlaybackOperation(transaction.operation)) {
            failUnifiedVideoTrackSwitch(transaction.operation, 'activation-rejected');
            return;
        }
        postOperationMessage({
            msg: 'playback_operation_started',
        } as WorkerMessagePacket, transaction.operation);
        pending_video_track_switch_init_segment = null;
        pending_video_track_switch_media_segment = null;
        const accepted = mse_buffer_state_machine.onVideoTrackSwitch({
            stage: 'request',
            operation: transaction.operation,
            transactionId: transaction.operation.transactionId,
        });
        if (!accepted || !video_track_switch_coordinator.transition(
            transaction.operation,
            'requested',
            'selecting'
        )) {
            failUnifiedVideoTrackSwitch(
                transaction.operation,
                accepted ? 'invalid-transition' : 'mse-request-rejected'
            );
            return;
        }
        const identity = createPlaybackSwitchIdentity(transaction.operation);
        if (config && config.isLive) {
            transmuxer.selectVideoTrack(transaction.targetPacketId, identity);
        } else {
            transmuxer.seekAndSelectVideoTrack(
                transaction.operation.requestedTimeMilliseconds,
                transaction.operation,
                transaction.targetPacketId,
                identity
            );
        }
    }

    function onMMTSVideoTrackSelectionResult(result: any,
                                               operation: PlaybackOperation): void {
        if (!acceptPlaybackOperation(operation) || !result ||
            !doesPlaybackSwitchIdentityMatchOperation(result, operation)) return;
        const outcome = video_track_switch_coordinator.selectionResult(operation, result);
        if (outcome.type === 'stale') return;
        if (outcome.type === 'rejected') {
            failUnifiedVideoTrackSwitch(operation, `selection:${result.reason}`);
            return;
        }
    }

    function consumeMMTSVideoTrackSwitchInit(segment: any,
                                              operation: PlaybackOperation): void {
        const transaction = video_track_switch_coordinator.active;
        if (!transaction || transaction.stage !== 'waiting-init' ||
            !doesMMTSVideoTrackSwitchMatch(segment, transaction, operation) ||
            !segment.data || typeof segment.data.byteLength !== 'number' ||
            segment.data.byteLength <= 0 ||
            !video_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-init',
                'waiting-media'
            )) {
            Log.w(TAG, 'Drop stale or invalid MMTS video track switch init segment');
            return;
        }
        pending_video_track_switch_init_segment = segment;
    }

    function consumeMMTSVideoTrackSwitchMedia(segment: any,
                                               operation: PlaybackOperation): void {
        const transaction = video_track_switch_coordinator.active;
        const initSegment = pending_video_track_switch_init_segment;
        const videoSwitch = segment && segment.mmtsVideoTrackSwitch;
        if (!transaction || transaction.stage !== 'waiting-media' || !initSegment ||
            !doesMMTSVideoTrackSwitchMatch(segment, transaction, operation) ||
            !doesMMTSVideoTrackSwitchMatch(initSegment, transaction, operation) ||
            !segment.data || typeof segment.data.byteLength !== 'number' ||
            segment.data.byteLength <= 0 ||
            !video_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-media',
                'submitted'
            )) {
            Log.w(TAG, 'Drop stale or out-of-order MMTS video track switch media segment');
            return;
        }
        pending_video_track_switch_media_segment = segment;
        if (!mse_buffer_state_machine.onVideoTrackSwitch({
            stage: 'commit_ready',
            operation: transaction.operation,
            transactionId: transaction.operation.transactionId,
            videoSwitch,
            videoInitSegment: initSegment,
            videoMediaSegment: segment,
        })) {
            failUnifiedVideoTrackSwitch(transaction.operation, 'mse-commit-rejected');
        }
    }

    function doesMMTSVideoTrackSwitchMatch(
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

    function finishUnifiedVideoTrackSwitch(operation: PlaybackOperation): void {
        const transaction = video_track_switch_coordinator.active;
        if (!transaction || transaction.stage !== 'submitted' ||
            !isSamePlaybackAttempt(transaction.operation, operation)) return;
        const committed = video_track_switch_coordinator.commit(transaction.operation);
        if (!committed) return;
        const committedInit = pending_video_track_switch_init_segment;
        const committedMedia = pending_video_track_switch_media_segment;
        pending_video_track_switch_init_segment = null;
        pending_video_track_switch_media_segment = null;
        publishUnifiedVideoTrackSwitch(committed, committedInit, committedMedia);
    }

    function publishUnifiedVideoTrackSwitch(
        committed: MMTSVideoTrackSwitchTransaction,
        committedInit: any,
        committedMedia: any
    ): void {
        const videoTracks = committed.confirmedTrackData;
        const sourceTracks = videoTracks && Array.isArray(videoTracks.tracks) ?
            videoTracks.tracks : mmts_video_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === committed.targetPacketId,
        }));
        selected_mmts_video_packet_id = committed.targetPacketId;
        mmts_video_tracks = tracks;
        if (config.isLive && committedInit) {
            latest_mmts_video_init_segment = committedInit;
            mmts_live_video_rebuild_window = null;
            if (committedMedia) cacheMMTSLiveVideoSegment(committedMedia);
        }
        emitPlayerEventsExtraData(PlayerEvents.MMTS_VIDEO_TRACKS, {
            ...(videoTracks || {}),
            tracks,
            selectedPacketId: committed.targetPacketId,
        }, committed.operation);
        if (committed.pendingMediaInfo) {
            const mediaInfo = committed.pendingMediaInfo;
            mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                media_duration_seconds = mediaInfo.duration / 1000;
                mse_controller?.setMediaDuration(media_duration_seconds);
            }
            emitTransmuxingEventsInfo(
                TransmuxingEvents.MEDIA_INFO,
                mediaInfo,
                committed.operation
            );
        }
        releaseVideoSwitchReservations(committed);
        if (!completePlaybackRecovery(committed.operation, true)) {
            postPlaybackOperationEvent(committed.operation, 'committed', {
                reason: 'video-track-committed',
                committedPacketId: committed.targetPacketId,
            });
        }
        promoteUnifiedVideoTrackSwitch(committed.operation);
    }

    function promoteUnifiedVideoTrackSwitch(completedOperation: PlaybackOperation): void {
        const queued = video_track_switch_coordinator.queued;
        const transaction = video_track_switch_coordinator.promote(
            completedOperation,
            undefined,
            selected_mmts_video_packet_id
        );
        if (transaction) {
            startUnifiedVideoTrackSwitch(transaction);
        } else if (queued && !video_track_switch_coordinator.queued) {
            releaseVideoSwitchReservations(queued);
        }
    }

    function failUnifiedVideoTrackSwitch(operation: PlaybackOperation,
                                          reason: string): void {
        const failed = video_track_switch_coordinator.abort(operation);
        if (!failed) return;
        mse_buffer_state_machine?.cancelVideoTrackSwitch(failed.operation);
        pending_video_track_switch_init_segment = null;
        pending_video_track_switch_media_segment = null;
        const recoveryDepth = failed.recoveryDepth || 0;
        if (recoveryDepth >= 1) {
            releaseVideoSwitchReservations(failed);
            const queued = video_track_switch_coordinator.queued;
            if (queued) releaseVideoSwitchReservations(queued);
            video_track_switch_coordinator.clear();
            if (!completePlaybackRecovery(
                failed.operation, false, `video-recovery-failed:${reason}`
            )) {
                postPlaybackOperationEvent(failed.operation, 'failed', {
                    reason: `video-recovery-failed:${reason}`,
                });
            }
            return;
        }
        if (!failed.internalSelectionChanged && !failed.selectionMayHaveMutated) {
            releaseVideoSwitchReservations(failed);
            postPlaybackOperationEvent(failed.operation, 'failed', {
                reason: `video-track-switch:${reason}`,
            });
            promoteUnifiedVideoTrackSwitch(failed.operation);
            return;
        }
        const promoted = video_track_switch_coordinator.promote(
            failed.operation,
            recoveryDepth + 1,
            selected_mmts_video_packet_id
        );
        if (promoted) {
            releaseVideoSwitchReservations(failed);
            postPlaybackOperationEvent(promoted.operation, 'retrying', {
                reason: `video-track-switch-retry:${reason}`,
            });
            startUnifiedVideoTrackSwitch(promoted);
            return;
        }
        const targetPacketId = selected_mmts_video_packet_id === undefined ?
            failed.priorCommittedPacketId : selected_mmts_video_packet_id;
        const reservedRecoveryOperation = failed.recoveryOperation;
        if (!reservedRecoveryOperation) {
            releaseVideoSwitchReservations(failed);
            video_track_switch_coordinator.clear();
            postPlaybackOperationEvent(failed.operation, 'failed', {
                reason: `video-recovery-reservation-missing:${reason}`,
            });
            return;
        }
        releaseVideoSwitchReservations(failed, false);
        const recoveryOperation = rebindReservedPlaybackOperation(reservedRecoveryOperation, {
            phase: 'recovery',
            // currentTime can already belong to the failed candidate timeline.
            // Recover from the stable point where the switch was requested.
            requestedTimeMilliseconds: Math.max(0, failed.operation.requestedTimeMilliseconds),
            packetId: targetPacketId,
        });
        registerPlaybackRecovery(recoveryOperation, failed.operation,
            `video-track-switch:${reason}`);
        const recovery = video_track_switch_coordinator.request({
            operation: recoveryOperation,
            priorCommittedPacketId: targetPacketId,
            targetPacketId,
            recoveryDepth: recoveryDepth + 1,
        });
        if (recovery.type === 'activate') {
            startUnifiedVideoTrackSwitch(recovery.transaction);
        } else {
            completePlaybackRecovery(recoveryOperation, false,
                `video-recovery-not-activated:${reason}`);
        }
    }

    function cancelMMTSVideoTrackSwitchForSeek(): void {
        if (!config || !config.isMMTS) return;
        const active = video_track_switch_coordinator.active;
        const queued = video_track_switch_coordinator.queued;
        if (active) {
            releaseVideoSwitchReservations(active);
            const aborted = video_track_switch_coordinator.abort(active.operation);
            if (aborted) {
                mse_buffer_state_machine?.cancelVideoTrackSwitch(aborted.operation);
                transferMMTSVideoSelectionToSeek(aborted);
                cancelPlaybackOperationForSeek(aborted.operation);
            }
        }
        if (queued) releaseVideoSwitchReservations(queued);
        video_track_switch_coordinator.clear();
        pending_video_track_switch_init_segment = null;
        pending_video_track_switch_media_segment = null;
    }

    function transferMMTSVideoSelectionToSeek(
        transaction: MMTSVideoTrackSwitchTransaction
    ): void {
        if (!transaction.internalSelectionChanged) return;
        const videoTracks = transaction.confirmedTrackData;
        const sourceTracks = videoTracks && Array.isArray(videoTracks.tracks) ?
            videoTracks.tracks : mmts_video_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === transaction.targetPacketId,
        }));
        selected_mmts_video_packet_id = transaction.targetPacketId;
        mmts_video_tracks = tracks;
        emitPlayerEventsExtraData(PlayerEvents.MMTS_VIDEO_TRACKS, {
            ...(videoTracks || {}),
            tracks,
            selectedPacketId: transaction.targetPacketId,
        });
        if (transaction.pendingMediaInfo) {
            const mediaInfo = transaction.pendingMediaInfo;
            mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                media_duration_seconds = mediaInfo.duration / 1000;
                mse_controller?.setMediaDuration(media_duration_seconds);
            }
            emitTransmuxingEventsInfo(TransmuxingEvents.MEDIA_INFO, mediaInfo);
        }
    }

    function postOperationMessage(
        packet: WorkerMessagePacket,
        operation: PlaybackOperation | null = active_playback_operation,
        transfer?: Transferable[]
    ): void {
        if (config && config.isMMTS === true) {
            if (!isPlaybackOperation(operation)) {
                return;
            }
            packet.playback_operation = clonePlaybackOperation(operation);
        }
        if (transfer) {
            self.postMessage(packet, transfer);
        } else {
            self.postMessage(packet);
        }
    }

    function postPlaybackOperationEvent(
        operation: PlaybackOperation,
        status: PlaybackOperationStatus,
        details: PlaybackOperationSettleDetails = {}
    ): void {
        if (!config || config.isMMTS !== true || !isPlaybackOperation(operation)) return;
        const event = createPlaybackOperationEvent(operation, status, details);
        postOperationMessage({
            msg: 'playback_operation_event',
            event,
        } as WorkerMessagePacketPlaybackOperationEvent, operation);
    }

    function registerPlaybackRecovery(
        recoveryOperation: PlaybackOperation,
        rootOperation: PlaybackOperation,
        reason: string
    ): void {
        playback_recovery_roots.set(recoveryOperation.transactionKey, {
            operation: clonePlaybackOperation(rootOperation),
            reason,
        });
        postPlaybackOperationEvent(rootOperation, 'recovering', {reason});
    }

    function completePlaybackRecovery(
        recoveryOperation: PlaybackOperation,
        recovered: boolean,
        failureReason?: string
    ): boolean {
        const root = playback_recovery_roots.get(recoveryOperation.transactionKey);
        if (!root) return false;
        playback_recovery_roots.delete(recoveryOperation.transactionKey);
        postPlaybackOperationEvent(root.operation, 'failed', {
            reason: recovered ? `${root.reason}:recovered-to-prior-track` :
                (failureReason || `${root.reason}:recovery-failed`),
            committedPacketId: recovered ? recoveryOperation.packetId : undefined,
        });
        return true;
    }

    function clearPlaybackRecoveryForRoot(rootOperation: PlaybackOperation): void {
        playback_recovery_roots.forEach((root, key) => {
            if (isSamePlaybackTransaction(root.operation, rootOperation)) {
                playback_recovery_roots.delete(key);
            }
        });
    }


    function cancelPlaybackOperationForSeek(
        operation: PlaybackOperation,
        reason: string = 'cancelled-by-seek'
    ): void {
        const recoveryRoot = playback_recovery_roots.get(operation.transactionKey);
        if (recoveryRoot) {
            playback_recovery_roots.delete(operation.transactionKey);
            postPlaybackOperationEvent(recoveryRoot.operation, 'cancelled', {reason});
            return;
        }
        clearPlaybackRecoveryForRoot(operation);
        postPlaybackOperationEvent(operation, 'cancelled', {reason});
    }

    function destroy(): void {
        active_playback_operation = null;
        pending_startup_group_operation = null;
        playback_recovery_roots.clear();
        if (transmuxer) {
            unload();
        }
        if (mse_controller) {
            shutdownMSE();
        }
        destroyed = true;

        self.postMessage({
            msg: 'destroyed',
        } as WorkerMessagePacket);
    }

    function initializeMSE(): void {
        Log.v(TAG, 'Initializing MediaSource in DedicatedWorker');
        mse_controller = createMSEController();
        mse_buffer_state_machine = createMSEBufferStateMachine();
        if (config && config.isMMTS && (!active_playback_operation ||
            !mse_buffer_state_machine.setPlaybackOperation(active_playback_operation))) {
            throw new IllegalStateException('Failed to initialize MMTS MSE playback operation');
        }
        postMSEHandle(mse_controller, false);
    }

    function createMSEController(): MSEController {
        const controller = new MSEController(config);
        controller.on(MSEEvents.SOURCE_OPEN, onMSESourceOpen.bind(this));
        controller.on(MSEEvents.UPDATE_END, onMSEUpdateEnd.bind(this));
        controller.on(MSEEvents.BUFFER_FULL, onMSEBufferFull.bind(this));
        controller.on(MSEEvents.ERROR, onMSEError.bind(this));
        controller.initialize({
            getCurrentTime: () => media_element_current_time,
            getReadyState: () => media_element_ready_state,
        });
        if (!config.isLive && media_duration_seconds > 0) {
            controller.setMediaDuration(media_duration_seconds);
        }
        return controller;
    }

    function postMSEHandle(controller: MSEController, rebuild: boolean): void {
        const handle = controller.getHandle();
        postOperationMessage({
            msg: 'mse_init',
            handle,
            rebuild,
        } as WorkerMessagePacketMSEInit, active_playback_operation, [handle]);
    }

    function rebuildMSEController(): boolean {
        if (!mse_controller) {
            return false;
        }

        const previousController = mse_controller;
        let replacementController: MSEController;
        try {
            replacementController = createMSEController();
            if (pending_mmts_vod_audio_track_switch &&
                pending_mmts_vod_audio_track_switch.stage === 'submitted') {
                pending_mmts_vod_audio_track_switch.stage = 'rebuilding';
                audio_track_switch_coordinator.transition(
                    pending_mmts_vod_audio_track_switch.operation,
                    'submitted',
                    'rebuilding'
                );
            }
            previousController.abandon();
            mse_controller = replacementController;
            mse_source_opened = false;
            postMSEHandle(replacementController, true);
        } catch (error) {
            onMSEError(error);
            return false;
        }

        previousController.revokeObjectURL();
        return true;
    }

    function createMSEBufferStateMachine(): MSEBufferStateMachine {
        return new MSEBufferStateMachine(config, {
            ensureSourceBuffer: (_type: any, segment: any) => {
                return mse_controller.ensureSourceBufferDirect(segment);
            },
            appendInit: (_type: any, segment: any) => {
                return mse_controller.appendInitSegmentDirect(
                    segment,
                    segment && segment.resetParserState === true
                );
            },
            appendMedia: (_type: any, segment: any) => {
                return mse_controller.appendMediaSegmentDirect(segment);
            },
            removeRange: (type: any, start: number, end: number) => {
                return mse_controller.removeRangeDirect(type, start, end);
            },
            resetParserState: (type: any, mimeType: string) => {
                return mse_controller.resetParserStateDirect(type, mimeType);
            },
            pauseTransmuxer: (_reason: string) => {
                if (transmuxer) {
                    transmuxer.pause();
                }
            },
            resumeTransmuxer: (_reason: string) => {
                if (transmuxer) {
                    transmuxer.resume();
                }
            },
            flushPending: (_type?: any) => {},
            emitFatal: (error: any) => {
                emitMSEError(error);
            },
            rebuildMediaSource: (_plan: any) => {
                return rebuildMSEController();
            },
            onStartupGroupAppended: (startupGroup: any) => {
                const operation = startupGroup && isPlaybackOperation(startupGroup.playbackOperation) ?
                    startupGroup.playbackOperation : pending_startup_group_operation;
                postOperationMessage({
                    msg: 'startup_group_appended',
                    startup_time: startupGroup.startupTime,
                } as WorkerMessagePacketStartupGroupAppended, operation);
                pending_startup_group_operation = null;
            },
            seekMedia: (targetTime: number, reason: string) => {
                media_element_current_time = targetTime;
                const operation = reason === 'STARTUP_GROUP' ?
                    pending_startup_group_operation : active_playback_operation;
                postOperationMessage({
                    msg: 'controlled_seek',
                    target_time: targetTime,
                    reason,
                } as WorkerMessagePacketControlledSeek, operation);
            },
            onAudioTrackSwitchRebuildComplete: (operation: PlaybackOperation) => {
                if (pending_mmts_vod_audio_track_switch) {
                    finishMMTSVodAudioTrackSwitch(operation);
                } else {
                    finishUnifiedLiveAudioTrackSwitch(operation);
                }
            },
            onAudioTrackSwitchRebuildFailed: (failure: any) => {
                const active = audio_track_switch_coordinator.active;
                if (active && failure && failure.kind === 'audio-switch' &&
                    isPlaybackOperation(failure.operation) &&
                    isSamePlaybackAttempt(active.operation, failure.operation)) {
                    failUnifiedAudioTrackSwitch(
                        active.operation,
                        `rebuild-failed:${failure.phase}`
                    );
                }
            },
            onVideoTrackSwitchComplete: (operation: PlaybackOperation) => {
                finishUnifiedVideoTrackSwitch(operation);
            },
            onVideoTrackSwitchFailed: (failure: any) => {
                const active = video_track_switch_coordinator.active;
                if (active && failure && failure.kind === 'video-switch' &&
                    isPlaybackOperation(failure.operation) &&
                    isSamePlaybackAttempt(active.operation, failure.operation)) {
                    failUnifiedVideoTrackSwitch(
                        active.operation,
                        `mse-failed:${failure.phase}`
                    );
                }
            },
            onPlaybackOperationComplete: (
                operation: PlaybackOperation,
                details?: {committedTimeMilliseconds?: number}
            ) => {
                if (operation.kind === 'seek') {
                    postPlaybackOperationEvent(operation, 'committed', {
                        reason: 'seek-committed',
                        committedTimeMilliseconds: details && details.committedTimeMilliseconds,
                    });
                }
            },
            onPlaybackOperationFailed: (operation: PlaybackOperation, error: any) => {
                if (operation.kind === 'seek') {
                    postPlaybackOperationEvent(operation, 'failed', {
                        reason: 'seek-mse-failed',
                        error,
                    });
                }
            },
            seekTransmuxer: (
                milliseconds: number,
                reason: string,
                operation?: PlaybackOperation
            ) => {
                if (!transmuxer || !isPlaybackOperation(operation) ||
                    !acceptPlaybackOperation(operation)) {
                    return;
                }
                if (reason === MMTS_VOD_AUDIO_TRACK_REBUILD_REASON) {
                    if (operation.kind === 'audio-switch') {
                        issueMMTSVodAudioTrackSelection(milliseconds);
                    }
                } else {
                    transmuxer.seek(milliseconds, operation);
                }
            },
            endOfStream: () => {
                mse_controller.endOfStream();
                return {ok: true};
            },
            getMediaSourceState: () => {
                return mse_controller.getMediaSourceState();
            },
            getForwardBufferInfo: (currentTime: number) => {
                return mse_controller.getForwardBufferInfo(currentTime);
            },
            getBufferedRanges: (type: any) => {
                return mse_controller.getBufferedRanges(type);
            },
        });
    }

    function shutdownMSE(): void {
        if (mse_buffer_state_machine) {
            mse_buffer_state_machine.destroy();
            mse_buffer_state_machine = null;
        }
        if (mse_controller) {
            mse_controller.shutdown();
            mse_controller.destroy();
            mse_controller = null;
        }
    }

    function load(): void {
        if (media_data_source == null || config == null) {
            throw new IllegalStateException('Worker not initialized');
        }
        if (transmuxer) {
            throw new IllegalStateException('Transmuxer has been initialized');
        }
        if (has_pending_load) {
            return;
        }
        if (config.deferLoadAfterSourceOpen && !mse_source_opened) {
            has_pending_load = true;
            return;
        }

        transmuxer = new Transmuxer(media_data_source, config);
        if (config.isMMTS && (!active_playback_operation ||
            !transmuxer.setPlaybackOperation(active_playback_operation))) {
            throw new IllegalStateException('Failed to initialize MMTS transmux playback operation');
        }

        transmuxer.on(TransmuxingEvents.INIT_SEGMENT, (type: string, is: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            const videoTransaction = video_track_switch_coordinator.active;
            if (config && config.isMMTS && !config.isLive && type === 'audio' &&
                videoTransaction && isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                return;
            }
            if (config && config.isMMTS && type === 'video' &&
                is && is.mmtsVideoTrackSwitch) {
                consumeMMTSVideoTrackSwitchInit(is, operation);
                return;
            }
            if (config && config.isMMTS && config.isLive && type === 'video') {
                latest_mmts_video_init_segment = is;
                mmts_live_video_rebuild_window = null;
            }
            if (type === 'audio' && pending_mmts_vod_audio_track_switch != null) {
                return;
            }
            if (config && config.isMMTS && type === 'audio' &&
                consumeMMTSLiveAudioTrackSwitchInit(is, operation)) {
                return;
            }
            mse_buffer_state_machine.onInitSegment(type as any, is);
        });
        transmuxer.on(TransmuxingEvents.STARTUP_GROUP, (startupGroup: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            startupGroup.playbackOperation = clonePlaybackOperation(operation);
            pending_startup_group_operation = clonePlaybackOperation(operation);
            if (pending_mmts_vod_audio_track_switch != null) {
                const result = initializeMMTSVodAudioTrackSwitchRebuild(
                    startupGroup,
                    operation
                );
                if (result.status === 'accepted') {
                    trySubmitMMTSVodAudioTrackSwitchRebuild();
                } else if (result.status === 'invalid') {
                    Log.w(
                        TAG,
                        `Reject MMTS VOD audio startup group: ${result.reason}, ` +
                        `attempt=${operation.attemptKey}`
                    );
                    failUnifiedAudioTrackSwitch(
                        operation,
                        `startup-group:validation:${result.reason}`
                    );
                }
                return;
            }
            if (config && config.isMMTS && config.isLive && startupGroup) {
                if (startupGroup.videoInitSegment) {
                    latest_mmts_video_init_segment = startupGroup.videoInitSegment;
                }
                if (startupGroup.videoMediaSegment) {
                    cacheMMTSLiveVideoSegment(startupGroup.videoMediaSegment);
                }
            }
            mse_buffer_state_machine.onStartupGroup(startupGroup);
            postBufferedPositionChanged(operation);
        });
        transmuxer.on(TransmuxingEvents.STARTUP_GROUP_FAILED,
            (failure: MMTSStartupGroupFailure, operation: PlaybackOperation) => {
                if (!isMMTSStartupGroupFailure(failure, operation) ||
                    !acceptPlaybackOperation(operation) ||
                    !active_playback_operation ||
                    !isSamePlaybackOperation(operation, active_playback_operation)) {
                    return;
                }
                if (operation.kind === 'audio-switch') {
                    const transaction = audio_track_switch_coordinator.active;
                    if (!transaction ||
                        !isSamePlaybackOperation(operation, transaction.operation)) {
                        return;
                    }
                    failUnifiedAudioTrackSwitch(
                        transaction.operation,
                        `startup-group:${failure.phase}:${failure.reason}`
                    );
                    return;
                }
                if (operation.kind === 'startup' || operation.kind === 'seek') {
                    pending_startup_group_operation = null;
                    mse_buffer_state_machine.onStartupGroupFailure(failure);
                }
            }
        );
        transmuxer.on(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
            (request: PlaybackOperationRetryRequest, operation: PlaybackOperation) => {
                onPlaybackOperationRetryRequired(request, operation);
            }
        );
        transmuxer.on(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED,
            (
                request: PlaybackOperationRetryRequest,
                retryOperation: PlaybackOperation,
                sourceOperation: PlaybackOperation
            ) => {
                onPlaybackOperationRetryRejected(
                    request,
                    retryOperation,
                    sourceOperation
                );
            }
        );
        transmuxer.on(TransmuxingEvents.MEDIA_SEGMENT, (type: string, ms: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            const videoTransaction = video_track_switch_coordinator.active;
            if (config && config.isMMTS && !config.isLive && type === 'audio' &&
                videoTransaction && isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                return;
            }
            if (config && config.isMMTS && type === 'video' &&
                ms && ms.mmtsVideoTrackSwitch) {
                consumeMMTSVideoTrackSwitchMedia(ms, operation);
                return;
            }
            if (pending_mmts_vod_audio_track_switch != null) {
                if (collectMMTSVodAudioTrackSwitchMedia(type, ms)) {
                    trySubmitMMTSVodAudioTrackSwitchRebuild();
                }
                return;
            }
            if (config && config.isMMTS && config.isLive && type === 'video') {
                cacheMMTSLiveVideoSegment(ms);
                if (trySubmitMMTSLiveAudioTrackRebuild()) {
                    return;
                }
            }
            if (config && config.isMMTS && type === 'audio' &&
                consumeMMTSLiveAudioTrackSwitchMedia(ms, operation)) {
                return;
            }
            mse_buffer_state_machine.onMediaSegment(type as any, ms);
            postBufferedPositionChanged(operation);
        });
        transmuxer.on(TransmuxingEvents.LOADING_COMPLETE, (operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            mse_buffer_state_machine.onEndOfStream(operation);
            postOperationMessage({
                msg: 'player_event',
                event: PlayerEvents.LOADING_COMPLETE,
            } as WorkerMessagePacketPlayerEvent, operation);
        });
        transmuxer.on(TransmuxingEvents.RECOVERED_EARLY_EOF, (operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            postOperationMessage({
                msg: 'player_event',
                event: PlayerEvents.RECOVERED_EARLY_EOF,
            } as WorkerMessagePacketPlayerEvent, operation);
        });
        transmuxer.on(TransmuxingEvents.IO_ERROR, (detail: any, info: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            postOperationMessage({
                msg: 'player_event',
                event: PlayerEvents.ERROR,
                error_type: ErrorTypes.NETWORK_ERROR,
                error_detail: detail,
                info: info,
            } as WorkerMessagePacketPlayerEventError, operation);
        });
        transmuxer.on(TransmuxingEvents.DEMUX_ERROR, (detail: any, info: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            postOperationMessage({
                msg: 'player_event',
                event: PlayerEvents.ERROR,
                error_type: ErrorTypes.MEDIA_ERROR,
                error_detail: detail,
                info: info,
            } as WorkerMessagePacketPlayerEventError, operation);
        });

        transmuxer.on(TransmuxingEvents.MEDIA_INFO, (mediaInfo: MediaInfo, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            const videoTransaction = video_track_switch_coordinator.active;
            if (videoTransaction &&
                isSamePlaybackTransaction(operation, videoTransaction.operation)) {
                video_track_switch_coordinator.setPendingMediaInfo(operation, mediaInfo);
                return;
            }
            const unifiedTransaction = audio_track_switch_coordinator.active;
            if (unifiedTransaction &&
                isSamePlaybackTransaction(operation, unifiedTransaction.operation)) {
                audio_track_switch_coordinator.setPendingMediaInfo(operation, mediaInfo);
            }
            const transaction = pending_mmts_vod_audio_track_switch;
            if (transaction) {
                transaction.pendingMediaInfo = mediaInfo;
                return;
            }
            if (unifiedTransaction) return;
            mse_buffer_state_machine.onMediaInfo(mediaInfo);
            if (!config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                media_duration_seconds = mediaInfo.duration / 1000;
                mse_controller.setMediaDuration(media_duration_seconds);
            }
            emitTransmuxingEventsInfo(TransmuxingEvents.MEDIA_INFO, mediaInfo, operation);
        });
        transmuxer.on(TransmuxingEvents.STATISTICS_INFO, (statInfo: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            emitTransmuxingEventsInfo(TransmuxingEvents.STATISTICS_INFO, statInfo, operation);
        });

        transmuxer.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, (milliseconds: number, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) {
                return;
            }
            if (handleMMTSVodAudioTrackSwitchRecommendedSeek(milliseconds)) {
                return;
            }
            postOperationMessage({
                msg: 'transmuxing_event',
                event: TransmuxingEvents.RECOMMEND_SEEKPOINT,
                milliseconds,
            } as WorkerMessagePacketTransmuxingEventRecommendSeekpoint, operation);
            mse_buffer_state_machine.onRecommendedSeekPoint(milliseconds / 1000);
        });

        transmuxer.on(TransmuxingEvents.METADATA_ARRIVED, (metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.METADATA_ARRIVED, metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, (data: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.SCRIPTDATA_ARRIVED, data, operation);
        });
        transmuxer.on(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, (timed_id3_metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.TIMED_ID3_METADATA_ARRIVED, timed_id3_metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.PGS_SUBTITLE_ARRIVED, (pgs_data: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.PGS_SUBTITLE_ARRIVED, pgs_data, operation);
        });
        transmuxer.on(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, (synchronous_klv_metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, synchronous_klv_metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, (asynchronous_klv_metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, asynchronous_klv_metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED, (smpte2038_metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.SMPTE2038_METADATA_ARRIVED, smpte2038_metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.SEI_ARRIVED, (sei_data: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.SEI_ARRIVED, sei_data, operation);
        });
        transmuxer.on(TransmuxingEvents.SCTE35_METADATA_ARRIVED, (scte35_metadata: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.SCTE35_METADATA_ARRIVED, scte35_metadata, operation);
        });
        transmuxer.on(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR, (descriptor: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.PES_PRIVATE_DATA_DESCRIPTOR, descriptor, operation);
        });
        transmuxer.on(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED, (private_data: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.PES_PRIVATE_DATA_ARRIVED, private_data, operation);
        });
        transmuxer.on(TransmuxingEvents.MMTS_AUDIO_TRACKS, (audio_tracks: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            const unifiedTransaction = audio_track_switch_coordinator.active;
            if (unifiedTransaction &&
                isSamePlaybackOperation(operation, unifiedTransaction.operation)) {
                audio_track_switch_coordinator.setConfirmedTrackData(operation, audio_tracks);
                if (pending_mmts_vod_audio_track_switch &&
                    isSamePlaybackOperation(
                        operation,
                        pending_mmts_vod_audio_track_switch.operation
                    )) {
                    pending_mmts_vod_audio_track_switch.confirmedTracks =
                        audio_tracks && audio_tracks.tracks;
                    pending_mmts_vod_audio_track_switch.confirmedAudioTracks = audio_tracks;
                }
                return;
            }
            const vodTransaction = pending_mmts_vod_audio_track_switch;
            if (!acceptAudioTrackSwitch(audio_tracks)) {
                return;
            }
            if (vodTransaction) {
                return;
            }
            emitPlayerEventsExtraData(PlayerEvents.MMTS_AUDIO_TRACKS, audio_tracks, operation);
        });
        transmuxer.on(TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
            (result: any, operation: PlaybackOperation) => {
                onMMTSAudioTrackSelectionResult(result, operation);
            });
        transmuxer.on(TransmuxingEvents.MMTS_VIDEO_TRACKS, (video_tracks: any, operation: PlaybackOperation) => {
            if (!acceptPlaybackOperation(operation)) return;
            const transaction = video_track_switch_coordinator.active;
            if (transaction && isSamePlaybackTransaction(operation, transaction.operation)) {
                video_track_switch_coordinator.setConfirmedTrackData(operation, video_tracks);
                return;
            }
            selected_mmts_video_packet_id = video_tracks && video_tracks.selectedPacketId;
            mmts_video_tracks = video_tracks && Array.isArray(video_tracks.tracks) ?
                video_tracks.tracks.slice() : [];
            emitPlayerEventsExtraData(PlayerEvents.MMTS_VIDEO_TRACKS, video_tracks, operation);
        });
        transmuxer.on(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT,
            (result: any, operation: PlaybackOperation) => {
                onMMTSVideoTrackSelectionResult(result, operation);
            });
        transmuxer.on(TransmuxingEvents.MMTS_SUBTITLE_TRACKS, (subtitle_tracks: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.MMTS_SUBTITLE_TRACKS, subtitle_tracks, operation);
        });
        transmuxer.on(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED, (subtitle_data: any, operation: PlaybackOperation) => {
            emitPlayerEventsExtraData(PlayerEvents.MMTS_SUBTITLE_DATA_ARRIVED, subtitle_data, operation);
        });

        transmuxer.open(active_playback_operation);
    }

    function unload(): void {
        const activeReservation = audio_track_switch_coordinator.active;
        const queuedReservation = audio_track_switch_coordinator.queued;
        const abortedAudioSwitch = activeReservation ?
            audio_track_switch_coordinator.abort(activeReservation.operation) : null;
        if (activeReservation) releaseAudioSwitchReservations(activeReservation);
        if (queuedReservation) releaseAudioSwitchReservations(queuedReservation);
        if (activeReservation || pending_mmts_vod_audio_track_switch) {
            cleanupUnifiedAudioTrackSwitch(
                activeReservation ? activeReservation.strategy : 'vod-reseek',
                abortedAudioSwitch?.operation
            );
        }
        audio_track_switch_coordinator.clear();
        const activeVideoReservation = video_track_switch_coordinator.active;
        const queuedVideoReservation = video_track_switch_coordinator.queued;
        if (activeVideoReservation) releaseVideoSwitchReservations(activeVideoReservation);
        if (queuedVideoReservation) releaseVideoSwitchReservations(queuedVideoReservation);
        video_track_switch_coordinator.clear();
        pending_video_track_switch_init_segment = null;
        pending_video_track_switch_media_segment = null;
        selected_mmts_video_packet_id = undefined;
        mmts_video_tracks = [];
        pending_audio_track_switch_request_time = null;
        pending_audio_track_switch_expected_packet_id = null;
        accepted_audio_track_switch_time = null;
        pending_audio_track_switch_init_segment = null;
        pending_audio_track_switch_media_segments = [];
        audio_track_switch_rebuild_pending = false;
        pending_mmts_vod_audio_track_switch = null;
        mmts_audio_tracks = [];
        latest_mmts_video_init_segment = null;
        mmts_live_video_rebuild_window = null;
        media_duration_seconds = 0;
        active_playback_operation = null;
        pending_startup_group_operation = null;
        playback_recovery_roots.clear();
        if (mse_buffer_state_machine) {
            mse_buffer_state_machine.flushPending();
        }
        if (mse_controller) {
            mse_controller.clearBufferedRanges();
        }
        if (transmuxer) {
            transmuxer.close();
            transmuxer.destroy();
            transmuxer = null;
        }
    }

    function onMSESourceOpen(): void {
        mse_source_opened = true;
        if (mse_buffer_state_machine) {
            mse_buffer_state_machine.onSourceOpen();
        }
        if (has_pending_load) {
            has_pending_load = false;
            load();
        }
    }

    function onMSEUpdateEnd(type?: any): void {
        if (mse_buffer_state_machine) {
            mse_buffer_state_machine.onUpdateEnd(type);
        }
        postBufferedPositionChanged(active_playback_operation);
        postOperationMessage({
            msg: 'mse_event',
            event: MSEEvents.UPDATE_END,
            forward_buffer_info: mse_buffer_state_machine ?
                mse_buffer_state_machine.getForwardBufferInfo(media_element_current_time) :
                (mse_controller ? mse_controller.getForwardBufferInfo(media_element_current_time) : undefined),
        } as WorkerMessagePacketMSEEvent);
    }

    function postBufferedPositionChanged(operation: PlaybackOperation | null = active_playback_operation): void {
        const info = mse_buffer_state_machine ?
            mse_buffer_state_machine.getForwardBufferInfo(media_element_current_time) :
            undefined;
        const audioDuration = info && typeof info.audioForwardDuration === 'number' ? info.audioForwardDuration : 0;
        const videoDuration = info && typeof info.videoForwardDuration === 'number' ? info.videoForwardDuration : 0;
        const forwardDuration = info && typeof info.forwardDuration === 'number' ?
            info.forwardDuration :
            Math.max(0, Math.min(audioDuration || videoDuration, videoDuration || audioDuration));
        postOperationMessage({
            msg: 'buffered_position_changed',
            buffered_position_milliseconds: (media_element_current_time + forwardDuration) * 1000,
            forward_buffer_info: info,
        } as WorkerMessagePacketBufferedPositionChanged, operation);
    }

    function acceptAudioTrackSwitch(audioTracks: any): boolean {
        const selectedPacketId = audioTracks && audioTracks.selectedPacketId;
        const previousPacketId = selected_mmts_audio_packet_id;
        const tracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks.slice() : [];

        const vodTransaction = pending_mmts_vod_audio_track_switch;
        if (vodTransaction != null) {
            if (!vodTransaction.selectionIssued || vodTransaction.stage !== 'selecting' ||
                vodTransaction.confirmedPacketId !== undefined ||
                typeof selectedPacketId !== 'number' || !isFinite(selectedPacketId) ||
                selectedPacketId !== vodTransaction.expectedPacketId) {
                return false;
            }

            mmts_audio_tracks = tracks;
            vodTransaction.confirmedPacketId = selectedPacketId;
            vodTransaction.confirmedTracks = tracks;
            vodTransaction.confirmedAudioTracks = audioTracks;
            vodTransaction.stage = 'waiting_startup';
            if (transmuxer) {
                transmuxer.completeMMTSVodAudioTrackRebuild();
            }
            Log.v(
                TAG,
                `Accepted MMTS VOD audio switch packet_id=0x${selectedPacketId.toString(16)}, ` +
                `request_time=${vodTransaction.requestedTime.toFixed(3)}`
            );
            return true;
        }

        if (pending_audio_track_switch_request_time == null) {
            mmts_audio_tracks = tracks;
            selected_mmts_audio_packet_id = selectedPacketId;
            return true;
        }

        const expectedPacketId = pending_audio_track_switch_expected_packet_id;
        if (typeof expectedPacketId === 'number' && isFinite(expectedPacketId) &&
            selectedPacketId !== expectedPacketId) {
            return false;
        }

        const switchTime = pending_audio_track_switch_request_time;
        pending_audio_track_switch_request_time = null;
        pending_audio_track_switch_expected_packet_id = null;
        if (selectedPacketId === undefined || selectedPacketId === previousPacketId) {
            return false;
        }

        mmts_audio_tracks = tracks;
        selected_mmts_audio_packet_id = selectedPacketId;
        accepted_audio_track_switch_time = switchTime;
        pending_audio_track_switch_media_segments = [];
        Log.v(
            TAG,
            `Accepted MMTS audio switch packet_id=0x${selectedPacketId.toString(16)}, ` +
            `request_time=${switchTime.toFixed(3)}`
        );
        return true;
    }

    function isForwardMMTSAudioTrackSwitch(
        transaction: UnifiedAudioSwitchTransaction | null
    ): transaction is UnifiedAudioSwitchTransaction {
        return !!transaction &&
            (transaction.strategy === 'live-forward' || transaction.strategy === 'vod-forward');
    }

    function consumeMMTSLiveAudioTrackSwitchInit(
        initSegment: any,
        operation: PlaybackOperation
    ): boolean {
        const audioSwitch = initSegment && initSegment.mmtsAudioTrackSwitch;
        const transaction = audio_track_switch_coordinator.active;
        const collecting = isForwardMMTSAudioTrackSwitch(transaction) &&
            ['selecting', 'waiting-init', 'collecting-overlap'].includes(transaction.stage) &&
            isSamePlaybackOperation(operation, transaction.operation);
        if (!audioSwitch) return collecting;
        if (!collecting ||
            !doesMMTSLiveAudioTrackSwitchIdentityMatch(audioSwitch, transaction)) {
            return true;
        }
        if (!isMMTSLiveAudioTrackSwitchInitValid(initSegment)) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'live-data:invalid-init');
            return true;
        }
        if (!pending_audio_track_switch_init_segment) {
            pending_audio_track_switch_init_segment = initSegment;
        }
        if (transaction.stage === 'waiting-init') {
            audio_track_switch_coordinator.transition(
                transaction.operation,
                'waiting-init',
                'collecting-overlap'
            );
        }
        trySubmitMMTSLiveAudioTrackRebuild();
        return true;
    }

    function consumeMMTSLiveAudioTrackSwitchMedia(
        mediaSegment: any,
        operation: PlaybackOperation
    ): boolean {
        const audioSwitch = mediaSegment && mediaSegment.mmtsAudioTrackSwitch;
        const transaction = audio_track_switch_coordinator.active;
        const collecting = isForwardMMTSAudioTrackSwitch(transaction) &&
            ['selecting', 'waiting-init', 'collecting-overlap'].includes(transaction.stage) &&
            isSamePlaybackOperation(operation, transaction.operation);
        if (audioSwitch && (!collecting ||
            !doesMMTSLiveAudioTrackSwitchIdentityMatch(audioSwitch, transaction))) {
            return true;
        }
        if (!collecting) return !!audioSwitch;

        if (pending_audio_track_switch_media_segments.length === 0) {
            if (!audioSwitch) return true;
            if (!isMMTSLiveAudioTrackSwitchMediaValid(mediaSegment, true)) {
                failUnifiedAudioTrackSwitch(
                    transaction.operation,
                    'live-data:invalid-first-media'
                );
                return true;
            }
            pending_audio_track_switch_media_segments.push(mediaSegment);
            trySubmitMMTSLiveAudioTrackRebuild();
            return true;
        }

        if (!isMMTSLiveAudioTrackSwitchMediaValid(mediaSegment, !!audioSwitch)) {
            failUnifiedAudioTrackSwitch(
                transaction.operation,
                audioSwitch ? 'live-data:invalid-first-media' :
                    'live-data:invalid-continuation'
            );
            return true;
        }
        const segmentRange = getMediaSegmentRange(mediaSegment);
        const previousRange = getMediaSegmentRange(
            pending_audio_track_switch_media_segments[
                pending_audio_track_switch_media_segments.length - 1
            ]
        );
        if (!segmentRange || !previousRange) {
            failUnifiedAudioTrackSwitch(
                transaction.operation,
                'live-data:invalid-continuation'
            );
            return true;
        }
        if (segmentRange.end <= previousRange.end) return true;
        if (segmentRange.start > previousRange.end + 0.1) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'live-data:forward-gap');
            return true;
        }
        if (audioSwitch) return true;
        if (pending_audio_track_switch_media_segments.length >=
            MMTS_LIVE_REBUILD_AUDIO_SEGMENT_LIMIT) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'live-data:overflow');
            return true;
        }
        pending_audio_track_switch_media_segments.push(mediaSegment);
        trySubmitMMTSLiveAudioTrackRebuild();
        return true;
    }

    function doesMMTSLiveAudioTrackSwitchIdentityMatch(
        audioSwitch: any,
        transaction: UnifiedAudioSwitchTransaction
    ): boolean {
        return !!audioSwitch &&
            doesPlaybackSwitchIdentityMatchOperation(audioSwitch, transaction.operation) &&
            Number.isInteger(audioSwitch.packetId) &&
            audioSwitch.packetId === transaction.targetPacketId &&
            Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
            audioSwitch.requestedStartMicroseconds ===
                transaction.operation.requestedTimeMicroseconds;
    }

    function isMMTSLiveAudioTrackSwitchInitValid(initSegment: any): boolean {
        return !!initSegment && initSegment.type === 'audio' &&
            typeof initSegment.container === 'string' && initSegment.container.length > 0 &&
            typeof initSegment.codec === 'string' && initSegment.codec.length > 0 &&
            !!initSegment.data && typeof initSegment.data.byteLength === 'number' &&
            initSegment.data.byteLength > 0;
    }

    function isMMTSLiveAudioTrackSwitchMediaValid(
        mediaSegment: any,
        requireSwitchSchema: boolean
    ): boolean {
        const range = getMediaSegmentRange(mediaSegment);
        if (!mediaSegment || mediaSegment.type !== 'audio' || !range ||
            !mediaSegment.data || typeof mediaSegment.data.byteLength !== 'number' ||
            mediaSegment.data.byteLength <= 0) {
            return false;
        }
        return !requireSwitchSchema ||
            isMMTSAudioTrackSwitchMediaValid(mediaSegment.mmtsAudioTrackSwitch);
    }

    function cacheMMTSLiveVideoSegment(mediaSegment: any): void {
        const transaction = audio_track_switch_coordinator.active;
        if (transaction && transaction.strategy === 'live-forward' &&
            (!isSamePlaybackOperation(mediaSegment && mediaSegment.playbackOperation,
                transaction.operation) ||
            mediaSegment.mseBufferGeneration !== transaction.operation.timelineGeneration)) {
            return;
        }
        const playableWindow = getMMTSFirstPlayableWindow(mediaSegment);
        if (playableWindow && isMMTSRandomAccessSafeVideoSegment(mediaSegment)) {
            mmts_live_video_rebuild_window = {
                playableStart: playableWindow.playableStart,
                segments: [mediaSegment],
            };
            return;
        }
        if (!mmts_live_video_rebuild_window ||
            mmts_live_video_rebuild_window.segments.length >= MMTS_LIVE_REBUILD_VIDEO_SEGMENT_LIMIT) {
            return;
        }
        const previousSegment = mmts_live_video_rebuild_window.segments[
            mmts_live_video_rebuild_window.segments.length - 1
        ];
        if (!canAppendMMTSLiveVideoContinuation(previousSegment, mediaSegment)) {
            return;
        }
        mmts_live_video_rebuild_window.segments.push(mediaSegment);
    }

    function trySubmitMMTSLiveAudioTrackRebuild(): boolean {
        const unifiedTransaction = audio_track_switch_coordinator.active;
        if (!config || !config.isMMTS ||
            !isForwardMMTSAudioTrackSwitch(unifiedTransaction) ||
            accepted_audio_track_switch_time == null ||
            !pending_audio_track_switch_init_segment ||
            pending_audio_track_switch_media_segments.length === 0) {
            return false;
        }
        const preserveVideoBuffer = Browser.firefox !== true;

        const firstAudioSegment = pending_audio_track_switch_media_segments[0];
        const audioSwitch = firstAudioSegment.mmtsAudioTrackSwitch;
        const firstAudioRange = getMediaSegmentRange(firstAudioSegment);
        if (!firstAudioRange) {
            return false;
        }

        const audioStart = Math.max(firstAudioRange.start, audioSwitch.audioStart);
        const switchTime = accepted_audio_track_switch_time;
        const targetTime = Math.max(switchTime, media_element_current_time);
        let seekTime = Math.max(targetTime, audioStart);
        let videoInitSegment: any = null;
        let videoSegments: any[] = [];
        let replaceMediaSource = false;
        if (!preserveVideoBuffer) {
            const authoritativeVideoInitSegment = latest_mmts_video_init_segment;
            if (!mmts_live_video_rebuild_window || !authoritativeVideoInitSegment) {
                return false;
            }
            seekTime = Math.max(seekTime, mmts_live_video_rebuild_window.playableStart);
            videoSegments = selectMMTSTrackSwitchSegmentPrefix(
                mmts_live_video_rebuild_window.segments,
                'video',
                seekTime,
                0.05
            );
            if (videoSegments.length === 0) {
                return false;
            }
            videoInitSegment = Object.assign({}, authoritativeVideoInitSegment, {
                playbackOperation: clonePlaybackOperation(unifiedTransaction.operation),
                mseBufferGeneration: unifiedTransaction.operation.timelineGeneration,
            });
            replaceMediaSource = true;
        }
        const audioSegments = selectMMTSTrackSwitchSegmentPrefix(
            pending_audio_track_switch_media_segments,
            'audio',
            seekTime,
            preserveVideoBuffer ? 0.25 : 0.05
        );
        if (audioSegments.length === 0) {
            return false;
        }

        if (!audio_track_switch_coordinator.transition(
                unifiedTransaction.operation,
                'collecting-overlap',
                'submitted'
            )) {
            return false;
        }
        const accepted = mse_buffer_state_machine.onAudioTrackSwitch({
            stage: 'rebuild_ready',
            mode: unifiedTransaction.strategy === 'live-forward' ? 'live' : 'vod-forward',
            operation: unifiedTransaction.operation,
            replaceMediaSource,
            preserveVideoBuffer,
            switchTime,
            seekTime,
            resumePlayback: false,
            videoInitSegment,
            audioInitSegment: pending_audio_track_switch_init_segment,
            videoSegments,
            audioSegments,
            transactionId: unifiedTransaction.operation.transactionId,
        });
        if (!accepted) {
            failUnifiedAudioTrackSwitch(
                unifiedTransaction.operation,
                'mse-submit-rejected'
            );
            return false;
        }
        const currentTransaction = audio_track_switch_coordinator.active;
        if (!currentTransaction || currentTransaction.stage !== 'submitted' ||
            !isSamePlaybackAttempt(currentTransaction.operation, unifiedTransaction.operation) ||
            !audio_track_switch_coordinator.transition(
            unifiedTransaction.operation,
            'submitted',
            'rebuilding'
            )) {
            return false;
        }
        audio_track_switch_rebuild_pending = true;

        Log.v(
            TAG,
            `Rebuild MMTS forward audio switch at ${seekTime.toFixed(3)}, ` +
            `request_time=${switchTime.toFixed(3)}, ` +
            `packet_id=0x${audioSwitch.packetId.toString(16)}, ` +
            `strategy=${preserveVideoBuffer ? 'audio-only-in-place' :
                (replaceMediaSource ? 'replace-media-source' : 'in-place')}`
        );
        accepted_audio_track_switch_time = null;
        pending_audio_track_switch_init_segment = null;
        pending_audio_track_switch_media_segments = [];
        mmts_live_video_rebuild_window = null;
        return true;
    }

    function getAudioTrackSwitchTimelineSeed(): number {
        return (media_element_current_time + getAudioTrackSwitchPrerollTime()) * 1000;
    }

    function getAudioTrackSwitchPrerollTime(): number {
        return 0.5;
    }

    function requestUnifiedAudioTrackSwitch(
        action: MMTSVodAudioTrackSwitchAction,
        timelineSeed: number,
        operation?: PlaybackOperation,
        recoveryOperation?: PlaybackOperation
    ): void {
        if (video_track_switch_coordinator.active) {
            if (isPlaybackOperation(operation)) {
                postPlaybackOperationEvent(operation, 'failed', {
                    reason: 'timeline-owner-conflict:video-switch',
                });
            }
            releaseAudioSwitchOperationPair(operation, recoveryOperation);
            return;
        }
        const targetPacketId = getMMTSVodAudioTrackTarget(action);
        const priorCommittedPacketId = selected_mmts_audio_packet_id == null ?
            targetPacketId : selected_mmts_audio_packet_id;
        if (targetPacketId === undefined || !isPlaybackOperation(operation) ||
            operation.kind !== 'audio-switch' || operation.phase !== 'requested' ||
            operation.attempt !== 0 || operation.packetId !== targetPacketId ||
            operation.requestedTimeMilliseconds !== timelineSeed ||
            !isPlaybackOperation(recoveryOperation) ||
            recoveryOperation.kind !== 'audio-switch' ||
            recoveryOperation.phase !== 'recovery-reserved' ||
            recoveryOperation.attempt !== 0 ||
            typeof recoveryOperation.packetId !== 'number' ||
            !Number.isInteger(recoveryOperation.packetId) ||
            recoveryOperation.packetId < 0 ||
            recoveryOperation.requestedTimeMilliseconds !== timelineSeed ||
            recoveryOperation.timelineGeneration <= operation.timelineGeneration ||
            recoveryOperation.transactionId <= operation.transactionId) {
            if (isPlaybackOperation(operation)) {
                postPlaybackOperationEvent(operation, 'failed', {
                    reason: 'invalid-audio-switch-reservation',
                });
            }
            releaseAudioSwitchOperationPair(operation, recoveryOperation);
            return;
        }
        const reboundRecoveryOperation = rebindReservedPlaybackOperation(
            recoveryOperation, {packetId: priorCommittedPacketId}
        );
        const reservation: MMTSAudioTrackSwitchReservation = {
            operation,
            priorCommittedPacketId,
            targetPacketId,
            strategy: config.isLive ? 'live-forward' : 'vod-reseek',
            resumeIntent: false,
            recoveryOperation: reboundRecoveryOperation,
        };
        const previousQueued = audio_track_switch_coordinator.queued;
        const result = audio_track_switch_coordinator.request(reservation);
        if (previousQueued && (result.type !== 'queued' ||
            !isSamePlaybackTransaction(previousQueued.operation, operation))) {
            releaseAudioSwitchReservations(previousQueued);
        }
        if (result.type === 'same-target') {
            releaseAudioSwitchReservations(reservation);
            postPlaybackOperationEvent(operation, 'no-op', {
                reason: 'already-selected',
                committedPacketId: targetPacketId,
            });
        }
        if (result.type === 'activate') {
            startUnifiedAudioTrackSwitch(result.transaction);
        }
    }

    function releaseAudioSwitchReservations(
        reservation: MMTSAudioTrackSwitchReservation,
        includeRecovery: boolean = true
    ): void {
        releaseAudioSwitchOperationPair(
            reservation.operation,
            includeRecovery ? reservation.recoveryOperation : undefined
        );
    }

    function releaseAudioSwitchOperationPair(
        operation?: PlaybackOperation,
        recoveryOperation?: PlaybackOperation
    ): void {
        const transactionKeys: string[] = [];
        if (isPlaybackOperation(operation) && operation.kind === 'audio-switch') {
            transactionKeys.push(operation.transactionKey);
        }
        if (isPlaybackOperation(recoveryOperation) && recoveryOperation.kind === 'audio-switch') {
            transactionKeys.push(recoveryOperation.transactionKey);
        }
        if (transactionKeys.length === 0) return;
        self.postMessage({
            msg: 'audio_switch_reservations_released',
            transaction_keys: transactionKeys,
        } as WorkerMessagePacketAudioSwitchReservationsReleased);
    }

    function startUnifiedAudioTrackSwitch(transaction: UnifiedAudioSwitchTransaction): void {
        if (!setPlaybackOperation(transaction.operation)) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'activation-rejected');
            return;
        }
        postOperationMessage({
            msg: 'playback_operation_started',
        } as WorkerMessagePacket, transaction.operation);
        audio_track_switch_coordinator.transition(transaction.operation, 'requested', 'preparing');
        if (isForwardMMTSAudioTrackSwitch(transaction) &&
            !mse_buffer_state_machine.onAudioTrackSwitch({
                stage: 'request',
                mode: transaction.strategy === 'live-forward' ? 'live' : 'vod-forward',
                operation: transaction.operation,
                transactionId: transaction.operation.transactionId,
            })) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'mse-request-rejected');
            return;
        }
        if (transaction.strategy === 'vod-reseek') {
            startMMTSVodAudioTrackSwitch({
                operation: transaction.operation,
                requestedTime: transaction.operation.requestedTimeMilliseconds / 1000,
                expectedPacketId: transaction.targetPacketId,
                retryCount: 0,
            });
            return;
        }
        pending_audio_track_switch_request_time = transaction.operation.requestedTimeMilliseconds / 1000;
        pending_audio_track_switch_expected_packet_id = transaction.targetPacketId;
        accepted_audio_track_switch_time = null;
        pending_audio_track_switch_init_segment = null;
        pending_audio_track_switch_media_segments = [];
        mmts_live_video_rebuild_window = null;
        audio_track_switch_coordinator.transition(transaction.operation, 'preparing', 'selecting');
        const identity = createPlaybackSwitchIdentity(transaction.operation);
        transmuxer.selectAudioTrack(
            transaction.targetPacketId,
            timelineSeedFromOperation(transaction.operation),
            false,
            identity
        );
    }

    function timelineSeedFromOperation(operation: PlaybackOperation): number {
        return operation.requestedTimeMilliseconds as number;
    }

    function onUnifiedAudioTrackSwitchTimeout(transaction: UnifiedAudioSwitchTransaction): void {
        if (transaction.strategy === 'vod-reseek') {
            onMMTSVodAudioTrackSwitchTimeout(transaction.operation.transactionId);
            return;
        }
        failUnifiedAudioTrackSwitch(transaction.operation, `timeout:${transaction.stage}`);
    }

    function onMMTSAudioTrackSelectionResult(result: any, operation: PlaybackOperation): void {
        if (!acceptPlaybackOperation(operation) || !result ||
            !doesPlaybackSwitchIdentityMatchOperation(result, operation)) return;
        const outcome = audio_track_switch_coordinator.selectionResult(operation, result);
        if (outcome.type === 'stale') return;
        if (outcome.type === 'rejected') {
            failUnifiedAudioTrackSwitch(operation, `selection:${result && result.reason}`);
            return;
        }
        const transaction = outcome.transaction;
        if (!transaction) return;
        const tracks = transaction.confirmedTrackData;
        if (pending_mmts_vod_audio_track_switch) {
            pending_mmts_vod_audio_track_switch.confirmedPacketId = result.selectedPacketId;
            pending_mmts_vod_audio_track_switch.confirmedTracks = tracks && tracks.tracks;
            pending_mmts_vod_audio_track_switch.confirmedAudioTracks = tracks;
            pending_mmts_vod_audio_track_switch.stage = 'waiting_startup';
            transmuxer.completeMMTSVodAudioTrackRebuild();
            return;
        }
        pending_audio_track_switch_request_time = null;
        pending_audio_track_switch_expected_packet_id = null;
        accepted_audio_track_switch_time = operation.requestedTimeMilliseconds / 1000;
        if (pending_audio_track_switch_init_segment) {
            audio_track_switch_coordinator.transition(
                operation,
                'waiting-init',
                'collecting-overlap'
            );
            trySubmitMMTSLiveAudioTrackRebuild();
        }
    }

    function promoteUnifiedAudioTrackSwitch(): void {
        if (!active_playback_operation) return;
        const queued = audio_track_switch_coordinator.queued;
        const requestedTimeMilliseconds = queued && queued.strategy === 'live-forward' ?
            getAudioTrackSwitchTimelineSeed() :
            Math.max(0, media_element_current_time * 1000);
        const transaction = audio_track_switch_coordinator.promote(
            active_playback_operation,
            requestedTimeMilliseconds,
            undefined,
            selected_mmts_audio_packet_id
        );
        if (transaction) {
            startUnifiedAudioTrackSwitch(transaction);
        } else if (queued && !audio_track_switch_coordinator.queued) {
            releaseAudioSwitchReservations(queued);
        }
    }

    function failUnifiedAudioTrackSwitch(operation: PlaybackOperation, reason: string): void {
        const failed = audio_track_switch_coordinator.abort(operation);
        if (!failed) return;
        cleanupUnifiedAudioTrackSwitch(failed.strategy, failed.operation);
        const requestedTimeMilliseconds = failed.strategy === 'live-forward' ?
            getAudioTrackSwitchTimelineSeed() :
            Math.max(0, failed.operation.requestedTimeMilliseconds);
        const recoveryDepth = failed.recoveryDepth || 0;
        if (recoveryDepth >= 1) {
            releaseAudioSwitchReservations(failed);
            const queued = audio_track_switch_coordinator.queued;
            if (queued) releaseAudioSwitchReservations(queued);
            audio_track_switch_coordinator.clear();
            if (!completePlaybackRecovery(
                failed.operation, false, `audio-recovery-failed:${reason}`
            )) {
                postPlaybackOperationEvent(failed.operation, 'failed', {
                    reason: `audio-recovery-failed:${reason}`,
                });
            }
            return;
        }
        if (!failed.internalSelectionChanged && !failed.selectionMayHaveMutated) {
            releaseAudioSwitchReservations(failed);
            postPlaybackOperationEvent(failed.operation, 'failed', {
                reason: `audio-track-switch:${reason}`,
            });
            promoteUnifiedAudioTrackSwitch();
            return;
        }
        const targetPacketId = failed.priorCommittedPacketId;
        const reservedRecoveryOperation = failed.recoveryOperation;
        if (!reservedRecoveryOperation) {
            releaseAudioSwitchReservations(failed);
            const queued = audio_track_switch_coordinator.queued;
            if (queued) releaseAudioSwitchReservations(queued);
            audio_track_switch_coordinator.clear();
            postPlaybackOperationEvent(failed.operation, 'failed', {
                reason: `audio-recovery-reservation-missing:${reason}`,
            });
            return;
        }
        releaseAudioSwitchReservations(failed, false);
        const recoveryOperation = rebindReservedPlaybackOperation(reservedRecoveryOperation, {
            phase: 'recovery',
            requestedTimeMilliseconds,
            packetId: targetPacketId,
        });
        registerPlaybackRecovery(recoveryOperation, failed.operation,
            `audio-track-switch:${reason}`);
        const recovery = audio_track_switch_coordinator.request({
            operation: recoveryOperation,
            priorCommittedPacketId: targetPacketId,
            targetPacketId,
            strategy: failed.strategy,
            resumeIntent: failed.resumeIntent,
            recoveryDepth: recoveryDepth + 1,
        });
        if (recovery.type === 'activate') {
            startUnifiedAudioTrackSwitch(recovery.transaction);
        } else {
            completePlaybackRecovery(recoveryOperation, false,
                `audio-recovery-not-activated:${reason}`);
        }
    }

    function cleanupUnifiedAudioTrackSwitch(
        strategy: MMTSAudioTrackSwitchStrategy,
        operation?: PlaybackOperation
    ): void {
        if (strategy === 'vod-reseek') {
            transmuxer?.cancelMMTSVodAudioTrackRebuild();
            pending_mmts_vod_audio_track_switch = null;
        }
        if (isPlaybackOperation(operation) && operation.kind === 'audio-switch') {
            mse_buffer_state_machine?.cancelAudioTrackSwitch(operation);
            if (pending_startup_group_operation &&
                isSamePlaybackOperation(pending_startup_group_operation, operation)) {
                pending_startup_group_operation = null;
            }
        }
        pending_audio_track_switch_request_time = null;
        pending_audio_track_switch_expected_packet_id = null;
        accepted_audio_track_switch_time = null;
        pending_audio_track_switch_init_segment = null;
        pending_audio_track_switch_media_segments = [];
        audio_track_switch_rebuild_pending = false;
        mmts_live_video_rebuild_window = null;
    }

    function startMMTSVodAudioTrackSwitch(request: MMTSVodAudioTrackSwitchRequest): void {
        pending_audio_track_switch_request_time = null;
        pending_audio_track_switch_expected_packet_id = null;
        accepted_audio_track_switch_time = null;
        pending_audio_track_switch_init_segment = null;
        pending_audio_track_switch_media_segments = [];
        pending_mmts_vod_audio_track_switch = {
            ...request,
            operation: request.operation,
            generation: request.operation.transactionId,
            stage: 'preparing',
            retryCount: request.retryCount || 0,
            selectionIssued: false,
        };
        transmuxer.beginMMTSVodAudioTrackRebuild();
        if (!mse_buffer_state_machine.onMMTSVodAudioTrackRebuild(
            request.requestedTime,
            request.operation,
            request.operation.transactionId
        )) {
            failUnifiedAudioTrackSwitch(
                request.operation,
                'mse-vod-request-rejected'
            );
        }
    }

    function onMMTSVodAudioTrackSwitchTimeout(generation: number): void {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.generation !== generation) {
            return;
        }
        if (transaction.stage === 'preparing' && transaction.selectionIssued === false) {
            Log.w(TAG, `Cancel stalled MMTS VOD audio switch generation=${generation}`);
            failUnifiedAudioTrackSwitch(transaction.operation, 'timeout:preparing');
            return;
        }
        const stage = transaction.stage;
        const retryCount = transaction.retryCount;
        if (stage !== 'rebuilding' && retryCount < MMTS_VOD_AUDIO_TRACK_SWITCH_MAX_RETRIES &&
            typeof media_element_current_time === 'number' && isFinite(media_element_current_time) &&
            media_element_current_time >= 0) {
            const requestedTime =
                Math.round(media_element_current_time * 1000000) / 1000000;
            const sourceOperation = transaction.operation;
            const retryOperation = createNextPlaybackAttempt(sourceOperation, {
                phase: 'preparing',
                requestedTimeMilliseconds: requestedTime * 1000,
            });
            if (!activateOwnerRetryAttempt(
                sourceOperation,
                retryOperation,
                'audio-switch-timeout-retry'
            )) {
                failUnifiedAudioTrackSwitch(
                    getOwnerRetryFailureOperation(
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
            transaction.videoSegments = [];
            transaction.audioSegments = [];
            transmuxer.beginMMTSVodAudioTrackRebuild();
            if (!mse_buffer_state_machine.onMMTSVodAudioTrackRebuild(
                requestedTime,
                retryOperation,
                retryOperation.transactionId
            )) {
                failUnifiedAudioTrackSwitch(
                    retryOperation,
                    'mse-vod-retry-rejected'
                );
            }
            return;
        }
        failUnifiedAudioTrackSwitch(transaction.operation, `timeout:${transaction.stage}`);
    }

    function getMMTSVodAudioTrackTarget(action: MMTSVodAudioTrackSwitchAction): number | undefined {
        if (!Array.isArray(mmts_audio_tracks) || mmts_audio_tracks.length === 0) {
            return undefined;
        }

        if (action.type === 'select') {
            const track = mmts_audio_tracks.find((item) => item && item.packetId === action.packetId);
            return track && isMMTSAudioTrackSelectable(track) ? track.packetId : undefined;
        }

        if (action.type === 'primary') {
            const primary = findPreferredAudioTrack(mmts_audio_tracks, false);
            return primary ? primary.packetId : undefined;
        }

        const tracks = mmts_audio_tracks.slice()
            .sort((left, right) => left.packetId - right.packetId)
            .filter((track) => isMMTSAudioTrackSelectable(track));
        if (tracks.length === 0) {
            return undefined;
        }
        const currentIndex = tracks.findIndex((track) => track.packetId === selected_mmts_audio_packet_id);
        return tracks[currentIndex >= 0 ? (currentIndex + 1) % tracks.length : 0].packetId;
    }

    function handleMMTSVodAudioTrackSwitchRecommendedSeek(milliseconds: number): boolean {
        const transaction = pending_mmts_vod_audio_track_switch;
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

    function issueMMTSVodAudioTrackSelection(seekMilliseconds?: number): void {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.selectionIssued || !transmuxer) {
            return;
        }

        transaction.selectionIssued = true;
        transaction.stage = 'selecting';
        audio_track_switch_coordinator.transition(
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
            transmuxer.seekAndSelectAudioTrack(
                seekMilliseconds,
                transaction.operation,
                transaction.expectedPacketId,
                timelineSeed,
                switchIdentity
            );
        } else {
            transmuxer.selectAudioTrack(
                transaction.expectedPacketId, timelineSeed, true, switchIdentity
            );
        }
    }

    function cancelMMTSAudioTrackSwitchForSeek(): void {
        if (!config || !config.isMMTS) {
            return;
        }
        const active = audio_track_switch_coordinator.active;
        const queued = audio_track_switch_coordinator.queued;
        const strategy = active ? active.strategy :
            pending_mmts_vod_audio_track_switch ? 'vod-reseek' : 'live-forward';
        let abortedTransaction: UnifiedAudioSwitchTransaction | null = null;
        if (active) {
            releaseAudioSwitchReservations(active);
            abortedTransaction = audio_track_switch_coordinator.abort(active.operation);
        }
        if (queued) releaseAudioSwitchReservations(queued);
        if (abortedTransaction) {
            transferMMTSAudioSelectionToSeek(abortedTransaction);
            cancelPlaybackOperationForSeek(abortedTransaction.operation);
        }
        audio_track_switch_coordinator.clear();

        const hasPendingSwitch = active != null ||
            pending_mmts_vod_audio_track_switch != null ||
            pending_audio_track_switch_request_time != null ||
            pending_audio_track_switch_expected_packet_id != null ||
            accepted_audio_track_switch_time != null ||
            pending_audio_track_switch_init_segment != null ||
            pending_audio_track_switch_media_segments.length > 0 ||
            audio_track_switch_rebuild_pending ||
            mmts_live_video_rebuild_window != null;
        if (hasPendingSwitch) {
            cleanupUnifiedAudioTrackSwitch(
                strategy,
                abortedTransaction?.operation
            );
        }
    }

    function transferMMTSAudioSelectionToSeek(
        transaction: UnifiedAudioSwitchTransaction
    ): void {
        if (!transaction.internalSelectionChanged) return;
        const audioTracks = transaction.confirmedTrackData;
        const sourceTracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks : mmts_audio_tracks;
        const tracks = sourceTracks.map((track) => Object.assign({}, track, {
            selected: track.packetId === transaction.targetPacketId,
        }));
        selected_mmts_audio_packet_id = transaction.targetPacketId;
        mmts_audio_tracks = tracks;
        emitPlayerEventsExtraData(PlayerEvents.MMTS_AUDIO_TRACKS, {
            ...(audioTracks || {}),
            tracks,
            selectedPacketId: transaction.targetPacketId,
        });
        if (transaction.pendingMediaInfo) {
            const mediaInfo = transaction.pendingMediaInfo;
            mse_buffer_state_machine?.onMediaInfo(mediaInfo);
            if (!config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
                media_duration_seconds = mediaInfo.duration / 1000;
                mse_controller?.setMediaDuration(media_duration_seconds);
            }
            emitTransmuxingEventsInfo(TransmuxingEvents.MEDIA_INFO, mediaInfo);
        }
    }

    function cancelMMTSVodAudioTrackSwitch(): void {
        const activeReservation = audio_track_switch_coordinator.active;
        const queuedReservation = audio_track_switch_coordinator.queued;
        const abortedTransaction = activeReservation ?
            audio_track_switch_coordinator.abort(activeReservation.operation) : null;
        if (activeReservation) releaseAudioSwitchReservations(activeReservation);
        if (queuedReservation) releaseAudioSwitchReservations(queuedReservation);
        audio_track_switch_coordinator.clear();
        cleanupUnifiedAudioTrackSwitch(
            'vod-reseek',
            abortedTransaction?.operation
        );
    }

    function finishMMTSVodAudioTrackSwitch(operation: PlaybackOperation): void {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'rebuilding' ||
            transaction.confirmedPacketId === undefined ||
            !isSamePlaybackAttempt(transaction.operation, operation)) {
            return;
        }
        const committed = audio_track_switch_coordinator.commit(transaction.operation);
        if (!committed) return;
        releaseAudioSwitchReservations(committed);
        selected_mmts_audio_packet_id = transaction.confirmedPacketId;
        if (transaction.confirmedTracks) {
            mmts_audio_tracks = transaction.confirmedTracks;
        }
        const confirmedAudioTracks = transaction.confirmedAudioTracks || {
            tracks: mmts_audio_tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === transaction.confirmedPacketId,
            })),
            selectedPacketId: transaction.confirmedPacketId,
        };
        mmts_audio_tracks = confirmedAudioTracks.tracks;
        pending_mmts_vod_audio_track_switch = null;
        audio_track_switch_rebuild_pending = false;
        emitPlayerEventsExtraData(
            PlayerEvents.MMTS_AUDIO_TRACKS, confirmedAudioTracks, committed.operation
        );
        commitMMTSVodAudioTrackMediaInfo(transaction);
        if (!completePlaybackRecovery(committed.operation, true)) {
            postPlaybackOperationEvent(committed.operation, 'committed', {
                reason: 'audio-track-committed',
                committedPacketId: transaction.confirmedPacketId,
            });
        }
        promoteUnifiedAudioTrackSwitch();
    }

    function finishUnifiedLiveAudioTrackSwitch(operation: PlaybackOperation): void {
        const transaction = audio_track_switch_coordinator.active;
        if (!isForwardMMTSAudioTrackSwitch(transaction) ||
            transaction.stage !== 'rebuilding' ||
            !isSamePlaybackAttempt(transaction.operation, operation)) {
            return;
        }
        const committed = audio_track_switch_coordinator.commit(transaction.operation);
        if (!committed) return;
        releaseAudioSwitchReservations(committed);
        const audioTracks = committed.confirmedTrackData;
        const tracks = audioTracks && Array.isArray(audioTracks.tracks) ?
            audioTracks.tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === committed.targetPacketId,
            })) : mmts_audio_tracks.map((track) => Object.assign({}, track, {
                selected: track.packetId === committed.targetPacketId,
            }));
        selected_mmts_audio_packet_id = committed.targetPacketId;
        mmts_audio_tracks = tracks;
        audio_track_switch_rebuild_pending = false;
        emitPlayerEventsExtraData(PlayerEvents.MMTS_AUDIO_TRACKS, {
            ...(audioTracks || {}),
            tracks,
            selectedPacketId: committed.targetPacketId,
        });
        if (committed.pendingMediaInfo) {
            mse_buffer_state_machine?.onMediaInfo(committed.pendingMediaInfo);
            if (!config.isLive && committed.pendingMediaInfo.duration > 0 &&
                isFinite(committed.pendingMediaInfo.duration)) {
                media_duration_seconds = committed.pendingMediaInfo.duration / 1000;
                mse_controller?.setMediaDuration(media_duration_seconds);
            }
            emitTransmuxingEventsInfo(
                TransmuxingEvents.MEDIA_INFO, committed.pendingMediaInfo, committed.operation
            );
        }
        if (!completePlaybackRecovery(committed.operation, true)) {
            postPlaybackOperationEvent(committed.operation, 'committed', {
                reason: 'audio-track-committed',
                committedPacketId: committed.targetPacketId,
            });
        }
        promoteUnifiedAudioTrackSwitch();
    }

    function commitMMTSVodAudioTrackMediaInfo(transaction: MMTSVodAudioTrackSwitchTransaction): void {
        const mediaInfo = transaction.pendingMediaInfo;
        if (!mediaInfo) {
            return;
        }
        mse_buffer_state_machine?.onMediaInfo(mediaInfo);
        if (!config.isLive && mediaInfo.duration > 0 && isFinite(mediaInfo.duration)) {
            media_duration_seconds = mediaInfo.duration / 1000;
            mse_controller?.setMediaDuration(media_duration_seconds);
        }
        emitTransmuxingEventsInfo(TransmuxingEvents.MEDIA_INFO, mediaInfo);
    }

    function initializeMMTSVodAudioTrackSwitchRebuild(
        startupGroup: any,
        operation?: PlaybackOperation
    ): MMTSVodAudioStartupGroupApplyResult {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'waiting_startup' || transaction.videoSegments) {
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
        const initMatches = doesMMTSVodAudioTrackSwitchMatch(initSwitch, transaction);
        const mediaMatches = doesMMTSVodAudioTrackSwitchMatch(mediaSwitch, transaction);
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
        if (!isMMTSAudioTrackSwitchMediaValid(mediaSwitch)) {
            return {status: 'invalid', reason: 'invalid-audio-window'};
        }
        const audioRange = getMediaSegmentRange(startupGroup.audioMediaSegment);
        if (!audioRange) {
            return {status: 'invalid', reason: 'invalid-audio-window'};
        }
        const playableWindow = getMMTSFirstPlayableWindow(startupGroup.videoMediaSegment);
        if (!playableWindow) {
            return {status: 'invalid', reason: 'missing-video-window'};
        }
        if (!isMMTSRandomAccessSafeVideoSegment(startupGroup.videoMediaSegment)) {
            return {status: 'invalid', reason: 'video-not-random-access'};
        }
        if (!isSyncVideoRebuildSegment(startupGroup.videoMediaSegment)) {
            return {status: 'invalid', reason: 'video-not-sync'};
        }

        transaction.videoInitSegment = startupGroup.videoInitSegment;
        transaction.audioInitSegment = startupGroup.audioInitSegment;
        transaction.videoSegments = [startupGroup.videoMediaSegment];
        transaction.audioSegments = [startupGroup.audioMediaSegment];
        transaction.videoPlayableStart = playableWindow.playableStart;
        transaction.audioPlayableStart = Math.max(audioRange.start, mediaSwitch.audioStart);
        transaction.resolvedSeekTime = Math.max(
            transaction.requestedTime,
            transaction.resolvedSeekTime || 0,
            transaction.videoPlayableStart,
            transaction.audioPlayableStart
        );
        if (!audio_track_switch_coordinator.transition(
            transaction.operation,
            'waiting-init',
            'collecting-overlap'
        )) {
            return {status: 'invalid', reason: 'coordinator-transition-rejected'};
        }
        transaction.stage = 'extending';
        transmuxer.acknowledgeMMTSVodAudioTrackStartup(Object.assign({}, initSwitch));
        return {status: 'accepted'};
    }

    function collectMMTSVodAudioTrackSwitchMedia(type: string, mediaSegment: any): boolean {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'extending' ||
            transaction.confirmedPacketId === undefined ||
            !transaction.videoSegments || !transaction.audioSegments) {
            return false;
        }

        const segments = type === 'video' ? transaction.videoSegments :
            (type === 'audio' ? transaction.audioSegments : null);
        if (!segments || !mediaSegment || mediaSegment.type !== type ||
            segments.length === 0 || segments.length >= MMTS_VOD_REBUILD_SEGMENT_LIMIT) {
            return false;
        }

        if (type === 'audio' && mediaSegment.mmtsAudioTrackSwitch) {
            const audioSwitch = mediaSegment.mmtsAudioTrackSwitch;
            const initialSwitch = transaction.audioSegments[0].mmtsAudioTrackSwitch;
            if (!initialSwitch || !doesMMTSVodAudioTrackSwitchMatch(audioSwitch, transaction) ||
                audioSwitch.attemptKey !== initialSwitch.attemptKey ||
                !isMMTSAudioTrackSwitchMediaValid(audioSwitch)) {
                return false;
            }
        }

        const previousRange = getMediaSegmentRange(segments[segments.length - 1]);
        const segmentRange = getMediaSegmentRange(mediaSegment);
        if (!previousRange || !segmentRange || Math.abs(segmentRange.start - previousRange.end) > 0.1 ||
            segmentRange.end <= previousRange.end) {
            return false;
        }

        segments.push(mediaSegment);
        return true;
    }

    function trySubmitMMTSVodAudioTrackSwitchRebuild(): boolean {
        const transaction = pending_mmts_vod_audio_track_switch;
        if (!transaction || transaction.stage !== 'extending' ||
            !transaction.videoInitSegment || !transaction.audioInitSegment ||
            !transaction.videoSegments || !transaction.audioSegments ||
            typeof transaction.videoPlayableStart !== 'number' ||
            typeof transaction.audioPlayableStart !== 'number' ||
            transaction.resolvedSeekTime === undefined) {
            return false;
        }

        const preserveVideoBuffer = Browser.firefox !== true;
        const seekTime = preserveVideoBuffer ?
            Math.max(transaction.resolvedSeekTime, media_element_current_time) :
            transaction.resolvedSeekTime;
        const videoSegments = preserveVideoBuffer ? [] : selectMMTSTrackSwitchSegmentPrefix(
            transaction.videoSegments,
            'video',
            seekTime,
            0.05
        );
        const audioSegments = selectMMTSTrackSwitchSegmentPrefix(
            transaction.audioSegments,
            'audio',
            seekTime,
            preserveVideoBuffer ? 0.25 : 0.05
        );
        if ((!preserveVideoBuffer && videoSegments.length === 0) || audioSegments.length === 0) {
            return false;
        }
        const replaceMediaSource = !preserveVideoBuffer;

        const request = {
            stage: 'rebuild_ready',
            mode: preserveVideoBuffer ? 'vod-forward' : 'vod',
            operation: transaction.operation,
            replaceMediaSource,
            preserveVideoBuffer,
            switchTime: transaction.requestedTime,
            seekTime,
            resumePlayback: false,
            videoInitSegment: preserveVideoBuffer ? null : transaction.videoInitSegment,
            audioInitSegment: transaction.audioInitSegment,
            videoSegments,
            audioSegments,
            transactionId: transaction.generation,
        };
        transaction.stage = 'submitted';
        audio_track_switch_coordinator.transition(
            transaction.operation,
            'collecting-overlap',
            'submitted'
        );
        if (!mse_buffer_state_machine.onAudioTrackSwitch(request)) {
            failUnifiedAudioTrackSwitch(transaction.operation, 'mse-submit-rejected');
            return false;
        }
        const currentTransaction = audio_track_switch_coordinator.active;
        if (!currentTransaction || !['submitted', 'rebuilding'].includes(currentTransaction.stage) ||
            !isSamePlaybackAttempt(currentTransaction.operation, transaction.operation)) {
            return false;
        }
        if (!replaceMediaSource &&
            (currentTransaction.stage !== 'submitted' ||
                !audio_track_switch_coordinator.transition(
                    transaction.operation,
                    'submitted',
                    'rebuilding'
                ))) {
            return false;
        }
        if (!replaceMediaSource) {
            transaction.stage = 'rebuilding';
        }

        const audioSwitch = transaction.audioSegments[0].mmtsAudioTrackSwitch;
        Log.v(
            TAG,
            `Rebuild MMTS VOD audio switch at ${transaction.requestedTime.toFixed(3)}, ` +
            `packet_id=0x${audioSwitch.packetId.toString(16)}, ` +
            `strategy=${replaceMediaSource ? 'replace-media-source' : 'in-place'}`
        );
        audio_track_switch_rebuild_pending = true;
        return true;
    }

    function doesMMTSVodAudioTrackSwitchMatch(audioSwitch: any,
                                               transaction: MMTSVodAudioTrackSwitchTransaction): boolean {
        return !!audioSwitch &&
            doesPlaybackSwitchIdentityMatchOperation(audioSwitch, transaction.operation) &&
            typeof audioSwitch.packetId === 'number' && isFinite(audioSwitch.packetId) &&
            typeof audioSwitch.requestedStartMicroseconds === 'number' &&
            Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
            audioSwitch.requestedStartMicroseconds ===
                transaction.operation.requestedTimeMicroseconds &&
            transaction.confirmedPacketId !== undefined &&
            audioSwitch.packetId === transaction.confirmedPacketId;
    }

    function isMMTSAudioTrackSwitchMediaValid(audioSwitch: any): boolean {
        return !!audioSwitch &&
            typeof audioSwitch.audioDecodeStart === 'number' && isFinite(audioSwitch.audioDecodeStart) &&
            typeof audioSwitch.audioStart === 'number' && isFinite(audioSwitch.audioStart) &&
            audioSwitch.audioStart >= 0 &&
            typeof audioSwitch.audioEnd === 'number' && isFinite(audioSwitch.audioEnd) &&
            audioSwitch.audioEnd > audioSwitch.audioStart;
    }

    function isSyncVideoRebuildSegment(segment: any): boolean {
        return !!segment && !!segment.info && !!segment.info.firstSample &&
            segment.info.firstSample.isSyncPoint === true;
    }

    function getMediaSegmentRange(segment: any): {start: number, end: number} | null {
        return getMMTSSegmentDecodeRange(segment);
    }

    function onMSEBufferFull(): void {
        logMSEBufferFull();
        if (mse_buffer_state_machine) {
            mse_buffer_state_machine.onQuotaExceeded();
        }
    }

    function logMSEBufferFull(): void {
        const now = Date.now();
        if (now - last_mse_buffer_full_log_time < 30000) {
            return;
        }
        last_mse_buffer_full_log_time = now;
        Log.v(TAG, 'MSE SourceBuffer is full, report to main thread');
    }

    function onMSEError(info: any): void {
        if (handling_external_mse_error) {
            emitMSEError(info);
            return;
        }
        handling_external_mse_error = true;
        external_mse_error_reported = false;
        try {
            mse_buffer_state_machine?.onExternalMSEError(info);
            if (!external_mse_error_reported) {
                emitMSEError(info);
            }
        } finally {
            handling_external_mse_error = false;
            external_mse_error_reported = false;
        }
    }

    function emitMSEError(info: any): void {
        if (handling_external_mse_error) {
            if (external_mse_error_reported) {
                return;
            }
            external_mse_error_reported = true;
        }
        postOperationMessage({
            msg: 'player_event',
            event: PlayerEvents.ERROR,
            error_type: ErrorTypes.MEDIA_ERROR,
            error_detail: ErrorTypes.MEDIA_MSE_ERROR,
            info: info,
        } as WorkerMessagePacketPlayerEventError);
    }

    function emitTransmuxingEventsInfo(
        event: TransmuxingEvents,
        info: any,
        operation: PlaybackOperation | null = active_playback_operation
    ) {
        if (!acceptPlaybackOperation(operation)) return;
        postOperationMessage({
            msg: 'transmuxing_event',
            event: event,
            info: info,
        } as WorkerMessagePacketTransmuxingEventInfo, operation);
    }

    function emitPlayerEventsExtraData(
        event: PlayerEvents,
        extraData: any,
        operation: PlaybackOperation | null = active_playback_operation
    ) {
        if (!acceptPlaybackOperation(operation)) return;
        postOperationMessage({
            msg: 'player_event',
            event: event,
            extraData: extraData,
        } as WorkerMessagePacketPlayerEventExtraData, operation);
    }

    function onLogcatCallback(type: string, str: string): void {
        self.postMessage({
            msg: 'logcat_callback',
            type: type,
            logcat: str,
        } as WorkerMessagePacketLogcatCallback);
    }

};

export default PlayerEngineWorker;

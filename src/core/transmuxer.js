/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
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

import EventEmitter from 'events';
import work from '../utils/webworkify-webpack';
import Log from '../utils/logger.js';
import LoggingControl from '../utils/logging-control.js';
import TransmuxingController from './transmuxing-controller.js';
import TransmuxingEvents from './transmuxing-events';
import TransmuxingWorker from './transmuxing-worker.js';
import MediaInfo from './media-info.js';
import TSDemuxer from '../demux/ts-demuxer.ts';
import MMTSDemuxer from '../demux/mmts-demuxer.ts';
import {
    canAdvancePlaybackOperation,
    classifyPlaybackOperationAdvance,
    clonePlaybackOperation,
    isPlaybackOperation,
    isPlaybackOperationRetryRequest,
    isSamePlaybackOperation,
    isSamePlaybackTransaction,
} from './playback-operation';
import {isMMTSStartupGroupFailure} from './mmts-startup-group-lifecycle';

class Transmuxer {

    constructor(mediaDataSource, config) {
        this.TAG = 'Transmuxer';
        this._emitter = new EventEmitter();
        this._mmtsVodAudioTrackRebuildEpoch = 0;
        this._mmtsVodAudioTrackRebuildPending = false;
        this._mmtsVodAudioTrackRebuildSeekPending = false;
        this._isMMTS = config.isMMTS === true;
        this._playbackOperation = null;
        this._pendingPlaybackOperationRetry = null;

        if (config.enableWorker && typeof (Worker) !== 'undefined') {
            try {
                this._worker = work(require.resolve('./transmuxing-worker'));
                this._workerDestroying = false;
                this._worker.addEventListener('message', this._onWorkerMessage.bind(this));
                this._worker.postMessage({cmd: 'init', param: [mediaDataSource, config]});
                this.e = {
                    onLoggingConfigChanged: this._onLoggingConfigChanged.bind(this)
                };
                LoggingControl.registerListener(this.e.onLoggingConfigChanged);
                this._worker.postMessage({cmd: 'logging_config', param: LoggingControl.getConfig()});
            } catch (error) {
                Log.e(this.TAG, 'Error while initialize transmuxing worker, fallback to inline transmuxing');
                this._worker = null;
                this._controller = new TransmuxingController(mediaDataSource, config);
            }
        } else {
            this._controller = new TransmuxingController(mediaDataSource, config);
        }

        if (this._controller) {
            let ctl = this._controller;
            ctl.on(TransmuxingEvents.IO_ERROR, this._onIOError.bind(this));
            ctl.on(TransmuxingEvents.DEMUX_ERROR, this._onDemuxError.bind(this));
            ctl.on(TransmuxingEvents.INIT_SEGMENT, this._onInitSegment.bind(this));
            ctl.on(TransmuxingEvents.MEDIA_SEGMENT, this._onMediaSegment.bind(this));
            ctl.on(TransmuxingEvents.STARTUP_GROUP, this._onStartupGroup.bind(this));
            ctl.on(TransmuxingEvents.STARTUP_GROUP_FAILED,
                this._onStartupGroupFailed.bind(this));
            ctl.on(TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
                this._onPlaybackOperationRetryRequired.bind(this));
            ctl.on(TransmuxingEvents.LOADING_COMPLETE, this._onLoadingComplete.bind(this));
            ctl.on(TransmuxingEvents.RECOVERED_EARLY_EOF, this._onRecoveredEarlyEof.bind(this));
            ctl.on(TransmuxingEvents.MEDIA_INFO, this._onMediaInfo.bind(this));
            ctl.on(TransmuxingEvents.METADATA_ARRIVED, this._onMetaDataArrived.bind(this));
            ctl.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, this._onScriptDataArrived.bind(this));
            ctl.on(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, this._onTimedID3MetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, this._onSynchronousKLVMetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, this._onAsynchronousKLVMetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED, this._onSMPTE2038MetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.SEI_ARRIVED, this._onSEIArrived.bind(this));
            ctl.on(TransmuxingEvents.SCTE35_METADATA_ARRIVED, this._onSCTE35MetadataArrived.bind(this));
            ctl.on(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR, this._onPESPrivateDataDescriptor.bind(this));
            ctl.on(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED, this._onPESPrivateDataArrived.bind(this));
            ctl.on(TransmuxingEvents.MMTS_AUDIO_TRACKS, this._onMMTSAudioTracks.bind(this));
            ctl.on(TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
                this._onMMTSAudioTrackSelectionResult.bind(this));
            ctl.on(TransmuxingEvents.MMTS_VIDEO_TRACKS, this._onMMTSVideoTracks.bind(this));
            ctl.on(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT,
                this._onMMTSVideoTrackSelectionResult.bind(this));
            ctl.on(TransmuxingEvents.MMTS_SUBTITLE_TRACKS, this._onMMTSSubtitleTracks.bind(this));
            ctl.on(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED, this._onMMTSSubtitleDataArrived.bind(this));
            ctl.on(TransmuxingEvents.STATISTICS_INFO, this._onStatisticsInfo.bind(this));
            ctl.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, this._onRecommendSeekpoint.bind(this));
        }
    }

    destroy() {
        this._playbackOperation = null;
        this._pendingPlaybackOperationRetry = null;
        if (this._worker) {
            if (!this._workerDestroying) {
                this._workerDestroying = true;
                this._worker.postMessage({cmd: 'destroy'});
                LoggingControl.removeListener(this.e.onLoggingConfigChanged);
                this.e = null;
            }
        } else {
            this._controller.destroy();
            this._controller = null;
        }
        this._emitter.removeAllListeners();
        this._emitter = null;
    }

    on(event, listener) {
        this._emitter.addListener(event, listener);
    }

    off(event, listener) {
        this._emitter.removeListener(event, listener);
    }

    hasWorker() {
        return this._worker != null;
    }

    canSetPlaybackOperation(operation) {
        if (!this._isMMTS) {
            return true;
        }
        if (!isPlaybackOperation(operation) ||
            !['startup', 'seek', 'audio-switch', 'video-switch'].includes(operation.kind) ||
            !canAdvancePlaybackOperation(this._playbackOperation, operation)) {
            return false;
        }
        const pendingRetry = this._pendingPlaybackOperationRetry;
        if (pendingRetry &&
            isSamePlaybackTransaction(pendingRetry.sourceOperation, operation) &&
            !isSamePlaybackOperation(pendingRetry.sourceOperation, operation)) {
            return false;
        }
        return this._worker || !this._controller ||
            this._controller.canSetPlaybackOperation(operation);
    }

    setPlaybackOperation(operation) {
        if (!this._isMMTS) {
            return true;
        }
        if (!isPlaybackOperation(operation) ||
            !['startup', 'seek', 'audio-switch', 'video-switch'].includes(operation.kind)) {
            throw new TypeError('Invalid MMTS playback operation');
        }
        const nextOperation = clonePlaybackOperation(operation);
        if (!this.canSetPlaybackOperation(nextOperation)) {
            return false;
        }
        const pendingRetry = this._pendingPlaybackOperationRetry;
        if (pendingRetry &&
            !isSamePlaybackOperation(pendingRetry.sourceOperation, nextOperation)) {
            this.cancelPlaybackOperationRetry(pendingRetry.request);
        }
        if (!this._worker && this._controller &&
            !this._controller.setPlaybackOperation(nextOperation)) {
            return false;
        }
        this._playbackOperation = nextOperation;
        if (this._worker) {
            this._worker.postMessage({cmd: 'set_playback_operation', playback_operation: nextOperation});
        }
        return true;
    }

    canContinuePlaybackOperationRetry(operation, request) {
        if (!this._isMMTS || !isPlaybackOperation(operation)) {
            return false;
        }
        const pending = this._pendingPlaybackOperationRetry;
        if (!pending || !isPlaybackOperationRetryRequest(
            request,
            pending.sourceOperation
        ) || request.requestId !== pending.request.requestId ||
            !this._playbackOperation ||
            !isSamePlaybackOperation(
                this._playbackOperation,
                pending.sourceOperation
            ) || !isSamePlaybackTransaction(
                pending.sourceOperation,
                operation
            ) || operation.attempt !== pending.sourceOperation.attempt + 1 ||
            operation.phase !== 'adaptive-retry' ||
            operation.requestedTimeMicroseconds !== request.requestedTimeMicroseconds ||
            !canAdvancePlaybackOperation(this._playbackOperation, operation)) {
            return false;
        }
        return this._worker || !this._controller ||
            this._controller.canContinuePlaybackOperationRetry(
                operation,
                request
            );
    }

    continuePlaybackOperationRetry(operation, request) {
        if (!this.canContinuePlaybackOperationRetry(operation, request)) {
            return false;
        }
        const nextOperation = clonePlaybackOperation(operation);
        if (this._worker) {
            const pending = this._pendingPlaybackOperationRetry;
            this._worker.postMessage({
                cmd: 'continue_playback_operation_retry',
                playback_operation: nextOperation,
                retry_request: request,
            });
            this._pendingPlaybackOperationRetry = Object.assign({}, pending, {
                nextOperation: clonePlaybackOperation(nextOperation),
                awaitingWorkerAck: true,
            });
        } else if (!this._controller.continuePlaybackOperationRetry(
            nextOperation,
            request
        )) {
            return false;
        } else {
            this._pendingPlaybackOperationRetry = null;
        }
        this._playbackOperation = nextOperation;
        return true;
    }

    cancelPlaybackOperationRetry(request) {
        const pending = this._pendingPlaybackOperationRetry;
        if (!pending || !isPlaybackOperationRetryRequest(
            request,
            pending.sourceOperation
        ) || request.requestId !== pending.request.requestId) {
            return false;
        }
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'cancel_playback_operation_retry',
                retry_request: request,
            });
        } else if (this._controller) {
            this._controller.cancelPlaybackOperationRetry(request);
        }
        this._pendingPlaybackOperationRetry = null;
        return true;
    }

    _acceptPlaybackOperation(operation) {
        if (!this._isMMTS) {
            return true;
        }
        if (!isPlaybackOperation(operation) || !this._playbackOperation) {
            return false;
        }
        const advance = classifyPlaybackOperationAdvance(this._playbackOperation, operation);
        return advance.accepted && advance.kind === 'same-attempt' &&
            isSamePlaybackOperation(this._playbackOperation, operation);
    }

    open(operation) {
        if (this._isMMTS && !this.setPlaybackOperation(operation)) {
            return;
        }
        if (this._worker) {
            this._worker.postMessage({cmd: 'start'});
        } else {
            this._controller.start();
        }
    }

    close() {
        if (this._worker) {
            this._worker.postMessage({cmd: 'stop'});
        } else {
            this._controller.stop();
        }
    }

    seek(milliseconds, operation) {
        if (this._isMMTS && !this.setPlaybackOperation(operation)) {
            return;
        }
        const rebuildSeek = this._mmtsVodAudioTrackRebuildPending ||
            this._mmtsVodAudioTrackRebuildSeekPending;
        if (this._worker) {
            const message = {cmd: 'seek', param: milliseconds};
            if (rebuildSeek) {
                message.mmts_vod_audio_track_rebuild_epoch = this._mmtsVodAudioTrackRebuildEpoch;
            }
            this._worker.postMessage(message);
        } else {
            if (rebuildSeek) {
                this._controller.resetMMTSStartupGroup();
            }
            this._controller.seek(milliseconds);
        }
        this._mmtsVodAudioTrackRebuildSeekPending = false;
    }

    seekAndSelectAudioTrack(milliseconds, operation, packetId, timelineSeed, switchIdentity) {
        if (this._isMMTS && !this.setPlaybackOperation(operation)) {
            return false;
        }
        const rebuildSeek = this._mmtsVodAudioTrackRebuildPending ||
            this._mmtsVodAudioTrackRebuildSeekPending;
        if (!rebuildSeek) {
            return false;
        }
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'seek_and_select_audio_track',
                param: milliseconds,
                packet_id: packetId,
                timeline_seed: timelineSeed,
                mmts_audio_switch_identity: switchIdentity,
                mmts_vod_audio_track_rebuild_epoch: this._mmtsVodAudioTrackRebuildEpoch
            });
        } else {
            this._controller.resetMMTSStartupGroup();
            this._controller.seek(milliseconds);
            if (this._controller._demuxer instanceof MMTSDemuxer) {
                this._controller.selectAudioTrack(packetId, timelineSeed, true, switchIdentity);
            }
        }
        this._mmtsVodAudioTrackRebuildSeekPending = false;
        return true;
    }

    seekAndSelectVideoTrack(milliseconds, operation, packetId, switchIdentity) {
        if (this._isMMTS && !this.setPlaybackOperation(operation)) {
            return false;
        }
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'seek_and_select_video_track',
                param: milliseconds,
                packet_id: packetId,
                mmts_video_switch_identity: switchIdentity,
            });
        } else {
            this._controller.seek(milliseconds);
            if (this._controller._demuxer instanceof MMTSDemuxer) {
                this._controller.selectVideoTrack(packetId, switchIdentity, true);
            }
        }
        return true;
    }

    pause() {
        if (this._worker) {
            this._worker.postMessage({cmd: 'pause'});
        } else {
            this._controller.pause();
        }
    }

    resume() {
        if (this._worker) {
            this._worker.postMessage({cmd: 'resume'});
        } else {
            this._controller.resume();
        }
    }

    switchPrimaryAudio(timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'switch_audio',
                param: 'primary',
                timeline_seed: timelineSeed,
                rebuild_from_seek: rebuildFromSeek,
                mmts_audio_switch_identity: switchIdentity,
                mmts_vod_audio_track_rebuild_epoch: rebuildFromSeek ?
                    this._mmtsVodAudioTrackRebuildEpoch : undefined
            });
        } else {
            if (this._controller._demuxer instanceof TSDemuxer) {
                this._controller._demuxer.preferred_secondary_audio = false;
            } else if (this._controller._demuxer instanceof MMTSDemuxer) {
                this._controller.selectPrimaryAudioTrack(timelineSeed, rebuildFromSeek, switchIdentity);
            }
        }
    }

    switchSecondaryAudio(timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'switch_audio',
                param: 'secondary',
                timeline_seed: timelineSeed,
                rebuild_from_seek: rebuildFromSeek,
                mmts_audio_switch_identity: switchIdentity,
                mmts_vod_audio_track_rebuild_epoch: rebuildFromSeek ?
                    this._mmtsVodAudioTrackRebuildEpoch : undefined
            });
        } else {
            if (this._controller._demuxer instanceof TSDemuxer) {
                this._controller._demuxer.preferred_secondary_audio = true;
            } else if (this._controller._demuxer instanceof MMTSDemuxer) {
                this._controller.selectSecondaryAudioTrack(timelineSeed, rebuildFromSeek, switchIdentity);
            }
        }
    }

    selectAudioTrack(packetId, timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'select_audio_track',
                packet_id: packetId,
                timeline_seed: timelineSeed,
                rebuild_from_seek: rebuildFromSeek,
                mmts_audio_switch_identity: switchIdentity,
                mmts_vod_audio_track_rebuild_epoch: rebuildFromSeek ?
                    this._mmtsVodAudioTrackRebuildEpoch : undefined
            });
        } else if (this._controller._demuxer instanceof MMTSDemuxer) {
            this._controller.selectAudioTrack(packetId, timelineSeed, rebuildFromSeek, switchIdentity);
        }
    }

    selectVideoTrack(packetId, switchIdentity) {
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'select_video_track',
                packet_id: packetId,
                mmts_video_switch_identity: switchIdentity,
            });
        } else if (this._controller._demuxer instanceof MMTSDemuxer) {
            return this._controller.selectVideoTrack(packetId, switchIdentity);
        }
    }

    beginMMTSVodAudioTrackRebuild() {
        this._mmtsVodAudioTrackRebuildEpoch++;
        this._mmtsVodAudioTrackRebuildPending = true;
        this._mmtsVodAudioTrackRebuildSeekPending = false;
    }

    completeMMTSVodAudioTrackRebuild() {
        this._mmtsVodAudioTrackRebuildPending = false;
    }

    acknowledgeMMTSVodAudioTrackStartup(identity) {
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'ack_mmts_vod_audio_track_startup',
                mmts_audio_switch_identity: identity
            });
        } else {
            this._controller.acknowledgeMMTSVodAudioTrackStartup(identity);
        }
    }

    cancelMMTSVodAudioTrackRebuild() {
        this._mmtsVodAudioTrackRebuildEpoch++;
        this._mmtsVodAudioTrackRebuildPending = false;
        this._mmtsVodAudioTrackRebuildSeekPending = true;
        if (this._worker) {
            this._worker.postMessage({
                cmd: 'sync_mmts_vod_audio_track_rebuild_epoch',
                mmts_vod_audio_track_rebuild_epoch: this._mmtsVodAudioTrackRebuildEpoch
            });
        } else {
            this._controller.cancelMMTSVodAudioTrackRebuild();
        }
    }

    _emitMMTSVodAudioTrackRebuildEvent(event, args, defer, sourceEpoch, operation) {
        const epoch = sourceEpoch !== undefined ? sourceEpoch : this._mmtsVodAudioTrackRebuildEpoch;
        const emit = () => {
            if (!this._acceptPlaybackOperation(operation)) {
                return;
            }
            if (this._mmtsVodAudioTrackRebuildPending ||
                epoch !== this._mmtsVodAudioTrackRebuildEpoch) {
                return;
            }
            this._emitter.emit.apply(this._emitter, [event].concat(args, [operation]));
        };

        if (defer) {
            Promise.resolve().then(emit);
        } else {
            emit();
        }
    }

    _emitMMTSVodAudioTrackSelectionEvent(event, args, defer, sourceEpoch, operation) {
        const epoch = sourceEpoch !== undefined ? sourceEpoch : this._mmtsVodAudioTrackRebuildEpoch;
        const emit = () => {
            if (!this._acceptPlaybackOperation(operation)) {
                return;
            }
            if (epoch !== this._mmtsVodAudioTrackRebuildEpoch) {
                return;
            }
            this._emitter.emit.apply(this._emitter, [event].concat(args, [operation]));
        };

        if (defer) {
            Promise.resolve().then(emit);
        } else {
            emit();
        }
    }

    _isMMTSOutputSegmentValid(segment, operation) {
        if (!this._isMMTS) {
            return true;
        }
        return !!segment && isSamePlaybackOperation(segment.playbackOperation, operation) &&
            segment.mseBufferGeneration === operation.timelineGeneration;
    }

    _isMMTSStartupGroupValid(startupGroup, operation) {
        if (!this._isMMTS) {
            return true;
        }
        if (!startupGroup || !isSamePlaybackOperation(startupGroup.playbackOperation, operation) ||
            startupGroup.mseBufferGeneration !== operation.timelineGeneration ||
            !this._isMMTSOutputSegmentValid(startupGroup.videoInitSegment, operation) ||
            !this._isMMTSOutputSegmentValid(startupGroup.videoMediaSegment, operation)) {
            return false;
        }
        if (startupGroup.hasAudio === true) {
            return this._isMMTSOutputSegmentValid(startupGroup.audioInitSegment, operation) &&
                this._isMMTSOutputSegmentValid(startupGroup.audioMediaSegment, operation);
        }
        return startupGroup.hasAudio === false && startupGroup.audioInitSegment === null &&
            startupGroup.audioMediaSegment === null;
    }

    _onInitSegment(type, initSegment, operation) {
        if (!this._isMMTSOutputSegmentValid(initSegment, operation)) {
            return;
        }
        // do async invoke
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.INIT_SEGMENT,
            [type, initSegment],
            true, undefined, operation
        );
    }

    _onMediaSegment(type, mediaSegment, operation) {
        if (!this._isMMTSOutputSegmentValid(mediaSegment, operation)) {
            return;
        }
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.MEDIA_SEGMENT,
            [type, mediaSegment],
            true, undefined, operation
        );
    }

    _onStartupGroup(startupGroup, operation) {
        if (!this._isMMTSStartupGroupValid(startupGroup, operation)) {
            return;
        }
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.STARTUP_GROUP,
            [startupGroup],
            true, undefined, operation
        );
    }

    _onStartupGroupFailed(failure, operation) {
        if (!isMMTSStartupGroupFailure(failure, operation)) {
            return;
        }
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.STARTUP_GROUP_FAILED,
            [failure],
            true, undefined, operation
        );
    }

    _onPlaybackOperationRetryRequired(request, operation) {
        if (!this._isMMTS || !this._playbackOperation ||
            !isSamePlaybackOperation(this._playbackOperation, operation) ||
            !isPlaybackOperationRetryRequest(request, operation)) {
            return;
        }
        this._pendingPlaybackOperationRetry = {
            request,
            sourceOperation: clonePlaybackOperation(operation),
        };
        this._emitter.emit(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
            request,
            operation
        );
    }

    _onLoadingComplete(operation) {
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.LOADING_COMPLETE,
            [],
            true, undefined, operation
        );
    }

    _onRecoveredEarlyEof(operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) {
                this._emitter.emit(TransmuxingEvents.RECOVERED_EARLY_EOF, operation);
            }
        });
    }

    _onMediaInfo(mediaInfo, operation) {
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.MEDIA_INFO,
            [mediaInfo],
            true, undefined, operation
        );
    }

    _onMetaDataArrived(metadata, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) {
                this._emitter.emit(TransmuxingEvents.METADATA_ARRIVED, metadata, operation);
            }
        });
    }

    _onScriptDataArrived(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data, operation);
        });
    }

    _onTimedID3MetadataArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, data, operation);
        });
    }

    _onPGSSubtitleArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.PGS_SUBTITLE_ARRIVED, data, operation);
        });
    }

    _onSynchronousKLVMetadataArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, data, operation);
        })
    }

    _onAsynchronousKLVMetadataArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, data, operation);
        })
    }

    _onSMPTE2038MetadataArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED, data, operation);
        })
    }

    _onSEIArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.SEI_ARRIVED, data, operation);
        })
    }

    _onSCTE35MetadataArrived (data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.SCTE35_METADATA_ARRIVED, data, operation);
        })
    }

    _onPESPrivateDataDescriptor(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR, data, operation);
        });
    }

    _onPESPrivateDataArrived(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED, data, operation);
        });
    }

    _onMMTSAudioTracks(data, operation) {
        this._emitMMTSVodAudioTrackSelectionEvent(
            TransmuxingEvents.MMTS_AUDIO_TRACKS,
            [data],
            true, undefined, operation
        );
    }

    _onMMTSAudioTrackSelectionResult(data, operation) {
        this._emitMMTSVodAudioTrackSelectionEvent(
            TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
            [data],
            true, undefined, operation
        );
    }

    _onMMTSVideoTracks(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.MMTS_VIDEO_TRACKS, data, operation);
        });
    }

    _onMMTSVideoTrackSelectionResult(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) {
                this._emitter.emit(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT, data, operation);
            }
        });
    }

    _onMMTSSubtitleTracks(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.MMTS_SUBTITLE_TRACKS, data, operation);
        });
    }

    _onMMTSSubtitleDataArrived(data, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED, data, operation);
        });
    }

    _onStatisticsInfo(statisticsInfo, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, statisticsInfo, operation);
        });
    }

    _onIOError(type, info, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.IO_ERROR, type, info, operation);
        });
    }

    _onDemuxError(type, info, operation) {
        Promise.resolve().then(() => {
            if (this._acceptPlaybackOperation(operation)) this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, type, info, operation);
        });
    }

    _onRecommendSeekpoint(milliseconds, operation) {
        this._emitMMTSVodAudioTrackRebuildEvent(
            TransmuxingEvents.RECOMMEND_SEEKPOINT,
            [milliseconds],
            true, undefined, operation
        );
    }

    _onLoggingConfigChanged(config) {
        if (this._worker) {
            this._worker.postMessage({cmd: 'logging_config', param: config});
        }
    }

    _onWorkerMessage(e) {
        let message = e.data;
        let data = message.data;
        const operation = message.playback_operation;
        const sourceEpoch = typeof message.mmts_vod_audio_track_rebuild_epoch === 'number' &&
            isFinite(message.mmts_vod_audio_track_rebuild_epoch) ?
            message.mmts_vod_audio_track_rebuild_epoch : -1;

        if (message.msg === 'destroyed' || this._workerDestroying) {
            this._workerDestroying = false;
            this._worker.terminate();
            this._worker = null;
            return;
        }

        switch (message.msg) {
            case TransmuxingEvents.INIT_SEGMENT:
            case TransmuxingEvents.MEDIA_SEGMENT:
                if (!this._isMMTSOutputSegmentValid(data.data, operation)) {
                    break;
                }
                this._emitMMTSVodAudioTrackRebuildEvent(message.msg, [data.type, data.data], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.STARTUP_GROUP:
                if (!this._isMMTSStartupGroupValid(data, operation)) {
                    break;
                }
                this._emitMMTSVodAudioTrackRebuildEvent(message.msg, [data], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.STARTUP_GROUP_FAILED:
                if (!isMMTSStartupGroupFailure(data, operation)) {
                    break;
                }
                this._emitMMTSVodAudioTrackRebuildEvent(
                    message.msg,
                    [data],
                    false,
                    sourceEpoch,
                    operation
                );
                break;
            case TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED:
                this._onPlaybackOperationRetryRequired(data, operation);
                break;
            case 'playback_operation_retry_continued': {
                const pending = this._pendingPlaybackOperationRetry;
                const retryOperation = message.retry_operation;
                if (pending && pending.awaitingWorkerAck === true &&
                    isPlaybackOperationRetryRequest(data, pending.sourceOperation) &&
                    data.requestId === pending.request.requestId &&
                    isSamePlaybackOperation(retryOperation, pending.nextOperation) &&
                    isSamePlaybackOperation(operation, retryOperation)) {
                    this._pendingPlaybackOperationRetry = null;
                }
                break;
            }
            case TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED: {
                const pending = this._pendingPlaybackOperationRetry;
                const retryOperation = message.retry_operation;
                if (!pending || pending.awaitingWorkerAck !== true ||
                    !isPlaybackOperationRetryRequest(data, pending.sourceOperation) ||
                    data.requestId !== pending.request.requestId ||
                    !isSamePlaybackOperation(retryOperation, pending.nextOperation)) {
                    break;
                }
                const sourceOperation = pending.sourceOperation;
                this._pendingPlaybackOperationRetry = null;
                this._emitter.emit(
                    TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED,
                    data,
                    retryOperation,
                    sourceOperation
                );
                break;
            }
            case TransmuxingEvents.LOADING_COMPLETE:
                this._emitMMTSVodAudioTrackRebuildEvent(message.msg, [], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.RECOVERED_EARLY_EOF:
                if (this._acceptPlaybackOperation(operation)) this._emitter.emit(message.msg, operation);
                break;
            case TransmuxingEvents.MEDIA_INFO:
                Object.setPrototypeOf(data, MediaInfo.prototype);
                this._emitMMTSVodAudioTrackRebuildEvent(message.msg, [data], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.METADATA_ARRIVED:
            case TransmuxingEvents.SCRIPTDATA_ARRIVED:
            case TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED:
            case TransmuxingEvents.PGS_SUBTITLE_ARRIVED:
            case TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED:
            case TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED:
            case TransmuxingEvents.SMPTE2038_METADATA_ARRIVED:
            case TransmuxingEvents.SCTE35_METADATA_ARRIVED:
            case TransmuxingEvents.SEI_ARRIVED:
            case TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR:
            case TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED:
            case TransmuxingEvents.MMTS_VIDEO_TRACKS:
            case TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT:
            case TransmuxingEvents.MMTS_SUBTITLE_TRACKS:
            case TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED:
            case TransmuxingEvents.STATISTICS_INFO:
                if (this._acceptPlaybackOperation(operation)) this._emitter.emit(message.msg, data, operation);
                break;
            case TransmuxingEvents.MMTS_AUDIO_TRACKS:
                this._emitMMTSVodAudioTrackSelectionEvent(message.msg, [data], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT:
                this._emitMMTSVodAudioTrackSelectionEvent(message.msg, [data], false, sourceEpoch, operation);
                break;
            case TransmuxingEvents.IO_ERROR:
            case TransmuxingEvents.DEMUX_ERROR:
                if (this._acceptPlaybackOperation(operation)) this._emitter.emit(message.msg, data.type, data.info, operation);
                break;
            case TransmuxingEvents.RECOMMEND_SEEKPOINT:
                this._emitMMTSVodAudioTrackRebuildEvent(message.msg, [data], false, sourceEpoch, operation);
                break;
            case 'logcat_callback':
                Log.emitter.emit('log', data.type, data.logcat);
                break;
            default:
                break;
        }
    }

}

export default Transmuxer;

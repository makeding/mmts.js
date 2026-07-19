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

import Log from '../utils/logger.js';
import LoggingControl from '../utils/logging-control.js';
import Polyfill from '../utils/polyfill.js';
import TransmuxingController from './transmuxing-controller.js';
import TransmuxingEvents from './transmuxing-events';
import TSDemuxer from '../demux/ts-demuxer.ts';
import MMTSDemuxer from '../demux/mmts-demuxer.ts';
import {
    canAdvancePlaybackOperation,
    clonePlaybackOperation,
    isPlaybackOperation,
    isPlaybackOperationRetryRequest,
    isSamePlaybackOperation,
} from './playback-operation';
import {isMMTSStartupGroupFailure} from './mmts-startup-group-lifecycle';

/* post message to worker:
   data: {
       cmd: string
       param: any
   }

   receive message from worker:
   data: {
       msg: string,
       data: any
   }
 */

let TransmuxingWorker = function (self) {

    let TAG = 'TransmuxingWorker';
    let controller = null;
    let logcatListener = onLogcatCallback.bind(this);
    let mmtsVodAudioTrackRebuildEpoch = 0;
    let playbackOperation = null;
    let isMMTS = false;

    Polyfill.install();

    self.addEventListener('message', function (e) {
        switch (e.data.cmd) {
            case 'init':
                isMMTS = e.data.param[1].isMMTS === true;
                controller = new TransmuxingController(e.data.param[0], e.data.param[1]);
                controller.on(TransmuxingEvents.IO_ERROR, onIOError.bind(this));
                controller.on(TransmuxingEvents.DEMUX_ERROR, onDemuxError.bind(this));
                controller.on(TransmuxingEvents.INIT_SEGMENT, onInitSegment.bind(this));
                controller.on(TransmuxingEvents.MEDIA_SEGMENT, onMediaSegment.bind(this));
                controller.on(TransmuxingEvents.STARTUP_GROUP, onStartupGroup.bind(this));
                controller.on(TransmuxingEvents.STARTUP_GROUP_FAILED,
                    onStartupGroupFailed.bind(this));
                controller.on(TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
                    onPlaybackOperationRetryRequired.bind(this));
                controller.on(TransmuxingEvents.LOADING_COMPLETE, onLoadingComplete.bind(this));
                controller.on(TransmuxingEvents.RECOVERED_EARLY_EOF, onRecoveredEarlyEof.bind(this));
                controller.on(TransmuxingEvents.MEDIA_INFO, onMediaInfo.bind(this));
                controller.on(TransmuxingEvents.METADATA_ARRIVED, onMetaDataArrived.bind(this));
                controller.on(TransmuxingEvents.SCRIPTDATA_ARRIVED, onScriptDataArrived.bind(this));
                controller.on(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, onTimedID3MetadataArrived.bind(this));
                controller.on(TransmuxingEvents.PGS_SUBTITLE_ARRIVED, onPGSSubtitleDataArrived.bind(this));
                controller.on(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, onSynchronousKLVMetadataArrived.bind(this));
                controller.on(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, onAsynchronousKLVMetadataArrived.bind(this));
                controller.on(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED, onSMPTE2038MetadataArrived.bind(this));
                controller.on(TransmuxingEvents.SEI_ARRIVED, onSEIArrived.bind(this));
                controller.on(TransmuxingEvents.SCTE35_METADATA_ARRIVED, onSCTE35MetadataArrived.bind(this));
                controller.on(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR, onPESPrivateDataDescriptor.bind(this));
                controller.on(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED, onPESPrivateDataArrived.bind(this));
                controller.on(TransmuxingEvents.MMTS_AUDIO_TRACKS, onMMTSAudioTracks.bind(this));
                controller.on(TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
                    onMMTSAudioTrackSelectionResult.bind(this));
                controller.on(TransmuxingEvents.MMTS_VIDEO_TRACKS, onMMTSVideoTracks.bind(this));
                controller.on(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT,
                    onMMTSVideoTrackSelectionResult.bind(this));
                controller.on(TransmuxingEvents.MMTS_SUBTITLE_TRACKS, onMMTSSubtitleTracks.bind(this));
                controller.on(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED, onMMTSSubtitleDataArrived.bind(this));
                controller.on(TransmuxingEvents.STATISTICS_INFO, onStatisticsInfo.bind(this));
                controller.on(TransmuxingEvents.RECOMMEND_SEEKPOINT, onRecommendSeekpoint.bind(this));
                break;
            case 'destroy':
                if (controller) {
                    controller.destroy();
                    controller = null;
                }
                self.postMessage({msg: 'destroyed'});
                break;
            case 'set_playback_operation':
                if (!isPlaybackOperation(e.data.playback_operation) ||
                    !['startup', 'seek', 'audio-switch', 'video-switch'].includes(e.data.playback_operation.kind)) {
                    throw new TypeError('Invalid MMTS playback operation');
                }
                const nextOperation = clonePlaybackOperation(e.data.playback_operation);
                if (!canAdvancePlaybackOperation(playbackOperation, nextOperation)) {
                    break;
                }
                if (controller.setPlaybackOperation(nextOperation)) {
                    playbackOperation = nextOperation;
                }
                break;
            case 'continue_playback_operation_retry': {
                const retryOperation = e.data.playback_operation;
                const retryRequest = e.data.retry_request;
                if (!isPlaybackOperation(retryOperation) ||
                    !isPlaybackOperationRetryRequest(retryRequest, playbackOperation) ||
                    !controller.canContinuePlaybackOperationRetry(
                        retryOperation,
                        retryRequest
                    )) {
                    self.postMessage({
                        msg: TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED,
                        playback_operation: playbackOperation,
                        retry_operation: retryOperation,
                        data: retryRequest,
                    });
                    break;
                }
                if (controller.continuePlaybackOperationRetry(
                    retryOperation,
                    retryRequest
                )) {
                    playbackOperation = clonePlaybackOperation(retryOperation);
                    self.postMessage({
                        msg: 'playback_operation_retry_continued',
                        playback_operation: playbackOperation,
                        retry_operation: retryOperation,
                        data: retryRequest,
                    });
                } else {
                    self.postMessage({
                        msg: TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REJECTED,
                        playback_operation: playbackOperation,
                        retry_operation: retryOperation,
                        data: retryRequest,
                    });
                }
                break;
            }
            case 'cancel_playback_operation_retry':
                controller.cancelPlaybackOperationRetry(e.data.retry_request);
                break;
            case 'start':
                controller.start();
                break;
            case 'stop':
                controller.stop();
                break;
            case 'seek':
                updateMMTSVodAudioTrackRebuildEpoch(e.data);
                if (hasMMTSVodAudioTrackRebuildEpoch(e.data)) {
                    controller.resetMMTSStartupGroup();
                }
                controller.seek(e.data.param);
                break;
            case 'seek_and_select_audio_track':
                // Keep selection in the seek task so new range data cannot expose
                // the previous audio track to the startup collector first.
                updateMMTSVodAudioTrackRebuildEpoch(e.data);
                controller.resetMMTSStartupGroup();
                controller.seek(e.data.param);
                if (controller._demuxer instanceof MMTSDemuxer) {
                    controller.selectAudioTrack(
                        e.data.packet_id,
                        e.data.timeline_seed,
                        true,
                        e.data.mmts_audio_switch_identity
                    );
                }
                break;
            case 'seek_and_select_video_track':
                controller.seek(e.data.param);
                if (controller._demuxer instanceof MMTSDemuxer) {
                    controller.selectVideoTrack(
                        e.data.packet_id,
                        e.data.mmts_video_switch_identity,
                        true
                    );
                }
                break;
            case 'pause':
                controller.pause();
                break;
            case 'resume':
                controller.resume();
                break;
            case 'sync_mmts_vod_audio_track_rebuild_epoch':
                updateMMTSVodAudioTrackRebuildEpoch(e.data);
                controller.cancelMMTSVodAudioTrackRebuild();
                break;
            case 'ack_mmts_vod_audio_track_startup':
                controller.acknowledgeMMTSVodAudioTrackStartup(e.data.mmts_audio_switch_identity);
                break;
            case 'logging_config': {
                let config = e.data.param;
                LoggingControl.applyConfig(config);

                if (config.enableCallback === true) {
                    LoggingControl.addLogListener(logcatListener);
                } else {
                    LoggingControl.removeLogListener(logcatListener);
                }
                break;
            }
            case 'switch_audio':
                updateMMTSVodAudioTrackRebuildEpoch(e.data);
                const audioTrack = e.data.audio_track || e.data.param;
                if (controller._demuxer instanceof TSDemuxer) {
                    if (audioTrack === 'primary') {
                        controller._demuxer.preferred_secondary_audio = false;
                    } else if (audioTrack === 'secondary') {
                        controller._demuxer.preferred_secondary_audio = true;
                    }
                } else if (controller._demuxer instanceof MMTSDemuxer) {
                    if (audioTrack === 'primary') {
                        controller.selectPrimaryAudioTrack(
                            e.data.timeline_seed,
                            e.data.rebuild_from_seek === true,
                            e.data.mmts_audio_switch_identity
                        );
                    } else if (audioTrack === 'secondary') {
                        controller.selectSecondaryAudioTrack(
                            e.data.timeline_seed,
                            e.data.rebuild_from_seek === true,
                            e.data.mmts_audio_switch_identity
                        );
                    }
                }
                break;
            case 'select_audio_track':
                updateMMTSVodAudioTrackRebuildEpoch(e.data);
                if (controller._demuxer instanceof MMTSDemuxer) {
                    controller.selectAudioTrack(
                        e.data.packet_id,
                        e.data.timeline_seed,
                        e.data.rebuild_from_seek === true,
                        e.data.mmts_audio_switch_identity
                    );
                }
                break;
            case 'select_video_track':
                if (controller._demuxer instanceof MMTSDemuxer) {
                    controller.selectVideoTrack(
                        e.data.packet_id,
                        e.data.mmts_video_switch_identity
                    );
                }
                break;
        }
    });

    function updateMMTSVodAudioTrackRebuildEpoch(message) {
        const epoch = message && message.mmts_vod_audio_track_rebuild_epoch;
        if (typeof epoch === 'number' && isFinite(epoch) && epoch >= 0) {
            mmtsVodAudioTrackRebuildEpoch = epoch;
        }
    }

    function hasMMTSVodAudioTrackRebuildEpoch(message) {
        const epoch = message && message.mmts_vod_audio_track_rebuild_epoch;
        return typeof epoch === 'number' && isFinite(epoch) && epoch >= 0;
    }

    function isMMTSOutputSegmentValid(segment, operation) {
        if (!isMMTS) {
            return true;
        }
        return !!segment && isSamePlaybackOperation(segment.playbackOperation, operation) &&
            segment.mseBufferGeneration === operation.timelineGeneration;
    }

    function isMMTSStartupGroupValid(startupGroup, operation) {
        if (!isMMTS) {
            return true;
        }
        if (!startupGroup || !isSamePlaybackOperation(startupGroup.playbackOperation, operation) ||
            startupGroup.mseBufferGeneration !== operation.timelineGeneration ||
            !isMMTSOutputSegmentValid(startupGroup.videoInitSegment, operation) ||
            !isMMTSOutputSegmentValid(startupGroup.videoMediaSegment, operation)) {
            return false;
        }
        if (startupGroup.hasAudio === true) {
            return isMMTSOutputSegmentValid(startupGroup.audioInitSegment, operation) &&
                isMMTSOutputSegmentValid(startupGroup.audioMediaSegment, operation);
        }
        return startupGroup.hasAudio === false && startupGroup.audioInitSegment === null &&
            startupGroup.audioMediaSegment === null;
    }

    function onInitSegment(type, initSegment, operation) {
        if (!isMMTSOutputSegmentValid(initSegment, operation)) {
            return;
        }
        let obj = {
            msg: TransmuxingEvents.INIT_SEGMENT,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            playback_operation: operation,
            data: {
                type: type,
                data: initSegment
            }
        };
        self.postMessage(obj, [initSegment.data]);  // data: ArrayBuffer
    }

    function onMediaSegment(type, mediaSegment, operation) {
        if (!isMMTSOutputSegmentValid(mediaSegment, operation)) {
            return;
        }
        let obj = {
            msg: TransmuxingEvents.MEDIA_SEGMENT,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            playback_operation: operation,
            data: {
                type: type,
                data: mediaSegment
            }
        };
        self.postMessage(obj, [mediaSegment.data]);  // data: ArrayBuffer
    }

    function onStartupGroup(startupGroup, operation) {
        if (!isMMTSStartupGroupValid(startupGroup, operation)) {
            return;
        }
        const transfers = [];
        const segments = [
            startupGroup.videoInitSegment,
            startupGroup.audioInitSegment,
            startupGroup.videoMediaSegment,
            startupGroup.audioMediaSegment
        ];
        for (let i = 0; i < segments.length; i++) {
            const data = segments[i] && segments[i].data;
            if (data instanceof ArrayBuffer && transfers.indexOf(data) < 0) {
                transfers.push(data);
            }
        }
        self.postMessage({
            msg: TransmuxingEvents.STARTUP_GROUP,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data: startupGroup
        }, transfers);
    }

    function onStartupGroupFailed(failure, operation) {
        if (!isMMTSStartupGroupFailure(failure, operation)) {
            return;
        }
        self.postMessage({
            msg: TransmuxingEvents.STARTUP_GROUP_FAILED,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data: failure
        });
    }

    function onPlaybackOperationRetryRequired(request, operation) {
        if (!isPlaybackOperationRetryRequest(request, operation) ||
            !isSamePlaybackOperation(operation, playbackOperation)) {
            return;
        }
        self.postMessage({
            msg: TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
            playback_operation: operation,
            data: request,
        });
    }

    function onLoadingComplete(operation) {
        let obj = {
            msg: TransmuxingEvents.LOADING_COMPLETE,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch
        };
        self.postMessage(obj);
    }

    function onRecoveredEarlyEof(operation) {
        let obj = {
            msg: TransmuxingEvents.RECOVERED_EARLY_EOF,
            playback_operation: operation
        };
        self.postMessage(obj);
    }

    function onMediaInfo(mediaInfo, operation) {
        let obj = {
            msg: TransmuxingEvents.MEDIA_INFO,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data: mediaInfo
        };
        self.postMessage(obj);
    }

    function onMetaDataArrived(metadata, operation) {
        let obj = {
            msg: TransmuxingEvents.METADATA_ARRIVED,
            playback_operation: operation,
            data: metadata
        };
        self.postMessage(obj);
    }

    function onScriptDataArrived(data, operation) {
        let obj = {
            msg: TransmuxingEvents.SCRIPTDATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onTimedID3MetadataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onPGSSubtitleDataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.PGS_SUBTITLE_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onSynchronousKLVMetadataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onAsynchronousKLVMetadataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onSMPTE2038MetadataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.SMPTE2038_METADATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onSEIArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.SEI_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onSCTE35MetadataArrived (data, operation) {
        let obj = {
            msg: TransmuxingEvents.SCTE35_METADATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onPESPrivateDataDescriptor(data, operation) {
        let obj = {
            msg: TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onPESPrivateDataArrived(data, operation) {
        let obj = {
            msg: TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onMMTSAudioTracks(data, operation) {
        let obj = {
            msg: TransmuxingEvents.MMTS_AUDIO_TRACKS,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data: data
        };
        self.postMessage(obj);
    }

    function onMMTSAudioTrackSelectionResult(data, operation) {
        self.postMessage({
            msg: TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data,
        });
    }

    function onMMTSVideoTracks(data, operation) {
        let obj = {
            msg: TransmuxingEvents.MMTS_VIDEO_TRACKS,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onMMTSVideoTrackSelectionResult(data, operation) {
        self.postMessage({
            msg: TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT,
            playback_operation: operation,
            data,
        });
    }

    function onMMTSSubtitleTracks(data, operation) {
        let obj = {
            msg: TransmuxingEvents.MMTS_SUBTITLE_TRACKS,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onMMTSSubtitleDataArrived(data, operation) {
        let obj = {
            msg: TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED,
            playback_operation: operation,
            data: data
        };
        self.postMessage(obj);
    }

    function onStatisticsInfo(statInfo, operation) {
        let obj = {
            msg: TransmuxingEvents.STATISTICS_INFO,
            playback_operation: operation,
            data: statInfo
        };
        self.postMessage(obj);
    }

    function onIOError(type, info, operation) {
        self.postMessage({
            msg: TransmuxingEvents.IO_ERROR,
            playback_operation: operation,
            data: {
                type: type,
                info: info
            }
        });
    }

    function onDemuxError(type, info, operation) {
        self.postMessage({
            msg: TransmuxingEvents.DEMUX_ERROR,
            playback_operation: operation,
            data: {
                type: type,
                info: info
            }
        });
    }

    function onRecommendSeekpoint(milliseconds, operation) {
        self.postMessage({
            msg: TransmuxingEvents.RECOMMEND_SEEKPOINT,
            playback_operation: operation,
            mmts_vod_audio_track_rebuild_epoch: mmtsVodAudioTrackRebuildEpoch,
            data: milliseconds
        });
    }

    function onLogcatCallback(type, str) {
        self.postMessage({
            msg: 'logcat_callback',
            data: {
                type: type,
                logcat: str
            }
        });
    }

};

export default TransmuxingWorker;

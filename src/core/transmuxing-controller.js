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
import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import MediaInfo from './media-info.js';
import FLVDemuxer from '../demux/flv-demuxer.js';
import TSDemuxer from '../demux/ts-demuxer';
import MMTSDemuxer from '../demux/mmts-demuxer';
import MP4Remuxer from '../remux/mp4-remuxer.js';
import DemuxErrors from '../demux/demux-errors.js';
import IOController from '../io/io-controller.js';
import TransmuxingEvents from './transmuxing-events';
import {LoaderStatus, LoaderErrors} from '../io/loader.js';
import {
    canAdvancePlaybackOperation,
    clonePlaybackOperation,
    createPlaybackSwitchIdentity,
    doesPlaybackSwitchIdentityMatchOperation,
    isPlaybackOperation,
    isPlaybackOperationRetryRequest,
    isPlaybackSwitchIdentity,
    isSamePlaybackAttempt,
    isSamePlaybackOperation,
    isSamePlaybackTransaction,
} from './playback-operation';
import {
    createMMTSStartupGroupFailure,
    resolveMMTSStartupGroupTimeout,
} from './mmts-startup-group-lifecycle';

class PlaybackOperationEventEmitter extends EventEmitter {
    constructor(getOperation, requireOperation) {
        super();
        this._getOperation = getOperation;
        this._requireOperation = requireOperation;
        this._deferralScope = null;
    }

    emit(event, ...args) {
        const operation = this._getOperation();
        if (this._requireOperation() && !operation) {
            return false;
        }
        if (this._deferralScope) {
            this._deferralScope.events.push({event, args, operation});
            return true;
        }
        args.push(operation);
        return super.emit(event, ...args);
    }

    beginDeferral() {
        if (this._deferralScope) {
            throw new Error('Nested transmuxing event deferral is not supported');
        }
        const scope = {events: []};
        this._deferralScope = scope;
        return scope;
    }

    emitImmediately(event, ...args) {
        const operation = this._getOperation();
        if (this._requireOperation() && !operation) {
            return false;
        }
        args.push(operation);
        return super.emit(event, ...args);
    }

    flushDeferral(scope) {
        if (this._deferralScope !== scope) {
            throw new Error('Invalid transmuxing event deferral scope');
        }
        this._deferralScope = null;
        for (let i = 0; i < scope.events.length; i++) {
            const deferred = scope.events[i];
            super.emit(deferred.event, ...deferred.args, deferred.operation);
        }
    }

    abortDeferral(scope) {
        if (this._deferralScope !== scope) {
            return false;
        }
        this._deferralScope = null;
        scope.events.length = 0;
        return true;
    }
}

// Transmuxing (IO, Demuxing, Remuxing) controller, with multipart support
class TransmuxingController {

    constructor(mediaDataSource, config) {
        this.TAG = 'TransmuxingController';
        this._playbackOperation = null;
        this._producerPlaybackOperation = null;
        this._activeIOProducer = null;
        this._emitter = new PlaybackOperationEventEmitter(() => {
            const operation = this._producerPlaybackOperation;
            return operation ? clonePlaybackOperation(operation) : null;
        }, () => this._config && this._config.isMMTS === true);

        this._config = config;
        this._mmtsStartupGroupTimeout = resolveMMTSStartupGroupTimeout(config);

        // treat single part media as multipart media, which has only one segment
        if (!mediaDataSource.segments) {
            mediaDataSource.segments = [{
                duration: mediaDataSource.duration,
                filesize: mediaDataSource.filesize,
                url: mediaDataSource.url
            }];
        }

        // fill in default IO params if not exists
        if (typeof mediaDataSource.cors !== 'boolean') {
            mediaDataSource.cors = true;
        }
        if (typeof mediaDataSource.withCredentials !== 'boolean') {
            mediaDataSource.withCredentials = false;
        }

        this._mediaDataSource = mediaDataSource;
        this._currentSegmentIndex = 0;
        let isLive = mediaDataSource.isLive === true || config.isLive === true;
        let totalDuration = 0;

        this._mediaDataSource.segments.forEach((segment) => {
            // timestampBase for each segment, and calculate total duration
            segment.timestampBase = isLive ? 0 : totalDuration;
            if (!isLive) {
                totalDuration += segment.duration;
            }
            // params needed by IOController
            segment.cors = mediaDataSource.cors;
            segment.withCredentials = mediaDataSource.withCredentials;
            // referrer policy control, if exist
            if (config.referrerPolicy) {
                segment.referrerPolicy = config.referrerPolicy;
            }
        });

        if (!isLive && !isNaN(totalDuration) && this._mediaDataSource.duration !== totalDuration) {
            this._mediaDataSource.duration = totalDuration;
        }

        this._mediaInfo = null;
        this._demuxer = null;
        this._remuxer = null;
        this._ioctl = null;

        this._pendingSeekTime = null;
        this._pendingResolveSeekPoint = null;
        this._pendingMMTSVodSeek = null;
        this._pendingMMTSVodSeekRetry = null;
        this._pendingPlaybackOperationRetry = null;
        this._playbackOperationRetrySequence = 0;
        this._pendingMMTSVodSeekAudioSegments = [];
        this._pendingMMTSVodSeekAudioOperation = null;
        this._pendingMMTSVodAudioSwitchIntent = null;
        this._pendingMMTSVodVideoSwitchIntent = null;
        this._mmtsStartupGroup = this._createMMTSStartupGroupState(null);

        this._statisticsReporter = null;
    }

    destroy() {
        this._clearMMTSStartupGroupWatchdog();
        this._playbackOperation = null;
        this._producerPlaybackOperation = null;
        this._activeIOProducer = null;
        this._pendingSeekTime = null;
        this._clearPendingSeekPoint();
        this._pendingPlaybackOperationRetry = null;
        this._mediaInfo = null;
        this._mediaDataSource = null;
        this._mmtsStartupGroup = null;
        this._pendingMMTSVodAudioSwitchIntent = null;
        this._pendingMMTSVodVideoSwitchIntent = null;

        if (this._statisticsReporter) {
            this._disableStatisticsReporter();
        }
        if (this._ioctl) {
            this._ioctl.destroy();
            this._ioctl = null;
        }
        if (this._demuxer) {
            this._demuxer.destroy();
            this._demuxer = null;
        }
        if (this._remuxer) {
            this._remuxer.destroy();
            this._remuxer = null;
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

    canSetPlaybackOperation(operation, retryRequest = null) {
        if (this._config.isMMTS !== true) {
            return true;
        }
        if (!isPlaybackOperation(operation) ||
            !['startup', 'seek', 'audio-switch', 'video-switch'].includes(operation.kind) ||
            !canAdvancePlaybackOperation(this._playbackOperation, operation)) {
            return false;
        }
        const pendingRetry = this._pendingPlaybackOperationRetry;
        if (!pendingRetry) {
            return retryRequest == null;
        }
        if (retryRequest != null) {
            return this._isPlaybackOperationRetryContinuation(
                operation,
                retryRequest,
                pendingRetry
            );
        }
        // A new transaction may supersede a participant retry.  The next
        // attempt of the same transaction, however, must be authorized through
        // continuePlaybackOperationRetry() so the saved retry plan is consumed
        // exactly once.
        return isSamePlaybackOperation(pendingRetry.sourceOperation, operation) ||
            !isSamePlaybackTransaction(pendingRetry.sourceOperation, operation);
    }

    setPlaybackOperation(operation, retryRequest = null) {
        if (this._config.isMMTS !== true) {
            return true;
        }
        if (!isPlaybackOperation(operation) ||
            !['startup', 'seek', 'audio-switch', 'video-switch'].includes(operation.kind)) {
            throw new TypeError('Invalid MMTS playback operation');
        }
        const nextOperation = clonePlaybackOperation(operation);
        if (!this.canSetPlaybackOperation(nextOperation, retryRequest)) {
            return false;
        }
        const pendingRetry = this._pendingPlaybackOperationRetry;
        const retryContinuation = pendingRetry && retryRequest != null &&
            this._isPlaybackOperationRetryContinuation(
                nextOperation,
                retryRequest,
                pendingRetry
            );
        if (pendingRetry && !retryContinuation) {
            this._pendingPlaybackOperationRetry = null;
        }
        const previousOperation = this._playbackOperation;
        const timelineAdvanced = previousOperation === null ||
            nextOperation.timelineGeneration > previousOperation.timelineGeneration;
        const attemptAdvanced = previousOperation !== null &&
            isSamePlaybackTransaction(previousOperation, nextOperation) &&
            nextOperation.attempt > previousOperation.attempt;
        const operationChanged = previousOperation === null ||
            !isSamePlaybackOperation(previousOperation, nextOperation);
        this._playbackOperation = nextOperation;

        const videoIntent = this._pendingMMTSVodVideoSwitchIntent;
        if (operationChanged && videoIntent &&
            (nextOperation.kind !== 'video-switch' ||
                nextOperation.transactionKey !== videoIntent.transactionKey)) {
            this._pendingMMTSVodVideoSwitchIntent = null;
        }

        if (timelineAdvanced || attemptAdvanced) {
            this._pendingSeekTime = null;
            this._clearPendingSeekPoint();
        }
        if (operationChanged) {
            const previousState = this._mmtsStartupGroup;
            const sameAttempt = previousState && previousState.operation &&
                isSamePlaybackAttempt(previousState.operation, nextOperation);
            const deadline = sameAttempt ? previousState.deadline : null;
            this._clearMMTSStartupGroupWatchdog(previousState);
            this._mmtsStartupGroup = this._createMMTSStartupGroupState(
                nextOperation,
                nextOperation.kind === 'startup' || nextOperation.kind === 'seek',
                deadline
            );
            this._armMMTSStartupGroupWatchdog(this._mmtsStartupGroup);
        }
        if (operationChanged && this._ioctl) {
            this._replaceIOProducerForCurrentOperation();
        }
        return true;
    }

    start() {
        this._armMMTSStartupGroupWatchdog(this._mmtsStartupGroup);
        this._loadSegment(0);
        this._enableStatisticsReporter();
    }

    _loadSegment(segmentIndex, optionalFrom) {
        this._currentSegmentIndex = segmentIndex;
        let dataSource = this._mediaDataSource.segments[segmentIndex];

        let ioctl = this._ioctl = new IOController(dataSource, this._config, segmentIndex);
        const producer = this._activeIOProducer = {
            ioctl,
            operation: this._playbackOperation ? clonePlaybackOperation(this._playbackOperation) : null,
        };
        ioctl.onError = this._bindIOProducerCallback(producer, this._onIOException);
        ioctl.onSeeked = this._bindIOProducerCallback(producer, this._onIOSeeked);
        ioctl.onComplete = this._bindIOProducerCallback(producer, this._onIOComplete);
        ioctl.onRedirect = this._bindIOProducerCallback(producer, this._onIORedirect);
        ioctl.onRecoveredEarlyEof = this._bindIOProducerCallback(producer, this._onIORecoveredEarlyEof);
        ioctl.onContentLengthKnown = this._bindIOProducerCallback(producer, this._onIOContentLengthKnown);

        if (optionalFrom !== undefined) {
            this._bindDemuxerDataSource(this._demuxer, ioctl, producer);
        } else {
            ioctl.onDataArrival = this._bindIOProducerCallback(
                producer,
                this._onInitChunkArrival,
                true
            );
        }
        this._bindOperationProducerCallbacks(producer);

        ioctl.open(optionalFrom);
    }

    stop() {
        this._clearMMTSStartupGroupWatchdog();
        this._pendingPlaybackOperationRetry = null;
        this._internalAbort();
        this._disableStatisticsReporter();
    }

    _internalAbort() {
        if (this._ioctl) {
            if (this._activeIOProducer && this._activeIOProducer.ioctl === this._ioctl) {
                this._activeIOProducer = null;
            }
            this._ioctl.destroy();
            this._ioctl = null;
        }
    }

    _bindIOProducerCallback(producer, callback, dataArrival = false) {
        return (...args) => {
            const staleOperation = this._config.isMMTS === true &&
                (!producer.operation || !this._playbackOperation ||
                    !isSamePlaybackOperation(producer.operation, this._playbackOperation));
            if (this._activeIOProducer !== producer || this._ioctl !== producer.ioctl || staleOperation) {
                return dataArrival ? 0 : undefined;
            }
            return this._withProducerPlaybackOperation(
                producer.operation,
                () => callback.apply(this, args)
            );
        };
    }

    _bindDemuxerDataSource(demuxer, ioctl, producer) {
        demuxer.bindDataSource(ioctl);
        ioctl.onDataArrival = this._bindIOProducerCallback(
            producer,
            demuxer.parseChunks.bind(demuxer),
            true
        );
        return demuxer;
    }

    _replaceIOProducerForCurrentOperation() {
        const ioctl = this._ioctl;
        if (!ioctl) {
            return null;
        }
        const producer = this._activeIOProducer = {
            ioctl,
            operation: this._playbackOperation ? clonePlaybackOperation(this._playbackOperation) : null,
        };
        ioctl.onError = this._bindIOProducerCallback(producer, this._onIOException);
        ioctl.onSeeked = this._bindIOProducerCallback(producer, this._onIOSeeked);
        ioctl.onComplete = this._bindIOProducerCallback(producer, this._onIOComplete);
        ioctl.onRedirect = this._bindIOProducerCallback(producer, this._onIORedirect);
        ioctl.onRecoveredEarlyEof = this._bindIOProducerCallback(producer, this._onIORecoveredEarlyEof);
        ioctl.onContentLengthKnown = this._bindIOProducerCallback(producer, this._onIOContentLengthKnown);
        if (this._demuxer) {
            this._bindDemuxerDataSource(this._demuxer, ioctl, producer);
        } else {
            ioctl.onDataArrival = this._bindIOProducerCallback(
                producer,
                this._onInitChunkArrival,
                true
            );
        }
        this._bindOperationProducerCallbacks(producer);
        return producer;
    }

    _bindOperationProducerCallbacks(producer) {
        const bind = (callback) => this._config.isMMTS === true ?
            this._bindIOProducerCallback(producer, callback) : callback.bind(this);
        const demuxer = this._demuxer;
        if (demuxer instanceof FLVDemuxer) {
            demuxer.onError = bind(this._onDemuxException);
            demuxer.onMediaInfo = bind(this._onMediaInfo);
            demuxer.onMetaDataArrived = bind(this._onMetaDataArrived);
            demuxer.onScriptDataArrived = bind(this._onScriptDataArrived);
            demuxer.onSeiArrived = bind(this._onSEI);
        } else if (demuxer instanceof TSDemuxer) {
            demuxer.onError = bind(this._onDemuxException);
            demuxer.onMediaInfo = bind(this._onMediaInfo);
            demuxer.onMetaDataArrived = bind(this._onMetaDataArrived);
            demuxer.onTimedID3Metadata = bind(this._onTimedID3Metadata);
            demuxer.onPGSSubtitleData = bind(this._onPGSSubtitle);
            demuxer.onSynchronousKLVMetadata = bind(this._onSynchronousKLVMetadata);
            demuxer.onAsynchronousKLVMetadata = bind(this._onAsynchronousKLVMetadata);
            demuxer.onSMPTE2038Metadata = bind(this._onSMPTE2038Metadata);
            demuxer.onSEI = bind(this._onSEI);
            demuxer.onSCTE35Metadata = bind(this._onSCTE35Metadata);
            demuxer.onPESPrivateDataDescriptor = bind(this._onPESPrivateDataDescriptor);
            demuxer.onPESPrivateData = bind(this._onPESPrivateData);
        } else if (demuxer instanceof MMTSDemuxer) {
            demuxer.onError = bind(this._onDemuxException);
            demuxer.onMediaInfo = bind(this._onMediaInfo);
            demuxer.onMMTSAudioTracks = bind(this._onMMTSAudioTracks);
            demuxer.onMMTSVideoTracks = bind(this._onMMTSVideoTracks);
            demuxer.onMMTSSubtitleTracks = bind(this._onMMTSSubtitleTracks);
            demuxer.onMMTSSubtitleData = bind(this._onMMTSSubtitleData);
        }

        if (this._remuxer) {
            this._remuxer.onInitSegment = bind(this._onRemuxerInitSegmentArrival);
            this._remuxer.onMediaSegment = bind(this._onRemuxerMediaSegmentArrival);
        }
    }

    _withProducerPlaybackOperation(operation, callback) {
        const previous = this._producerPlaybackOperation;
        this._producerPlaybackOperation = operation ? clonePlaybackOperation(operation) : null;
        try {
            return callback();
        } finally {
            this._producerPlaybackOperation = previous;
        }
    }

    _withCurrentPlaybackOperation(callback) {
        return this._withProducerPlaybackOperation(this._playbackOperation, callback);
    }

    _isCurrentPlaybackOperation(operation) {
        return isPlaybackOperation(operation) &&
            isPlaybackOperation(this._playbackOperation) &&
            isSamePlaybackOperation(operation, this._playbackOperation);
    }

    _getCurrentProducerPlaybackOperation() {
        const operation = this._producerPlaybackOperation;
        return this._isCurrentPlaybackOperation(operation) ? operation : null;
    }

    _stampMMTSOutputSegment(segment) {
        if (this._config.isMMTS !== true) {
            return segment;
        }
        const operation = this._getCurrentProducerPlaybackOperation();
        if (!segment || typeof segment !== 'object' || !operation) {
            return null;
        }
        if (segment.playbackOperation !== undefined &&
            !isSamePlaybackOperation(segment.playbackOperation, operation)) {
            return null;
        }
        segment.playbackOperation = clonePlaybackOperation(operation);
        segment.mseBufferGeneration = operation.timelineGeneration;
        return segment;
    }

    pause() {  // take a rest
        if (this._ioctl && this._ioctl.isWorking()) {
            this._ioctl.pause();
            this._disableStatisticsReporter();
        }
    }

    resume() {
        if (this._ioctl && this._ioctl.isPaused()) {
            this._ioctl.resume();
            this._enableStatisticsReporter();
        }
    }

    selectPrimaryAudioTrack(timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._demuxer instanceof MMTSDemuxer) {
            return this._selectMMTSAudioTrack(() => {
                return this._demuxer.selectPrimaryAudioTrack(
                    timelineSeed,
                    () => this._remuxer.resetAudioState(),
                    rebuildFromSeek,
                    switchIdentity
                );
            }, rebuildFromSeek, switchIdentity);
        }
        return null;
    }

    selectSecondaryAudioTrack(timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._demuxer instanceof MMTSDemuxer) {
            return this._selectMMTSAudioTrack(() => {
                return this._demuxer.selectSecondaryAudioTrack(
                    timelineSeed,
                    () => this._remuxer.resetAudioState(),
                    rebuildFromSeek,
                    switchIdentity
                );
            }, rebuildFromSeek, switchIdentity);
        }
        return null;
    }

    selectAudioTrack(packetId, timelineSeed, rebuildFromSeek = false, switchIdentity) {
        if (this._demuxer instanceof MMTSDemuxer) {
            return this._selectMMTSAudioTrack(() => {
                return this._demuxer.selectAudioTrack(
                    packetId,
                    timelineSeed,
                    () => this._remuxer.resetAudioState(),
                    rebuildFromSeek,
                    switchIdentity
                );
            }, rebuildFromSeek, switchIdentity);
        }
        return null;
    }

    _selectMMTSAudioTrack(select, rebuildFromSeek, switchIdentity) {
        return this._withCurrentPlaybackOperation(() => {
            const scope = this._emitter.beginDeferral();
            let result;
            try {
                result = select();
                if (result.accepted && (result.changed || switchIdentity)) {
                    this._captureMMTSVodAudioSwitchIntent(
                        rebuildFromSeek,
                        switchIdentity,
                        result
                    );
                }
            } catch (error) {
                this._emitter.abortDeferral(scope);
                throw error;
            }

            try {
                this._emitter.emitImmediately(
                    TransmuxingEvents.MMTS_AUDIO_TRACK_SELECTION_RESULT,
                    result
                );
                this._resetMMTSLiveAudioSwitchVideoBootstrap(
                    result,
                    rebuildFromSeek,
                    switchIdentity
                );
                this._emitter.flushDeferral(scope);
            } catch (error) {
                this._emitter.abortDeferral(scope);
                throw error;
            }
            return result;
        });
    }

    _resetMMTSLiveAudioSwitchVideoBootstrap(result, rebuildFromSeek, switchIdentity) {
        if (!result || result.accepted !== true || rebuildFromSeek !== false ||
            !switchIdentity || this._config.isLive !== true ||
            Browser.firefox !== true ||
            !(this._demuxer instanceof MMTSDemuxer) ||
            !this._demuxer.resetVideoForDecoderBootstrap()) {
            return false;
        }
        this._remuxer.resetVideoState();
        return true;
    }

    _captureMMTSVodAudioSwitchIntent(rebuildFromSeek, switchIdentity, result) {
        if (!rebuildFromSeek || !(this._demuxer instanceof MMTSDemuxer)) {
            return;
        }
        const context = this._demuxer.getPendingAudioTrackSwitch();
        if (!context || (switchIdentity &&
            (context.transactionKey !== switchIdentity.transactionKey ||
                context.attemptKey !== switchIdentity.attemptKey)) ||
            (result && result.selectedPacketId !== undefined &&
                context.packetId !== result.selectedPacketId)) {
            return;
        }
        this._pendingMMTSVodAudioSwitchIntent = Object.assign({}, context);
    }

    _reapplyMMTSVodAudioSwitchIntent() {
        const intent = this._pendingMMTSVodAudioSwitchIntent;
        const operation = this._playbackOperation;
        if (!intent || !(this._demuxer instanceof MMTSDemuxer) ||
            !isPlaybackOperation(operation) || operation.kind !== 'audio-switch' ||
            operation.transactionKey !== intent.transactionKey) {
            return false;
        }
        const identity = createPlaybackSwitchIdentity(operation);
        this._pendingMMTSVodAudioSwitchIntent = Object.assign({}, intent, identity);
        return this._demuxer.selectAudioTrack(
            intent.packetId,
            intent.requestedStartMicroseconds / 1000,
            () => this._remuxer.resetAudioState(),
            true,
            identity
        );
    }

    selectVideoTrack(packetId, switchIdentity, rebuildFromSeek = false) {
        if (this._demuxer instanceof MMTSDemuxer) {
            return this._withCurrentPlaybackOperation(() => {
                let result;
                const operation = this._getCurrentProducerPlaybackOperation();
                if (switchIdentity !== undefined && (!isPlaybackSwitchIdentity(switchIdentity) ||
                    !operation || operation.kind !== 'video-switch' ||
                    !doesPlaybackSwitchIdentityMatchOperation(switchIdentity, operation))) {
                    result = {
                        accepted: false,
                        changed: false,
                        requestedPacketId: packetId,
                        reason: 'invalid-identity',
                        ...(switchIdentity || {}),
                    };
                } else {
                    result = this._demuxer.selectVideoTrack(packetId, switchIdentity);
                    if (rebuildFromSeek && result.accepted && switchIdentity) {
                        this._pendingMMTSVodVideoSwitchIntent = Object.assign({
                            packetId,
                        }, switchIdentity);
                    }
                }
                this._emitter.emit(TransmuxingEvents.MMTS_VIDEO_TRACK_SELECTION_RESULT, result);
                return result;
            });
        }
        return null;
    }

    _reapplyMMTSVodVideoSwitchIntent() {
        const intent = this._pendingMMTSVodVideoSwitchIntent;
        const operation = this._playbackOperation;
        if (!intent || !(this._demuxer instanceof MMTSDemuxer) ||
            !isPlaybackOperation(operation) || operation.kind !== 'video-switch' ||
            operation.transactionKey !== intent.transactionKey) {
            return false;
        }
        const identity = createPlaybackSwitchIdentity(operation);
        this._pendingMMTSVodVideoSwitchIntent = Object.assign({}, intent, identity);
        return this.selectVideoTrack(
            intent.packetId,
            identity,
            true
        );
    }

    resetMMTSStartupGroup() {
        if (this._config.isMMTS !== true) {
            return false;
        }
        const previousState = this._mmtsStartupGroup;
        const sameAttempt = previousState && previousState.operation &&
            this._playbackOperation &&
            isSamePlaybackAttempt(previousState.operation, this._playbackOperation);
        const deadline = sameAttempt ? previousState.deadline : null;
        this._clearMMTSStartupGroupWatchdog(previousState);
        this._mmtsStartupGroup = this._createMMTSStartupGroupState(
            this._playbackOperation,
            true,
            deadline
        );
        this._armMMTSStartupGroupWatchdog(this._mmtsStartupGroup);
        return true;
    }

    cancelMMTSVodAudioTrackRebuild() {
        this._pendingMMTSVodAudioSwitchIntent = null;
    }

    acknowledgeMMTSVodAudioTrackStartup(identity) {
        const intent = this._pendingMMTSVodAudioSwitchIntent;
        if (!intent || !isPlaybackSwitchIdentity(identity) ||
            identity.transactionKey !== intent.transactionKey ||
            identity.attemptKey !== intent.attemptKey) {
            return false;
        }
        this._pendingMMTSVodAudioSwitchIntent = null;
        return true;
    }

    seek(milliseconds) {
        if (this._config.isMMTS === true) {
            if (!isPlaybackOperation(this._playbackOperation)) {
                throw new TypeError('MMTS seek requires a playback operation');
            }
            if (this._producerPlaybackOperation === null) {
                return this._withCurrentPlaybackOperation(() => this.seek(milliseconds));
            }
            if (!this._getCurrentProducerPlaybackOperation()) {
                return;
            }
        }
        if (this._mediaInfo == null) {
            return;
        }

        let targetSegmentIndex = this._searchSegmentIndexContains(milliseconds);

        if (targetSegmentIndex === this._currentSegmentIndex) {
            // intra-segment seeking
            let segmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (segmentInfo == undefined) {
                // current segment loading started, but mediainfo hasn't received yet
                // wait for the metadata loaded, then seek to expected position
                this._pendingSeekTime = {
                    milliseconds,
                    operation: this._playbackOperation ?
                        clonePlaybackOperation(this._playbackOperation) : null,
                };
            } else {
                let keyframe = this._resolveSeekPoint(segmentInfo, this._mediaDataSource.segments[targetSegmentIndex], milliseconds);
                if (keyframe == null) {
                    return;
                }
                this._prepareDemuxerForSeek(keyframe.milliseconds);
                this._remuxer.seek(keyframe.milliseconds);
                this._replaceIOProducerForCurrentOperation();
                this._ioctl.seek(keyframe.fileposition);
                this._setPendingSeekPoint(keyframe, targetSegmentIndex, segmentInfo, this._mediaDataSource.segments[targetSegmentIndex]);
            }
        } else {
            // cross-segment seeking
            let targetSegmentInfo = this._mediaInfo.segments[targetSegmentIndex];

            if (targetSegmentInfo == undefined) {
                // target segment hasn't been loaded. We need metadata then seek to expected time
                this._pendingSeekTime = {
                    milliseconds,
                    operation: this._playbackOperation ?
                        clonePlaybackOperation(this._playbackOperation) : null,
                };
                this._internalAbort();
                this._remuxer.seek();
                this._remuxer.insertDiscontinuity();
                this._loadSegment(targetSegmentIndex);
                // Here we wait for the metadata loaded, then seek to expected position
            } else {
                // We have target segment's metadata, direct seek to target position
                let keyframe = this._resolveSeekPoint(targetSegmentInfo, this._mediaDataSource.segments[targetSegmentIndex], milliseconds);
                if (keyframe == null) {
                    return;
                }
                this._internalAbort();
                this._remuxer.seek(milliseconds);
                this._remuxer.insertDiscontinuity();
                this._demuxer.resetMediaInfo();
                this._demuxer.timestampBase = this._mediaDataSource.segments[targetSegmentIndex].timestampBase;
                this._prepareDemuxerForSeek(keyframe.milliseconds);
                this._loadSegment(targetSegmentIndex, keyframe.fileposition);
                this._setPendingSeekPoint(keyframe, targetSegmentIndex, targetSegmentInfo, this._mediaDataSource.segments[targetSegmentIndex]);
                this._reportSegmentMediaInfo(targetSegmentIndex);
            }
        }

        this._enableStatisticsReporter();
    }

    _resolveSeekPoint(segmentInfo, segment, milliseconds, estimatedLookback) {
        const isMMTS = this._demuxer instanceof MMTSDemuxer;
        const canEstimateMMTSPosition = isMMTS &&
            segment &&
            typeof segment.filesize === 'number' &&
            segment.filesize > 0 &&
            isFinite(segment.filesize) &&
            segmentInfo &&
            typeof segmentInfo.duration === 'number' &&
            segmentInfo.duration > 0 &&
            isFinite(segmentInfo.duration);

        if (segmentInfo && segmentInfo.isSeekable()) {
            const nearest = segmentInfo.getNearestKeyframe(milliseconds);
            if (!isMMTS) {
                return nearest;
            }
            if (nearest != null && nearest.milliseconds <= milliseconds) {
                const keyframes = segmentInfo.keyframesIndex;
                const nextIndex = nearest.index + 1;
                if (nearest.milliseconds === milliseconds ||
                    (nextIndex < keyframes.times.length &&
                     keyframes.times[nextIndex] >= milliseconds &&
                     keyframes.filepositions[nextIndex] >= nearest.fileposition &&
                     keyframes.filepositions[nextIndex] - nearest.fileposition <=
                        this._getMMTSVodSeekInitialLookback())) {
                    return nearest;
                }
                if (canEstimateMMTSPosition) {
                    const estimatedReadBytes = Math.ceil(
                        (milliseconds - nearest.milliseconds) * segment.filesize / segmentInfo.duration
                    );
                    if (estimatedReadBytes <= this._getMMTSVodSeekInitialLookback()) {
                        return nearest;
                    }
                } else {
                    const lastIndexedTime = keyframes.times[keyframes.times.length - 1];
                    if (milliseconds <= lastIndexedTime) {
                        return nearest;
                    }
                }
            }
        }

        if (canEstimateMMTSPosition) {
            let estimatedPosition = Math.floor(milliseconds * segment.filesize / segmentInfo.duration);
            let lookback = estimatedLookback;
            if (typeof lookback !== 'number' || !isFinite(lookback) || lookback < 0) {
                lookback = this._getMMTSVodSeekInitialLookback();
            }
            let fileposition = Math.max(0, estimatedPosition - lookback);
            return {
                milliseconds,
                fileposition,
                estimatedPosition,
                lookback,
                estimated: true
            };
        }

        return null;
    }

    _setPendingSeekPoint(keyframe, segmentIndex, segmentInfo, segment) {
        const operation = this._playbackOperation ?
            clonePlaybackOperation(this._playbackOperation) : null;
        this._pendingMMTSVodSeekRetry = null;
        this._pendingResolveSeekPoint = {
            milliseconds: keyframe.milliseconds,
            useFirstSyncPoint: keyframe.estimated === true,
            operation: operation ? clonePlaybackOperation(operation) : null,
        };
        if (keyframe.estimated === true && this._demuxer instanceof MMTSDemuxer) {
            this._pendingMMTSVodSeekAudioSegments.splice(0, this._pendingMMTSVodSeekAudioSegments.length);
            this._pendingMMTSVodSeekAudioOperation = null;
            this._pendingMMTSVodSeek = {
                milliseconds: keyframe.milliseconds,
                segmentIndex,
                segmentInfo,
                segment,
                estimatedPosition: keyframe.estimatedPosition,
                lookback: keyframe.lookback,
                fileposition: keyframe.fileposition,
                operation: operation ? clonePlaybackOperation(operation) : null,
            };
        } else {
            this._pendingMMTSVodSeek = null;
        }
    }

    _clearPendingSeekPoint() {
        this._pendingMMTSVodSeekRetry = null;
        this._pendingResolveSeekPoint = null;
        this._pendingMMTSVodSeek = null;
        this._pendingMMTSVodSeekAudioSegments.splice(0, this._pendingMMTSVodSeekAudioSegments.length);
        this._pendingMMTSVodSeekAudioOperation = null;
    }

    _getMMTSVodSeekInitialLookback() {
        let lookback = this._config.mmtsVodSeekLookbackBytes;
        if (typeof lookback !== 'number' || !isFinite(lookback) || lookback < 0) {
            lookback = 32 * 1024 * 1024;
        }
        return lookback;
    }

    _getMMTSVodSeekMaxLookback() {
        let maxLookback = this._config.mmtsVodSeekMaxLookbackBytes;
        if (typeof maxLookback !== 'number' || !isFinite(maxLookback) || maxLookback < 0) {
            maxLookback = 256 * 1024 * 1024;
        }
        return Math.max(maxLookback, this._getMMTSVodSeekInitialLookback());
    }

    _retryPendingMMTSVodSeekIfNeeded(segmentIndex) {
        const pending = this._pendingMMTSVodSeek;
        if (pending == null || pending.segmentIndex !== segmentIndex) {
            return false;
        }
        if (this._config.isMMTS === true &&
            !this._isCurrentPlaybackOperation(pending.operation)) {
            this._clearPendingSeekPoint();
            return false;
        }
        if (this._pendingPlaybackOperationRetry !== null) {
            return true;
        }

        const maxLookback = this._getMMTSVodSeekMaxLookback();
        let nextLookback = pending.lookback > 0 ?
            pending.lookback * 2 : this._getMMTSVodSeekInitialLookback();
        nextLookback = Math.min(nextLookback, maxLookback);
        if (nextLookback <= pending.lookback && pending.fileposition === 0) {
            this._clearPendingSeekPoint();
            return false;
        }

        let keyframe = this._resolveSeekPoint(
            pending.segmentInfo,
            pending.segment,
            pending.milliseconds,
            nextLookback
        );
        if (keyframe == null || keyframe.fileposition >= pending.fileposition) {
            if (pending.fileposition === 0) {
                this._clearPendingSeekPoint();
                return false;
            }
            keyframe = {
                milliseconds: pending.milliseconds,
                fileposition: 0,
                estimatedPosition: pending.estimatedPosition,
                lookback: pending.estimatedPosition,
                estimated: true
            };
        }

        const sourceOperation = this._playbackOperation;
        if (!isPlaybackOperation(sourceOperation) ||
            !['seek', 'audio-switch', 'video-switch'].includes(sourceOperation.kind)) {
            this._clearPendingSeekPoint();
            return false;
        }

        const normalizeByteOffset = (value) => {
            if (typeof value !== 'number' || !isFinite(value) || value < 0) {
                return null;
            }
            const normalized = Math.floor(value);
            return Number.isSafeInteger(normalized) ? normalized : null;
        };
        const filePosition = normalizeByteOffset(keyframe.fileposition);
        const estimatedPosition = normalizeByteOffset(
            typeof keyframe.estimatedPosition === 'number' ?
                keyframe.estimatedPosition :
                (typeof pending.estimatedPosition === 'number' ?
                    pending.estimatedPosition : keyframe.fileposition)
        );
        const lookbackBytes = normalizeByteOffset(
            typeof keyframe.lookback === 'number' ? keyframe.lookback : nextLookback
        );
        if (filePosition === null || estimatedPosition === null || lookbackBytes === null) {
            this._clearPendingSeekPoint();
            return false;
        }

        const request = {
            requestId: `${sourceOperation.attemptKey}:mmts-vod-seek-lookback:${++this._playbackOperationRetrySequence}`,
            reason: 'mmts-vod-seek-lookback',
            sourceTransactionKey: sourceOperation.transactionKey,
            sourceAttemptKey: sourceOperation.attemptKey,
            sourceTimelineGeneration: sourceOperation.timelineGeneration,
            sourceTransactionId: sourceOperation.transactionId,
            sourceAttempt: sourceOperation.attempt,
            segmentIndex,
            requestedTimeMicroseconds: sourceOperation.requestedTimeMicroseconds,
            requestedTimeMilliseconds: sourceOperation.requestedTimeMilliseconds,
            filePosition,
            estimatedPosition,
            lookbackBytes,
        };
        if (!isPlaybackOperationRetryRequest(request, sourceOperation)) {
            this._clearPendingSeekPoint();
            return false;
        }

        Log.w(
            this.TAG,
            `Request owner-authorized MMTS VOD seek retry from ${request.filePosition} ` +
            `for target ${pending.milliseconds} ms, attempt=${sourceOperation.attempt}`
        );
        this._pendingPlaybackOperationRetry = {
            request,
            sourceOperation: clonePlaybackOperation(sourceOperation),
            keyframe: Object.assign({}, keyframe),
            segmentIndex,
            segmentInfo: pending.segmentInfo,
            segment: pending.segment,
        };

        // Stop the source attempt before asking the owner for a new token.  No
        // new IO is started until continuePlaybackOperationRetry() consumes the
        // saved plan with the exact next attempt.
        this._clearMMTSStartupGroupWatchdog();
        this._internalAbort();
        this._clearPendingSeekPoint();
        this._emitter.emit(
            TransmuxingEvents.PLAYBACK_OPERATION_RETRY_REQUIRED,
            request,
            clonePlaybackOperation(sourceOperation)
        );
        return true;
    }

    canContinuePlaybackOperationRetry(operation, request) {
        if (this._config.isMMTS !== true) {
            return false;
        }
        const pending = this._pendingPlaybackOperationRetry;
        return !!pending && this._isPlaybackOperationRetryContinuation(
            operation,
            request,
            pending
        ) && this.canSetPlaybackOperation(operation, request);
    }

    continuePlaybackOperationRetry(operation, request) {
        const pending = this._pendingPlaybackOperationRetry;
        if (!pending || !this.canContinuePlaybackOperationRetry(operation, request)) {
            return false;
        }
        const plan = pending;
        if (!this.setPlaybackOperation(operation, request)) {
            return false;
        }
        this._pendingPlaybackOperationRetry = null;

        this._withCurrentPlaybackOperation(() => {
            this.resetMMTSStartupGroup();
            this._remuxer.seek(plan.keyframe.milliseconds);
            this._remuxer.insertDiscontinuity();
            this._prepareDemuxerForSeek(plan.keyframe.milliseconds);
            this._reapplyMMTSVodAudioSwitchIntent();
            this._reapplyMMTSVodVideoSwitchIntent();
            this._loadSegment(plan.segmentIndex, plan.keyframe.fileposition);
            this._setPendingSeekPoint(
                plan.keyframe,
                plan.segmentIndex,
                plan.segmentInfo,
                plan.segment
            );
        });
        this._enableStatisticsReporter();
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
        this._pendingPlaybackOperationRetry = null;
        return true;
    }

    _isPlaybackOperationRetryContinuation(operation, request, pending) {
        if (!pending || !isPlaybackOperation(operation) ||
            !isPlaybackOperationRetryRequest(request, pending.sourceOperation) ||
            request.requestId !== pending.request.requestId ||
            !this._isCurrentPlaybackOperation(pending.sourceOperation) ||
            !isSamePlaybackTransaction(pending.sourceOperation, operation) ||
            operation.attempt !== pending.sourceOperation.attempt + 1 ||
            operation.phase !== 'adaptive-retry' ||
            operation.requestedTimeMicroseconds !== request.requestedTimeMicroseconds ||
            operation.intentTimeMicroseconds !== pending.sourceOperation.intentTimeMicroseconds ||
            operation.packetId !== pending.sourceOperation.packetId) {
            return false;
        }
        return true;
    }

    _schedulePendingMMTSVodSeekRetryIfNeeded(segmentIndex, syncPointTime) {
        const pending = this._pendingMMTSVodSeek;
        if (pending == null || pending.segmentIndex !== segmentIndex ||
            typeof syncPointTime !== 'number' || !isFinite(syncPointTime) ||
            syncPointTime <= pending.milliseconds + 250 ||
            pending.lookback >= this._getMMTSVodSeekMaxLookback()) {
            return false;
        }

        this._pendingMMTSVodSeekRetry = pending;
        const producer = this._activeIOProducer;
        Promise.resolve().then(() => {
            if (this._activeIOProducer !== producer || !producer ||
                !this._isCurrentPlaybackOperation(producer.operation) ||
                !this._isCurrentPlaybackOperation(pending.operation)) {
                return;
            }
            if (this._pendingMMTSVodSeekRetry !== pending || this._pendingMMTSVodSeek !== pending) {
                return;
            }
            this._pendingMMTSVodSeekRetry = null;
            this._withProducerPlaybackOperation(producer.operation, () => {
                this._retryPendingMMTSVodSeekIfNeeded(segmentIndex);
            });
        });
        return true;
    }

    _emitPendingMMTSVodSeekAudioSegments() {
        const audioSegments = this._pendingMMTSVodSeekAudioSegments;
        const operation = this._pendingMMTSVodSeekAudioOperation;
        if (this._config.isMMTS === true && !this._isCurrentPlaybackOperation(operation)) {
            audioSegments.splice(0, audioSegments.length);
            this._pendingMMTSVodSeekAudioOperation = null;
            return;
        }
        this._withProducerPlaybackOperation(operation, () => {
            for (let i = 0; i < audioSegments.length; i++) {
                this._emitRemuxerMediaSegment('audio', audioSegments[i]);
            }
        });
        audioSegments.splice(0, audioSegments.length);
        this._pendingMMTSVodSeekAudioOperation = null;
    }

    _prepareDemuxerForSeek(milliseconds) {
        if (this._demuxer instanceof MMTSDemuxer) {
            this._demuxer.seek(milliseconds);
        }
    }

    _searchSegmentIndexContains(milliseconds) {
        let segments = this._mediaDataSource.segments;
        let idx = segments.length - 1;

        for (let i = 0; i < segments.length; i++) {
            if (milliseconds < segments[i].timestampBase) {
                idx = i - 1;
                break;
            }
        }
        return idx;
    }

    _onInitChunkArrival(data, byteStart) {
        let consumed = 0;

        if (byteStart > 0) {
            // IOController seeked immediately after opened, byteStart > 0 callback may received
            this._bindDemuxerDataSource(
                this._demuxer,
                this._ioctl,
                this._activeIOProducer
            );
            this._demuxer.timestampBase = this._mediaDataSource.segments[this._currentSegmentIndex].timestampBase;

            consumed = this._demuxer.parseChunks(data, byteStart);
        } else {
            // byteStart == 0, Initial data, probe it first
            let probeData = null;

            // Try probing input data as FLV first
            probeData = FLVDemuxer.probe(data);
            if (probeData.match) {
                // Hit as FLV
                this._setupFLVDemuxerRemuxer(probeData);
                consumed = this._demuxer.parseChunks(data, byteStart);
            }

            if (!probeData.match && !probeData.needMoreData) {
                // Non-FLV, try MPEG-TS probe
                probeData = TSDemuxer.probe(data);
                if (probeData.match) {
                    // Hit as MPEG-TS
                    this._setupTSDemuxerRemuxer(probeData);
                    consumed = this._demuxer.parseChunks(data, byteStart);
                }
            }

            if (!probeData.match && !probeData.needMoreData) {
                // Non-FLV / Non-MPEG-TS, try MMTS probe
                probeData = MMTSDemuxer.probe(data);
                if (probeData.match) {
                    // Hit as MMT/TLV
                    this._setupMMTSDemuxerRemuxer(probeData);
                    consumed = this._demuxer.parseChunks(data, byteStart);
                }
            }

            if (!probeData.match && !probeData.needMoreData) {
                // Probing as FLV / MPEG-TS / MMTS failed, report error
                probeData = null;
                Log.e(this.TAG, 'Non MPEG-TS/MMTS/FLV, Unsupported media type!');
                this._terminateMMTSStartupGroupForCurrentOperation();
                const producer = this._activeIOProducer;
                Promise.resolve().then(() => {
                    if (producer && this._activeIOProducer === producer) {
                        this._withProducerPlaybackOperation(producer.operation, () => {
                            this._internalAbort();
                        });
                    }
                });
                this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, DemuxErrors.FORMAT_UNSUPPORTED, 'Non MPEG-TS/MMTS/FLV, Unsupported media type!');
                // Leave consumed as 0
            }
        }

        return consumed;
    }

    _setupFLVDemuxerRemuxer(probeData) {
        this._demuxer = new FLVDemuxer(probeData, this._config);

        if (!this._remuxer) {
            this._remuxer = new MP4Remuxer(this._config);
        }

        let mds = this._mediaDataSource;
        if (!this._config.isLive && mds.duration != undefined && !isNaN(mds.duration)) {
            this._demuxer.overridedDuration = mds.duration;
        }
        if (typeof mds.hasAudio === 'boolean') {
            this._demuxer.overridedHasAudio = mds.hasAudio;
        }
        if (typeof mds.hasVideo === 'boolean') {
            this._demuxer.overridedHasVideo = mds.hasVideo;
        }

        this._demuxer.timestampBase = mds.segments[this._currentSegmentIndex].timestampBase;

        this._remuxer.bindDataSource(this._bindDemuxerDataSource(
            this._demuxer,
            this._ioctl,
            this._activeIOProducer
        ));
        this._bindOperationProducerCallbacks(this._activeIOProducer);
    }

    _setupTSDemuxerRemuxer(probeData) {
        let demuxer = this._demuxer = new TSDemuxer(probeData, this._config);

        if (!this._remuxer) {
            this._remuxer = new MP4Remuxer(this._config);
        }

        this._remuxer.bindDataSource(this._demuxer);
        this._bindDemuxerDataSource(this._demuxer, this._ioctl, this._activeIOProducer);
        this._bindOperationProducerCallbacks(this._activeIOProducer);
    }

    _setupMMTSDemuxerRemuxer(probeData) {
        let demuxer = this._demuxer = new MMTSDemuxer(probeData, this._config);

        if (!this._remuxer) {
            this._remuxer = new MP4Remuxer(this._config);
        }

        let mds = this._mediaDataSource;
        let segment = mds.segments[this._currentSegmentIndex];
        if (!this._config.isLive && mds.duration != undefined && !isNaN(mds.duration)) {
            demuxer.overridedDuration = mds.duration;
        }
        if (segment && segment.filesize != undefined && !isNaN(segment.filesize)) {
            demuxer.filesize = segment.filesize;
        }

        this._remuxer.bindDataSource(this._demuxer);
        this._bindDemuxerDataSource(this._demuxer, this._ioctl, this._activeIOProducer);
        this._bindOperationProducerCallbacks(this._activeIOProducer);
    }

    _onMediaInfo(mediaInfo) {
        if (this._config.isMMTS === true && !this._getCurrentProducerPlaybackOperation()) {
            return;
        }
        if (this._mediaInfo == null) {
            // Store first segment's mediainfo as global mediaInfo
            this._mediaInfo = Object.assign({}, mediaInfo);
            this._mediaInfo.keyframesIndex = null;
            this._mediaInfo.segments = [];
            this._mediaInfo.segmentCount = this._mediaDataSource.segments.length;
            Object.setPrototypeOf(this._mediaInfo, MediaInfo.prototype);
        } else {
            this._mediaInfo.duration = mediaInfo.duration;
            this._mediaInfo.hasAudio = mediaInfo.hasAudio;
            this._mediaInfo.hasVideo = mediaInfo.hasVideo;
            this._mediaInfo.hasKeyframesIndex = mediaInfo.hasKeyframesIndex;
        }

        let segmentInfo = Object.assign({}, mediaInfo);
        Object.setPrototypeOf(segmentInfo, MediaInfo.prototype);
        this._mediaInfo.segments[this._currentSegmentIndex] = segmentInfo;

        // notify mediaInfo update
        this._reportSegmentMediaInfo(this._currentSegmentIndex);
        this._setMMTSStartupGroupMediaInfo(mediaInfo);

        if (this._pendingSeekTime != null) {
            const pendingSeek = this._pendingSeekTime;
            if (this._config.isMMTS === true &&
                !this._isCurrentPlaybackOperation(pendingSeek.operation)) {
                this._pendingSeekTime = null;
                return;
            }
            const producer = this._activeIOProducer;
            Promise.resolve().then(() => {
                if (!producer || this._activeIOProducer !== producer ||
                    this._pendingSeekTime !== pendingSeek ||
                    (this._config.isMMTS === true &&
                        (!this._isCurrentPlaybackOperation(producer.operation) ||
                            !this._isCurrentPlaybackOperation(pendingSeek.operation)))) {
                    return;
                }
                this._pendingSeekTime = null;
                this._withProducerPlaybackOperation(
                    pendingSeek.operation,
                    () => this.seek(pendingSeek.milliseconds)
                );
            });
        }
    }

    _onMetaDataArrived(metadata) {
        this._emitter.emit(TransmuxingEvents.METADATA_ARRIVED, metadata);
    }

    _onScriptDataArrived(data) {
        this._emitter.emit(TransmuxingEvents.SCRIPTDATA_ARRIVED, data);
    }

    _onTimedID3Metadata(timed_id3_metadata) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (timed_id3_metadata.pts != undefined) {
            timed_id3_metadata.pts -= timestamp_base;
        }

        if (timed_id3_metadata.dts != undefined) {
            timed_id3_metadata.dts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED, timed_id3_metadata);
    }

    _onPGSSubtitle(pgs_data) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (pgs_data.pts != undefined) {
            pgs_data.pts -= timestamp_base;
        }

        if (pgs_data.dts != undefined) {
            pgs_data.dts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.PGS_SUBTITLE_ARRIVED, pgs_data);
    }

    _onSynchronousKLVMetadata(synchronous_klv_metadata) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (synchronous_klv_metadata.pts != undefined) {
            synchronous_klv_metadata.pts -= timestamp_base;
        }

        if (synchronous_klv_metadata.dts != undefined) {
            synchronous_klv_metadata.dts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED, synchronous_klv_metadata);
    }

    _onAsynchronousKLVMetadata(asynchronous_klv_metadata) {
        this._emitter.emit(TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED, asynchronous_klv_metadata);
    }

    _onSMPTE2038Metadata(smpte2038_metadata) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (smpte2038_metadata.pts != undefined) {
            smpte2038_metadata.pts -= timestamp_base;
        }

        if (smpte2038_metadata.dts != undefined) {
            smpte2038_metadata.dts -= timestamp_base;
        }

        if (smpte2038_metadata.nearest_pts != undefined) {
            smpte2038_metadata.nearest_pts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.SMPTE2038_METADATA_ARRIVED, smpte2038_metadata);
    }

    _onSEI(sei_data) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (sei_data.pts != undefined) {
            sei_data.pts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.SEI_ARRIVED, sei_data);
    }

    _onSCTE35Metadata(scte35) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (scte35.pts != undefined) {
            scte35.pts -= timestamp_base;
        }

        if (scte35.nearest_pts != undefined) {
            scte35.nearest_pts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.SCTE35_METADATA_ARRIVED, scte35);
    }

    _onPESPrivateDataDescriptor(descriptor) {
        this._emitter.emit(TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR, descriptor);
    }

    _onPESPrivateData(private_data) {
        let timestamp_base = this._remuxer.getTimestampBase();
        if (timestamp_base == undefined) { return; }

        if (private_data.pts != undefined) {
            private_data.pts -= timestamp_base;
        }

        if (private_data.nearest_pts != undefined) {
            private_data.nearest_pts -= timestamp_base;
        }

        if (private_data.dts != undefined) {
            private_data.dts -= timestamp_base;
        }

        this._emitter.emit(TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED, private_data);
    }

    _onMMTSAudioTracks(audio_tracks) {
        this._emitter.emit(TransmuxingEvents.MMTS_AUDIO_TRACKS, audio_tracks);
    }

    _onMMTSVideoTracks(video_tracks) {
        this._emitter.emit(TransmuxingEvents.MMTS_VIDEO_TRACKS, video_tracks);
    }

    _onMMTSSubtitleTracks(subtitle_tracks) {
        this._emitter.emit(TransmuxingEvents.MMTS_SUBTITLE_TRACKS, subtitle_tracks);
    }

    _onMMTSSubtitleData(subtitle_data) {
        this._emitter.emit(TransmuxingEvents.MMTS_SUBTITLE_DATA_ARRIVED, subtitle_data);
    }

    _onIOSeeked() {
        this._remuxer.insertDiscontinuity();
    }

    _onIOComplete(extraData) {
        let segmentIndex = extraData;
        let nextSegmentIndex = segmentIndex + 1;

        if (this._retryPendingMMTSVodSeekIfNeeded(segmentIndex)) {
            return;
        }

        if (nextSegmentIndex < this._mediaDataSource.segments.length) {
            this._internalAbort();
            if (this._remuxer) {
                this._remuxer.flushStashedSamples();
            }
            this._loadSegment(nextSegmentIndex);
        } else {
            if (this._remuxer) {
                this._remuxer.flushStashedSamples();
            }
            if (this._hasUnfinishedMMTSStartupGroupForCurrentOperation()) {
                this._failMMTSStartupGroup(
                    this._mmtsStartupGroup,
                    'loading-complete'
                );
                this._disableStatisticsReporter();
                return;
            }
            this._emitter.emit(TransmuxingEvents.LOADING_COMPLETE);
            this._disableStatisticsReporter();
        }
    }

    _onIORedirect(redirectedURL) {
        let segmentIndex = this._ioctl.extraData;
        this._mediaDataSource.segments[segmentIndex].redirectedURL = redirectedURL;
    }

    _onIOContentLengthKnown(totalLength, segmentIndex) {
        let segment = this._mediaDataSource.segments[segmentIndex];
        if (segment) {
            segment.filesize = totalLength;
        }
        if (this._demuxer instanceof MMTSDemuxer) {
            this._demuxer.filesize = totalLength;
        }
    }

    _onIORecoveredEarlyEof() {
        this._emitter.emit(TransmuxingEvents.RECOVERED_EARLY_EOF);
    }

    _onIOException(type, info) {
        Log.e(this.TAG, `IOException: type = ${type}, code = ${info.code}, msg = ${info.msg}`);
        this._terminateMMTSStartupGroupForCurrentOperation();
        this._emitter.emit(TransmuxingEvents.IO_ERROR, type, info);
        this._disableStatisticsReporter();
    }

    _onDemuxException(type, info) {
        Log.e(this.TAG, `DemuxException: type = ${type}, info = ${info}`);
        this._terminateMMTSStartupGroupForCurrentOperation();
        this._emitter.emit(TransmuxingEvents.DEMUX_ERROR, type, info);
    }

    _onRemuxerInitSegmentArrival(type, initSegment) {
        initSegment = this._stampMMTSOutputSegment(initSegment);
        if (!initSegment) {
            return;
        }
        if (this._collectMMTSStartupInitSegment(type, initSegment)) {
            return;
        }
        this._emitter.emit(TransmuxingEvents.INIT_SEGMENT, type, initSegment);
    }

    _onRemuxerMediaSegmentArrival(type, mediaSegment) {
        mediaSegment = this._stampMMTSOutputSegment(mediaSegment);
        if (!mediaSegment) {
            return;
        }
        if (this._pendingSeekTime != null) {
            // Media segments after new-segment cross-seeking should be dropped.
            return;
        }

        if (this._pendingMMTSVodSeek != null) {
            if (!this._isCurrentPlaybackOperation(this._pendingMMTSVodSeek.operation)) {
                this._clearPendingSeekPoint();
                return;
            }
            if (this._pendingMMTSVodSeekRetry != null) {
                return;
            }
            if (type === 'audio') {
                if (this._pendingMMTSVodSeekAudioSegments.length === 0) {
                    this._pendingMMTSVodSeekAudioOperation = clonePlaybackOperation(
                        mediaSegment.playbackOperation
                    );
                } else if (!isSamePlaybackOperation(
                    this._pendingMMTSVodSeekAudioOperation,
                    mediaSegment.playbackOperation
                )) {
                    return;
                }
                this._pendingMMTSVodSeekAudioSegments.push(mediaSegment);
                return;
            }
            if (type === 'video') {
                const syncPoints = mediaSegment.info && mediaSegment.info.syncPoints ? mediaSegment.info.syncPoints : [];
                if (syncPoints.length === 0) {
                    return;
                }
                const pending = this._pendingResolveSeekPoint;
                if (pending == null || !this._isCurrentPlaybackOperation(pending.operation)) {
                    this._clearPendingSeekPoint();
                    return;
                }
                const mmtsPending = this._pendingMMTSVodSeek;
                const firstSyncPoint = syncPoints[0];
                const syncPointTime = typeof firstSyncPoint.originalDts === 'number' && isFinite(firstSyncPoint.originalDts) ?
                    firstSyncPoint.originalDts : firstSyncPoint.dts;
                if (this._schedulePendingMMTSVodSeekRetryIfNeeded(
                    mmtsPending.segmentIndex,
                    syncPointTime
                )) {
                    return;
                }
                this._emitRemuxerMediaSegment(type, mediaSegment);
                const videoSwitch = mediaSegment && mediaSegment.mmtsVideoTrackSwitch;
                const videoIntent = this._pendingMMTSVodVideoSwitchIntent;
                if (videoIntent && videoSwitch &&
                    videoSwitch.transactionKey === videoIntent.transactionKey &&
                    videoSwitch.attemptKey === videoIntent.attemptKey &&
                    videoSwitch.packetId === videoIntent.packetId) {
                    this._pendingMMTSVodVideoSwitchIntent = null;
                }
                this._emitPendingMMTSVodSeekAudioSegments();
                this._clearPendingSeekPoint();
                let seekpoint = mmtsPending.milliseconds;
                if (typeof syncPointTime === 'number' && isFinite(syncPointTime) &&
                    syncPointTime > mmtsPending.milliseconds + 250) {
                    seekpoint = Browser.safari ? firstSyncPoint.pts : syncPointTime;
                }

                this._emitter.emit(TransmuxingEvents.RECOMMEND_SEEKPOINT, seekpoint);
                return;
            }
        }

        if (this._emitRemuxerMediaSegment(type, mediaSegment)) {
            return;
        }

        // Resolve pending seekPoint
        if (this._pendingResolveSeekPoint != null && type === 'video') {
            let syncPoints = mediaSegment.info.syncPoints;
            let pending = this._pendingResolveSeekPoint;
            if (this._config.isMMTS === true &&
                !this._isCurrentPlaybackOperation(pending.operation)) {
                this._clearPendingSeekPoint();
                return;
            }
            if (typeof pending === 'object' && pending.useFirstSyncPoint && syncPoints.length === 0) {
                return;
            }
            this._clearPendingSeekPoint();
            let seekpoint = typeof pending === 'object' ? pending.milliseconds : pending;

            if (typeof pending === 'object' && pending.useFirstSyncPoint && syncPoints.length > 0) {
                seekpoint = Browser.safari ? syncPoints[0].pts : syncPoints[0].originalDts;
            }

            // Safari: Pass PTS for recommend_seekpoint
            if (Browser.safari && syncPoints.length > 0 && syncPoints[0].originalDts === seekpoint) {
                seekpoint = syncPoints[0].pts;
            }
            // else: use original DTS (keyframe.milliseconds)

            this._emitter.emit(TransmuxingEvents.RECOMMEND_SEEKPOINT, seekpoint);
        }
    }

    _createMMTSStartupGroupState(operation, collect = true, deadline = null) {
        return {
            operation: isPlaybackOperation(operation) ? clonePlaybackOperation(operation) : null,
            emitted: collect !== true,
            failed: false,
            deadline,
            watchdogTimer: null,
            mediaInfo: null,
            videoInitSegment: null,
            audioInitSegment: null,
            videoMediaSegment: null,
            latestVideoMediaSegment: null,
            videoMediaSegments: [],
            audioMediaSegments: []
        };
    }

    _getMMTSStartupGroupClock() {
        return self.performance && typeof self.performance.now === 'function' ?
            self.performance.now() : Date.now();
    }

    _armMMTSStartupGroupWatchdog(state) {
        if (this._config.isMMTS !== true || !state || state !== this._mmtsStartupGroup ||
            state.emitted === true || state.failed === true || state.watchdogTimer !== null ||
            !this._isCurrentPlaybackOperation(state.operation)) {
            return false;
        }
        if (state.deadline === null) {
            state.deadline = this._getMMTSStartupGroupClock() + this._mmtsStartupGroupTimeout;
        }
        const operation = clonePlaybackOperation(state.operation);
        const delay = Math.max(0, state.deadline - this._getMMTSStartupGroupClock());
        const timer = self.setTimeout(() => {
            if (this._mmtsStartupGroup !== state || state.watchdogTimer !== timer ||
                state.emitted === true || state.failed === true ||
                !isSamePlaybackOperation(state.operation, operation) ||
                !this._isCurrentPlaybackOperation(operation)) {
                return;
            }
            state.watchdogTimer = null;
            this._withProducerPlaybackOperation(operation, () => {
                if (this._mmtsStartupGroup === state &&
                    this._isCurrentPlaybackOperation(operation)) {
                    this._failMMTSStartupGroup(state, 'timeout');
                }
            });
        }, delay);
        state.watchdogTimer = timer;
        return true;
    }

    _clearMMTSStartupGroupWatchdog(state = this._mmtsStartupGroup) {
        if (!state || state.watchdogTimer === null) {
            return false;
        }
        self.clearTimeout(state.watchdogTimer);
        state.watchdogTimer = null;
        return true;
    }

    _hasUnfinishedMMTSStartupGroupForCurrentOperation() {
        const state = this._mmtsStartupGroup;
        return this._config.isMMTS === true && !!state && state.emitted !== true &&
            this._isCurrentPlaybackOperation(state.operation);
    }

    _terminateMMTSStartupGroupForCurrentOperation() {
        const state = this._mmtsStartupGroup;
        const operation = this._getCurrentProducerPlaybackOperation();
        if (!state || !operation ||
            !isSamePlaybackOperation(state.operation, operation)) {
            return false;
        }
        if (state.emitted !== true) {
            state.failed = true;
        }
        return this._clearMMTSStartupGroupWatchdog(state);
    }

    _getMMTSStartupGroupMissing(state) {
        const missing = [];
        const vodAudioSwitch = this._isMMTSVodAudioSwitchStartupGroup(state);
        const mediaInfoValid = state.mediaInfo && state.mediaInfo.hasVideo === true &&
            typeof state.mediaInfo.hasAudio === 'boolean';
        if (!mediaInfoValid) {
            missing.push('media-info');
        }
        if (!state.videoInitSegment) {
            missing.push('video-init');
        }
        if (!state.videoMediaSegment) {
            missing.push('video-media');
        }
        if (mediaInfoValid && state.mediaInfo.hasAudio === true) {
            if (!state.audioInitSegment) {
                missing.push('audio-init');
            }
            let audioMediaSegment = null;
            const window = state.videoMediaSegment && state.videoMediaSegment.firstPlayableWindow;
            if (this._isFirstPlayableWindowValid(window)) {
                if (vodAudioSwitch &&
                    this._isMMTSStartupRandomAccessSafeVideoSegment(state.videoMediaSegment)) {
                    const videoEnd = this._getMMTSStartupVideoCoverageEnd(state, window);
                    audioMediaSegment = this._findMMTSVodAudioSwitchStartupSegment(
                        state,
                        window.playableStart,
                        videoEnd
                    );
                } else if (!vodAudioSwitch) {
                    audioMediaSegment = state.audioMediaSegments.find((segment) => {
                        return this._isMMTSStartupSegmentForOperation(segment, state.operation) &&
                            this._doesMMTSAudioSegmentCoverTime(segment, window.playableStart);
                    });
                }
            }
            if (!audioMediaSegment) {
                missing.push('audio-media-overlap');
            } else {
                const audioInfo = audioMediaSegment.info;
                const audioStart = audioInfo ? audioInfo.beginDts / 1000 : NaN;
                const audioEnd = audioInfo ? audioInfo.endDts / 1000 : NaN;
                const playableStart = vodAudioSwitch ?
                    Math.max(window.playableStart, audioStart) : window.playableStart;
                const videoEnd = vodAudioSwitch ?
                    this._getMMTSStartupVideoCoverageEnd(state, window) : window.playableEnd;
                const playableEnd = Math.min(videoEnd, audioEnd);
                if (!isFinite(playableEnd) || playableEnd <= playableStart) {
                    missing.push('av-overlap');
                }
            }
        }
        return missing.length > 0 ? missing : ['av-overlap'];
    }

    _failMMTSStartupGroup(state, reason) {
        if (!state || state !== this._mmtsStartupGroup || state.emitted === true ||
            state.failed === true || !this._isCurrentPlaybackOperation(state.operation)) {
            return false;
        }
        const failure = createMMTSStartupGroupFailure(
            state.operation,
            'collecting',
            reason,
            this._getMMTSStartupGroupMissing(state)
        );
        state.failed = true;
        this._clearMMTSStartupGroupWatchdog(state);
        const operation = clonePlaybackOperation(state.operation);
        if (this._getCurrentProducerPlaybackOperation()) {
            this._emitter.emit(TransmuxingEvents.STARTUP_GROUP_FAILED, failure);
        } else {
            this._withProducerPlaybackOperation(operation, () => {
                this._emitter.emit(TransmuxingEvents.STARTUP_GROUP_FAILED, failure);
            });
        }
        return true;
    }

    _isCollectingMMTSStartupGroup() {
        return this._config.isMMTS === true &&
            this._mmtsStartupGroup !== null &&
            this._mmtsStartupGroup.emitted !== true;
    }

    _setMMTSStartupGroupMediaInfo(mediaInfo) {
        if (!this._isCollectingMMTSStartupGroup()) {
            return;
        }
        const operation = this._getCurrentProducerPlaybackOperation();
        if (!operation || !isSamePlaybackOperation(
            operation,
            this._mmtsStartupGroup.operation
        ) || this._mmtsStartupGroup.failed === true) {
            return;
        }
        this._mmtsStartupGroup.mediaInfo = {
            hasVideo: mediaInfo && mediaInfo.hasVideo,
            hasAudio: mediaInfo && mediaInfo.hasAudio,
        };
        this._tryEmitMMTSStartupGroup();
    }

    _collectMMTSStartupInitSegment(type, initSegment) {
        if (!this._isCollectingMMTSStartupGroup()) {
            return false;
        }
        if (type !== 'video' && type !== 'audio') {
            return false;
        }
        if (this._mmtsStartupGroup.failed === true) {
            return true;
        }
        initSegment = this._stampMMTSOutputSegment(initSegment);
        if (!initSegment || !this._isMMTSStartupSegmentForOperation(
            initSegment,
            this._mmtsStartupGroup.operation
        )) {
            return true;
        }
        if (type === 'audio' && !this._isCurrentMMTSVodAudioSwitchOutput(
            initSegment && initSegment.mmtsAudioTrackSwitch,
            true
        )) {
            return true;
        }
        if (type === 'video') {
            this._mmtsStartupGroup.videoInitSegment = initSegment;
        } else {
            this._mmtsStartupGroup.audioInitSegment = initSegment;
        }
        this._tryEmitMMTSStartupGroup();
        return true;
    }

    _emitRemuxerMediaSegment(type, mediaSegment) {
        if (this._collectMMTSStartupMediaSegment(type, mediaSegment)) {
            return true;
        }
        this._emitter.emit(TransmuxingEvents.MEDIA_SEGMENT, type, mediaSegment);
        return false;
    }

    _collectMMTSStartupMediaSegment(type, mediaSegment) {
        if (!this._isCollectingMMTSStartupGroup()) {
            return false;
        }
        if (type !== 'video' && type !== 'audio') {
            return false;
        }
        if (this._mmtsStartupGroup.failed === true) {
            return true;
        }
        mediaSegment = this._stampMMTSOutputSegment(mediaSegment);
        if (!mediaSegment || !this._isMMTSStartupSegmentForOperation(
            mediaSegment,
            this._mmtsStartupGroup.operation
        )) {
            return true;
        }
        if (type === 'video') {
            const validWindow = mediaSegment &&
                this._isFirstPlayableWindowValid(mediaSegment.firstPlayableWindow);
            const validSwitchRoot = !this._isMMTSVodAudioSwitchStartupGroup(
                this._mmtsStartupGroup
            ) || this._isMMTSStartupRandomAccessSafeVideoSegment(mediaSegment);
            if (validWindow && validSwitchRoot) {
                if (this._mmtsStartupGroup.videoMediaSegment === null) {
                    this._mmtsStartupGroup.videoMediaSegment = mediaSegment;
                } else {
                    this._mmtsStartupGroup.latestVideoMediaSegment = mediaSegment;
                }
            }
            if (this._mmtsStartupGroup.videoMediaSegment !== null) {
                this._mmtsStartupGroup.videoMediaSegments.push(mediaSegment);
            }
        } else {
            const requireIdentity = (this._pendingMMTSVodAudioSwitchIntent !== null ||
                this._isMMTSVodAudioSwitchStartupGroup(this._mmtsStartupGroup)) &&
                this._mmtsStartupGroup.audioMediaSegments.length === 0;
            if (!this._isCurrentMMTSVodAudioSwitchOutput(
                mediaSegment && mediaSegment.mmtsAudioTrackSwitch,
                requireIdentity
            )) {
                return true;
            }
            this._mmtsStartupGroup.audioMediaSegments.push(mediaSegment);
        }
        this._tryEmitMMTSStartupGroup();
        return true;
    }

    _tryEmitMMTSStartupGroup() {
        const state = this._mmtsStartupGroup;
        if (!state || state.emitted || state.failed || !state.mediaInfo || state.mediaInfo.hasVideo !== true ||
            typeof state.mediaInfo.hasAudio !== 'boolean' ||
            !state.videoInitSegment || !state.videoMediaSegment ||
            !this._isCurrentPlaybackOperation(state.operation) ||
            !this._isMMTSStartupSegmentForOperation(state.videoInitSegment, state.operation) ||
            !this._isMMTSStartupSegmentForOperation(state.videoMediaSegment, state.operation)) {
            return;
        }

        let window = state.videoMediaSegment.firstPlayableWindow;
        if (!this._isFirstPlayableWindowValid(window)) {
            return;
        }

        const hasAudio = state.mediaInfo.hasAudio === true;
        const vodAudioSwitch = this._isMMTSVodAudioSwitchStartupGroup(state);
        let audioMediaSegment = null;
        let videoPlayableEnd = window.playableEnd;
        if (hasAudio) {
            if (!state.audioInitSegment ||
                !this._isMMTSStartupSegmentForOperation(state.audioInitSegment, state.operation)) {
                return;
            }
            if (vodAudioSwitch) {
                if (!this._isMMTSStartupRandomAccessSafeVideoSegment(state.videoMediaSegment)) {
                    return;
                }
                videoPlayableEnd = this._getMMTSStartupVideoCoverageEnd(state, window);
                audioMediaSegment = this._findMMTSVodAudioSwitchStartupSegment(
                    state,
                    window.playableStart,
                    videoPlayableEnd
                );
            } else {
                audioMediaSegment = state.audioMediaSegments.find((segment) => {
                    return this._isMMTSStartupSegmentForOperation(segment, state.operation) &&
                        this._doesMMTSAudioSegmentCoverTime(segment, window.playableStart);
                });
                if (!audioMediaSegment &&
                    state.latestVideoMediaSegment &&
                    this._hasMMTSAudioAdvancedPastTime(state.audioMediaSegments, window.playableStart)) {
                    state.videoMediaSegment = state.latestVideoMediaSegment;
                    state.latestVideoMediaSegment = null;
                    window = state.videoMediaSegment.firstPlayableWindow;
                    state.audioMediaSegments = state.audioMediaSegments.filter((segment) => {
                        const info = segment && segment.info;
                        const end = info ? info.endDts / 1000 : NaN;
                        return isFinite(end) && end >= window.playableStart;
                    });
                    audioMediaSegment = state.audioMediaSegments.find((segment) => {
                        return this._isMMTSStartupSegmentForOperation(segment, state.operation) &&
                            this._doesMMTSAudioSegmentCoverTime(segment, window.playableStart);
                    });
                }
            }
            if (!audioMediaSegment) {
                return;
            }
        }

        const audioInfo = audioMediaSegment && audioMediaSegment.info;
        const audioStart = audioInfo ? audioInfo.beginDts / 1000 : undefined;
        const audioEnd = audioInfo ? audioInfo.endDts / 1000 : undefined;
        const playableStart = hasAudio && vodAudioSwitch ?
            Math.max(window.playableStart, audioStart) : window.playableStart;
        const playableEnd = hasAudio ? Math.min(videoPlayableEnd, audioEnd) : window.playableEnd;
        if (!isFinite(playableStart) || !isFinite(playableEnd) || playableEnd <= playableStart) {
            return;
        }

        state.emitted = true;
        this._clearMMTSStartupGroupWatchdog(state);
        const operation = clonePlaybackOperation(state.operation);
        const selectedVideoIndex = state.videoMediaSegments.indexOf(state.videoMediaSegment);
        const videoContinuationSegments = selectedVideoIndex >= 0 ?
            state.videoMediaSegments.slice(selectedVideoIndex + 1) : [];
        const selectedAudioIndex = state.audioMediaSegments.indexOf(audioMediaSegment);
        const audioContinuationSegments = selectedAudioIndex >= 0 ?
            state.audioMediaSegments.slice(selectedAudioIndex + 1) : [];
        this._emitter.emit(TransmuxingEvents.STARTUP_GROUP, {
            videoInitSegment: state.videoInitSegment,
            audioInitSegment: hasAudio ? state.audioInitSegment : null,
            videoMediaSegment: state.videoMediaSegment,
            audioMediaSegment,
            startupTime: playableStart,
            videoDecodeStart: window.decodeStart,
            videoCompositionStart: window.compositionStart,
            audioStart,
            audioEnd,
            syncPoint: window.syncPoint,
            playableStart,
            playableEnd,
            hasAudio,
            hasVideo: true,
            playbackOperation: operation,
            mseBufferGeneration: operation.timelineGeneration,
        });
        for (let i = 0; i < videoContinuationSegments.length; i++) {
            this._emitter.emit(
                TransmuxingEvents.MEDIA_SEGMENT,
                'video',
                videoContinuationSegments[i]
            );
        }
        for (let i = 0; i < audioContinuationSegments.length; i++) {
            this._emitter.emit(
                TransmuxingEvents.MEDIA_SEGMENT,
                'audio',
                audioContinuationSegments[i]
            );
        }
        state.latestVideoMediaSegment = null;
        state.videoMediaSegments = [];
        state.audioMediaSegments = [];
    }

    _isMMTSStartupSegmentForOperation(segment, operation) {
        return !!segment && isSamePlaybackOperation(segment.playbackOperation, operation) &&
            segment.mseBufferGeneration === operation.timelineGeneration;
    }

    _isCurrentMMTSVodAudioSwitchOutput(audioSwitch, requireIdentity) {
        const state = this._mmtsStartupGroup;
        const operation = state && state.operation && state.operation.kind === 'audio-switch' ?
            state.operation : null;
        if (operation) {
            if (!audioSwitch) {
                return requireIdentity !== true;
            }
            return isPlaybackSwitchIdentity(audioSwitch) &&
                doesPlaybackSwitchIdentityMatchOperation(audioSwitch, operation) &&
                Number.isInteger(operation.packetId) &&
                audioSwitch.packetId === operation.packetId &&
                Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
                audioSwitch.requestedStartMicroseconds === operation.requestedTimeMicroseconds;
        }
        const intent = this._pendingMMTSVodAudioSwitchIntent;
        if (!intent) {
            return true;
        }
        if (!audioSwitch) {
            return requireIdentity !== true;
        }
        return audioSwitch.transactionKey === intent.transactionKey &&
            audioSwitch.attemptKey === intent.attemptKey &&
            audioSwitch.packetId === intent.packetId &&
            Number.isSafeInteger(audioSwitch.requestedStartMicroseconds) &&
            audioSwitch.requestedStartMicroseconds === intent.requestedStartMicroseconds;
    }

    _isMMTSVodAudioSwitchStartupGroup(state) {
        return !!state && !!state.operation && state.operation.kind === 'audio-switch';
    }

    _isMMTSStartupRandomAccessSafeVideoSegment(segment) {
        const info = segment && segment.info;
        const firstSample = info && info.firstSample;
        const window = segment && segment.firstPlayableWindow;
        const decodeStart = info && isFinite(info.beginDts) ? info.beginDts / 1000 : NaN;
        return !!segment && segment.type === 'video' &&
            segment.mmtsRandomAccessSafe === true &&
            !!firstSample && firstSample.isSyncPoint === true &&
            this._isFirstPlayableWindowValid(window) &&
            isFinite(decodeStart) && Math.abs(window.decodeStart - decodeStart) <= 0.001 &&
            window.compositionStart <= window.playableStart &&
            Math.abs(window.syncPoint - window.playableStart) <= 0.001 &&
            window.playableStart >= 0;
    }

    _getMMTSStartupVideoCoverageEnd(state, window) {
        let previousEnd = null;
        let coverageEnd = window.playableEnd;
        for (const segment of state.videoMediaSegments) {
            const info = segment && segment.info;
            const start = info && isFinite(info.beginDts) ? info.beginDts / 1000 : NaN;
            const end = info && isFinite(info.endDts) ? info.endDts / 1000 : NaN;
            if (!isFinite(start) || !isFinite(end) || end <= start ||
                (previousEnd !== null &&
                    (start < previousEnd - 0.000001 || start > previousEnd + 0.100001))) {
                break;
            }
            coverageEnd = Math.max(coverageEnd, end);
            if (isFinite(info.endPts)) {
                coverageEnd = Math.max(coverageEnd, info.endPts / 1000);
            }
            for (const sample of [info.firstSample, info.lastSample]) {
                if (sample && isFinite(sample.pts) && isFinite(sample.duration) &&
                    sample.duration >= 0) {
                    coverageEnd = Math.max(coverageEnd, (sample.pts + sample.duration) / 1000);
                }
            }
            previousEnd = end;
        }
        return coverageEnd;
    }

    _findMMTSVodAudioSwitchStartupSegment(state, videoStart, videoEnd) {
        return state.audioMediaSegments.find((segment) => {
            if (!this._isMMTSStartupSegmentForOperation(segment, state.operation) ||
                !this._isCurrentMMTSVodAudioSwitchOutput(
                    segment && segment.mmtsAudioTrackSwitch,
                    true
                )) {
                return false;
            }
            const info = segment.info;
            const start = info ? info.beginDts / 1000 : NaN;
            const end = info ? info.endDts / 1000 : NaN;
            return isFinite(start) && isFinite(end) && end > start &&
                Math.max(videoStart, start) < Math.min(videoEnd, end);
        });
    }

    _doesMMTSAudioSegmentCoverTime(segment, time) {
        const info = segment && segment.info;
        const start = info ? info.beginDts / 1000 : NaN;
        const end = info ? info.endDts / 1000 : NaN;
        return isFinite(start) && isFinite(end) && start <= time && end >= time;
    }

    _hasMMTSAudioAdvancedPastTime(segments, time) {
        for (let i = segments.length - 1; i >= 0; i--) {
            const info = segments[i] && segments[i].info;
            const start = info ? info.beginDts / 1000 : NaN;
            if (isFinite(start)) {
                return start > time;
            }
        }
        return false;
    }

    _isFirstPlayableWindowValid(window) {
        return !!window &&
            isFinite(window.decodeStart) &&
            isFinite(window.compositionStart) &&
            isFinite(window.syncPoint) &&
            isFinite(window.playableStart) &&
            isFinite(window.playableEnd) &&
            window.playableEnd > window.playableStart;
    }

    _enableStatisticsReporter() {
        if (this._statisticsReporter == null) {
            this._statisticsReporter = self.setInterval(
                this._reportStatisticsInfo.bind(this),
            this._config.statisticsInfoReportInterval);
        }
    }

    _disableStatisticsReporter() {
        if (this._statisticsReporter) {
            self.clearInterval(this._statisticsReporter);
            this._statisticsReporter = null;
        }
    }

    _reportSegmentMediaInfo(segmentIndex) {
        let segmentInfo = this._mediaInfo.segments[segmentIndex];
        let exportInfo = Object.assign({}, segmentInfo);

        exportInfo.duration = this._mediaInfo.duration;
        exportInfo.segmentCount = this._mediaInfo.segmentCount;
        delete exportInfo.segments;
        delete exportInfo.keyframesIndex;

        this._emitter.emit(TransmuxingEvents.MEDIA_INFO, exportInfo);
    }

    _reportStatisticsInfo() {
        let info = {};

        info.url = this._ioctl.currentURL;
        info.hasRedirect = this._ioctl.hasRedirect;
        if (info.hasRedirect) {
            info.redirectedURL = this._ioctl.currentRedirectedURL;
        }

        info.speed = this._ioctl.currentSpeed;
        info.loaderType = this._ioctl.loaderType;
        info.currentSegmentIndex = this._currentSegmentIndex;
        info.totalSegmentCount = this._mediaDataSource.segments.length;

        if (this._config.isMMTS === true) {
            const producer = this._activeIOProducer;
            if (!producer || !this._isCurrentPlaybackOperation(producer.operation)) {
                return;
            }
            this._withProducerPlaybackOperation(producer.operation, () => {
                this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, info);
            });
        } else {
            this._emitter.emit(TransmuxingEvents.STATISTICS_INFO, info);
        }
    }

}

export default TransmuxingController;

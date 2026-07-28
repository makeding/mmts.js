/*
 * Copyright (C) 2021 magicxqq. All Rights Reserved.
 *
 * @author magicxqq <xqq@xqq.im>
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

// mpegts.js TypeScript definition file

declare namespace Mpegts {
    interface MediaSegment {
        duration: number;
        filesize?: number;
        url: string;
    }

    interface MediaDataSource {
        type: string;
        isLive?: boolean;
        cors?: boolean;
        withCredentials?: boolean;

        hasAudio?: boolean;
        hasVideo?: boolean;

        duration?: number;
        filesize?: number;
        url?: string;

        segments?: MediaSegment[];
    }

    interface MMTSDurationProbeOptions {
        filesize?: number;
        withCredentials?: boolean;
        timeout?: number;
        videoPacketId?: number;
        initialStartProbeBytes?: number;
        initialTailProbeBytes?: number;
        maxStartProbeBytes?: number;
        maxTailProbeBytes?: number;
    }

    interface MMTSDurationProbeResult {
        duration: number;
        filesize: number;
        startTime: number;
        endTime: number;
        startOffset: number;
        endOffset: number;
        startPacketId: number;
        endPacketId: number;
    }

    type PlaybackOperationKind = 'startup' | 'seek' | 'audio-switch' | 'video-switch';
    type PlaybackOperationProgressStatus = 'queued' | 'running' | 'retrying' | 'recovering';
    type PlaybackOperationTerminalStatus =
        'committed' | 'no-op' | 'cancelled' | 'superseded' | 'failed';
    type PlaybackOperationStatus = PlaybackOperationProgressStatus | PlaybackOperationTerminalStatus;

    interface PlaybackOperation {
        scopeId: string;
        transactionKey: string;
        attemptKey: string;
        timelineGeneration: number;
        kind: PlaybackOperationKind;
        transactionId: number;
        attempt: number;
        phase: string;
        intentTimeMicroseconds: number;
        requestedTimeMicroseconds: number;
        requestedTimeMilliseconds: number;
        packetId?: number;
    }

    interface PlaybackOperationEvent {
        operation: PlaybackOperation;
        scopeId: string;
        transactionKey: string;
        attemptKey: string;
        timelineGeneration: number;
        transactionId: number;
        attempt: number;
        kind: PlaybackOperationKind;
        phase: string;
        status: PlaybackOperationStatus;
        terminal: boolean;
        requestedPacketId?: number;
        committedPacketId?: number;
        requestedTimeMilliseconds: number;
        committedTimeMilliseconds?: number;
        reason?: string;
        error?: any;
    }

    interface PlaybackOperationResult extends PlaybackOperationEvent {
        status: PlaybackOperationTerminalStatus;
        terminal: true;
    }

    interface Config {
        /**
         * @desc Enable separated thread (DedicatedWorker) for transmuxing
         * @defaultvalue false
         */
        enableWorker?: boolean;
        /**
         * @desc Enable separated thread (DedicatedWorker) for MediaSource
         * @defaultvalue false
         */
        enableWorkerForMSE?: boolean;
        /**
         * @desc Enable IO stash buffer. Set to false if you need realtime (minimal latency) for live stream
         *          playback, but may stalled if there's network jittering.
         * @defaultvalue true
         */
        enableStashBuffer?: boolean;
        /**
         * @desc Prefer bounded XMLHttpRequest range chunks over a streaming fetch response.
         *       Enabled by default for Safari MMTS VOD to keep paused network buffering bounded.
         * @defaultvalue false
         */
        preferRangeLoader?: boolean;
        /**
         * @desc Indicates IO stash buffer initial size. Default is `384KB`. Indicate a suitable size can
         *          improve video load/seek time.
         */
        stashInitialSize?: number;

        /**
         * @desc Maximum loader read rate in KB/s. Set to 0 to disable throttling.
         *       This limits fetch-stream and xhr-range reads before transmuxing.
         * @defaultvalue 0
         */
        loaderThrottleKBps?: number;

        /**
         * @desc Same to `isLive` in **MediaDataSource**, ignored if has been set in MediaDataSource structure.
         * @defaultvalue false
         */
        isLive?: boolean;

        /**
         * @desc Chasing the live stream latency caused by the internal buffer in HTMLMediaElement
         *       `isLive` should also be set to `true`
         * @defaultvalue false
         */
        liveBufferLatencyChasing?: boolean;

        /**
         * @desc Chasing the live stream latency caused by the internal buffer in HTMLMediaElement even if HTMLMediaElement is paused
         *       Effective only if `isLive: true` and `liveBufferLatencyChasing: true`
         * @defaultvalue false
         */
        liveBufferLatencyChasingOnPaused?: boolean;

        /**
         * @desc Maximum acceptable buffer latency in HTMLMediaElement, in seconds
         *       Effective only if `isLive: true` and `liveBufferLatencyChasing: true`
         * @defaultvalue 1.5
         */
        liveBufferLatencyMaxLatency?: number;

        /**
         * @desc Minimum buffer latency to be keeped in HTMLMediaElement, in seconds
         *       Effective only if `isLive: true` and `liveBufferLatencyChasing: true`
         * @defaultvalue 0.5
         */
        liveBufferLatencyMinRemain?: number;

        /**
         * @desc Enable lazy-load pause/resume backpressure for live streams.
         *       Useful when a file or timeshift source is served as a simulated live stream.
         * @defaultvalue false
         */
        lazyLoadOnLive?: boolean;

        /**
         * @desc Force the MMTS HEVC video packet_id. Useful for choosing an alternate video asset.
         */
        mmtsVideoPacketId?: number;

        /**
         * @desc Advertise MMTS HEVC with an hvc1 ISO BMFF sample entry while retaining
         *       in-band parameter sets from an hev1 broadcast asset.
         * @defaultvalue true on Safari and Firefox; false on Chromium
         */
        mmtsForceHvc1SampleEntry?: boolean;

        /**
         * @desc Prototype switch that advertises MMTS HEVC as SDR BT.709 primaries/transfer while preserving
         *       the source matrix coefficients. This tests whether browser HDR tone mapping can be bypassed.
         * @defaultvalue false
         */
        mmtsForceSDRColorimetry?: boolean;

        /**
         * @desc Defer initial MMTS HEVC video SourceBuffer creation until the audio init segment has arrived.
         * @defaultvalue true for MMTS VOD except Firefox; false for MMTS live
         */
        mmtsDeferHevcVideoInitUntilAudio?: boolean;

        /**
         * @desc Keep remuxer timestamp state on MMTS packet discontinuity unless a media timeline reset is required.
         * @defaultvalue true for `type: 'mmts'`
         */
        mmtsPreserveRemuxerTimestampOnPacketDiscontinuity?: boolean;

        /**
         * @desc Clamp small positive MMTS AAC timestamp gaps to the expected frame timeline when enabled.
         *       Disabled by default so packet-loss gaps remain on the media timeline.
         * @defaultvalue false
         */
        mmtsClampAudioTimestampGap?: boolean;

        /**
         * @desc Clamp small positive MMTS HEVC timestamp gaps to the expected frame timeline when enabled.
         *       Disabled by default so packet-loss gaps remain visible as freezes or decoder recovery artifacts.
         * @defaultvalue false
         */
        mmtsClampVideoTimestampGap?: boolean;

        /**
         * @desc Required forward buffer before initial MMTS live playback starts, in seconds. Set to 0 to disable.
         * @defaultvalue 1.5 for `type: 'mmts'` with `isLive: true`
         */
        mmtsLiveInitialBufferDuration?: number;

        /**
         * @desc Duration of MMTS video samples kept in remuxer memory before appending to MSE, in seconds.
         *       This gives packet-loss recovery enough previous video samples to bridge sparse HEVC ranges.
         * @defaultvalue 0
         */
        mmtsVideoTailStashDuration?: number;

        /**
         * @desc Duration of the small in-memory AAC sample cache used for instant MMTS audio track switching, in seconds.
         *       This caches audio frames only, not video frames or MSE buffered media.
         * @defaultvalue 10
         */
        mmtsAudioTrackSwitchCacheDuration?: number;

        /**
         * @desc Bytes to seek before an estimated MMTS VOD byte position while the target time has not been indexed yet.
         * @defaultvalue 33554432
         */
        mmtsVodSeekLookbackBytes?: number;

        /**
         * @desc Maximum bytes to seek before an estimated MMTS VOD byte position when retrying unresolved seeks
         *       or when the first random access point is still after the requested time.
         * @defaultvalue 268435456
         */
        mmtsVodSeekMaxLookbackBytes?: number;

        /**
         * @desc Coalesce rapid MMTS VOD progress-bar changes. Only the latest
         *       target is submitted after this interval, in milliseconds.
         * @defaultvalue 100
         */
        mmtsSeekDebounceInterval?: number;

        /**
         * @desc Chasing the live stream latency caused by the internal buffer in HTMLMediaElement
         *       by changing the playbackRate. `isLive` should also be set to `true`
         * @defaultvalue false
         */
        liveSync?: boolean;

        /**
         * @desc Maximum acceptable buffer latency in HTMLMediaElement, in seconds.
         *       Effective only if `isLive: true` and `liveSync: true`
         * @defaultvalue 1.2
         */
        liveSyncMaxLatency?: number;

        /**
         * @desc Target latency in HTMLMediaElement to chase when latency exceeds liveSyncMaxLatency, in seconds.
         *       Effective only if `isLive: true` and `liveSync: true`
         * @defaultvalue 0.8
         */
        liveSyncTargetLatency?: number;

        /**
         * @desc PlaybackRate limited between [1, 2] will be used for latency chasing.
         *       Effective only if `isLive: true` and `liveSync: true`
         * @defaultvalue 1.2
         */
        liveSyncPlaybackRate?: number;

        /**
         * @desc Minimum acceptable buffer latency in HTMLMediaElement, in seconds.
         *       Effective only if `isLive: true` and `liveSync: true`
         * @defaultvalue undefined
         */
        liveSyncMinLatency?: number;

        /**
         * @desc PlaybackRate limited between [0.5, 1] will be used for latency chasing.
         *       Effective only if `isLive: true` and `liveSync: true`
         * @defaultvalue 0.95
         */
        liveSyncMinPlaybackRate?: number;

        /**
         * @desc Abort the http connection if there's enough data for playback.
         * @defaultvalue true
         */
        lazyLoad?: boolean;
        /**
         * @desc Indicates how many seconds of data to be kept for `lazyLoad`.
         * @defaultvalue 3 * 60; 90 for MMTS VOD; 18 for MMTS live
         */
        lazyLoadMaxDuration?: number;
        /**
         * @desc Indicates the `lazyLoad` recover time boundary in seconds.
         * @defaultvalue 30; 60 for MMTS VOD; 8 for MMTS live
         */
        lazyLoadRecoverDuration?: number;
        /**
         * @desc Indicates how many forward buffered bytes to be kept for `lazyLoad`.
         * @defaultvalue undefined; 112MiB for MMTS VOD; 64MiB for MMTS live
         */
        lazyLoadMaxBytes?: number;
        /**
         * @desc Indicates the `lazyLoad` recover byte boundary.
         * @defaultvalue undefined; 96MiB for MMTS VOD; 32MiB for MMTS live
         */
        lazyLoadRecoverBytes?: number;
        /**
         * @desc Pause MMTS loading when appended and queued video bytes reach this soft limit.
         * @defaultvalue undefined; 112MiB for MMTS VOD; 64MiB for MMTS live
         */
        mseBufferVideoSoftLimitBytes?: number;
        /**
         * @desc Stop MMTS video append before total buffered video reaches this hard byte limit and wait for played data cleanup.
         * @defaultvalue undefined; 128MiB for MMTS VOD; 96MiB for MMTS live
         */
        mseBufferVideoHardLimitBytes?: number;
        /**
         * @desc Pause MMTS loading when appended and queued audio bytes reach this soft limit.
         * @defaultvalue undefined; 8MiB for MMTS VOD and live
         */
        mseBufferAudioSoftLimitBytes?: number;
        /**
         * @desc Stop MMTS audio append before total buffered audio reaches this hard byte limit and wait for played data cleanup.
         * @defaultvalue undefined; 12MiB for MMTS VOD and live
         */
        mseBufferAudioHardLimitBytes?: number;
        /**
         * @desc Pause MMTS loading when the contiguous playable forward window reaches this duration.
         * @defaultvalue undefined; 90 for MMTS VOD; 18 for MMTS live
         */
        mseBufferForwardTargetDuration?: number;
        /**
         * @desc Resume MMTS loading after the contiguous playable forward window falls below this duration.
         * @defaultvalue undefined; 60 for MMTS VOD; 8 for MMTS live
         */
        mseBufferRecoverForwardDuration?: number;
        /**
         * @desc Required forward buffer before initial playback starts, in seconds. Set to 0 to disable.
         *       If unset, MMTS live playback falls back to `mmtsLiveInitialBufferDuration`.
         * @defaultvalue 0; 3 for MMTS live lazy-load
         */
        startupBufferDuration?: number;
        /**
         * @desc Maximum media duration to combine into one MSE appendBuffer call, in seconds. Set to 0 to disable.
         * @defaultvalue 0; 0.5 for MMTS VOD; 0.35 for MMTS live
         */
        mseAppendBatchDuration?: number;
        /**
         * @desc Maximum seconds one MSE track may be appended ahead of the other track.
         *       This prevents audio and video SourceBuffers from drifting apart under heavy append load.
         * @defaultvalue undefined; 2 for MMTS VOD; 1.5 for MMTS live
         */
        mseAppendTrackLeadLimit?: number;
        /**
         * @desc Do load after MediaSource `sourceopen` event triggered. On Chrome, tabs which
         *          be opened in background may not trigger `sourceopen` event until switched to that tab.
         * @defaultvalue true
         */
        deferLoadAfterSourceOpen?: boolean;

        /**
         * @desc Do auto cleanup for SourceBuffer
         * @defaultvalue false; true for MMTS
         */
        autoCleanupSourceBuffer?: boolean;
        /**
         * @desc When backward buffer duration exceeded this value (in seconds), do auto cleanup for SourceBuffer
         * @defaultvalue 3 * 60; 6 for MMTS VOD, 10 for MMTS live
         */
        autoCleanupMaxBackwardDuration?: number;
        /**
         * @desc Indicates the duration in seconds to reserve for backward buffer when doing auto cleanup.
         *       MMTS hard-budget or quota recovery may reduce this to at most 4 seconds for live or 2 seconds for VOD.
         * @defaultvalue 2 * 60; 2 for MMTS VOD, 4 for MMTS live
         */
        autoCleanupMinBackwardDuration?: number;
        /**
         * @defaultvalue 600
         */
        statisticsInfoReportInterval?: number;

        /**
         * @desc Fill silent audio frames to avoid a/v unsync when detect large audio timestamp gap.
         * @defaultvalue true
         */
        fixAudioTimestampGap?: boolean;

        /**
         * @desc Accurate seek to any frame, not limited to video IDR frame, but may a bit slower.
         *          Available on Chrome > 50, FireFox and Safari.
         * @defaultvalue false
         */
        accurateSeek?: boolean;
        /**
         * @desc 'range' use range request to seek, or 'param' add params into url to indicate request range.
         * @defaultvalue 'range'
         */
        seekType?: 'range' | 'param' | 'custom';
        /**
         * @desc Indicates seek start parameter name for seekType = 'param'
         * @defaultvalue 'bstart'
         */
        seekParamStart?: string;
        /**
         * @desc Indicates seek end parameter name for seekType = 'param'
         * @defaultvalue 'bend'
         */
        seekParamEnd?: string;
        /**
         * @desc Send Range: bytes=0- for first time load if use Range seek
         * @defaultvalue false
         */
        rangeLoadZeroStart?: boolean;
        /**
         * @desc Indicates a custom seek handler
         * @desc Should implement `SeekHandler` interface
         */
        customSeekHandler?: CustomSeekHandlerConstructor;
        /**
         * @desc Reuse 301/302 redirected url for subsequence request like seek, reconnect, etc.
         * @defaultvalue false
         */
        reuseRedirectedURL?: boolean;
        /**
         * @desc Indicates the Referrer Policy when using FetchStreamLoader
         * @defaultvalue 'no-referrer-when-downgrade' (from docs)
         */
        referrerPolicy?: ReferrerPolicy;
        /**
         * @desc Indicates additional headers that will be added to request
         */
        headers?: {
            [k: string]: string
        }
        /**
         * @desc Should implement `BaseLoader` interface
         */
        customLoader?: CustomLoaderConstructor;
    }

    interface CustomSeekHandlerConstructor {
        new(): SeekHandler;
    }

    interface SeekHandler {
        getConfig(sourceURL: string, range: Range): SeekConfig;
        removeURLParameters(url: string): string;
    }

    interface SeekConfig {
        url: string;
        headers: Headers | object;
    }

    interface BaseLoaderConstructor {
        new(typeName: string): BaseLoader;
    }

    interface BaseLoader {
        _status: number;
        _needStash: boolean;

        destroy(): void;
        isWorking(): boolean;
        readonly type: string;
        readonly status: number;
        readonly needStashBuffer: boolean;
        onContentLengthKnown: (contentLength: number) => void;
        onURLRedirect: (redirectedURL: string) => void;
        onDataArrival: (chunk: ArrayBuffer, byteStart: number, receivedLength?: number) => void;
        onError: (errorType: LoaderErrors, errorInfo: LoaderErrorMessage) => void;
        onComplete: (rangeFrom: number, rangeTo: number) => void;
        open(dataSource: MediaSegment, range: Range): void;
        abort(): void;
    }

    interface CustomLoaderConstructor {
        new(seekHandler: SeekHandler, config: Config): BaseLoader;
    }

    interface Range {
        from: number;
        to: number;
    }

    interface LoaderStatus {
        readonly kIdle: 0;
        readonly kConnecting: 1;
        readonly kBuffering: 2;
        readonly kError: 3;
        readonly kComplete: 4;
    }

    interface LoaderErrors {
        readonly OK: 'OK';
        readonly EXCEPTION: 'Exception';
        readonly HTTP_STATUS_CODE_INVALID: 'HttpStatusCodeInvalid';
        readonly CONNECTING_TIMEOUT: 'ConnectingTimeout';
        readonly EARLY_EOF: 'EarlyEof';
        readonly UNRECOVERABLE_EARLY_EOF: 'UnrecoverableEarlyEof';
    }

    interface LoaderErrorMessage {
        code: number;
        msg: string;
    }

    interface FeatureList {
        msePlayback: boolean;
        mseLivePlayback: boolean;
        mseH265Playback: boolean;
        networkStreamIO: boolean;
        networkLoaderName: string;
        nativeMP4H264Playback: boolean;
        nativeMP4H265Playback: boolean;
        nativeWebmVP8Playback: boolean;
        nativeWebmVP9Playback: boolean;
    }

    interface PlayerConstructor<T extends Player> {
        new (mediaDataSource: MediaDataSource, config?: Config): T;
    }

    interface Player {
        destroy(): void;
        on(event: string, listener: (...args: any[]) => void): void;
        off(event: string, listener: (...args: any[]) => void): void;
        attachMediaElement(mediaElement: HTMLMediaElement): void;
        detachMediaElement(): void;
        load(): void;
        unload(): void;
        play(): Promise<void> | void;
        pause(): void;
        type: string;
        buffered: TimeRanges;
        duration: number;
        volume: number;
        muted: boolean;
        currentTime: number;
        /**
         * @deprecated MSEPlayer/NativePlayer have its own `mediaInfo` field.
         * @desc Keep it for backwards compatibility
         * @since 1.4
         */
        mediaInfo: NativePlayerMediaInfo | MSEPlayerMediaInfo;
        /**
         * @deprecated MSEPlayer/NativePlayer have its own `statisticsInfo` field.
         * @desc Keep it for backwards compatibility
         * @since 1.4
         */
        statisticsInfo: NativePlayerStatisticsInfo | MSEPlayerStatisticsInfo;
    }

    interface NativePlayerStatisticsInfo {
        playerType: 'NativePlayer';
        url: string;
        decodedFrames?: number;
        droppedFrames?: number;
    }

    interface MSEPlayerReportStatisticsInfo {
        url: string;
        hasRedirect: boolean;
        redirectedURL?: string;
        speed: number; // KB/s
        loaderType: string;
        currentSegmentIndex: number;
        totalSegmentCount: number;
    }

    interface MSEPlayerStatisticsInfo extends Partial<MSEPlayerReportStatisticsInfo> {
        playerType: 'MSEPlayer';
        decodedFrames?: number;
        droppedFrames?: number;
    }

    interface NativePlayerMediaInfo {
        mimeType: string;
        duration?: number;
        width?: number;
        height?: number;
    }

    interface MSEPlayerMediaInfo extends NativePlayerMediaInfo {
        audioCodec?: string;
        videoCodec?: string;
        audioDataRate?: number;
        videoDataRate?: number;
        hasAudio?: boolean;
        hasVideo?: boolean;
        chromaFormat?: string;
        fps?: number;

        [k: string]: any;
    }

    interface MSEPlayer extends Player {
        /**
         * Submit a seek. For MMTS VOD the Promise resolves only when the new
         * startup group is committed, cancelled, superseded, or failed.
         */
        seek(seconds: number): Promise<PlaybackOperationResult>;
        switchPrimaryAudio(): Promise<PlaybackOperationResult>;
        switchSecondaryAudio(): Promise<PlaybackOperationResult>;
        selectAudioTrack(packetId: number): Promise<PlaybackOperationResult>;
        selectVideoTrack(packetId: number): Promise<PlaybackOperationResult>;
        mediaInfo: MSEPlayerMediaInfo;
        statisticsInfo: MSEPlayerStatisticsInfo;
    }

    interface NativePlayer extends Player {
        mediaInfo: NativePlayerMediaInfo;
        statisticsInfo: NativePlayerStatisticsInfo;
    }

    interface LoggingControlConfig {
        forceGlobalTag: boolean;
        globalTag: string;
        enableAll: boolean;
        enableDebug: boolean;
        enableVerbose: boolean;
        enableInfo: boolean;
        enableWarn: boolean;
        enableError: boolean;
    }

    interface LoggingControl extends LoggingControlConfig {
        getConfig(): LoggingControlConfig;
        applyConfig(config: Partial<LoggingControlConfig>): void;
        addLogListener(listener: (...args: any[]) => void): void;
        removeLogListener(listener: (...args: any[]) => void): void;
    }

    interface Events {
        ERROR: string;
        LOADING_COMPLETE: string;
        RECOVERED_EARLY_EOF: string;
        MEDIA_INFO: string;
        METADATA_ARRIVED: string;
        SCRIPTDATA_ARRIVED: string;
        TIMED_ID3_METADATA_ARRIVED: string;
        PGS_SUBTITLE_ARRIVED: string;
        SYNCHRONOUS_KLV_METADATA_ARRIVED: string;
        ASYNCHRONOUS_KLV_METADATA_ARRIVED: string;
        SMPTE2038_METADATA_ARRIVED: string;
        PES_PRIVATE_DATA_DESCRIPTOR: string;
        PES_PRIVATE_DATA_ARRIVED: string;
        MMTS_AUDIO_TRACKS: string;
        MMTS_VIDEO_TRACKS: string;
        /** Progress events: queued/running/retrying/recovering and terminal states. */
        MMTS_OPERATION_STATE: string;
        /** Terminal operation events only. */
        MMTS_OPERATION_RESULT: string;
        MMTS_SUBTITLE_TRACKS: string;
        MMTS_SUBTITLE_DATA_ARRIVED: string;
        STATISTICS_INFO: string;
    }

    interface ErrorTypes {
        NETWORK_ERROR: string;
        MEDIA_ERROR: string;
        OTHER_ERROR: string;
    }

    interface ErrorDetails {
        NETWORK_EXCEPTION: string;
        NETWORK_STATUS_CODE_INVALID: string;
        NETWORK_TIMEOUT: string;
        NETWORK_UNRECOVERABLE_EARLY_EOF: string;

        MEDIA_MSE_ERROR: string;

        MEDIA_FORMAT_ERROR: string;
        MEDIA_FORMAT_UNSUPPORTED: string;
        MEDIA_CODEC_UNSUPPORTED: string;
    }
}

declare var Mpegts: {
    createPlayer(mediaDataSource: Mpegts.MediaDataSource, config?: Mpegts.Config): Mpegts.Player;
    isSupported(): boolean;
    supportWorkerForMSEH265Playback(): Promise<boolean>;
    getFeatureList(): Mpegts.FeatureList;
    probeMMTSDuration(url: string, options?: Mpegts.MMTSDurationProbeOptions): Promise<Mpegts.MMTSDurationProbeResult>;

    /**
     * @deprecated Use `Mpegts.BaseLoaderConstructor` instead.
     *              Because it's not available on `mpegts` variable.
     * @desc implement interface `BaseLoader`
     * @since 1.4
     */
    BaseLoader: Mpegts.BaseLoaderConstructor;
    /**
     * @deprecated Use `Mpegts.BaseLoaderConstructor` instead.
     *              Because it's not available on `mpegts` variable.
     * @since 1.4
     */
    LoaderStatus: Mpegts.LoaderStatus;
    /**
     * @deprecated Use `Mpegts.BaseLoaderConstructor` instead.
     *              Because it's not available on `mpegts` variable.
     * @since 1.4
     */
    LoaderErrors: Mpegts.LoaderErrors;

    readonly version: string;

    readonly Events: Readonly<Mpegts.Events>;
    readonly ErrorTypes: Readonly<Mpegts.ErrorTypes>;
    readonly ErrorDetails: Readonly<Mpegts.ErrorDetails>;

    readonly MSEPlayer: Mpegts.PlayerConstructor<Mpegts.MSEPlayer>;
    readonly NativePlayer: Mpegts.PlayerConstructor<Mpegts.NativePlayer>;
    readonly LoggingControl: Mpegts.LoggingControl;
};

export default Mpegts;

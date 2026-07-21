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

import Browser from './utils/browser.js';

export const defaultConfig = {
    enableWorker: false,
    enableWorkerForMSE: false,
    enableStashBuffer: true,
    stashInitialSize: undefined,
    loaderThrottleKBps: 0,

    isLive: false,
    isMMTS: false,

    liveBufferLatencyChasing: false,
    liveBufferLatencyChasingOnPaused: false,
    liveBufferLatencyMaxLatency: 1.5,
    liveBufferLatencyMinRemain: 0.5,

    liveSync: false,
    liveSyncMaxLatency: 1.2,
    liveSyncTargetLatency: 0.8,
    liveSyncPlaybackRate: 1.2,
    liveSyncMinLatency: undefined,
    liveSyncMinPlaybackRate: 0.95,

    lazyLoad: true,
    lazyLoadOnLive: false,
    lazyLoadMaxDuration: 3 * 60,
    lazyLoadRecoverDuration: 30,
    lazyLoadMaxBytes: undefined,
    lazyLoadRecoverBytes: undefined,
    startupBufferDuration: undefined,
    mseBufferVideoSoftLimitBytes: undefined,
    mseBufferVideoHardLimitBytes: undefined,
    mseBufferAudioSoftLimitBytes: undefined,
    mseBufferAudioHardLimitBytes: undefined,
    mseBufferForwardTargetDuration: undefined,
    mseBufferRecoverForwardDuration: undefined,
    mseAppendBatchDuration: 0,
    mseAppendTrackLeadLimit: undefined,
    deferLoadAfterSourceOpen: true,

    // autoCleanupSourceBuffer: default as false, leave unspecified
    autoCleanupMaxBackwardDuration: 3 * 60,
    autoCleanupMinBackwardDuration: 2 * 60,

    statisticsInfoReportInterval: 600,

    fixAudioTimestampGap: true,

    mmtsVideoPacketId: undefined,
    // Prototype switch: advertise HLG samples as SDR to stop the browser from applying its HDR tone mapper.
    // The BT.2020-NCL matrix is intentionally preserved so decoded YUV components are not mixed with BT.709 coefficients.
    mmtsForceSDRColorimetry: false,
    mmtsDeferHevcVideoInitUntilAudio: false,
    mmtsPreserveRemuxerTimestampOnPacketDiscontinuity: false,
    mmtsClampAudioTimestampGap: false,
    mmtsClampVideoTimestampGap: false,
    mmtsLiveInitialBufferDuration: 0,
    mmtsVideoTailStashDuration: 0,
    mmtsAudioTrackSwitchCacheDuration: 10,
    mmtsStartupGroupTimeout: 45000,
    mmtsVodSeekLookbackBytes: 32 * 1024 * 1024,
    mmtsVodSeekMaxLookbackBytes: 256 * 1024 * 1024,
    mmtsSeekDebounceInterval: 100,

    accurateSeek: false,
    seekType: 'range',  // [range, param, custom]
    seekParamStart: 'bstart',
    seekParamEnd: 'bend',
    rangeLoadZeroStart: false,
    customSeekHandler: undefined,
    reuseRedirectedURL: false,
    // referrerPolicy: leave as unspecified

    headers: undefined,
    customLoader: undefined
};

export function createDefaultConfig() {
    return Object.assign({}, defaultConfig);
}

export function applyMediaDataSourceConfig(config, mediaDataSource, customConfig) {
    if (mediaDataSource.isLive === true) {
        config.isLive = true;
    }

    if (mediaDataSource.type !== 'mmts') {
        return;
    }

    config.isMMTS = true;
    if (!customConfig || customConfig.mmtsDeferHevcVideoInitUntilAudio === undefined) {
        config.mmtsDeferHevcVideoInitUntilAudio = !config.isLive && !Browser.firefox;
    }
    if (!customConfig || customConfig.mmtsPreserveRemuxerTimestampOnPacketDiscontinuity === undefined) {
        config.mmtsPreserveRemuxerTimestampOnPacketDiscontinuity = true;
    }
    if (!customConfig || customConfig.mmtsClampVideoTimestampGap === undefined) {
        config.mmtsClampVideoTimestampGap = false;
    }
    if (!customConfig || customConfig.mmtsClampAudioTimestampGap === undefined) {
        config.mmtsClampAudioTimestampGap = false;
    }
    if (!customConfig || customConfig.lazyLoadMaxDuration === undefined) {
        config.lazyLoadMaxDuration = config.isLive ? 18 : 90;
    }
    if (!customConfig || customConfig.lazyLoadRecoverDuration === undefined) {
        config.lazyLoadRecoverDuration = config.isLive ? 8 : 60;
    }
    if (!customConfig || customConfig.lazyLoadMaxBytes === undefined) {
        config.lazyLoadMaxBytes = config.isLive ? 64 * 1024 * 1024 : 112 * 1024 * 1024;
    }
    if (!customConfig || customConfig.lazyLoadRecoverBytes === undefined) {
        config.lazyLoadRecoverBytes = config.isLive ? 32 * 1024 * 1024 : 96 * 1024 * 1024;
    }
    if (!customConfig || customConfig.mseBufferVideoSoftLimitBytes === undefined) {
        config.mseBufferVideoSoftLimitBytes = config.isLive ? 64 * 1024 * 1024 : 112 * 1024 * 1024;
    }
    if (!customConfig || customConfig.mseBufferVideoHardLimitBytes === undefined) {
        config.mseBufferVideoHardLimitBytes = config.isLive ? 96 * 1024 * 1024 : 128 * 1024 * 1024;
    }
    if (!customConfig || customConfig.mseBufferAudioSoftLimitBytes === undefined) {
        config.mseBufferAudioSoftLimitBytes = config.isLive ? 8 * 1024 * 1024 : 8 * 1024 * 1024;
    }
    if (!customConfig || customConfig.mseBufferAudioHardLimitBytes === undefined) {
        config.mseBufferAudioHardLimitBytes = config.isLive ? 12 * 1024 * 1024 : 12 * 1024 * 1024;
    }
    if (!customConfig || customConfig.mseBufferForwardTargetDuration === undefined) {
        config.mseBufferForwardTargetDuration = config.isLive ? 18 : 90;
    }
    if (!customConfig || customConfig.mseBufferRecoverForwardDuration === undefined) {
        config.mseBufferRecoverForwardDuration = config.isLive ? 8 : 60;
    }
    if (!customConfig || customConfig.mseAppendTrackLeadLimit === undefined) {
        config.mseAppendTrackLeadLimit = config.isLive ? 1.5 : 2;
    }
    if (!customConfig || customConfig.mseAppendBatchDuration === undefined) {
        config.mseAppendBatchDuration = config.isLive ? 0.35 : 0.5;
    }
    if (!customConfig || customConfig.autoCleanupSourceBuffer === undefined) {
        config.autoCleanupSourceBuffer = true;
    }
    if (config.autoCleanupSourceBuffer) {
        if (!customConfig || customConfig.autoCleanupMaxBackwardDuration === undefined) {
            config.autoCleanupMaxBackwardDuration = config.isLive ? 10 : 6;
        } else {
            const maxBackwardDuration = config.autoCleanupMaxBackwardDuration;
            if (typeof maxBackwardDuration !== 'number' ||
                !isFinite(maxBackwardDuration) ||
                maxBackwardDuration <= 0) {
                config.autoCleanupMaxBackwardDuration = config.isLive ? 10 : 6;
            }
        }

        if (!customConfig || customConfig.autoCleanupMinBackwardDuration === undefined) {
            config.autoCleanupMinBackwardDuration = config.isLive ? 4 : 2;
        } else {
            const minBackwardDuration = config.autoCleanupMinBackwardDuration;
            if (typeof minBackwardDuration !== 'number' ||
                !isFinite(minBackwardDuration) ||
                minBackwardDuration < 0) {
                config.autoCleanupMinBackwardDuration = config.isLive ? 4 : 2;
            }
        }
        if (config.autoCleanupMinBackwardDuration > config.autoCleanupMaxBackwardDuration) {
            config.autoCleanupMinBackwardDuration = config.autoCleanupMaxBackwardDuration;
        }
    }
    if ((!config.isLive || config.lazyLoadOnLive) &&
        (!customConfig || customConfig.startupBufferDuration === undefined)) {
        config.startupBufferDuration = config.isLive ? 3 : 0;
    }
    if (config.isLive && (!customConfig || customConfig.mmtsLiveInitialBufferDuration === undefined)) {
        config.mmtsLiveInitialBufferDuration = 1.5;
    }
}

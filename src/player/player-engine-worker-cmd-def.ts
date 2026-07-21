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

import type {PlaybackOperation} from '../core/playback-operation';

export type WorkerCommandOp =
    | 'logging_config'
    | 'init'
    | 'destroy'
    | 'initialize_mse'
    | 'shutdown_mse'
    | 'load'
    | 'unload'
    | 'user_seek'
    | 'unbuffered_seek'
    | 'startup_jump'
    | 'timeupdate'
    | 'readystatechange'
    | 'continuous_buffer_stall'
    | 'pause_transmuxer'
    | 'resume_transmuxer'
    | 'switch_audio'
    | 'select_audio_track'
    | 'select_video_track';

export type WorkerCommandPacket = {
    cmd: WorkerCommandOp,
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketInit = WorkerCommandPacket & {
    cmd: 'init',
    media_data_source: any,
    config: any,
};

export type WorkerCommandPacketLoggingConfig = WorkerCommandPacket & {
    cmd: 'logging_config',
    logging_config: any,
};

export type WorkerCommandPacketUnbufferedSeek = WorkerCommandPacket & {
    cmd: 'unbuffered_seek',
    milliseconds: number,
    playback_operation: PlaybackOperation,
};

export type WorkerCommandPacketUserSeek = WorkerCommandPacket & {
    cmd: 'user_seek',
    target_time: number,
    source?: string,
    playback_operation: PlaybackOperation,
};

export type WorkerCommandPacketInitializeMSE = WorkerCommandPacket & {
    cmd: 'initialize_mse',
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketLoad = WorkerCommandPacket & {
    cmd: 'load',
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketStartupJump = WorkerCommandPacket & {
    cmd: 'startup_jump',
    target_time: number,
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketTimeUpdate = WorkerCommandPacket & {
    cmd: 'timeupdate',
    current_time: number,
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketReadyStateChange = WorkerCommandPacket & {
    cmd: 'readystatechange',
    ready_state: number,
    current_time: number,
    event_type?: string,
    playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketSwitchAudio = WorkerCommandPacket & {
    cmd: 'switch_audio',
    audio_track: 'primary' | 'secondary',
    timeline_seed?: number,
    rebuild_from_seek?: boolean,
    playback_operation?: PlaybackOperation,
    recovery_playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketSelectAudioTrack = WorkerCommandPacket & {
    cmd: 'select_audio_track',
    packet_id: number,
    timeline_seed?: number,
    rebuild_from_seek?: boolean,
    playback_operation?: PlaybackOperation,
    recovery_playback_operation?: PlaybackOperation,
};

export type WorkerCommandPacketSelectVideoTrack = WorkerCommandPacket & {
    cmd: 'select_video_track',
    packet_id: number,
    playback_operation?: PlaybackOperation,
    recovery_playback_operation?: PlaybackOperation,
};

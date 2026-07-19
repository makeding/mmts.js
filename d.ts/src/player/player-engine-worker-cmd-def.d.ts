import type { PlaybackOperation } from '../core/playback-operation';
export type WorkerCommandOp = 'logging_config' | 'init' | 'destroy' | 'initialize_mse' | 'shutdown_mse' | 'load' | 'unload' | 'user_seek' | 'unbuffered_seek' | 'startup_jump' | 'timeupdate' | 'readystatechange' | 'pause_transmuxer' | 'resume_transmuxer' | 'switch_audio' | 'select_audio_track' | 'select_video_track';
export type WorkerCommandPacket = {
    cmd: WorkerCommandOp;
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketInit = WorkerCommandPacket & {
    cmd: 'init';
    media_data_source: any;
    config: any;
};
export type WorkerCommandPacketLoggingConfig = WorkerCommandPacket & {
    cmd: 'logging_config';
    logging_config: any;
};
export type WorkerCommandPacketUnbufferedSeek = WorkerCommandPacket & {
    cmd: 'unbuffered_seek';
    milliseconds: number;
    playback_operation: PlaybackOperation;
};
export type WorkerCommandPacketUserSeek = WorkerCommandPacket & {
    cmd: 'user_seek';
    target_time: number;
    source?: string;
    playback_operation: PlaybackOperation;
};
export type WorkerCommandPacketInitializeMSE = WorkerCommandPacket & {
    cmd: 'initialize_mse';
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketLoad = WorkerCommandPacket & {
    cmd: 'load';
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketStartupJump = WorkerCommandPacket & {
    cmd: 'startup_jump';
    target_time: number;
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketTimeUpdate = WorkerCommandPacket & {
    cmd: 'timeupdate';
    current_time: number;
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketReadyStateChange = WorkerCommandPacket & {
    cmd: 'readystatechange';
    ready_state: number;
    current_time: number;
    event_type?: string;
    playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketSwitchAudio = WorkerCommandPacket & {
    cmd: 'switch_audio';
    audio_track: 'primary' | 'secondary';
    timeline_seed?: number;
    rebuild_from_seek?: boolean;
    playback_operation?: PlaybackOperation;
    recovery_playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketSelectAudioTrack = WorkerCommandPacket & {
    cmd: 'select_audio_track';
    packet_id: number;
    timeline_seed?: number;
    rebuild_from_seek?: boolean;
    playback_operation?: PlaybackOperation;
    recovery_playback_operation?: PlaybackOperation;
};
export type WorkerCommandPacketSelectVideoTrack = WorkerCommandPacket & {
    cmd: 'select_video_track';
    packet_id: number;
    playback_operation?: PlaybackOperation;
    recovery_playback_operation?: PlaybackOperation;
};

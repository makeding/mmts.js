export type WorkerCommandOp = 'logging_config' | 'init' | 'destroy' | 'initialize_mse' | 'shutdown_mse' | 'load' | 'unload' | 'unbuffered_seek' | 'timeupdate' | 'readystatechange' | 'pause_transmuxer' | 'resume_transmuxer' | 'switch_audio' | 'select_audio_track' | 'select_video_track';
export type WorkerCommandPacket = {
    cmd: WorkerCommandOp;
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
};
export type WorkerCommandPacketTimeUpdate = WorkerCommandPacket & {
    cmd: 'timeupdate';
    current_time: number;
};
export type WorkerCommandPacketReadyStateChange = WorkerCommandPacket & {
    cmd: 'readystatechange';
    ready_state: number;
};
export type WorkerCommandPacketSwitchAudio = WorkerCommandPacket & {
    cmd: 'switch_audio';
    audio_track: 'primary' | 'secondary';
};
export type WorkerCommandPacketSelectAudioTrack = WorkerCommandPacket & {
    cmd: 'select_audio_track';
    packet_id: number;
};
export type WorkerCommandPacketSelectVideoTrack = WorkerCommandPacket & {
    cmd: 'select_video_track';
    packet_id: number;
};

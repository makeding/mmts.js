import { PlaybackOperation } from './playback-operation';
export type MMTSPlaybackOutputPhase = 'READY' | 'SEEK_PREROLL';
export type MMTSPlaybackOutputRelease = {
    operation: PlaybackOperation;
    audioSegments: any[];
};
/**
 * Coordinates elementary-stream output around an MMTS VOD seek landing.
 *
 * Video owns the transition out of SEEK_PREROLL because only a verified RAP
 * proves the new timeline is usable.  Audio is retained until that transition;
 * subtitle MFUs seen while scanning the byte lookback are discarded because
 * arrival-timed subtitles cannot be mapped safely before the new video clock.
 */
export default class MMTSPlaybackOutputState {
    private phase_;
    private operation_;
    private audio_operation_;
    private audio_segments_;
    get phase(): MMTSPlaybackOutputPhase;
    get pendingAudioSegments(): readonly any[];
    beginSeekPreroll(operation: PlaybackOperation): void;
    reset(): void;
    isSeekPreroll(operation: PlaybackOperation | null | undefined): boolean;
    queueAudio(segment: any, operation: PlaybackOperation): boolean;
    shouldPublishSubtitle(operation: PlaybackOperation | null | undefined): boolean;
    acceptVideoLanding(operation: PlaybackOperation): MMTSPlaybackOutputRelease | null;
}

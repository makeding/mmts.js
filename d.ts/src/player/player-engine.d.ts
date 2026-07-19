import type MediaInfo from "../core/media-info";
import type { PlaybackOperationResult } from "./playback-operation-result";
export default interface PlayerEngine {
    destroy(): void;
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    attachMediaElement(mediaElement: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    play(): Promise<void>;
    pause(): void;
    seek(seconds: number): Promise<PlaybackOperationResult>;
    switchPrimaryAudio(): Promise<PlaybackOperationResult>;
    switchSecondaryAudio(): Promise<PlaybackOperationResult>;
    selectAudioTrack(packetId: number): Promise<PlaybackOperationResult>;
    selectVideoTrack(packetId: number): Promise<PlaybackOperationResult>;
    readonly mediaInfo: MediaInfo | undefined;
    readonly statisticsInfo: any | undefined;
}

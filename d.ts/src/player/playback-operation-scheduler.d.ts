import { type PlaybackOperation } from '../core/playback-operation';
export type InteractivePlaybackOperationKind = 'seek' | 'audio-switch' | 'video-switch';
export type ScheduledPlaybackIntent<T = any> = {
    operation: PlaybackOperation;
    payload: T;
};
export type PlaybackIntentScheduleResult<T = any> = {
    type: 'activate';
    intent: ScheduledPlaybackIntent<T>;
    interrupted?: ScheduledPlaybackIntent<T>;
    superseded: ScheduledPlaybackIntent<T>[];
} | {
    type: 'queued';
    intent: ScheduledPlaybackIntent<T>;
    superseded: ScheduledPlaybackIntent<T>[];
} | {
    type: 'duplicate';
    intent: ScheduledPlaybackIntent<T>;
    superseded: ScheduledPlaybackIntent<T>[];
};
export type PlaybackIntentCompletion<T = any> = {
    completed: ScheduledPlaybackIntent<T> | null;
    next: ScheduledPlaybackIntent<T> | null;
};
/**
 * One owner for user-visible timeline mutations.
 *
 * - seek is preemptive and latest-wins;
 * - audio/video each retain at most one pending intent;
 * - track intents never silently disappear when another track kind is active.
 */
export default class PlaybackOperationScheduler<T = any> {
    private _active;
    private _queued;
    private _sequence;
    get active(): ScheduledPlaybackIntent<T> | null;
    get queued(): ScheduledPlaybackIntent<T>[];
    request(intent: ScheduledPlaybackIntent<T>): PlaybackIntentScheduleResult<T>;
    replaceActiveReservation(operation: PlaybackOperation): boolean;
    canAdoptAttempt(operation: PlaybackOperation): boolean;
    adoptAttempt(operation: PlaybackOperation): boolean;
    complete(operation: PlaybackOperation): PlaybackIntentCompletion<T>;
    cancelActive(operation?: PlaybackOperation): PlaybackIntentCompletion<T>;
    removeQueued(operation: PlaybackOperation): ScheduledPlaybackIntent<T> | null;
    clear(): ScheduledPlaybackIntent<T>[];
    private _takeNext;
    private _validate;
    private _snapshot;
}

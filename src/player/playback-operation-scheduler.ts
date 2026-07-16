import {
    classifyPlaybackOperationAdvance,
    canReplacePlaybackOperationReservation,
    clonePlaybackOperation,
    isPlaybackOperation,
    isSamePlaybackTransaction,
    type PlaybackOperation,
} from '../core/playback-operation';

export type InteractivePlaybackOperationKind = 'seek' | 'audio-switch' | 'video-switch';

export type ScheduledPlaybackIntent<T = any> = {
    operation: PlaybackOperation,
    payload: T,
};

type InternalIntent<T> = ScheduledPlaybackIntent<T> & {sequence: number};

export type PlaybackIntentScheduleResult<T = any> =
    | {
          type: 'activate',
          intent: ScheduledPlaybackIntent<T>,
          interrupted?: ScheduledPlaybackIntent<T>,
          superseded: ScheduledPlaybackIntent<T>[],
      }
    | {
          type: 'queued',
          intent: ScheduledPlaybackIntent<T>,
          superseded: ScheduledPlaybackIntent<T>[],
      }
    | {
          type: 'duplicate',
          intent: ScheduledPlaybackIntent<T>,
          superseded: ScheduledPlaybackIntent<T>[],
      };

export type PlaybackIntentCompletion<T = any> = {
    completed: ScheduledPlaybackIntent<T> | null,
    next: ScheduledPlaybackIntent<T> | null,
};

/**
 * One owner for user-visible timeline mutations.
 *
 * - seek is preemptive and latest-wins;
 * - audio/video each retain at most one pending intent;
 * - track intents never silently disappear when another track kind is active.
 */
export default class PlaybackOperationScheduler<T = any> {
    private _active: InternalIntent<T> | null = null;
    private _queued: Map<InteractivePlaybackOperationKind, InternalIntent<T>> = new Map();
    private _sequence: number = 0;

    public get active(): ScheduledPlaybackIntent<T> | null {
        return this._active ? this._snapshot(this._active) : null;
    }

    public get queued(): ScheduledPlaybackIntent<T>[] {
        return Array.from(this._queued.values())
            .sort((left, right) => left.sequence - right.sequence)
            .map((intent) => this._snapshot(intent));
    }

    public request(intent: ScheduledPlaybackIntent<T>): PlaybackIntentScheduleResult<T> {
        this._validate(intent);
        const scheduled: InternalIntent<T> = {
            operation: clonePlaybackOperation(intent.operation),
            payload: intent.payload,
            sequence: ++this._sequence,
        };
        const superseded: ScheduledPlaybackIntent<T>[] = [];

        if (this._active && isSamePlaybackTransaction(this._active.operation, scheduled.operation)) {
            return {type: 'duplicate', intent: this._snapshot(this._active), superseded};
        }
        const kind = scheduled.operation.kind as InteractivePlaybackOperationKind;
        const existing = this._queued.get(kind);
        if (existing && isSamePlaybackTransaction(existing.operation, scheduled.operation)) {
            return {type: 'duplicate', intent: this._snapshot(existing), superseded};
        }

        if (kind === 'seek') {
            // A new seek invalidates every not-yet-started operation on the old timeline.
            this._queued.forEach((queued) => superseded.push(this._snapshot(queued)));
            this._queued.clear();
            if (!this._active) {
                this._active = scheduled;
                return {type: 'activate', intent: this._snapshot(scheduled), superseded};
            }
            const interrupted = this._snapshot(this._active);
            this._active = scheduled;
            return {
                type: 'activate',
                intent: this._snapshot(scheduled),
                interrupted,
                superseded,
            };
        }

        if (!this._active) {
            this._active = scheduled;
            return {type: 'activate', intent: this._snapshot(scheduled), superseded};
        }

        if (existing) {
            superseded.push(this._snapshot(existing));
        }
        this._queued.set(kind, scheduled);
        return {type: 'queued', intent: this._snapshot(scheduled), superseded};
    }

    public replaceActiveReservation(operation: PlaybackOperation): boolean {
        if (!this._active ||
            !canReplacePlaybackOperationReservation(this._active.operation, operation)) {
            return false;
        }
        this._active.operation = clonePlaybackOperation(operation);
        return true;
    }

    public canAdoptAttempt(operation: PlaybackOperation): boolean {
        if (!this._active || !isPlaybackOperation(operation) ||
            !isSamePlaybackTransaction(this._active.operation, operation)) {
            return false;
        }
        const advance = classifyPlaybackOperationAdvance(this._active.operation, operation);
        return advance.accepted &&
            (advance.kind === 'same-attempt' || advance.kind === 'next-attempt');
    }

    public adoptAttempt(operation: PlaybackOperation): boolean {
        if (!this.canAdoptAttempt(operation) || !this._active) {
            return false;
        }
        this._active.operation = clonePlaybackOperation(operation);
        return true;
    }

    public complete(operation: PlaybackOperation): PlaybackIntentCompletion<T> {
        if (!this._active || !isPlaybackOperation(operation) ||
            !isSamePlaybackTransaction(this._active.operation, operation)) {
            return {completed: null, next: null};
        }
        const completed = this._snapshot(this._active);
        this._active = this._takeNext();
        return {
            completed,
            next: this._active ? this._snapshot(this._active) : null,
        };
    }

    public cancelActive(operation?: PlaybackOperation): PlaybackIntentCompletion<T> {
        if (!this._active || (operation &&
            !isSamePlaybackTransaction(this._active.operation, operation))) {
            return {completed: null, next: null};
        }
        const completed = this._snapshot(this._active);
        this._active = this._takeNext();
        return {
            completed,
            next: this._active ? this._snapshot(this._active) : null,
        };
    }

    public removeQueued(operation: PlaybackOperation): ScheduledPlaybackIntent<T> | null {
        if (!isPlaybackOperation(operation)) return null;
        const kinds: InteractivePlaybackOperationKind[] = ['seek', 'audio-switch', 'video-switch'];
        for (let i = 0; i < kinds.length; i++) {
            const queued = this._queued.get(kinds[i]);
            if (queued && isSamePlaybackTransaction(queued.operation, operation)) {
                this._queued.delete(kinds[i]);
                return this._snapshot(queued);
            }
        }
        return null;
    }

    public clear(): ScheduledPlaybackIntent<T>[] {
        const removed: ScheduledPlaybackIntent<T>[] = [];
        if (this._active) removed.push(this._snapshot(this._active));
        this._queued.forEach((intent) => removed.push(this._snapshot(intent)));
        this._active = null;
        this._queued.clear();
        return removed;
    }

    private _takeNext(): InternalIntent<T> | null {
        let selectedKind: InteractivePlaybackOperationKind | null = null;
        let selected: InternalIntent<T> | null = null;
        this._queued.forEach((intent, kind) => {
            if (!selected || intent.sequence < selected.sequence) {
                selected = intent;
                selectedKind = kind;
            }
        });
        if (selectedKind) this._queued.delete(selectedKind);
        return selected;
    }

    private _validate(intent: ScheduledPlaybackIntent<T>): void {
        if (!intent || !isPlaybackOperation(intent.operation) ||
            !['seek', 'audio-switch', 'video-switch'].includes(intent.operation.kind)) {
            throw new TypeError('Invalid interactive playback intent');
        }
    }

    private _snapshot(intent: InternalIntent<T>): ScheduledPlaybackIntent<T> {
        return {operation: clonePlaybackOperation(intent.operation), payload: intent.payload};
    }
}

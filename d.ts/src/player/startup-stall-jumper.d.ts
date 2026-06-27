declare class StartupStallJumper {
    private readonly TAG;
    private _media_element;
    private _on_direct_seek;
    private _canplay_received;
    private _last_jump_target;
    private _last_jump_clock;
    private _stall_check_timer;
    private _stall_check_time;
    private e;
    constructor(media_element: HTMLMediaElement, on_direct_seek: (target: number) => void);
    destroy(): void;
    private _onMediaCanPlay;
    private _onMediaStalled;
    private _onMediaWaiting;
    private _onMediaProgress;
    private _detectAndFixStuckPlayback;
    private _findBufferedJumpTarget;
    private _scheduleStallCheck;
    private _clearStallCheckTimer;
    private _onStallCheckTimer;
    private _findSmallForwardJumpTarget;
    private _shouldJumpTo;
    private static _getClockTime;
}
export default StartupStallJumper;

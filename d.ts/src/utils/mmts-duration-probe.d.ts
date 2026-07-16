export interface MMTSDurationProbeOptions {
    filesize?: number;
    withCredentials?: boolean;
    timeout?: number;
    videoPacketId?: number;
    initialStartProbeBytes?: number;
    initialTailProbeBytes?: number;
    maxStartProbeBytes?: number;
    maxTailProbeBytes?: number;
}
export interface MMTSDurationProbeResult {
    duration: number;
    filesize: number;
    startTime: number;
    endTime: number;
    startOffset: number;
    endOffset: number;
    startPacketId: number;
    endPacketId: number;
}
export default function probeMMTSDuration(url: string, options?: MMTSDurationProbeOptions): Promise<MMTSDurationProbeResult>;

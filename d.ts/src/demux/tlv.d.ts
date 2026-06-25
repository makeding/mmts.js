export interface TLVPacket {
    packetType: number;
    payload: Uint8Array;
    startOffset: number;
    packetLength: number;
}
export interface TLVParseResult {
    packets: TLVPacket[];
    consumed: number;
    syncOffset: number;
    needMoreData: boolean;
}
export interface TLVProbeResult {
    match: boolean;
    needMoreData?: boolean;
    syncOffset?: number;
    packetCount?: number;
}
export default class TLV {
    static probe(buffer: ArrayBuffer): TLVProbeResult;
    static parse(buffer: ArrayBuffer | Uint8Array, initialOffset?: number, maxPackets?: number): TLVParseResult;
    static isKnownPacketType(packetType: number): boolean;
}

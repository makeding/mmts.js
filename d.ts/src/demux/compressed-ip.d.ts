export declare const enum ContextHeaderType {
    ContextIdPartialIpv4AndPartialUdp = 32,
    ContextIdIpv4Identifier = 33,
    ContextIdPartialIpv6AndPartialUdp = 96,
    ContextIdNoCompressedHeader = 97
}
export interface CompressedIPPacket {
    contextId: number;
    sequenceNumber: number;
    headerType: ContextHeaderType;
    payloadOffset: number;
}
export default class CompressedIP {
    static parse(data: Uint8Array): CompressedIPPacket | null;
}

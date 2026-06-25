export const enum ContextHeaderType {
    ContextIdPartialIpv4AndPartialUdp = 0x20,
    ContextIdIpv4Identifier = 0x21,
    ContextIdPartialIpv6AndPartialUdp = 0x60,
    ContextIdNoCompressedHeader = 0x61
}

export interface CompressedIPPacket {
    contextId: number;
    sequenceNumber: number;
    headerType: ContextHeaderType;
    payloadOffset: number;
}

export default class CompressedIP {

    public static parse(data: Uint8Array): CompressedIPPacket | null {
        if (data.byteLength < 3) {
            return null;
        }

        const contextAndSequence = (data[0] << 8) | data[1];
        const headerType = data[2] as ContextHeaderType;
        let payloadOffset = 3;

        switch (headerType) {
            case ContextHeaderType.ContextIdPartialIpv4AndPartialUdp:
            case ContextHeaderType.ContextIdIpv4Identifier:
            case ContextHeaderType.ContextIdNoCompressedHeader:
                break;
            case ContextHeaderType.ContextIdPartialIpv6AndPartialUdp:
                payloadOffset += 38 + 4;
                break;
            default:
                return null;
        }

        if (payloadOffset > data.byteLength) {
            return null;
        }

        return {
            contextId: (contextAndSequence & 0xfff0) >> 4,
            sequenceNumber: contextAndSequence & 0x000f,
            headerType,
            payloadOffset
        };
    }

}

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
                // ARIB STD-B32 Part 3, 3.7.2.1 / 3.7.2.3:
                // partial IPv4 is 16 bytes and partial UDP is 4 bytes.
                payloadOffset += 16 + 4;
                break;
            case ContextHeaderType.ContextIdIpv4Identifier:
                // ARIB STD-B32 Part 3, 3.7.2.2: IPv4 identifier is 2 bytes.
                payloadOffset += 2;
                break;
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

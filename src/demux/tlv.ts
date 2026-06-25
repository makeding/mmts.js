const TLV_SYNC_BYTE = 0x7f;
const TLV_HEADER_SIZE = 4;
const TLV_MAX_PACKET_LENGTH = 65535;

const TLV_KNOWN_PACKET_TYPES = {
    0x01: true,
    0x02: true,
    0x03: true,
    0xfe: true,
    0xff: true
};

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

    public static probe(buffer: ArrayBuffer): TLVProbeResult {
        const result = TLV.parse(buffer, 0, 4);

        if (result.packets.length > 0) {
            return {
                match: true,
                syncOffset: result.syncOffset,
                packetCount: result.packets.length
            };
        }

        if (result.needMoreData) {
            return {match: false, needMoreData: true};
        }

        return {match: false};
    }

    public static parse(buffer: ArrayBuffer | Uint8Array,
                        initialOffset: number = 0,
                        maxPackets: number = Number.MAX_SAFE_INTEGER): TLVParseResult {
        const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const packets: TLVPacket[] = [];
        let offset = Math.max(0, initialOffset);
        let syncOffset = -1;
        let needMoreData = false;

        while (offset + TLV_HEADER_SIZE <= data.byteLength && packets.length < maxPackets) {
            if (data[offset] !== TLV_SYNC_BYTE) {
                offset++;
                continue;
            }

            const packetType = data[offset + 1];
            const packetLength = (data[offset + 2] << 8) | data[offset + 3];

            if (!TLV.isKnownPacketType(packetType) || packetLength <= 0 || packetLength > TLV_MAX_PACKET_LENGTH) {
                offset++;
                continue;
            }

            const packetEnd = offset + TLV_HEADER_SIZE + packetLength;
            if (packetEnd > data.byteLength) {
                needMoreData = true;
                break;
            }

            if (syncOffset === -1) {
                syncOffset = offset;
            }

            packets.push({
                packetType,
                payload: data.subarray(offset + TLV_HEADER_SIZE, packetEnd),
                startOffset: offset,
                packetLength
            });
            offset = packetEnd;
        }

        if (packets.length === 0 && data.byteLength < TLV_HEADER_SIZE) {
            needMoreData = true;
        }

        return {
            packets,
            consumed: offset,
            syncOffset,
            needMoreData
        };
    }

    public static isKnownPacketType(packetType: number): boolean {
        return TLV_KNOWN_PACKET_TYPES[packetType] === true;
    }

}

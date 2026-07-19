export interface IPUdpPayload {
    payloadOffset: number;
    payloadLength: number;
}

export default class IP {

    public static parseUdpPayload(data: Uint8Array, version: 4 | 6): IPUdpPayload | null {
        return version === 4 ? IP.parseIpv4UdpPayload(data) : IP.parseIpv6UdpPayload(data);
    }

    private static parseIpv4UdpPayload(data: Uint8Array): IPUdpPayload | null {
        if (data.byteLength < 28 || (data[0] >> 4) !== 4) {
            return null;
        }
        const headerLength = (data[0] & 0x0f) * 4;
        const totalLength = IP.readU16(data, 2);
        if (headerLength < 20 || totalLength < headerLength + 8 || totalLength > data.byteLength) {
            return null;
        }
        // ARIB STD-B32 Part 3, 3.4 carries UDP immediately after the IP
        // header.  Reject fragmented datagrams because they cannot contain a
        // complete MMTP packet as required by ARIB STD-B60 6.4.1.
        const fragment = IP.readU16(data, 6);
        if ((fragment & 0x3fff) !== 0 || data[9] !== 17) {
            return null;
        }
        return IP.parseUdpHeader(data, headerLength, totalLength);
    }

    private static parseIpv6UdpPayload(data: Uint8Array): IPUdpPayload | null {
        if (data.byteLength < 48 || (data[0] >> 4) !== 6) {
            return null;
        }
        const ipv6PayloadLength = IP.readU16(data, 4);
        const packetEnd = 40 + ipv6PayloadLength;
        if (ipv6PayloadLength < 8 || packetEnd > data.byteLength) {
            return null;
        }

        let nextHeader = data[6];
        let offset = 40;
        // RFC 8200 extension headers that can precede UDP.  Bounded iteration
        // prevents malformed chains from turning into an unbounded scan.
        for (let i = 0; i < 16 && nextHeader !== 17; i++) {
            if (nextHeader === 0 || nextHeader === 43 || nextHeader === 60) {
                if (offset + 2 > packetEnd) {
                    return null;
                }
                const extensionLength = (data[offset + 1] + 1) * 8;
                nextHeader = data[offset];
                offset += extensionLength;
            } else if (nextHeader === 44) {
                if (offset + 8 > packetEnd) {
                    return null;
                }
                const fragment = IP.readU16(data, offset + 2);
                if ((fragment & 0xfff9) !== 0) {
                    return null;
                }
                nextHeader = data[offset];
                offset += 8;
            } else if (nextHeader === 51) {
                if (offset + 2 > packetEnd) {
                    return null;
                }
                const extensionLength = (data[offset + 1] + 2) * 4;
                nextHeader = data[offset];
                offset += extensionLength;
            } else {
                return null;
            }
            if (offset > packetEnd) {
                return null;
            }
        }
        if (nextHeader !== 17) {
            return null;
        }
        return IP.parseUdpHeader(data, offset, packetEnd);
    }

    private static parseUdpHeader(data: Uint8Array, offset: number, packetEnd: number): IPUdpPayload | null {
        if (offset + 8 > packetEnd) {
            return null;
        }
        const udpLength = IP.readU16(data, offset + 4);
        if (udpLength < 8 || offset + udpLength > packetEnd) {
            return null;
        }
        return {
            payloadOffset: offset + 8,
            payloadLength: udpLength - 8
        };
    }

    private static readU16(data: Uint8Array, offset: number): number {
        return (data[offset] << 8) | data[offset + 1];
    }
}

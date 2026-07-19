export interface IPUdpPayload {
    payloadOffset: number;
    payloadLength: number;
}
export default class IP {
    static parseUdpPayload(data: Uint8Array, version: 4 | 6): IPUdpPayload | null;
    private static parseIpv4UdpPayload;
    private static parseIpv6UdpPayload;
    private static parseUdpHeader;
    private static readU16;
}

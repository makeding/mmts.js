export const enum MMTPPayloadType {
    Mpu = 0x00,
    Undefined = 0x01,
    ControlMessage = 0x02
}

export const enum MMTPEncryptionFlag {
    Unscrambled = 0x00,
    Reserved = 0x01,
    Even = 0x02,
    Odd = 0x03
}

export interface MMTPScramblingInfo {
    encryptionFlag: MMTPEncryptionFlag;
    scrambleSystemControl: number;
    scramblingSubsystem: number;
    scrambleSystemId?: number;
    messageAuthenticationControl: number;
    authenticatedPayloadLength?: number;
    scramblingInitialCounterValue: number;
}

export interface MMTPPacket {
    version: number;
    packetCounterFlag: boolean;
    fecType: number;
    extensionHeaderFlag: boolean;
    rapFlag: boolean;
    payloadType: MMTPPayloadType;
    packetId: number;
    deliveryTimestamp: number;
    packetSequenceNumber: number;
    packetCounter?: number;
    extensionHeaderType?: number;
    extensionHeaderLength?: number;
    extensionHeaderField?: Uint8Array;
    extensionHeaderScrambling?: MMTPScramblingInfo;
    messageAuthenticationCode?: Uint8Array;
    payload: Uint8Array;
}

export default class MMTP {

    public static parse(data: Uint8Array): MMTPPacket | null {
        if (data.byteLength < 12) {
            return null;
        }

        let offset = 0;
        let byte = data[offset++];

        const version = (byte & 0xc0) >> 6;
        const packetCounterFlag = ((byte & 0x20) >> 5) !== 0;
        const fecType = (byte & 0x18) >> 3;
        const extensionHeaderFlag = ((byte & 0x02) >> 1) !== 0;
        const rapFlag = (byte & 0x01) !== 0;

        byte = data[offset++];
        const payloadType = byte & 0x3f;
        const packetId = MMTP.readBe16(data, offset);
        offset += 2;
        const deliveryTimestamp = MMTP.readBe32(data, offset);
        offset += 4;
        const packetSequenceNumber = MMTP.readBe32(data, offset);
        offset += 4;

        const packet: MMTPPacket = {
            version,
            packetCounterFlag,
            fecType,
            extensionHeaderFlag,
            rapFlag,
            payloadType,
            packetId,
            deliveryTimestamp,
            packetSequenceNumber,
            payload: null
        };

        if (packetCounterFlag) {
            if (offset + 4 > data.byteLength) {
                return null;
            }
            packet.packetCounter = MMTP.readBe32(data, offset);
            offset += 4;
        }

        if (extensionHeaderFlag) {
            if (offset + 4 > data.byteLength) {
                return null;
            }

            packet.extensionHeaderType = MMTP.readBe16(data, offset);
            offset += 2;
            packet.extensionHeaderLength = MMTP.readBe16(data, offset);
            offset += 2;

            if (offset + packet.extensionHeaderLength > data.byteLength) {
                return null;
            }

            packet.extensionHeaderField = data.subarray(offset, offset + packet.extensionHeaderLength);
            packet.extensionHeaderScrambling = MMTP.parseScramblingExtension(
                packet.extensionHeaderField,
                packet.extensionHeaderType,
                packet.extensionHeaderLength
            );
            offset += packet.extensionHeaderLength;
        }

        let payloadEnd = data.byteLength;
        const authenticatedPayloadLength = packet.extensionHeaderScrambling &&
            packet.extensionHeaderScrambling.authenticatedPayloadLength;
        if (authenticatedPayloadLength !== undefined && offset + authenticatedPayloadLength <= data.byteLength) {
            payloadEnd = offset + authenticatedPayloadLength;
            packet.messageAuthenticationCode = data.subarray(payloadEnd);
        }

        packet.payload = data.subarray(offset, payloadEnd);
        return packet;
    }

    private static parseScramblingExtension(field: Uint8Array,
                                            extensionHeaderType: number,
                                            extensionHeaderLength: number): MMTPScramblingInfo | undefined {
        if (extensionHeaderType !== 0x0000 || field.byteLength < 5 || extensionHeaderLength !== field.byteLength) {
            return undefined;
        }

        let offset = 0;
        while (offset + 4 <= field.byteLength) {
            const header = MMTP.readBe16(field, offset);
            const extensionType = header & 0x7fff;
            const extensionEnd = (header & 0x8000) !== 0;
            const extensionLength = MMTP.readBe16(field, offset + 2);
            offset += 4;

            if (offset + extensionLength > field.byteLength) {
                return undefined;
            }

            if (extensionType === 0x0001) {
                return MMTP.parseB61ScramblingExtension(field.subarray(offset, offset + extensionLength));
            }

            offset += extensionLength;
            if (extensionEnd) {
                break;
            }
        }

        return undefined;
    }

    private static parseB61ScramblingExtension(field: Uint8Array): MMTPScramblingInfo | undefined {
        if (field.byteLength < 1) {
            return undefined;
        }

        let offset = 0;
        const byte = field[offset++];
        const scrambleSystemControl = (byte & 0x04) >> 2;
        const messageAuthenticationControl = (byte & 0x02) >> 1;
        const info: MMTPScramblingInfo = {
            encryptionFlag: (byte & 0x18) >> 3,
            scrambleSystemControl,
            scramblingSubsystem: scrambleSystemControl,
            messageAuthenticationControl,
            scramblingInitialCounterValue: byte & 0x01
        };

        if (scrambleSystemControl !== 0 && offset < field.byteLength) {
            info.scrambleSystemId = field[offset++];
        }

        if (messageAuthenticationControl !== 0 && offset + 2 <= field.byteLength) {
            info.authenticatedPayloadLength = MMTP.readBe16(field, offset);
        }

        return info;
    }

    private static readBe16(data: Uint8Array, offset: number): number {
        return (data[offset] << 8) | data[offset + 1];
    }

    private static readBe32(data: Uint8Array, offset: number): number {
        return ((data[offset] << 24) >>> 0) +
            (data[offset + 1] << 16) +
            (data[offset + 2] << 8) +
            data[offset + 3];
    }

}

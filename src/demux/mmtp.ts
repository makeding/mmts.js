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
    scramblingSubsystem: number;
    messageAuthenticationControl: number;
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

        packet.payload = data.subarray(offset);
        return packet;
    }

    private static parseScramblingExtension(field: Uint8Array,
                                            extensionHeaderType: number,
                                            extensionHeaderLength: number): MMTPScramblingInfo | undefined {
        if (field.byteLength < 5) {
            return undefined;
        }

        const extensionId = MMTP.readBe16(field, 0);
        if ((extensionId & 0x7fff) !== 0x0001) {
            return undefined;
        }

        const byte = field[4];
        return {
            encryptionFlag: (byte & 0x18) >> 3,
            scramblingSubsystem: (byte & 0x04) >> 2,
            messageAuthenticationControl: (byte & 0x02) >> 1,
            scramblingInitialCounterValue: byte & 0x01
        };
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

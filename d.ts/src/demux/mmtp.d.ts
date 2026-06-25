export declare const enum MMTPPayloadType {
    Mpu = 0,
    Undefined = 1,
    ControlMessage = 2
}
export declare const enum MMTPEncryptionFlag {
    Unscrambled = 0,
    Reserved = 1,
    Even = 2,
    Odd = 3
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
    static parse(data: Uint8Array): MMTPPacket | null;
    private static parseScramblingExtension;
    private static readBe16;
    private static readBe32;
}

export const enum MPUFragmentType {
    MpuMetadata = 0x00,
    MovieFragmentMetadata = 0x01,
    Mfu = 0x02
}

export const enum FragmentationIndicator {
    NotFragmented = 0x00,
    FirstFragment = 0x01,
    MiddleFragment = 0x02,
    LastFragment = 0x03
}

export interface MFUInfo {
    timed: boolean;
    payloadOffset: number;
    payloadLength: number;
    movieFragmentSequenceNumber?: number;
    sampleNumber?: number;
    offset?: number;
    priority?: number;
    dependencyCounter?: number;
    nalUnitLength?: number;
}

export interface MFUFragment {
    timed: boolean;
    fragmentationIndicator: FragmentationIndicator;
    payload: Uint8Array;
    sampleNumber?: number;
    offset?: number;
    nalUnitLength?: number;
}

export interface MPUInfo {
    fragmentType: MPUFragmentType;
    timed: boolean;
    fragmentationIndicator: FragmentationIndicator;
    aggregationFlag: boolean;
    fragmentCounter: number;
    mpuSequenceNumber: number;
    payloadOffset: number;
    payloadLength: number;
    mfu?: MFUInfo;
    mfuFragments: MFUFragment[];
}

export default class MPU {

    public static parse(payload: Uint8Array): MPUInfo | null {
        if (payload.byteLength < 8) {
            return null;
        }

        const payloadLength = MPU.readU16(payload, 0);
        if (payloadLength !== payload.byteLength - 2) {
            return null;
        }

        const flags = payload[2];
        const fragmentType = (flags >> 4) as MPUFragmentType;
        const timed = ((flags >> 3) & 0x01) !== 0;
        const fragmentationIndicator = ((flags >> 1) & 0x03) as FragmentationIndicator;
        const aggregationFlag = (flags & 0x01) !== 0;
        const fragmentCounter = payload[3];
        const mpuSequenceNumber = MPU.readU32(payload, 4);
        const dataOffset = 8;

        const info: MPUInfo = {
            fragmentType,
            timed,
            fragmentationIndicator,
            aggregationFlag,
            fragmentCounter,
            mpuSequenceNumber,
            payloadOffset: dataOffset,
            payloadLength: payload.byteLength - dataOffset,
            mfuFragments: []
        };

        if (fragmentType === MPUFragmentType.Mfu) {
            info.mfuFragments = MPU.parseMfuFragments(payload, dataOffset, timed, fragmentationIndicator, aggregationFlag);
            if (!aggregationFlag) {
                info.mfu = MPU.parseMfu(payload, dataOffset, timed);
            }
        }

        return info;
    }

    public static readLengthPrefixedUnitLength(data: Uint8Array): number | undefined {
        if (data.byteLength < 4) {
            return undefined;
        }
        return MPU.readU32(data, 0);
    }

    private static parseMfuFragments(payload: Uint8Array,
                                     offset: number,
                                     timed: boolean,
                                     fragmentationIndicator: FragmentationIndicator,
                                     aggregationFlag: boolean): MFUFragment[] {
        if (!aggregationFlag) {
            const mfu = MPU.parseMfu(payload, offset, timed);
            if (mfu === undefined) {
                return [];
            }
            return [{
                timed,
                fragmentationIndicator,
                payload: payload.subarray(mfu.payloadOffset, mfu.payloadOffset + mfu.payloadLength),
                sampleNumber: mfu.sampleNumber,
                offset: mfu.offset,
                nalUnitLength: mfu.nalUnitLength
            }];
        }

        const fragments: MFUFragment[] = [];
        let cursor = offset;

        while (cursor + 2 <= payload.byteLength) {
            const unitLength = MPU.readU16(payload, cursor);
            cursor += 2;
            if (cursor + unitLength > payload.byteLength) {
                break;
            }

            const unit = payload.subarray(cursor, cursor + unitLength);
            const mfu = MPU.parseMfu(unit, 0, timed);
            if (mfu !== undefined) {
                fragments.push({
                    timed,
                    fragmentationIndicator: FragmentationIndicator.NotFragmented,
                    payload: unit.subarray(mfu.payloadOffset, mfu.payloadOffset + mfu.payloadLength),
                    sampleNumber: mfu.sampleNumber,
                    offset: mfu.offset,
                    nalUnitLength: mfu.nalUnitLength
                });
            }

            cursor += unitLength;
        }

        return fragments;
    }

    private static parseMfu(payload: Uint8Array, offset: number, timed: boolean): MFUInfo | undefined {
        const headerLength = timed ? 14 : 4;
        if (offset + headerLength > payload.byteLength) {
            return undefined;
        }

        const mfuPayloadOffset = offset + headerLength;
        const mfuPayloadLength = payload.byteLength - mfuPayloadOffset;
        const info: MFUInfo = {
            timed,
            payloadOffset: mfuPayloadOffset,
            payloadLength: mfuPayloadLength
        };

        if (timed) {
            info.movieFragmentSequenceNumber = MPU.readU32(payload, offset);
            info.sampleNumber = MPU.readU32(payload, offset + 4);
            info.offset = MPU.readU32(payload, offset + 8);
            info.priority = payload[offset + 12];
            info.dependencyCounter = payload[offset + 13];
        }

        if (mfuPayloadLength >= 4) {
            info.nalUnitLength = MPU.readU32(payload, mfuPayloadOffset);
        }

        return info;
    }

    private static readU16(data: Uint8Array, offset: number): number {
        return (data[offset] << 8) | data[offset + 1];
    }

    private static readU32(data: Uint8Array, offset: number): number {
        return ((data[offset] << 24) >>> 0) +
            (data[offset + 1] << 16) +
            (data[offset + 2] << 8) +
            data[offset + 3];
    }

}

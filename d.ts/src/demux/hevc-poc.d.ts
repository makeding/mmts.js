export interface HEVCPictureOrderInput {
    auIndex: number;
    nalUnitType: number;
    temporalId: number;
    pocLsb: number;
    log2MaxPicOrderCntLsb: number;
    parameterSetSignature: string;
}
export interface HEVCRecoveredPicture extends HEVCPictureOrderInput {
    poc: number;
    noRaslOutput: boolean;
    outputAllowed: boolean;
}
export interface HEVCPreparedMpu {
    pictures: HEVCRecoveredPicture[];
    presentationIndexes: number[];
    endOfSequenceAfterMpu: boolean;
}
/**
 * Transactional HEVC picture-order recovery.
 *
 * prepareMpu() never mutates the committed state.  The caller must commit only
 * after the corresponding ARIB B60 timestamp descriptor has also passed its
 * whole-MPU validation.  A rejected MPU moves the recovery state back to a
 * random-access boundary so a guessed POC cannot leak into later MPUs.
 */
export default class HEVCPocRecovery {
    private state_;
    private preparedState_;
    reset(requireRandomAccess?: boolean): void;
    rejectMpu(): void;
    get waitingForRandomAccess(): boolean;
    prepareMpu(pictures: HEVCPictureOrderInput[], endOfSequenceAfterMpu?: boolean): HEVCPreparedMpu | null;
    commit(prepared: HEVCPreparedMpu): boolean;
    private isValidPictureInput;
}

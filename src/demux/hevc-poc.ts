/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import {H265NaluType} from './h265';

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

interface HEVCInternalState {
    initialized: boolean;
    waitingForRandomAccess: boolean;
    prevTid0Poc?: number;
    activeParameterSetSignature?: string;
    associatedIrap?: {
        poc: number;
        nalUnitType: number;
        noRaslOutput: boolean;
    };
}

function cloneState(state: HEVCInternalState): HEVCInternalState {
    return {
        initialized: state.initialized,
        waitingForRandomAccess: state.waitingForRandomAccess,
        prevTid0Poc: state.prevTid0Poc,
        activeParameterSetSignature: state.activeParameterSetSignature,
        associatedIrap: state.associatedIrap === undefined ? undefined : {...state.associatedIrap}
    };
}

function isIrap(nalUnitType: number): boolean {
    return nalUnitType >= H265NaluType.kSliceBLA_W_LP &&
        nalUnitType <= H265NaluType.kSliceRSV_IRAP_VCL23;
}

function isIdr(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceIDR_W_RADL ||
        nalUnitType === H265NaluType.kSliceIDR_N_LP;
}

function isBla(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceBLA_W_LP ||
        nalUnitType === H265NaluType.kSliceBLA_W_RADL ||
        nalUnitType === H265NaluType.kSliceBLA_N_LP;
}

function isCra(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceCRA_NUT;
}

function isRasl(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceRASL_N ||
        nalUnitType === H265NaluType.kSliceRASL_R;
}

function isRadl(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceRADL_N ||
        nalUnitType === H265NaluType.kSliceRADL_R;
}

function isSubLayerNonReference(nalUnitType: number): boolean {
    return nalUnitType === H265NaluType.kSliceTRAIL_N ||
        nalUnitType === H265NaluType.kSliceTSA_N ||
        nalUnitType === H265NaluType.kSliceSTSA_N ||
        nalUnitType === H265NaluType.kSliceRADL_N ||
        nalUnitType === H265NaluType.kSliceRASL_N ||
        nalUnitType === H265NaluType.kSliceRSV_VCL_N10 ||
        nalUnitType === H265NaluType.kSliceRSV_VCL_N12 ||
        nalUnitType === H265NaluType.kSliceRSV_VCL_N14;
}

function updatesPrevTid0Pic(picture: HEVCPictureOrderInput): boolean {
    return picture.temporalId === 0 &&
        !isSubLayerNonReference(picture.nalUnitType) &&
        !isRasl(picture.nalUnitType) &&
        !isRadl(picture.nalUnitType);
}

function derivePocMsb(pocLsb: number, maxPocLsb: number, prevTid0Poc: number): number {
    const prevPocLsb = ((prevTid0Poc % maxPocLsb) + maxPocLsb) % maxPocLsb;
    const prevPocMsb = prevTid0Poc - prevPocLsb;
    if (pocLsb < prevPocLsb && prevPocLsb - pocLsb >= maxPocLsb / 2) {
        return prevPocMsb + maxPocLsb;
    }
    if (pocLsb > prevPocLsb && pocLsb - prevPocLsb > maxPocLsb / 2) {
        return prevPocMsb - maxPocLsb;
    }
    return prevPocMsb;
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

    private state_: HEVCInternalState = {
        initialized: false,
        waitingForRandomAccess: true
    };
    private preparedState_: HEVCInternalState | null = null;

    public reset(requireRandomAccess: boolean = true): void {
        this.state_ = {
            initialized: false,
            waitingForRandomAccess: requireRandomAccess
        };
        this.preparedState_ = null;
    }

    public rejectMpu(): void {
        this.state_ = {
            initialized: false,
            waitingForRandomAccess: true,
            activeParameterSetSignature: this.state_.activeParameterSetSignature
        };
        this.preparedState_ = null;
    }

    public get waitingForRandomAccess(): boolean {
        return this.state_.waitingForRandomAccess;
    }

    public prepareMpu(pictures: HEVCPictureOrderInput[],
                      endOfSequenceAfterMpu: boolean = false): HEVCPreparedMpu | null {
        this.preparedState_ = null;
        if (!Array.isArray(pictures) || pictures.length === 0) {
            return null;
        }

        const state = cloneState(this.state_);
        const recovered: HEVCRecoveredPicture[] = [];
        const seenPocs: {[poc: string]: boolean} = {};

        for (let decodingIndex = 0; decodingIndex < pictures.length; decodingIndex++) {
            const picture = pictures[decodingIndex];
            if (!this.isValidPictureInput(picture, decodingIndex)) {
                return null;
            }

            const irap = isIrap(picture.nalUnitType);
            if ((state.waitingForRandomAccess || !state.initialized) && decodingIndex === 0 && !irap) {
                return null;
            }
            if ((state.waitingForRandomAccess || !state.initialized) && decodingIndex > 0) {
                return null;
            }
            if (state.activeParameterSetSignature !== undefined &&
                state.activeParameterSetSignature !== picture.parameterSetSignature && !irap) {
                return null;
            }

            let noRaslOutput = false;
            if (irap) {
                noRaslOutput = isIdr(picture.nalUnitType) || isBla(picture.nalUnitType) ||
                    state.waitingForRandomAccess || !state.initialized;
            }

            const maxPocLsb = Math.pow(2, picture.log2MaxPicOrderCntLsb);
            let poc: number;
            if (isIdr(picture.nalUnitType)) {
                if (picture.pocLsb !== 0) {
                    return null;
                }
                poc = 0;
            } else if (isBla(picture.nalUnitType) || (isCra(picture.nalUnitType) && noRaslOutput)) {
                poc = picture.pocLsb;
            } else {
                if (state.prevTid0Poc === undefined) {
                    return null;
                }
                poc = derivePocMsb(picture.pocLsb, maxPocLsb, state.prevTid0Poc) + picture.pocLsb;
            }

            const pocKey = String(poc);
            if (seenPocs[pocKey]) {
                return null;
            }
            seenPocs[pocKey] = true;

            let outputAllowed = true;
            if (isRasl(picture.nalUnitType)) {
                if (state.associatedIrap === undefined) {
                    return null;
                }
                outputAllowed = !state.associatedIrap.noRaslOutput;
            }

            recovered.push({
                ...picture,
                poc,
                noRaslOutput,
                outputAllowed
            });

            if (irap) {
                state.associatedIrap = {
                    poc,
                    nalUnitType: picture.nalUnitType,
                    noRaslOutput
                };
                state.activeParameterSetSignature = picture.parameterSetSignature;
                state.initialized = true;
                state.waitingForRandomAccess = false;
            } else if (!state.initialized) {
                return null;
            }

            if (updatesPrevTid0Pic(picture)) {
                state.prevTid0Poc = poc;
            }
        }

        const presentationIndexes = new Array<number>(pictures.length);
        recovered.map((picture, decodingIndex) => ({picture, decodingIndex}))
            .sort((a, b) => a.picture.poc - b.picture.poc)
            .forEach((item, presentationIndex) => {
                presentationIndexes[item.decodingIndex] = presentationIndex;
            });

        if (endOfSequenceAfterMpu) {
            state.initialized = false;
            state.waitingForRandomAccess = true;
            state.prevTid0Poc = undefined;
            state.associatedIrap = undefined;
        }

        this.preparedState_ = state;
        return {
            pictures: recovered,
            presentationIndexes,
            endOfSequenceAfterMpu
        };
    }

    public commit(prepared: HEVCPreparedMpu): boolean {
        if (this.preparedState_ === null || prepared === null) {
            return false;
        }
        this.state_ = this.preparedState_;
        this.preparedState_ = null;
        return true;
    }

    private isValidPictureInput(picture: HEVCPictureOrderInput, decodingIndex: number): boolean {
        if (picture === null || picture === undefined || picture.auIndex !== decodingIndex ||
            !Number.isInteger(picture.nalUnitType) || picture.nalUnitType < 0 || picture.nalUnitType > 31 ||
            picture.nalUnitType === H265NaluType.kSliceRSV_IRAP_VCL22 ||
            picture.nalUnitType === H265NaluType.kSliceRSV_IRAP_VCL23 ||
            !Number.isInteger(picture.temporalId) || picture.temporalId < 0 || picture.temporalId > 6 ||
            !Number.isInteger(picture.log2MaxPicOrderCntLsb) ||
            picture.log2MaxPicOrderCntLsb < 4 || picture.log2MaxPicOrderCntLsb > 16 ||
            !Number.isInteger(picture.pocLsb) || picture.pocLsb < 0 ||
            picture.pocLsb >= Math.pow(2, picture.log2MaxPicOrderCntLsb) ||
            typeof picture.parameterSetSignature !== 'string' || picture.parameterSetSignature.length === 0) {
            return false;
        }
        return !isIrap(picture.nalUnitType) || picture.temporalId === 0;
    }
}

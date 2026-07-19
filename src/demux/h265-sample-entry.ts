/*
 * Copyright (C) 2026 SoraneOumi. All Rights Reserved.
 *
 * @author SoraneOumi <22672990+soraneoumi@users.noreply.github.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {H265NaluHVC1, H265NaluType} from './h265';

export type H265SampleEntryType = 'hvc1' | 'hev1';

export interface H265NormalizedAccessUnit {
    units: H265NaluHVC1[];
    length: number;
}

// hvc1 keeps parameter sets in hvcC; hev1 may also carry them in media samples.
function isH265ParameterSetNalu(type: H265NaluType): boolean {
    return type === H265NaluType.kSliceVPS ||
        type === H265NaluType.kSliceSPS ||
        type === H265NaluType.kSlicePPS;
}

export function normalizeH265AccessUnitForSampleEntry(sampleEntryType: H265SampleEntryType,
                                                       units: H265NaluHVC1[],
                                                       length: number): H265NormalizedAccessUnit {
    if (sampleEntryType === 'hev1') {
        return {units, length};
    }
    if (sampleEntryType !== 'hvc1') {
        throw new Error(`Unsupported HEVC sample entry type: ${sampleEntryType}`);
    }

    let normalizedUnits: H265NaluHVC1[] | null = null;
    let removedLength = 0;
    for (let index = 0; index < units.length; index++) {
        const unit = units[index];
        if (isH265ParameterSetNalu(unit.type)) {
            if (normalizedUnits === null) {
                normalizedUnits = units.slice(0, index);
            }
            removedLength += unit.byteLength || unit.data.byteLength;
        } else if (normalizedUnits !== null) {
            normalizedUnits.push(unit);
        }
    }

    if (normalizedUnits === null) {
        return {units, length};
    }
    return {
        units: normalizedUnits,
        length: length - removedLength
    };
}

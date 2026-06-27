/*
 * Copyright (C) 2022 magicxqq. All Rights Reserved.
 *
 * @author magicxqq <xqq@xqq.im>
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

interface MMTSAudioTimelineAlignment {
    rawPts: number;
    offset: number;
    mappedPts: number;
}

interface MMTSAudioTimelineMapping {
    pts: number;
    alignment?: MMTSAudioTimelineAlignment;
}

export default class MMTSAudioTimeline {

    private timestamp_offsets_by_packet_id_: {[packetId: number]: number} = {};
    private pending_seeds_by_packet_id_: {[packetId: number]: number} = {};

    public destroy(): void {
        this.timestamp_offsets_by_packet_id_ = null;
        this.pending_seeds_by_packet_id_ = null;
    }

    public clearPacket(packetId: number): void {
        delete this.timestamp_offsets_by_packet_id_[packetId];
        delete this.pending_seeds_by_packet_id_[packetId];
    }

    public clearPendingSeed(packetId: number): void {
        delete this.pending_seeds_by_packet_id_[packetId];
    }

    public seed(packetId: number, timelinePts: number): void {
        this.pending_seeds_by_packet_id_[packetId] = timelinePts;
    }

    public mapTimestamp(packetId: number, pts: number, refSampleDuration: number): MMTSAudioTimelineMapping {
        const pendingSeed = this.pending_seeds_by_packet_id_[packetId];
        if (pendingSeed !== undefined) {
            const offset = pendingSeed + refSampleDuration - pts;
            const mappedPts = pts + offset;
            this.timestamp_offsets_by_packet_id_[packetId] = offset;
            delete this.pending_seeds_by_packet_id_[packetId];
            return {
                pts: mappedPts,
                alignment: {
                    rawPts: pts,
                    offset,
                    mappedPts
                }
            };
        }

        const offset = this.timestamp_offsets_by_packet_id_[packetId];
        return {
            pts: offset !== undefined ? pts + offset : pts
        };
    }
}

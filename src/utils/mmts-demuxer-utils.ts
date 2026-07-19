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

import {MMTAsset} from '../demux/mmt-si';
import {MMTPEncryptionFlag, MMTPPayloadType, MMTPScramblingInfo} from '../demux/mmtp';
import MPU from '../demux/mpu';
import {H265NaluHVC1, H265NaluType} from '../demux/h265';
import {LOASAACFrame} from '../demux/aac';
import {MMTSAudioTrackInfo, MMTSSubtitleTrackInfo, MMTSVideoTrackInfo} from '../demux/mmts-track-data';

export function isH265VclNalu(naluType: number): boolean {
    return naluType >= 0 && naluType <= 31;
}

export function isH265IrapNalu(naluType: number): boolean {
    return naluType >= 16 && naluType <= 23;
}

export function hasH265CraNalu(units: H265NaluHVC1[]): boolean {
    return units.some((unit) => unit.type === H265NaluType.kSliceCRA_NUT);
}

export function hasH265IdrNalu(units: H265NaluHVC1[]): boolean {
    return units.some((unit) => {
        return unit.type === H265NaluType.kSliceIDR_W_RADL ||
            unit.type === H265NaluType.kSliceIDR_N_LP;
    });
}

export function hasH265RaslNalu(units: H265NaluHVC1[]): boolean {
    return units.some((unit) => {
        return unit.type === H265NaluType.kSliceRASL_N ||
            unit.type === H265NaluType.kSliceRASL_R;
    });
}

export function hasH265PostCraTrailingVclNalu(units: H265NaluHVC1[]): boolean {
    return units.some((unit) => {
        return isH265VclNalu(unit.type) &&
            unit.type !== H265NaluType.kSliceCRA_NUT &&
            unit.type !== H265NaluType.kSliceRASL_N &&
            unit.type !== H265NaluType.kSliceRASL_R;
    });
}

export function readH265NaluType(unit: Uint8Array): number {
    const unitLength = MPU.readLengthPrefixedUnitLength(unit);
    if (unitLength === undefined || unitLength !== unit.byteLength - 4 || unit.byteLength < 6) {
        return -1;
    }
    return (unit[4] >> 1) & 0x3f;
}

export function compareMMTSVideoTrackPriority(a: MMTSVideoTrackInfo, b: MMTSVideoTrackInfo): number {
    if (a.assetGroupId !== undefined &&
        b.assetGroupId !== undefined &&
        a.assetGroupId === b.assetGroupId &&
        a.assetSelectionLevel !== undefined &&
        b.assetSelectionLevel !== undefined &&
        a.assetSelectionLevel !== b.assetSelectionLevel) {
        return a.assetSelectionLevel - b.assetSelectionLevel;
    }

    const resolutionDiff = (b.resolution || 0) - (a.resolution || 0);
    if (resolutionDiff !== 0) {
        return resolutionDiff;
    }

    return a.packetId - b.packetId;
}

export function findMMTSPrimaryVideoTrack(tracks: MMTSVideoTrackInfo[]): MMTSVideoTrackInfo | undefined {
    const selectableTracks = tracks.filter((track) => {
        return track.assetSelectionLevel !== undefined || (track.resolution || 0) > 0;
    });
    if (selectableTracks.length === 0) {
        return undefined;
    }

    return selectableTracks.reduce((best, track) => {
        return compareMMTSVideoTrackPriority(track, best) < 0 ? track : best;
    }, selectableTracks[0]);
}

export function findMMTSSecondaryVideoTrack(tracks: MMTSVideoTrackInfo[],
                                            primaryTrack: MMTSVideoTrackInfo | undefined): MMTSVideoTrackInfo | undefined {
    if (primaryTrack === undefined) {
        return undefined;
    }

    let secondaryTracks: MMTSVideoTrackInfo[] = [];
    if (primaryTrack.assetGroupId !== undefined && primaryTrack.assetSelectionLevel !== undefined) {
        secondaryTracks = tracks.filter((track) => {
            return track.assetGroupId === primaryTrack.assetGroupId &&
                track.assetSelectionLevel !== undefined &&
                track.assetSelectionLevel > primaryTrack.assetSelectionLevel!;
        });
    }

    if (secondaryTracks.length === 0) {
        if (primaryTrack.resolution === undefined) {
            return undefined;
        }
        secondaryTracks = tracks.filter((track) => {
            return track.assetSelectionLevel === undefined &&
                (track.resolution || 0) > 0 &&
                (track.resolution || 0) < primaryTrack.resolution!;
        });
        if (secondaryTracks.length === 0) {
            return undefined;
        }
    }

    return secondaryTracks.reduce((best, track) => {
        return compareMMTSVideoTrackPriority(track, best) < 0 ? track : best;
    }, secondaryTracks[0]);
}

export function isMMTSVideoFallback(tracks: MMTSVideoTrackInfo[], selectedPacketId: number): boolean {
    const selected = tracks.find((track) => track.packetId === selectedPacketId);
    if (selected === undefined || selected.active !== true) {
        return false;
    }

    const primaryTrack = findMMTSPrimaryVideoTrack(tracks);
    if (primaryTrack !== undefined &&
        primaryTrack.packetId !== selected.packetId &&
        primaryTrack.active !== true &&
        compareMMTSVideoTrackPriority(primaryTrack, selected) < 0) {
        return true;
    }

    const selectedResolution = selected.resolution || 0;
    return tracks.some((track) => {
        return track.assetSelectionLevel === undefined &&
            selected.assetSelectionLevel === undefined &&
            (track.resolution || 0) > selectedResolution &&
            track.active !== true;
    });
}

export function getMMTSSelectedVideoRole(tracks: MMTSVideoTrackInfo[],
                                         selectedPacketId: number,
                                         fallback: boolean): 'primary' | 'secondary' | undefined {
    if (selectedPacketId < 0) {
        return undefined;
    }
    if (fallback) {
        return 'secondary';
    }

    const selected = tracks.find((track) => track.packetId === selectedPacketId);
    if (selected === undefined) {
        return undefined;
    }

    const primaryTrack = findMMTSPrimaryVideoTrack(tracks);
    if (primaryTrack === undefined) {
        return undefined;
    }

    if (selected.packetId === primaryTrack.packetId) {
        return 'primary';
    }

    const secondaryTrack = findMMTSSecondaryVideoTrack(tracks, primaryTrack);
    if (secondaryTrack !== undefined && selected.packetId === secondaryTrack.packetId) {
        return 'secondary';
    }

    return compareMMTSVideoTrackPriority(selected, primaryTrack) <= 0 ? 'primary' : 'secondary';
}

export function audioSampleRateFromCode(code: number | undefined): number | undefined {
    switch (code) {
        case 0x01:
            return 16000;
        case 0x02:
            return 22050;
        case 0x03:
            return 24000;
        case 0x05:
            return 32000;
        case 0x06:
            return 44100;
        case 0x07:
            return 48000;
        default:
            return undefined;
    }
}

export function audioLayoutFromComponentType(componentType: number | undefined): string | undefined {
    if (componentType === undefined) {
        return undefined;
    }
    switch (componentType & 0x1f) {
        case 0x01:
            return 'mono';
        case 0x02:
            return 'dual-mono';
        case 0x03:
            return 'stereo';
        case 0x04:
            return '2/1';
        case 0x05:
            return '3ch';
        case 0x06:
            return '2/2';
        case 0x07:
            return '4ch';
        case 0x08:
            return '5ch';
        case 0x09:
            return '5.1ch';
        case 0x0a:
            return '3/3.1';
        case 0x0b:
            return '6.1ch';
        case 0x0c:
        case 0x0d:
        case 0x0e:
        case 0x0f:
            return '7.1ch';
        case 0x10:
            return '10.2ch';
        case 0x11:
            return '22.2ch';
        default:
            return undefined;
    }
}

export function audioChannelCountFromComponentType(componentType: number | undefined): number | undefined {
    if (componentType === undefined) {
        return undefined;
    }
    switch (componentType & 0x1f) {
        case 0x01:
            return 1;
        case 0x02:
        case 0x03:
            return 2;
        case 0x04:
        case 0x05:
            return 3;
        case 0x06:
        case 0x07:
            return 4;
        case 0x08:
            return 5;
        case 0x09:
            return 6;
        case 0x0a:
        case 0x0b:
            return 7;
        case 0x0c:
        case 0x0d:
        case 0x0e:
        case 0x0f:
            return 8;
        case 0x10:
            return 12;
        case 0x11:
            return 24;
        default:
            return undefined;
    }
}

export function audioLayoutFromAacConfig(channelConfig: number): string | undefined {
    switch (channelConfig) {
        case 1:
            return 'mono';
        case 2:
            return 'stereo';
        case 3:
            return '3ch';
        case 4:
            return '4ch';
        case 5:
            return '5ch';
        case 6:
            return '5.1ch';
        case 7:
            return '7.1ch';
        case 11:
            return '6.1ch';
        case 12:
        case 14:
            return '7.1ch';
        case 13:
            return '22.2ch';
        default:
            return undefined;
    }
}

export function audioChannelCountFromAacConfig(channelConfig: number): number | undefined {
    if (channelConfig >= 1 && channelConfig <= 7) {
        return channelConfig === 7 ? 8 : channelConfig;
    }
    switch (channelConfig) {
        case 11: return 7;
        case 12:
        case 14: return 8;
        case 13: return 24;
        default: return undefined;
    }
}

export function isSupportedAACChannelConfig(channelConfig: number): boolean {
    return channelConfig >= 1 && channelConfig <= 7;
}

export function hasKnownMMTSAudioSupport(info: MMTSAudioTrackInfo | undefined): boolean {
    return info !== undefined &&
        info.channelConfig !== undefined &&
        isSupportedAACChannelConfig(info.channelConfig);
}

export function isMMTSAudioTrackSelectable(info: MMTSAudioTrackInfo | undefined): boolean {
    if (info === undefined) {
        return false;
    }

    if (info.supported === false) {
        return false;
    }

    if (info.channelConfig !== undefined) {
        return isSupportedAACChannelConfig(info.channelConfig);
    }

    if (info.channelCount !== undefined && info.channelCount > 8) {
        return false;
    }

    return info.channelLayout !== '10.2ch' && info.channelLayout !== '22.2ch';
}

export function scoreAudioTrack(track: MMTSAudioTrackInfo): number {
    const channelCount = track.channelCount || 0;
    const knownSupport = hasKnownMMTSAudioSupport(track) ? 10000 : 0;
    const main = track.mainComponent ? 100 : 0;
    const quality = track.qualityIndicator !== undefined ? track.qualityIndicator : 0;
    return knownSupport + channelCount * 1000 + main + quality;
}

export function scoreDeclaredAudioTrack(track: MMTSAudioTrackInfo): number {
    const channelCount = track.channelCount || 0;
    const main = track.mainComponent ? 100 : 0;
    const quality = track.qualityIndicator !== undefined ? track.qualityIndicator : 0;
    return channelCount * 1000 + main + quality;
}

export function findPreferredAudioTrack(tracks: MMTSAudioTrackInfo[],
                                        requireKnownSupport: boolean): MMTSAudioTrackInfo | undefined {
    const candidates = tracks.filter((track) => {
        return isMMTSAudioTrackSelectable(track) &&
            (!requireKnownSupport || hasKnownMMTSAudioSupport(track));
    });
    if (candidates.length === 0) {
        return undefined;
    }

    return candidates.reduce((best, track) => {
        return scoreAudioTrack(track) > scoreAudioTrack(best) ? track : best;
    }, candidates[0]);
}

export function findPreferredDeclaredAudioTrack(tracks: MMTSAudioTrackInfo[]): MMTSAudioTrackInfo | undefined {
    const candidates = tracks.filter((track) => {
        return isMMTSAudioTrackSelectable(track);
    });
    if (candidates.length === 0) {
        return undefined;
    }

    return candidates.reduce((best, track) => {
        return scoreDeclaredAudioTrack(track) > scoreDeclaredAudioTrack(best) ? track : best;
    }, candidates[0]);
}

export function getSortedAudioTrackInfos(tracksByPacketId: {[packetId: number]: MMTSAudioTrackInfo}): MMTSAudioTrackInfo[] {
    return Object.keys(tracksByPacketId)
        .map((key) => tracksByPacketId[Number(key)])
        .sort((a, b) => a.packetId - b.packetId);
}

export function getSortedVideoTrackInfos(tracksByPacketId: {[packetId: number]: MMTSVideoTrackInfo}): MMTSVideoTrackInfo[] {
    return Object.keys(tracksByPacketId)
        .map((key) => tracksByPacketId[Number(key)])
        .sort((a, b) => compareMMTSVideoTrackPriority(a, b));
}

export function getSortedSubtitleTrackInfos(tracksByPacketId: {[packetId: number]: MMTSSubtitleTrackInfo}): MMTSSubtitleTrackInfo[] {
    return Object.keys(tracksByPacketId)
        .map((key) => tracksByPacketId[Number(key)])
        .sort((a, b) => a.packetId - b.packetId);
}

export function createMMTSVideoTrackInfo(asset: MMTAsset,
                                         previous: MMTSVideoTrackInfo | undefined,
                                         active: boolean,
                                         selected: boolean): MMTSVideoTrackInfo {
    return {
        ...previous,
        packetId: asset.packetId,
        assetType: asset.assetType,
        codec: asset.codec || 'hevc',
        language: asset.language,
        componentTag: asset.componentTag,
        assetGroupId: asset.assetGroupId,
        assetSelectionLevel: asset.assetSelectionLevel,
        accessControlCaSystemId: asset.accessControlCaSystemId,
        accessControlLocationType: asset.accessControlLocationType,
        accessControlPacketId: asset.accessControlPacketId,
        scramblerLayerType: asset.scramblerLayerType,
        scrambleSystemId: asset.scrambleSystemId,
        messageAuthenticationLayerType: asset.messageAuthenticationLayerType,
        messageAuthenticationSystemId: asset.messageAuthenticationSystemId,
        resolution: asset.videoResolution,
        resolutionLabel: videoResolutionLabel(asset),
        frameRateCode: asset.videoFrameRate,
        hierarchyType: asset.hierarchyType,
        hierarchyLayerIndex: asset.hierarchyLayerIndex,
        hierarchyEmbeddedLayerIndex: asset.hierarchyEmbeddedLayerIndex,
        hierarchyChannel: asset.hierarchyChannel,
        hierarchyTemporalScalability: asset.hierarchyTemporalScalability,
        hierarchySpatialScalability: asset.hierarchySpatialScalability,
        hierarchyQualityScalability: asset.hierarchyQualityScalability,
        active,
        selected
    };
}

export function createMMTSAudioTrackInfo(asset: MMTAsset,
                                         previous: MMTSAudioTrackInfo | undefined,
                                         selected: boolean): MMTSAudioTrackInfo {
    const declaredChannelCount = audioChannelCountFromComponentType(asset.audioComponentType);
    const declaredChannelLayout = audioLayoutFromComponentType(asset.audioComponentType);
    const unsupportedChannelLayout = declaredChannelCount !== undefined && declaredChannelCount > 8;
    const codecSupported = asset.codec !== 'mp4als';
    return {
        ...previous,
        packetId: asset.packetId,
        assetType: asset.assetType,
        codec: asset.codec || 'aac-latm',
        language: asset.language,
        componentType: asset.audioComponentType,
        componentTag: asset.componentTag !== undefined ? asset.componentTag : asset.audioComponentTag,
        assetGroupId: asset.assetGroupId,
        assetSelectionLevel: asset.assetSelectionLevel,
        accessControlCaSystemId: asset.accessControlCaSystemId,
        accessControlLocationType: asset.accessControlLocationType,
        accessControlPacketId: asset.accessControlPacketId,
        scramblerLayerType: asset.scramblerLayerType,
        scrambleSystemId: asset.scrambleSystemId,
        messageAuthenticationLayerType: asset.messageAuthenticationLayerType,
        messageAuthenticationSystemId: asset.messageAuthenticationSystemId,
        streamType: asset.audioStreamType,
        simulcastGroupTag: asset.audioSimulcastGroupTag,
        mainComponent: asset.audioMainComponent,
        qualityIndicator: asset.audioQualityIndicator,
        samplingRateCode: asset.audioSamplingRateCode,
        audioSampleRate: audioSampleRateFromCode(asset.audioSamplingRateCode),
        channelLayout: declaredChannelLayout,
        channelCount: declaredChannelCount,
        supported: codecSupported && !unsupportedChannelLayout,
        unsupportedReason: !codecSupported ? 'als' :
            (unsupportedChannelLayout ? 'channel-layout' : undefined),
        selected
    };
}

export function createMMTSSubtitleTrackInfo(asset: MMTAsset,
                                            previous: MMTSSubtitleTrackInfo | undefined): MMTSSubtitleTrackInfo {
    return {
        ...previous,
        packetId: asset.packetId,
        assetType: asset.assetType,
        codec: asset.codec || 'ttml',
        language: asset.language,
        componentTag: asset.componentTag,
        assetGroupId: asset.assetGroupId,
        assetSelectionLevel: asset.assetSelectionLevel,
        accessControlCaSystemId: asset.accessControlCaSystemId,
        accessControlLocationType: asset.accessControlLocationType,
        accessControlPacketId: asset.accessControlPacketId,
        scramblerLayerType: asset.scramblerLayerType,
        scrambleSystemId: asset.scrambleSystemId,
        messageAuthenticationLayerType: asset.messageAuthenticationLayerType,
        messageAuthenticationSystemId: asset.messageAuthenticationSystemId,
        dataComponentId: asset.dataComponentId,
        dataComponentInfo: asset.dataComponentInfo,
        subtitleTag: asset.subtitleTag,
        subtitleInfoVersion: asset.subtitleInfoVersion,
        subtitleStartMpuSequenceNumber: asset.subtitleStartMpuSequenceNumber,
        subtitleType: asset.subtitleType,
        subtitleFormat: asset.subtitleFormat,
        subtitleOperationMode: asset.subtitleOperationMode,
        subtitleTimingMode: asset.subtitleTimingMode,
        subtitleDisplayMode: asset.subtitleDisplayMode,
        subtitleResolution: asset.subtitleResolution,
        subtitleCompressionType: asset.subtitleCompressionType,
        supported: asset.subtitleCompressionType === undefined || asset.subtitleCompressionType === 0,
        unsupportedReason: asset.subtitleCompressionType !== undefined && asset.subtitleCompressionType !== 0 ?
            'compression' : undefined,
        subtitleReferenceStartTime: asset.subtitleReferenceStartTimeUs !== undefined
            ? Math.floor(asset.subtitleReferenceStartTimeUs / 1000)
            : undefined
    };
}

export function updateMMTSAudioTrackInfoFromFrame(packetId: number,
                                                  frame: LOASAACFrame,
                                                  previous: MMTSAudioTrackInfo | undefined,
                                                  selected: boolean): MMTSAudioTrackInfo {
    const codecSupported = previous === undefined || previous.codec !== 'mp4als';
    const channelConfigSupported = isSupportedAACChannelConfig(frame.channel_config);
    return {
        ...previous,
        packetId,
        assetType: previous ? previous.assetType : 'mp4a',
        codec: previous && previous.codec ? previous.codec : 'aac-latm',
        channelConfig: frame.channel_config,
        channelCount: audioChannelCountFromAacConfig(frame.channel_config) ||
            (previous && previous.channelCount) ||
            audioChannelCountFromComponentType(previous && previous.componentType),
        channelLayout: audioLayoutFromAacConfig(frame.channel_config) ||
            (previous && previous.channelLayout) ||
            audioLayoutFromComponentType(previous && previous.componentType),
        audioSampleRate: frame.sampling_frequency,
        supported: codecSupported && channelConfigSupported,
        unsupportedReason: !codecSupported ? 'als' :
            (channelConfigSupported ? undefined : 'aac-channel-config'),
        selected
    };
}

export function videoResolutionLabel(asset: MMTAsset): string {
    switch (asset.videoResolution) {
        case 0x01:
            return '180p';
        case 0x02:
            return '240p';
        case 0x03:
            return '480p';
        case 0x04:
            return '720p';
        case 0x05:
            return '1080p';
        case 0x06:
            return '2160p';
        case 0x07:
            return '4320p';
        default:
            return asset.videoResolution !== undefined ? `code=${asset.videoResolution}` : 'unknown';
    }
}

export function toHex(data: Uint8Array): string {
    const hex: string[] = [];
    for (let i = 0; i < data.byteLength; i++) {
        hex.push(data[i].toString(16).padStart(2, '0'));
    }
    return hex.join('');
}

export function formatHex(value: number, width: number): string {
    return '0x' + value.toString(16).padStart(width, '0');
}

export function formatMsTimestamp(value: number, timescale: number): number {
    return Math.floor(value * 1000 / timescale);
}

export function formatH265NaluTypes(units: H265NaluHVC1[]): string {
    return units.map((unit) => unit.type).join(',');
}

export function formatPacketCounts(counts: {[packetId: number]: number}): string {
    const entries = Object.keys(counts).map((key) => {
        const packetId = Number(key);
        return {packetId, count: counts[packetId]};
    });
    entries.sort((a, b) => b.count - a.count);
    return entries.slice(0, 12).map((entry) => {
        return `${formatHex(entry.packetId, 4)}:${entry.count}`;
    }).join(',');
}

export function mmtLocationTypeName(locationType: number): string {
    switch (locationType) {
        case 0x00:
            return 'same-flow';
        case 0x01:
            return 'ipv4';
        case 0x02:
            return 'ipv6';
        case 0x03:
            return 'ts';
        case 0x04:
            return 'ts-ipv6';
        case 0x05:
            return 'url';
        default:
            return `unknown(${locationType})`;
    }
}

export function layerTypeName(layerType: number | undefined): string {
    switch (layerType) {
        case 0x01:
            return 'mmtp';
        case 0x02:
            return 'ip';
        case undefined:
            return 'unknown';
        default:
            return `layer${layerType}`;
    }
}

export function scrambleSystemName(systemId: number): string {
    switch (systemId) {
        case 0x01:
            return 'aes-128';
        case 0x02:
            return 'camellia-128';
        default:
            return formatHex(systemId, 2);
    }
}

export function formatAssetConditionalAccessInfo(asset: MMTAsset): string {
    const parts: string[] = [];
    if (asset.accessControlCaSystemId !== undefined) {
        parts.push(`ca_system=${formatHex(asset.accessControlCaSystemId, 4)}`);
    }
    if (asset.accessControlLocationType !== undefined) {
        parts.push(`ca_location=${mmtLocationTypeName(asset.accessControlLocationType)}`);
    }
    if (asset.accessControlPacketId !== undefined) {
        parts.push(`ca_packet=${formatHex(asset.accessControlPacketId, 4)}`);
    }
    if (asset.accessControlPrivateData !== undefined && asset.accessControlPrivateData.byteLength > 0) {
        parts.push(`ca_private=${asset.accessControlPrivateData.byteLength}B`);
    }
    if (asset.scrambleSystemId !== undefined) {
        parts.push(
            `scrambler=${layerTypeName(asset.scramblerLayerType)}/` +
            `${scrambleSystemName(asset.scrambleSystemId)}`
        );
    }
    if (asset.scramblerPrivateData !== undefined && asset.scramblerPrivateData.byteLength > 0) {
        parts.push(`scrambler_private=${asset.scramblerPrivateData.byteLength}B`);
    }
    if (asset.messageAuthenticationSystemId !== undefined) {
        parts.push(
            `auth=${layerTypeName(asset.messageAuthenticationLayerType)}/` +
            `${formatHex(asset.messageAuthenticationSystemId, 2)}`
        );
    }
    if (asset.messageAuthenticationPrivateData !== undefined &&
        asset.messageAuthenticationPrivateData.byteLength > 0) {
        parts.push(`auth_private=${asset.messageAuthenticationPrivateData.byteLength}B`);
    }

    return parts.length > 0 ? ', ' + parts.join(', ') : '';
}

export function readU16(data: Uint8Array, offset: number): number {
    return (data[offset] << 8) | data[offset + 1];
}

export function readU32(data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) >>> 0) +
        (data[offset + 1] << 16) +
        (data[offset + 2] << 8) +
        data[offset + 3];
}

export function payloadTypeName(payloadType: MMTPPayloadType): string {
    switch (payloadType) {
        case MMTPPayloadType.Mpu:
            return 'mpu';
        case MMTPPayloadType.ControlMessage:
            return 'control';
        default:
            return `unknown(${payloadType})`;
    }
}

export function formatMmtpScramblingInfo(info: MMTPScramblingInfo | undefined): string {
    if (info === undefined) {
        return '';
    }

    const parts: string[] = [];
    if (info.scrambleSystemId !== undefined) {
        parts.push(`scramble_system=${scrambleSystemName(info.scrambleSystemId)}`);
    } else if (info.scrambleSystemControl !== 0) {
        parts.push('scramble_system=present');
    }
    if (info.messageAuthenticationControl !== 0) {
        parts.push(
            info.authenticatedPayloadLength !== undefined ?
                `auth_payload=${info.authenticatedPayloadLength}` :
                'auth_payload=present'
        );
    }
    if (info.scramblingInitialCounterValue !== 0) {
        parts.push('counter=present');
    }

    return parts.length > 0 ? ', ' + parts.join(', ') : '';
}

export function scramblingName(encryptionFlag: MMTPEncryptionFlag | undefined): string {
    switch (encryptionFlag) {
        case MMTPEncryptionFlag.Unscrambled:
            return 'unscrambled';
        case MMTPEncryptionFlag.Reserved:
            return 'reserved';
        case MMTPEncryptionFlag.Even:
            return 'even';
        case MMTPEncryptionFlag.Odd:
            return 'odd';
        default:
            return 'none';
    }
}

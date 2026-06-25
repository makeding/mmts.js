import BaseDemuxer from './base-demuxer';
import DemuxErrors from './demux-errors.js';
import TLV from './tlv';
import CompressedIP from './compressed-ip';
import MMTP, {MMTPEncryptionFlag, MMTPPayloadType} from './mmtp';
import Log from '../utils/logger.js';

class MMTSDemuxer extends BaseDemuxer {

    private readonly TAG: string = 'MMTSDemuxer';

    private config_: any;
    private stash_: Uint8Array = null;
    private unsupported_reported_: boolean = false;
    private parsed_packet_count_: number = 0;
    private parsed_mmtp_count_: number = 0;
    private tlv_packet_type_counts_: {[packetType: number]: number} = {};
    private mmtp_packet_id_counts_: {[packetId: number]: number} = {};

    public constructor(probeData: any, config: any) {
        super();
        this.config_ = config;

        Log.v(this.TAG, `TLV sync_offset = ${probeData.syncOffset}, probe_packets = ${probeData.packetCount || 0}`);
    }

    public destroy(): void {
        this.config_ = null;
        this.stash_ = null;
        this.tlv_packet_type_counts_ = null;
        this.mmtp_packet_id_counts_ = null;
        super.destroy();
    }

    public static probe(buffer: ArrayBuffer) {
        return TLV.probe(buffer);
    }

    public bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    public parseChunks(chunk: ArrayBuffer, byteStart: number): number {
        let input = new Uint8Array(chunk);

        if (this.stash_ !== null && this.stash_.byteLength > 0) {
            const merged = new Uint8Array(this.stash_.byteLength + input.byteLength);
            merged.set(this.stash_, 0);
            merged.set(input, this.stash_.byteLength);
            input = merged;
            this.stash_ = null;
        }

        const result = TLV.parse(input);
        this.parsed_packet_count_ += result.packets.length;

        for (const packet of result.packets) {
            this.tlv_packet_type_counts_[packet.packetType] = (this.tlv_packet_type_counts_[packet.packetType] || 0) + 1;

            if (packet.packetType !== 0x03) {
                continue;
            }

            const compressedIP = CompressedIP.parse(packet.payload);
            if (compressedIP === null) {
                continue;
            }

            const mmtp = MMTP.parse(packet.payload.subarray(compressedIP.payloadOffset));
            if (mmtp === null) {
                continue;
            }

            this.parsed_mmtp_count_++;
            this.mmtp_packet_id_counts_[mmtp.packetId] = (this.mmtp_packet_id_counts_[mmtp.packetId] || 0) + 1;

            if (this.parsed_mmtp_count_ <= 10) {
                Log.v(
                    this.TAG,
                    `MMTP packet_id=${this.formatHex(mmtp.packetId, 4)}, ` +
                    `payload=${this.payloadTypeName(mmtp.payloadType)}, ` +
                    `seq=${mmtp.packetSequenceNumber}, ` +
                    `rap=${mmtp.rapFlag ? 1 : 0}, ` +
                    `scrambling=${this.scramblingName(mmtp.extensionHeaderScrambling && mmtp.extensionHeaderScrambling.encryptionFlag)}`
                );
            }
        }

        if (result.packets.length > 0) {
            Log.v(
                this.TAG,
                `Parsed ${result.packets.length} TLV packets, total_tlv=${this.parsed_packet_count_}, total_mmtp=${this.parsed_mmtp_count_}`
            );
        }

        if (result.needMoreData && result.consumed < input.byteLength) {
            this.stash_ = input.subarray(result.consumed);
        }

        if (!this.unsupported_reported_ && this.parsed_mmtp_count_ > 0) {
            this.unsupported_reported_ = true;
            this.onError && this.onError(
                DemuxErrors.FORMAT_UNSUPPORTED,
                'MMTS TLV/MMTP parsing works, but MPU remux is not implemented yet'
            );
        }

        return chunk.byteLength;
    }

    private formatHex(value: number, width: number): string {
        return '0x' + value.toString(16).padStart(width, '0');
    }

    private payloadTypeName(payloadType: MMTPPayloadType): string {
        switch (payloadType) {
            case MMTPPayloadType.Mpu:
                return 'mpu';
            case MMTPPayloadType.ControlMessage:
                return 'control';
            default:
                return `unknown(${payloadType})`;
        }
    }

    private scramblingName(encryptionFlag: MMTPEncryptionFlag | undefined): string {
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

}

export default MMTSDemuxer;

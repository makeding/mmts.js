import BaseDemuxer from './base-demuxer';
declare class MMTSDemuxer extends BaseDemuxer {
    private readonly TAG;
    private config_;
    private stash_;
    private unsupported_reported_;
    private parsed_packet_count_;
    private parsed_mmtp_count_;
    private tlv_packet_type_counts_;
    private mmtp_packet_id_counts_;
    constructor(probeData: any, config: any);
    destroy(): void;
    static probe(buffer: ArrayBuffer): import("./tlv").TLVProbeResult;
    bindDataSource(loader: any): this;
    parseChunks(chunk: ArrayBuffer, byteStart: number): number;
    private formatHex;
    private payloadTypeName;
    private scramblingName;
}
export default MMTSDemuxer;

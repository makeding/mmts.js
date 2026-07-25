(function(root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BT2446CWebGPU = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';

    var LUT_SIZE = 33;
    var HLG_A = 0.17883277;
    var HLG_B = 1 - 4 * HLG_A;
    var HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
    var HLG_SYSTEM_GAMMA = 1.2;
    var HLG_PEAK_NITS = 1000;
    // BT.2446-1 (2021) reports only Method A and Method C. The earlier
    // "Method B" 291-nit transitional model was removed, so this prototype now
    // implements A and C and uses A as the default.
    var REFERENCE_WHITE_NITS = 203;
    var SDR_PEAK_NITS = 100;
    // Method A tone-curve constants (BT.2446-1 6.1.2 / hdr-toys bt2446a.glsl).
    var METHOD_A_MAX_LUMA = 1000;
    // Method C crosstalk + Lab chroma correction constants (BT.2446-1 6.1.2..6.1.8).
    var CROSSTALK_ALPHA = 0.04;
    var CHROMA_CORRECTION_SIGMA = 0.33;
    var METHOD_C_IP = 0.58535;
    var METHOD_C_K1 = 0.83802;
    var METHOD_C_K3 = 0.74204;
    var METHOD_C_K2 = (METHOD_C_K1 * (METHOD_C_IP / METHOD_C_K1)) * (1 - METHOD_C_K3);
    var METHOD_C_K4 = METHOD_C_K1 * (METHOD_C_IP / METHOD_C_K1) -
        METHOD_C_K2 * Math.log(1 - METHOD_C_K3);
    // BT.2407-style signal scaling: 0..1019/940 (super-white 108.4%) -> 0.001..1.0.
    var SIGNAL_SCALE_A = 0.0;
    var SIGNAL_SCALE_B = 1019 / 940;
    var SIGNAL_SCALE_C = 0.001;
    var SIGNAL_SCALE_D = 1.0;
    // ICC-style black point compensation (Method A stage 2).
    var BLACK_POINT_SOURCE = 0.0;
    var BLACK_POINT_DEST = 0.001;
    // ARIB broadcast SDR simulcast mode. Uses a 291-nit HLG OOTF model (system
    // gamma 1.03) followed by a YCbCr chroma-scaling tone curve calibrated so
    // that 75% HLG (the 203-nit HDR reference white) maps to ~0.90 sRGB, which
    // matches the on-air look of Japanese BS 4K / 1080i simulcast. The curve is
    // linear below the 40-nit knee and logarithmic above it, with the shoulder
    // parameters solved so sdrY(74 nits) = 79 nits (~0.9 sRGB) and
    // sdrY(291 nits) = 100 nits (1.0 sRGB).
    var ARIB_PEAK_NITS = 291;
    var ARIB_SYSTEM_GAMMA = 1.03;
    var ARIB_KNEE_NITS = 40;
    var ARIB_K1 = 1.440;
    var ARIB_K2 = 11.289;
    var ARIB_K3 = 0.85;
    var ARIB_K4 = 79.0;

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function srgbToLinear(value) {
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    }

    function linearToSRGB(value) {
        value = Math.max(0, value);
        return value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
    }

    function linearToBT709(value) {
        value = Math.max(0, value);
        return value < 0.018 ? 4.5 * value : 1.099 * Math.pow(value, 0.45) - 0.099;
    }

    function bt709ToLinear(value) {
        value = Math.max(0, value);
        return value < 0.081 ? value / 4.5 : Math.pow((value + 0.099) / 1.099, 1 / 0.45);
    }

    function hlgInverseOETF(value) {
        value = Math.max(0, value);
        return value <= 0.5 ? value * value / 3 :
            (Math.exp((value - HLG_C) / HLG_A) + HLG_B) / 12;
    }

    function applyCrosstalk(rgb, alpha) {
        var diagonal = 1 - 2 * alpha;
        return [
            diagonal * rgb[0] + alpha * rgb[1] + alpha * rgb[2],
            alpha * rgb[0] + diagonal * rgb[1] + alpha * rgb[2],
            alpha * rgb[0] + alpha * rgb[1] + diagonal * rgb[2],
        ];
    }

    function applyInverseCrosstalk(rgb, alpha) {
        var b = 1 - alpha;
        var scale = 1 / (1 - 3 * alpha);
        return [
            scale * (b * rgb[0] - alpha * rgb[1] - alpha * rgb[2]),
            scale * (-alpha * rgb[0] + b * rgb[1] - alpha * rgb[2]),
            scale * (-alpha * rgb[0] - alpha * rgb[1] + b * rgb[2]),
        ];
    }

    // Full-precision BT.2020 <-> XYZ matrices (same values as hdr-toys / BT.2100).
    var RGB2020_TO_XYZ = [
        0.6369580483012914, 0.14461690358620832, 0.1688809751641721,
        0.2627002120112671, 0.6779980715188708,  0.05930171646986196,
        0.0,               0.028072693049087428, 1.060985057710791,
    ];
    var XYZ_TO_RGB2020 = [
         1.716651187971268,  -0.355670783776392, -0.253366281373660,
        -0.666684351832489,   1.616481236634939,  0.0157685458139111,
         0.017639857445311,  -0.042770613257809,  0.942103121235474,
    ];
    var RGB2020_TO_RGB709 = [
        1.660491, -0.587641, -0.072850,
        -0.124550, 1.132900, -0.008349,
        -0.018151, -0.100579, 1.118730,
    ];

    function mat3MulVec(m, v) {
        return [
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
        ];
    }

    function rgb2020ToXYZ(rgb) { return mat3MulVec(RGB2020_TO_XYZ, rgb); }
    function xyzToRGB2020(xyz) { return mat3MulVec(XYZ_TO_RGB2020, xyz); }
    function rgb2020ToRGB709(rgb) { return mat3MulVec(RGB2020_TO_RGB709, rgb); }

    // HLG signal -> linear display light normalised so that 1.0 = HLG_PEAK_NITS.
    // This matches hdr-toys' hlg_inv.glsl + OOTF convention: the BT.2446 tone
    // curves operate on linear BT.2020 RGB expressed in units of the HDR
    // reference white (203 nits), i.e. pure HLG 100% maps to 1000/203 ~= 4.93.
    function hlgToLinearDisplayNorm(hlgRGB) {
        var sceneRGB = [
            hlgInverseOETF(hlgRGB[0]),
            hlgInverseOETF(hlgRGB[1]),
            hlgInverseOETF(hlgRGB[2]),
        ];
        var sceneLuminance =
            0.2627 * sceneRGB[0] + 0.6780 * sceneRGB[1] + 0.0593 * sceneRGB[2];
        var ootfScale = sceneLuminance > 0 ?
            HLG_PEAK_NITS * Math.pow(sceneLuminance, HLG_SYSTEM_GAMMA - 1) : 0;
        return [
            sceneRGB[0] * ootfScale / HLG_PEAK_NITS,
            sceneRGB[1] * ootfScale / HLG_PEAK_NITS,
            sceneRGB[2] * ootfScale / HLG_PEAK_NITS,
        ];
    }

    // HLG signal -> linear display light in absolute nits, for an arbitrary
    // OOTF peak luminance. Used by the ARIB mode (291-nit model) which needs
    // absolute nits because its tone curve was calibrated against nits.
    function hlgToLinearDisplayNits(hlgRGB, peakNits, systemGamma) {
        var sceneRGB = [
            hlgInverseOETF(hlgRGB[0]),
            hlgInverseOETF(hlgRGB[1]),
            hlgInverseOETF(hlgRGB[2]),
        ];
        var sceneLuminance =
            0.2627 * sceneRGB[0] + 0.6780 * sceneRGB[1] + 0.0593 * sceneRGB[2];
        var ootfScale = sceneLuminance > 0 ?
            peakNits * Math.pow(sceneLuminance, systemGamma - 1) : 0;
        return [
            sceneRGB[0] * ootfScale,
            sceneRGB[1] * ootfScale,
            sceneRGB[2] * ootfScale,
        ];
    }

    // xyY helpers (Method C tone-maps luminance only, preserving chromaticity).
    function xyzToxyY(xyz) {
        var sum = xyz[0] + xyz[1] + xyz[2];
        if (sum === 0) { sum = 1e-6; }
        return [xyz[0] / sum, xyz[1] / sum, xyz[1]];
    }
    function xyYToXYZ(xyY) {
        var x = xyY[0], y = xyY[1], Y = xyY[2];
        var mult = Y / Math.max(y, 1e-6);
        return [x * mult, Y, (1 - x - y) * mult];
    }

    // Method C core luminance tone curve (BT.2446-1 6.1.4).
    function toneMapMethodC(Y) {
        var inflection = METHOD_C_IP / METHOD_C_K1;
        if (Y < inflection) {
            return Y * METHOD_C_K1;
        }
        return METHOD_C_K2 * Math.log(Y / inflection - METHOD_C_K3) + METHOD_C_K4;
    }

    // ARIB simulcast tone curve: linear below the 40-nit knee, log shoulder above.
    // Calibrated so that HLG 75% (74 nits under the 291-nit OOTF) maps to ~79 nits
    // SDR (~0.9 sRGB) and HLG 100% (291 nits) maps to 100 nits (1.0 sRGB).
    function toneMapARIB(hdrNits) {
        if (hdrNits <= ARIB_KNEE_NITS) {
            return ARIB_K1 * hdrNits;
        }
        return ARIB_K2 * Math.log(hdrNits / ARIB_KNEE_NITS - ARIB_K3) + ARIB_K4;
    }

    // CIELAB <-> XYZ/RGB for Method C 6.1.8 optional chroma correction.
    var LAB_DELTA = 6 / 29;
    var LAB_DELTA_C = LAB_DELTA * 2 / 3;
    var LAB_XYZ_N = [0.95047, 1.0, 1.08883];

    function cbrtSigned(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3); }
    function labF(x) {
        return x > Math.pow(LAB_DELTA, 3) ?
            cbrtSigned(x) : LAB_DELTA_C + x / (3 * Math.pow(LAB_DELTA, 2));
    }
    function labFInv(x) {
        return x > LAB_DELTA ?
            Math.pow(x, 3) : (x - LAB_DELTA_C) * (3 * Math.pow(LAB_DELTA, 2));
    }
    function rgb2020ToLab(rgb) {
        var xyz = rgb2020ToXYZ(rgb);
        var fx = labF(xyz[0] / LAB_XYZ_N[0]);
        var fy = labF(xyz[1] / LAB_XYZ_N[1]);
        var fz = labF(xyz[2] / LAB_XYZ_N[2]);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    function labToRGB2020(lab) {
        var fy = (lab[0] + 16) / 116;
        var fx = fy + lab[1] / 500;
        var fz = fy - lab[2] / 200;
        return xyzToRGB2020([
            labFInv(fx) * LAB_XYZ_N[0],
            labFInv(fy) * LAB_XYZ_N[1],
            labFInv(fz) * LAB_XYZ_N[2],
        ]);
    }
    function labToLCh(lab) {
        var chroma = Math.hypot(lab[1], lab[2]);
        var hue = (Math.abs(lab[1]) < 1e-6 && Math.abs(lab[2]) < 1e-6) ?
            0 : Math.atan2(lab[2], lab[1]);
        return [lab[0], chroma, hue];
    }
    function lchToLab(lch) {
        return [lch[0], lch[1] * Math.cos(lch[2]), lch[1] * Math.sin(lch[2])];
    }
    function chromaCorrection(L, Lref, Lmax, sigma) {
        if (L <= Lref) { return 1; }
        return Math.max(1 - sigma * (L - Lref) / (Lmax - Lref), 0);
    }

    // BT.2020 YCbCr (Method A) — BT.2100 / BT.2020 luma coefficients.
    var Y_COEF_A = 0.2627002120112671;
    var Y_COEF_B = 0.6779980715188708;
    var Y_COEF_C = 0.05930171646986196;
    var YCBCR_D = 2 * (1 - Y_COEF_C);
    var YCBCR_E = 2 * (1 - Y_COEF_A);

    function rgb2020ToYCbCr(rgb) {
        return [
            Y_COEF_A * rgb[0] + Y_COEF_B * rgb[1] + Y_COEF_C * rgb[2],
            -Y_COEF_A / YCBCR_D * rgb[0] - Y_COEF_B / YCBCR_D * rgb[1] + 0.5 * rgb[2],
            0.5 * rgb[0] - Y_COEF_B / YCBCR_E * rgb[1] - Y_COEF_C / YCBCR_E * rgb[2],
        ];
    }
    function yCbCrToRGB2020(ycbcr) {
        var Y = ycbcr[0], Cb = ycbcr[1], Cr = ycbcr[2];
        return [
            Y + YCBCR_E * Cr,
            Y + (-Y_COEF_C / Y_COEF_B * YCBCR_D) * Cb +
                (-Y_COEF_A / Y_COEF_B * YCBCR_E) * Cr,
            Y + YCBCR_D * Cb,
        ];
    }

    // Method A perceptual tone curve (BT.2446-1 6.1.2, ported from hdr-toys).
    function methodAToneCurve(Y, maxLuma) {
        Y = Math.pow(Y, 1 / 2.4);
        var pHDR = 1 + 32 * Math.pow(maxLuma / 10000, 1 / 2.4);
        var pSDR = 1 + 32 * Math.pow(REFERENCE_WHITE_NITS / 10000, 1 / 2.4);
        var Yp = Math.log(1 + (pHDR - 1) * Y) / Math.log(pHDR);
        var Yc;
        if (Yp <= 0.7399) {
            Yc = Yp * 1.0770;
        } else if (Yp < 0.9909) {
            Yc = Yp * (-1.1510 * Yp + 2.7811) - 0.6302;
        } else {
            Yc = Yp * 0.5 + 0.5;
        }
        var Ysdr = (Math.pow(pSDR, Yc) - 1) / (pSDR - 1);
        return Math.pow(Ysdr, 2.4);
    }

    // ICC-style black point compensation (Method A stage 2 / hdr-toys bt2446a.glsl).
    function blackPointCompensation(xyz, srcBlack, dstBlack) {
        var ratio = (1 - dstBlack) / (1 - srcBlack);
        var white = rgb2020ToXYZ([1, 1, 1]);
        return [
            ratio * xyz[0] + (1 - ratio) * white[0],
            ratio * xyz[1] + (1 - ratio) * white[1],
            ratio * xyz[2] + (1 - ratio) * white[2],
        ];
    }

    // BT.2407 hue-preserving gamut reduction after BT.2020 -> BT.709 matrix.
    // Saturated BT.2020 colours land outside [0, 1] in BT.709 linear; hard
    // per-channel clipping would shift their hue. Add white light to lift the
    // minimum channel, then uniformly scale if the maximum still exceeds 1.
    function gamutClipBT709Linear(sdr709) {
        var red = sdr709[0];
        var green = sdr709[1];
        var blue = sdr709[2];
        var minChannel = Math.min(red, green, blue);
        if (minChannel < 0) {
            var shift = -minChannel;
            red += shift; green += shift; blue += shift;
        }
        var maxChannel = Math.max(red, green, blue);
        if (maxChannel > 1) {
            var scale = 1 / maxChannel;
            red *= scale; green *= scale; blue *= scale;
        }
        return [red, green, blue];
    }

    function encodeLinearBT709ToSRGB(sdr709Linear) {
        var clipped = gamutClipBT709Linear(sdr709Linear);
        return [
            clamp(linearToSRGB(clipped[0]), 0, 1),
            clamp(linearToSRGB(clipped[1]), 0, 1),
            clamp(linearToSRGB(clipped[2]), 0, 1),
        ];
    }

    // BT.2446-1 Method A: YCbCr-based tone mapping with chroma scaling.
    // The chroma scaling ratio Yr = Ysdr / (1.1 * Y) keeps hue intact while
    // desaturating highlights; the max(0.1 * Cr, 0) term compensates the
    // otherwise-too-bright red highlights. A second pass applies ICC-style
    // black point compensation in XYZ space to prevent shadow crush.
    // Ported from hdr-toys bt2446a.glsl.
    function mapHLGToSDRMethodA(hlgRGB) {
        var linearNorm = hlgToLinearDisplayNorm(hlgRGB);
        var ycbcr = rgb2020ToYCbCr(linearNorm);
        var scale = METHOD_A_MAX_LUMA / REFERENCE_WHITE_NITS;
        var Y = ycbcr[0] / scale;
        var Cb = ycbcr[1] / scale;
        var Cr = ycbcr[2] / scale;
        var Ysdr = methodAToneCurve(Y, METHOD_A_MAX_LUMA);
        var Yr = Ysdr / Math.max(1.1 * Y, 1e-6);
        var CbScaled = Cb * Yr;
        var CrScaled = Cr * Yr;
        var YFinal = Ysdr - Math.max(0.1 * CrScaled, 0);
        var sdr2020 = yCbCrToRGB2020([YFinal, CbScaled, CrScaled]);
        var xyz = rgb2020ToXYZ(sdr2020);
        xyz = blackPointCompensation(xyz, BLACK_POINT_SOURCE, BLACK_POINT_DEST);
        sdr2020 = xyzToRGB2020(xyz);
        return encodeLinearBT709ToSRGB(rgb2020ToRGB709(sdr2020));
    }

    // BT.2446-1 Method C: crosstalk -> Lab chroma correction -> xyY tone map
    // -> inverse crosstalk -> signal scaling. The Lab stage linearly reduces
    // chroma for L above the HDR reference white (203 nits) so that highlights
    // trend toward achromatic, which is the production-look intended by SDR
    // simulcast. Ported from hdr-toys bt2446c.glsl.
    function mapHLGToSDRMethodC(hlgRGB) {
        var rgb = hlgToLinearDisplayNorm(hlgRGB);
        rgb = applyCrosstalk(rgb, CROSSTALK_ALPHA);
        var Lref = rgb2020ToLab([1, 1, 1])[0];
        var Lmax = rgb2020ToLab([
            1000 / REFERENCE_WHITE_NITS,
            1000 / REFERENCE_WHITE_NITS,
            1000 / REFERENCE_WHITE_NITS,
        ])[0];
        var lab = rgb2020ToLab(rgb);
        var lch = labToLCh(lab);
        lch[1] *= chromaCorrection(lch[0], Lref, Lmax, CHROMA_CORRECTION_SIGMA);
        rgb = labToRGB2020(lchToLab(lch));
        var xyz = rgb2020ToXYZ(rgb);
        var xyY = xyzToxyY(xyz);
        xyY[2] = toneMapMethodC(xyY[2]);
        xyz = xyYToXYZ(xyY);
        rgb = xyzToRGB2020(xyz);
        rgb = applyInverseCrosstalk(rgb, CROSSTALK_ALPHA);
        // Signal scaling: handle 109% super-whites and lift black point.
        rgb = [
            (rgb[0] - SIGNAL_SCALE_A) * (SIGNAL_SCALE_D - SIGNAL_SCALE_C) /
                (SIGNAL_SCALE_B - SIGNAL_SCALE_A) + SIGNAL_SCALE_C,
            (rgb[1] - SIGNAL_SCALE_A) * (SIGNAL_SCALE_D - SIGNAL_SCALE_C) /
                (SIGNAL_SCALE_B - SIGNAL_SCALE_A) + SIGNAL_SCALE_C,
            (rgb[2] - SIGNAL_SCALE_A) * (SIGNAL_SCALE_D - SIGNAL_SCALE_C) /
                (SIGNAL_SCALE_B - SIGNAL_SCALE_A) + SIGNAL_SCALE_C,
        ];
        return encodeLinearBT709ToSRGB(rgb2020ToRGB709(rgb));
    }

    // ARIB broadcast SDR simulcast mode. Combines a 291-nit HLG OOTF model with
    // the Method A YCbCr chroma-scaling approach (without Method A's red
    // highlight compensation, since broadcast SDR look does not need that lift).
    // The tone curve is calibrated to on-air Japanese BS 4K / 1080i practice:
    // 75% HLG reference white -> ~0.90 sRGB, 100% HLG -> 1.0 sRGB.
    function mapHLGToSDRARIB(hlgRGB) {
        var linearNits = hlgToLinearDisplayNits(
            hlgRGB, ARIB_PEAK_NITS, ARIB_SYSTEM_GAMMA);
        var ycbcr = rgb2020ToYCbCr(linearNits);
        var Y = ycbcr[0], Cb = ycbcr[1], Cr = ycbcr[2];
        var Ysdr = toneMapARIB(Y);
        var Yr = Ysdr / Math.max(1.1 * Y, 1e-6);
        var CbScaled = Cb * Yr;
        var CrScaled = Cr * Yr;
        // Convert absolute nits to normalised linear (1.0 = 100 nits SDR peak),
        // matching the convention expected by encodeLinearBT709ToSRGB.
        var sdr2020 = yCbCrToRGB2020([Ysdr, CbScaled, CrScaled]).map(function (c) {
            return c / SDR_PEAK_NITS;
        });
        return encodeLinearBT709ToSRGB(rgb2020ToRGB709(sdr2020));
    }

    function normalizeMode(mode) {
        if (mode === 'bt2446c') { return 'bt2446c'; }
        if (mode === 'bt2446a') { return 'bt2446a'; }
        return 'bt2446arib';
    }

    function modeLabel(mode) {
        var normalized = normalizeMode(mode);
        if (normalized === 'bt2446c') {
            return 'BT.2446-C (Lab chroma correction)';
        }
        if (normalized === 'bt2446a') {
            return 'BT.2446-A (YCbCr chroma scaling)';
        }
        return 'ARIB (291-nit simulcast)';
    }

    function mapDisplayedSDRToBT2446(displayedSRGB, mode) {
        // The demuxer prototype labels HLG as BT.709 so MSE exposes an SDR external
        // texture. Undo that browser BT.709 -> sRGB presentation conversion first;
        // the recovered channel values are the original HLG R'G'B' signal values.
        var hlgRGB = [
            linearToBT709(srgbToLinear(displayedSRGB[0])),
            linearToBT709(srgbToLinear(displayedSRGB[1])),
            linearToBT709(srgbToLinear(displayedSRGB[2])),
        ];
        var normalized = normalizeMode(mode);
        if (normalized === 'bt2446c') { return mapHLGToSDRMethodC(hlgRGB); }
        if (normalized === 'bt2446a') { return mapHLGToSDRMethodA(hlgRGB); }
        return mapHLGToSDRARIB(hlgRGB);
    }

    function buildLUT(size, mode) {
        size = size || LUT_SIZE;
        mode = normalizeMode(mode);
        var rowBytes = size * 4;
        var bytesPerRow = Math.ceil(rowBytes / 256) * 256;
        var data = new Uint8Array(bytesPerRow * size * size);
        for (var blue = 0; blue < size; blue++) {
            for (var green = 0; green < size; green++) {
                var rowOffset = (blue * size + green) * bytesPerRow;
                for (var red = 0; red < size; red++) {
                    var mapped = mapDisplayedSDRToBT2446([
                        red / (size - 1),
                        green / (size - 1),
                        blue / (size - 1),
                    ], mode);
                    var offset = rowOffset + red * 4;
                    data[offset] = Math.round(mapped[0] * 255);
                    data[offset + 1] = Math.round(mapped[1] * 255);
                    data[offset + 2] = Math.round(mapped[2] * 255);
                    data[offset + 3] = 255;
                }
            }
        }
        return {
            data: data,
            size: size,
            bytesPerRow: bytesPerRow,
        };
    }

    function Renderer(video, canvas, statusCallback, mode) {
        this.video = video;
        this.canvas = canvas;
        this.statusCallback = statusCallback || function() {};
        this.enabled = false;
        this.initialized = false;
        this.initializationPromise = null;
        this.frameCallbackId = null;
        this.animationFrameId = null;
        this.device = null;
        this.context = null;
        this.pipeline = null;
        this.videoSampler = null;
        this.lutTexture = null;
        this.lutView = null;
        this.lutSampler = null;
        this.frameCount = 0;
        this.lastFpsTime = 0;
        this.mode = normalizeMode(mode);
    }

    Renderer.prototype.report = function(message) {
        this.statusCallback(message);
    };

    Renderer.prototype.initialize = async function() {
        if (this.initialized) {
            return;
        }
        if (!navigator.gpu) {
            throw new Error('WebGPU unavailable');
        }
        var adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error('WebGPU adapter unavailable');
        }
        this.device = await adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        if (!this.context) {
            throw new Error('WebGPU canvas context unavailable');
        }

        var format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: format,
            alphaMode: 'opaque',
            colorSpace: 'srgb',
        });
        var shader = this.device.createShaderModule({
            code: [
                'struct VertexOutput {',
                '  @builtin(position) position: vec4f,',
                '  @location(0) uv: vec2f,',
                '}',
                '@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {',
                '  var positions = array<vec2f, 3>(',
                '    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)',
                '  );',
                '  var output: VertexOutput;',
                '  let position = positions[index];',
                '  output.position = vec4f(position, 0.0, 1.0);',
                '  output.uv = position * vec2f(0.5, -0.5) + vec2f(0.5);',
                '  return output;',
                '}',
                '@group(0) @binding(0) var videoTexture: texture_external;',
                '@group(0) @binding(1) var videoSampler: sampler;',
                '@group(0) @binding(2) var lutTexture: texture_3d<f32>;',
                '@group(0) @binding(3) var lutSampler: sampler;',
                '@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {',
                '  let source = clamp(textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv).rgb, vec3f(0.0), vec3f(1.0));',
                '  let lutCoordinate = (source * ' + (LUT_SIZE - 1) + '.0 + vec3f(0.5)) / ' + LUT_SIZE + '.0;',
                '  return vec4f(textureSampleLevel(lutTexture, lutSampler, lutCoordinate, 0.0).rgb, 1.0);',
                '}',
            ].join('\n'),
        });
        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {module: shader, entryPoint: 'vertexMain'},
            fragment: {
                module: shader,
                entryPoint: 'fragmentMain',
                targets: [{format: format}],
            },
            primitive: {topology: 'triangle-list'},
        });
        this.videoSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });
        this.lutSampler = this.device.createSampler({
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        var lut = buildLUT(LUT_SIZE, this.mode);
        this.lutTexture = this.device.createTexture({
            size: [lut.size, lut.size, lut.size],
            dimension: '3d',
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.lutView = this.lutTexture.createView();
        this.device.queue.writeTexture(
            {texture: this.lutTexture},
            lut.data,
            {bytesPerRow: lut.bytesPerRow, rowsPerImage: lut.size},
            {width: lut.size, height: lut.size, depthOrArrayLayers: lut.size}
        );
        this.device.lost.then(function(info) {
            this.enabled = false;
            this.canvas.classList.remove('active');
            this.report('device lost: ' + info.message);
        }.bind(this));
        this.initialized = true;
        this.report('ready, ' + modeLabel(this.mode) + ', fixed 33^3 LUT');
    };

    Renderer.prototype.uploadLUT = function() {
        var lut = buildLUT(LUT_SIZE, this.mode);
        this.device.queue.writeTexture(
            {texture: this.lutTexture},
            lut.data,
            {bytesPerRow: lut.bytesPerRow, rowsPerImage: lut.size},
            {width: lut.size, height: lut.size, depthOrArrayLayers: lut.size}
        );
    };

    Renderer.prototype.setMode = function(mode) {
        var normalizedMode = normalizeMode(mode);
        if (this.mode === normalizedMode) {
            return;
        }
        this.mode = normalizedMode;
        if (this.initialized) {
            this.uploadLUT();
            this.report('active, ' + modeLabel(this.mode) + ' LUT');
            if (this.enabled) {
                // A paused video does not produce another video-frame callback.
                // Redraw immediately so the comparison selector still responds.
                this.renderFrame();
            }
        }
    };

    Renderer.prototype.setEnabled = async function(enabled) {
        if (!enabled) {
            this.enabled = false;
            this.canvas.classList.remove('active');
            this.cancelFrame();
            this.report('off');
            return;
        }
        if (!this.initializationPromise) {
            this.report('initializing');
            this.initializationPromise = this.initialize();
        }
        try {
            await this.initializationPromise;
        } catch (error) {
            // Allow retry after a transient adapter/device initialization failure.
            this.initializationPromise = null;
            throw error;
        }
        this.enabled = true;
        this.canvas.classList.add('active');
        this.frameCount = 0;
        this.lastFpsTime = performance.now();
        this.renderFrame();
        this.scheduleFrame();
    };

    Renderer.prototype.cancelFrame = function() {
        if (this.frameCallbackId !== null && this.video.cancelVideoFrameCallback) {
            this.video.cancelVideoFrameCallback(this.frameCallbackId);
        }
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
        }
        this.frameCallbackId = null;
        this.animationFrameId = null;
    };

    Renderer.prototype.scheduleFrame = function() {
        if (!this.enabled || this.frameCallbackId !== null || this.animationFrameId !== null) {
            return;
        }
        if (this.video.requestVideoFrameCallback) {
            this.frameCallbackId = this.video.requestVideoFrameCallback(function() {
                this.frameCallbackId = null;
                this.renderFrame();
                this.scheduleFrame();
            }.bind(this));
        } else {
            this.animationFrameId = requestAnimationFrame(function() {
                this.animationFrameId = null;
                this.renderFrame();
                this.scheduleFrame();
            }.bind(this));
        }
    };

    Renderer.prototype.renderFrame = function() {
        if (!this.enabled || this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) {
            return;
        }
        if (this.canvas.width !== this.video.videoWidth || this.canvas.height !== this.video.videoHeight) {
            this.canvas.width = this.video.videoWidth;
            this.canvas.height = this.video.videoHeight;
        }
        try {
            var externalTexture = this.device.importExternalTexture({
                source: this.video,
                colorSpace: 'srgb',
            });
            var bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    {binding: 0, resource: externalTexture},
                    {binding: 1, resource: this.videoSampler},
                    {binding: 2, resource: this.lutView},
                    {binding: 3, resource: this.lutSampler},
                ],
            });
            var encoder = this.device.createCommandEncoder();
            var pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: {r: 0, g: 0, b: 0, a: 1},
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            this.frameCount++;
            var now = performance.now();
            if (now - this.lastFpsTime >= 2000) {
                var fps = this.frameCount * 1000 / (now - this.lastFpsTime);
                this.report('active, ' + modeLabel(this.mode) + ' LUT, ' + fps.toFixed(1) + 'fps, ' +
                    this.video.videoWidth + 'x' + this.video.videoHeight);
                this.frameCount = 0;
                this.lastFpsTime = now;
            }
        } catch (error) {
            this.report('frame error: ' + error.message);
        }
    };

    return {
        Renderer: Renderer,
        buildLUT: buildLUT,
        mapHLGToSDR: mapHLGToSDRARIB,
        mapHLGToSDRMethodA: mapHLGToSDRMethodA,
        mapHLGToSDRMethodC: mapHLGToSDRMethodC,
        mapHLGToSDRARIB: mapHLGToSDRARIB,
        mapDisplayedSDRToBT2446: mapDisplayedSDRToBT2446,
        bt709ToLinear: bt709ToLinear,
        linearToSRGB: linearToSRGB,
    };
});

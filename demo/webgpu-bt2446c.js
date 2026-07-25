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
    // BT.2446 tone mapping is kept for native HDR. SDR-originated HLG material
    // uses the inverse mappings published in ARIB STD-B72 Attachment 4 instead.
    var REFERENCE_WHITE_NITS = 203;
    var SDR_PEAK_NITS = 100;
    // ARIB STD-B72 Attachment 4 sets the gain so 75% HLG maps to 100% SDR.
    // For neutral HLG, the display-light result is sceneLight^systemGamma.
    var ARIB_REFERENCE_HLG = 0.75;
    var ARIB_SCENE_GAIN = 1 / hlgInverseOETF(ARIB_REFERENCE_HLG);
    var ARIB_DISPLAY_GAIN = 1 /
        Math.pow(hlgInverseOETF(ARIB_REFERENCE_HLG), HLG_SYSTEM_GAMMA);
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
    // Legacy experimental 291-nit tone mapper. This predates the ARIB
    // STD-B72-based inverse mappings below and is retained only for comparison.
    // It uses a 291-nit HLG OOTF model with system gamma 1.03, then a YCbCr
    // chroma-scaling tone curve calibrated so that:
    //   - 1:1 linear mapping below the 55-nit breakpoint (78% SDR signal),
    //   - log compression above, with unity slope at the breakpoint,
    //   - 75% HLG (HDR reference white, 74 nits under 291-nit OOTF) -> 86% SDR
    //     signal (~0.832 sRGB),
    //   - 100% HLG (291 nits) -> 100% SDR signal (1.0 sRGB).
    // The tone-mapping is applied only to Y (luminance); Cb/Cr are scaled by
    // Yr = Ysdr / Y to preserve hue.
    var ARIB_PEAK_NITS = 291;
    var ARIB_SYSTEM_GAMMA = 1.03;
    var ARIB_BREAKPOINT_NITS = 55;
    // Solved from: sdrY(55)=55, sdrY(74)=BT.1886(0.86)=69.6, sdrY(291)=100,
    // unity slope at breakpoint. K3=0.80 gives K1~=1.003 (essentially unity).
    var ARIB_K1 = 1.003;
    var ARIB_K2 = 14.406;
    var ARIB_K3 = 0.80;
    var ARIB_K4 = 78.362;

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

    // Emulate the browser's BT.709-video-to-sRGB presentation step. The HLG
    // input is deliberately tagged as BT.709 so WebGPU can import it as SDR;
    // the final mapped SDR signal must pass through the same presentation
    // conversion as an ordinary BT.709 video to match the HD simulcast.
    function encodeBT709SignalToSRGB(signalRGB) {
        return [
            clamp(linearToSRGB(bt709ToLinear(clamp(signalRGB[0], 0, 1))), 0, 1),
            clamp(linearToSRGB(bt709ToLinear(clamp(signalRGB[1], 0, 1))), 0, 1),
            clamp(linearToSRGB(bt709ToLinear(clamp(signalRGB[2], 0, 1))), 0, 1),
        ];
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

    // Legacy experimental simulcast tone curve: linear 1:1 below the 55-nit
    // breakpoint, then logarithmic compression. This is not an ARIB normative
    // conversion and is retained only for visual comparison.
    function toneMapARIB(hdrNits) {
        if (hdrNits <= ARIB_BREAKPOINT_NITS) {
            return ARIB_K1 * hdrNits;
        }
        return ARIB_K2 * Math.log(hdrNits / ARIB_BREAKPOINT_NITS - ARIB_K3) + ARIB_K4;
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

    // ARIB STD-B72 Attachment 4 scene-referred inverse mapping:
    // HLG OETF^-1 -> gain (75% HLG = 100% SDR) -> BT.2020-to-BT.709 matrix ->
    // SDR OETF -> hard clip. It intentionally has no tone-mapping and is the
    // preferred path for SDR-originated content carried in an HLG container.
    function mapHLGToSDRARIBSceneSignal(hlgRGB) {
        var scene2020 = [
            hlgInverseOETF(hlgRGB[0]) * ARIB_SCENE_GAIN,
            hlgInverseOETF(hlgRGB[1]) * ARIB_SCENE_GAIN,
            hlgInverseOETF(hlgRGB[2]) * ARIB_SCENE_GAIN,
        ];
        var scene709 = rgb2020ToRGB709(scene2020);
        return [
            clamp(linearToBT709(scene709[0]), 0, 1),
            clamp(linearToBT709(scene709[1]), 0, 1),
            clamp(linearToBT709(scene709[2]), 0, 1),
        ];
    }

    function mapHLGToSDRARIBScene(hlgRGB) {
        return encodeBT709SignalToSRGB(mapHLGToSDRARIBSceneSignal(hlgRGB));
    }

    // ARIB STD-B72 Attachment 4 display-referred inverse mapping:
    // HLG EOTF -> gain (75% HLG = 100% SDR) -> BT.2020-to-BT.709 matrix ->
    // inverse SDR EOTF (BT.1886 gamma 2.4) -> hard clip.
    function mapHLGToSDRARIBDisplaySignal(hlgRGB) {
        var display2020 = hlgToLinearDisplayNorm(hlgRGB).map(function (channel) {
            return channel * ARIB_DISPLAY_GAIN;
        });
        var display709 = rgb2020ToRGB709(display2020);
        return [
            clamp(Math.pow(Math.max(display709[0], 0), 1 / 2.4), 0, 1),
            clamp(Math.pow(Math.max(display709[1], 0), 1 / 2.4), 0, 1),
            clamp(Math.pow(Math.max(display709[2], 0), 1 / 2.4), 0, 1),
        ];
    }

    function mapHLGToSDRARIBDisplay(hlgRGB) {
        return encodeBT709SignalToSRGB(mapHLGToSDRARIBDisplaySignal(hlgRGB));
    }

    // Legacy experimental broadcast-match tone mapper. Combines a 291-nit HLG
    // OOTF model with YCbCr chroma scaling and a fitted logarithmic shoulder.
    function mapHLGToSDRARIB(hlgRGB) {
        var linearNits = hlgToLinearDisplayNits(
            hlgRGB, ARIB_PEAK_NITS, ARIB_SYSTEM_GAMMA);
        var ycbcr = rgb2020ToYCbCr(linearNits);
        var Y = ycbcr[0], Cb = ycbcr[1], Cr = ycbcr[2];
        var Ysdr = toneMapARIB(Y);
        // Chroma scaling: Cb/Cr follow Y by ratio Yr = Ysdr / Y.
        var Yr = Ysdr / Math.max(Y, 1e-6);
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
        if (mode === 'arib-display') { return 'arib-display'; }
        if (mode === 'arib-scene') { return 'arib-scene'; }
        if (mode === 'bt2446arib') { return 'bt2446arib'; }
        if (mode === 'bt2446c') { return 'bt2446c'; }
        if (mode === 'bt2446a') { return 'bt2446a'; }
        return 'arib-display';
    }

    function modeLabel(mode) {
        var normalized = normalizeMode(mode);
        if (normalized === 'bt2446c') {
            return 'BT.2446-C (Lab chroma correction)';
        }
        if (normalized === 'bt2446a') {
            return 'BT.2446-A (YCbCr chroma scaling)';
        }
        if (normalized === 'arib-display') {
            return 'ARIB inverse (display-referred)';
        }
        if (normalized === 'bt2446arib') {
            return 'Experimental 291-nit tone map';
        }
        return 'ARIB inverse (scene-referred)';
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
        if (normalized === 'arib-scene') { return mapHLGToSDRARIBScene(hlgRGB); }
        if (normalized === 'arib-display') { return mapHLGToSDRARIBDisplay(hlgRGB); }
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
        mapHLGToSDR: mapHLGToSDRARIBDisplay,
        mapHLGToSDRMethodA: mapHLGToSDRMethodA,
        mapHLGToSDRMethodC: mapHLGToSDRMethodC,
        mapHLGToSDRARIBScene: mapHLGToSDRARIBScene,
        mapHLGToSDRARIBSceneSignal: mapHLGToSDRARIBSceneSignal,
        mapHLGToSDRARIBDisplay: mapHLGToSDRARIBDisplay,
        mapHLGToSDRARIBDisplaySignal: mapHLGToSDRARIBDisplaySignal,
        mapHLGToSDRARIB: mapHLGToSDRARIB,
        mapDisplayedSDRToBT2446: mapDisplayedSDRToBT2446,
        bt709ToLinear: bt709ToLinear,
        linearToSRGB: linearToSRGB,
    };
});

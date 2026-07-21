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
    var SDR_PEAK_NITS = 100;
    var CROSSTALK_ALPHA = 0.04;
    var K1 = 0.83802;
    var K2 = 15.09968;
    var K3 = 0.74204;
    var K4 = 78.99439;
    var HDR_INFLECTION_NITS = 58.5 / K1;

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
        var scale = 1 / (1 - 3 * alpha);
        return [
            scale * ((1 - alpha) * rgb[0] - alpha * rgb[1] - alpha * rgb[2]),
            scale * (-alpha * rgb[0] + (1 - alpha) * rgb[1] - alpha * rgb[2]),
            scale * (-alpha * rgb[0] - alpha * rgb[1] + (1 - alpha) * rgb[2]),
        ];
    }

    function rgb2020ToXYZ(rgb) {
        return [
            0.6370 * rgb[0] + 0.1446 * rgb[1] + 0.1689 * rgb[2],
            0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2],
            0.0000 * rgb[0] + 0.0281 * rgb[1] + 1.0610 * rgb[2],
        ];
    }

    function xyzToRGB2020(xyz) {
        return [
            1.7167 * xyz[0] - 0.3557 * xyz[1] - 0.2534 * xyz[2],
            -0.6667 * xyz[0] + 1.6165 * xyz[1] + 0.0158 * xyz[2],
            0.0176 * xyz[0] - 0.0428 * xyz[1] + 0.9421 * xyz[2],
        ];
    }

    function rgb2020ToRGB709(rgb) {
        return [
            1.660491 * rgb[0] - 0.587641 * rgb[1] - 0.072850 * rgb[2],
            -0.124550 * rgb[0] + 1.132900 * rgb[1] - 0.008349 * rgb[2],
            -0.018151 * rgb[0] - 0.100579 * rgb[1] + 1.118730 * rgb[2],
        ];
    }

    function toneMapLuminance(hdrNits) {
        if (hdrNits < HDR_INFLECTION_NITS) {
            return K1 * hdrNits;
        }
        return K2 * Math.log(hdrNits / HDR_INFLECTION_NITS - K3) + K4;
    }

    function mapHLGToSDR(hlgRGB) {
        var sceneRGB = [
            hlgInverseOETF(hlgRGB[0]),
            hlgInverseOETF(hlgRGB[1]),
            hlgInverseOETF(hlgRGB[2]),
        ];
        var sceneLuminance = 0.2627 * sceneRGB[0] + 0.6780 * sceneRGB[1] + 0.0593 * sceneRGB[2];
        var ootfScale = sceneLuminance > 0 ?
            HLG_PEAK_NITS * Math.pow(sceneLuminance, HLG_SYSTEM_GAMMA - 1) : 0;
        var hdrRGB = [
            sceneRGB[0] * ootfScale,
            sceneRGB[1] * ootfScale,
            sceneRGB[2] * ootfScale,
        ];

        // BT.2446-C 6.1.2 through 6.1.6.  The optional highlight chroma correction
        // in 6.1.8 is deliberately omitted so this remains a fixed, inexpensive LUT.
        var crosstalkRGB = applyCrosstalk(hdrRGB, CROSSTALK_ALPHA);
        var hdrXYZ = rgb2020ToXYZ(crosstalkRGB);
        var hdrY = Math.max(0, hdrXYZ[1]);
        var sdrY = toneMapLuminance(hdrY);
        var luminanceScale = hdrY > 1e-8 ? sdrY / hdrY : 0;
        var sdrXYZ = [
            hdrXYZ[0] * luminanceScale,
            hdrXYZ[1] * luminanceScale,
            hdrXYZ[2] * luminanceScale,
        ];
        var sdr2020 = applyInverseCrosstalk(xyzToRGB2020(sdrXYZ), CROSSTALK_ALPHA);

        // BT.2446-C leaves BT.2020 -> BT.709 gamut conversion to BT.2407.  For this
        // prototype the normal linear matrix plus output-gamut clipping is sufficient.
        var sdr709 = rgb2020ToRGB709(sdr2020);
        return [
            clamp(linearToSRGB(sdr709[0] / SDR_PEAK_NITS), 0, 1),
            clamp(linearToSRGB(sdr709[1] / SDR_PEAK_NITS), 0, 1),
            clamp(linearToSRGB(sdr709[2] / SDR_PEAK_NITS), 0, 1),
        ];
    }

    function mapDisplayedSDRToBT2446C(displayedSRGB) {
        // The demuxer prototype labels HLG as BT.709 so MSE exposes an SDR external
        // texture. Undo that browser BT.709 -> sRGB presentation conversion first;
        // the recovered channel values are the original HLG R'G'B' signal values.
        var hlgRGB = [
            linearToBT709(srgbToLinear(displayedSRGB[0])),
            linearToBT709(srgbToLinear(displayedSRGB[1])),
            linearToBT709(srgbToLinear(displayedSRGB[2])),
        ];
        return mapHLGToSDR(hlgRGB);
    }

    function buildLUT(size) {
        size = size || LUT_SIZE;
        var rowBytes = size * 4;
        var bytesPerRow = Math.ceil(rowBytes / 256) * 256;
        var data = new Uint8Array(bytesPerRow * size * size);
        for (var blue = 0; blue < size; blue++) {
            for (var green = 0; green < size; green++) {
                var rowOffset = (blue * size + green) * bytesPerRow;
                for (var red = 0; red < size; red++) {
                    var mapped = mapDisplayedSDRToBT2446C([
                        red / (size - 1),
                        green / (size - 1),
                        blue / (size - 1),
                    ]);
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

    function Renderer(video, canvas, statusCallback) {
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

        var lut = buildLUT(LUT_SIZE);
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
        this.report('ready, fixed 33^3 LUT, alpha=0.04');
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
                this.report('active, fixed BT.2446-C LUT, ' + fps.toFixed(1) + 'fps, ' +
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
        mapHLGToSDR: mapHLGToSDR,
        mapDisplayedSDRToBT2446C: mapDisplayedSDRToBT2446C,
        bt709ToLinear: bt709ToLinear,
        linearToSRGB: linearToSRGB,
    };
});

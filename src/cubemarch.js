"use strict";

var twgl = require("twgl.js");
var glslify = require("glslify");
var Scene = require('./scene');
var WorkerPool = require('./worker-pool');
var splitVolume = require("./split-volume");

var CubeMarch = function() {
    this.scene = new Scene(1, 1);

    this.shaderVert = '#version 300 es\n' + glslify('./shaders/shader.vert');
    this.calcPotentialsFrag = glslify('./shaders/calc-potentials.frag');

    this.startTime = new Date().getTime();
    this.numWorkers = 4;
    this.workerPool = new WorkerPool('build/workers/march.js', this.numWorkers);
};

CubeMarch.prototype.setVolume = function(dims, bounds) {
    var scene = this.scene;

    var vertexCount = (dims[0] + 1) * (dims[1] + 1) * (dims[2] + 1);
    var size = Math.ceil(Math.sqrt(vertexCount));
    scene.resize(size, size);
    var maxSize = scene.gl.drawingBufferWidth;
    maxSize = Math.min(maxSize, 4096); // Even though GPUs can go over this, things get weird
    // maxSize /= 2;
    // maxSize = 60;

    var volume = { dims: dims, bounds: bounds };
    this.volumes = splitVolume(volume, maxSize);

    var newSize = this.volumes.reduce(function(max, volume) {
        return Math.max(max, volume.size);
    }, 0);
    scene.resize(newSize, newSize);

    // Create float framebuffer for lossless SDF potential readback
    this.floatFb = scene.createFloatFramebuffer(newSize, newSize);

    this.totalCubes = dims[0] * dims[1] * dims[2];
}

CubeMarch.prototype.sizeBuckets = function(pixels, maxSize) {
    return Math.ceil(pixels / Math.max(pixels / maxSize));
};

CubeMarch.prototype.calcPotentials = function(volumeIndex, pixels, uniforms) {
    var volume = this.volumes[volumeIndex];
    var potentialsBuffer;
    var potentials;
    var blockPotentialBuffers = [];
    var blockPotentials = [];

    for (var i = 0; i < this.numWorkers; i++) {
        potentialsBuffer = new ArrayBuffer(volume.vertexCount * 4);
        potentials = new Float32Array(potentialsBuffer);
        blockPotentialBuffers.push(potentialsBuffer);
        blockPotentials.push(potentials);
    }

    var value;
    var i;
    var bl;
    var gl = this.scene.gl;

    uniforms.dims = volume.dims;
    uniforms.globalOrigin = volume.globalOrigin;
    uniforms.globalScale = volume.globalScale;
    uniforms.startVoxel = volume.startVoxel;

    // Render to float framebuffer for lossless SDF readback
    this.scene.draw({
        program: this.potentialsProg,
        uniforms: uniforms,
        output: this.floatFb
    });

    // Read back float potentials directly (no encode/decode roundtrip)
    gl.readPixels(
        0, 0,
        this.floatFb.width, this.floatFb.height,
        gl.RGBA, gl.FLOAT,
        pixels
    );

    var previousValue;
    var containsGeometry = false;

    for (i = 0; i < volume.vertexCount; i++) {
        value = pixels[i * 4]; // R channel contains the SDF potential directly
        if ( ! containsGeometry && previousValue !== undefined && (value > 0) !== (previousValue > 0)) {
            containsGeometry = true;
        }
        previousValue = value;
        for (bl = 0; bl < this.numWorkers; bl++) {
            blockPotentials[bl][i] = value;
        }
    }

    if ( ! containsGeometry) {
        return;
    }

    return blockPotentialBuffers;
}

CubeMarch.prototype.marchVolume = function(config) {
    var volume = this.volumes[config.volumeIndex];
    var initialSpecs = [];
    var marchSpecs = [];

    for (var i = 0; i < this.numWorkers; i++) {
        initialSpecs.push({
            transferable: config.blockPotentialBuffers[i]
        });
    }

    this.workerPool.each('init', initialSpecs);

    var blocks = 256;
    var start;
    var end = 0;
    var cubes = volume.dims[0] * volume.dims[1] * volume.dims[2];
    while (blocks--) {
        start = end;
        end = start + Math.floor((cubes - start) / (blocks + 1));
        marchSpecs.push({
            json: {
                start: start,
                end: end,
                dims: volume.dims,
                globalOrigin: volume.globalOrigin,
                globalScale: volume.globalScale,
                startVoxel: volume.startVoxel
            }
        });
    }

    var update = function(data, configIndex) {
        var spec = marchSpecs[configIndex].json;
        this.cubesMarched += spec.end - spec.start;
        config.onSection(data);
        config.onProgress(this.cubesMarched, this.totalCubes);
    };

    this.workerPool.each('march', marchSpecs, update.bind(this), config.onDone);
};

CubeMarch.prototype.abort = function() {
    this.aborting = true;
    this.workerPool.abort();
};

CubeMarch.prototype.march = function(config) {

    this.aborting = false;
    this.cubesMarched = 0;
    var gl = this.scene.gl;

    // Build shader with optional texture declarations
    var textureDeclarations = '';
    if (config.textureDeclarations) {
        textureDeclarations = config.textureDeclarations;
    }

    var shaderCode = this.calcPotentialsFrag
        .replace('INSERT_TEXTURE_DECLARATIONS', textureDeclarations)
        .replace('INSERT_MAP_DISTANCE', config.mapDistance);

    // Upgrade to GLSL ES 3.0 for guaranteed 32-bit integer arithmetic
    shaderCode = '#version 300 es\n' + shaderCode;
    // Replace texture2D with texture (ES 3.0 syntax)
    shaderCode = shaderCode.replace(/texture2D\(/g, 'texture(');

    this.potentialsProg = this.scene.createProgramInfo(
        this.shaderVert,
        shaderCode
    );

    var uniforms = {
        time: new Date().getTime() - this.startTime
    };

    // Add custom uniforms (including textures)
    if (config.uniforms) {
        Object.assign(uniforms, config.uniforms);
    }

    var pixelCount = this.floatFb.width * this.floatFb.height;
    var pixels = new Float32Array(pixelCount * 4);

    var blockPotentialBuffers;
    var volumeIndex = 0;

    var nextVolume = function() {
        if (this.aborting) {
            return;
        }

        if (volumeIndex >= this.volumes.length) {
            config.hasOwnProperty('onDone') && config.onDone();
            return;
        }

        blockPotentialBuffers = this.calcPotentials(volumeIndex, pixels, uniforms);
        if ( ! blockPotentialBuffers) {
            var volume = this.volumes[volumeIndex];
            var cubes = volume.dims[0] * volume.dims[1] * volume.dims[2];
            this.cubesMarched += cubes;
            config.onProgress(this.cubesMarched, this.totalCubes);
            volumeIndex += 1;
            setTimeout(nextVolume.bind(this), 100);
            return;
        }

        this.marchVolume({
            volumeIndex: volumeIndex,
            blockPotentialBuffers: blockPotentialBuffers,
            onSection: config.onSection,
            onProgress: config.onProgress,
            onDone: nextVolume.bind(this)
        });

        volumeIndex += 1;
    };

    nextVolume.bind(this)();
};

module.exports = CubeMarch;

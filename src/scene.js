"use strict";

var twgl = require("twgl.js");

var Scene = function(width, height) {
    this.canvas = document.createElement('canvas');

    // Use WebGL 2 for native float framebuffer support (eliminates
    // lossy log2/pow float encoding that caused seam plane artifacts)
    this.gl = this.canvas.getContext('webgl2');
    if (!this.gl) {
        console.warn('WebGL 2 not available, falling back to WebGL 1');
        this.gl = twgl.getWebGLContext(this.canvas);
    } else {
        var ext = this.gl.getExtension('EXT_color_buffer_float');
        if (!ext) {
            console.warn('EXT_color_buffer_float not available, float readback may fail');
        }
    }

    var arrays = {
        position: [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0],
    };
    this.bufferInfo = twgl.createBufferInfoFromArrays(this.gl, arrays);

    this.resize(width, height);
}

Scene.prototype.resize = function(width, height) {
    this.width = width;
    this.height = height;
    this.gl.canvas.width = this.width;
    this.gl.canvas.height = this.height;
    this.gl.viewport(0, 0, this.width, this.height);
}

Scene.prototype.createBuffer = function(width, height) {
    width = width || this.width;
    height = height || this.height;
    var attachments = [
        {
            format: this.gl.RGBA,
            type: this.gl.UNSIGNED_BYTE,
            min: this.gl.NEAREST,
            mag: this.gl.NEAREST,
            wrap: this.gl.REPEAT
        }
    ];
    var fbi = twgl.createFramebufferInfo(
        this.gl,
        attachments,
        width,
        height
    )
    fbi.width = width;
    fbi.height = height;
    return fbi;
};

Scene.prototype.createFloatFramebuffer = function(width, height) {
    var gl = this.gl;
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Float framebuffer not complete:', status);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return {
        framebuffer: framebuffer,
        width: width,
        height: height
    };
};

Scene.prototype.createProgramInfo = function(vs, fs) {
    return twgl.createProgramInfo(this.gl, [vs, fs]);
};

Scene.prototype.drawLastBuffer = function() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    twgl.drawBufferInfo(this.gl, this.gl.TRIANGLES, this.bufferInfo);
}

Scene.prototype.draw = function(spec) {

    this.gl.useProgram(spec.program.program);
    
    var uniforms = {};

    if (spec.uniforms) {
        Object.assign(uniforms, spec.uniforms);
    }

    if (spec.inputs) {
        var inputs = {};
        Object.keys(spec.inputs).map(function(key, index) {
            inputs[key] = spec.inputs[key].attachments[0];
        });
        Object.assign(uniforms, inputs);
    }

    var resolution = [this.width, this.height];

    if (spec.output) {
        var resolution = [spec.output.width, spec.output.height];
    }

    Object.assign(uniforms, {
        resolution: resolution,
    });

    twgl.setUniforms(spec.program, uniforms);

    if (spec.output) {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, spec.output.framebuffer);
    } else {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    twgl.setBuffersAndAttributes(this.gl, spec.program, this.bufferInfo);
    twgl.drawBufferInfo(this.gl, this.gl.TRIANGLES, this.bufferInfo);
}

module.exports = Scene;

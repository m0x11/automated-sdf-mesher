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
    this.calcPotentialsGatherFrag = glslify('./shaders/calc-potentials-gather.frag');

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
    this.volumeSpec = {
        dims: dims.slice(),
        globalOrigin: this.volumes[0].globalOrigin,
        globalScale: this.volumes[0].globalScale
    };

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

    // Sections are handed on in job order, not worker-completion order, so
    // the triangle stream is deterministic (ascending cell index within the
    // sub-volume) — identical run to run, and identical to the sparse path's.
    var sections = new Array(marchSpecs.length);
    var update = function(data, configIndex) {
        var spec = marchSpecs[configIndex].json;
        this.cubesMarched += spec.end - spec.start;
        sections[configIndex] = data;
        config.onProgress(this.cubesMarched, this.totalCubes);
    };
    var done = function() {
        sections.forEach(function(data) { config.onSection(data); });
        config.onDone();
    };

    this.workerPool.each('march', marchSpecs, update.bind(this), done);
};

CubeMarch.prototype.abort = function() {
    this.aborting = true;
    this.workerPool.abort();
};

// Assemble a potentials fragment shader from a template: splice in the
// SDF's texture declarations and mapDistance, upgrade to GLSL ES 3.0.
CubeMarch.prototype.buildFragment = function(template, config) {
    // Build shader with optional texture declarations
    var textureDeclarations = '';
    if (config.textureDeclarations) {
        textureDeclarations = config.textureDeclarations;
    }

    var shaderCode = template
        .replace('INSERT_TEXTURE_DECLARATIONS', textureDeclarations)
        .replace('INSERT_MAP_DISTANCE', config.mapDistance);

    // Upgrade to GLSL ES 3.0 for guaranteed 32-bit integer arithmetic
    shaderCode = '#version 300 es\n' + shaderCode;
    // Replace texture2D with texture (ES 3.0 syntax)
    shaderCode = shaderCode.replace(/texture2D\(/g, 'texture(');

    return shaderCode;
};

CubeMarch.prototype.march = function(config) {

    this.aborting = false;
    this.cubesMarched = 0;
    var gl = this.scene.gl;

    var uniforms = {
        time: new Date().getTime() - this.startTime
    };

    // Add custom uniforms (including textures)
    if (config.uniforms) {
        Object.assign(uniforms, config.uniforms);
    }

    if (config.sparse) {
        this.marchSparse(config, uniforms);
        return;
    }

    this.potentialsProg = this.scene.createProgramInfo(
        this.shaderVert,
        this.buildFragment(this.calcPotentialsFrag, config)
    );

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

// ---------------------------------------------------------------------------
// Sparse (narrow-band) marching
//
// The dense path evaluates mapDistance at every grid vertex, but marching
// cubes only ever reads a cell's corner potentials, and only a cell whose
// corners differ in sign (relative to `> 0`) emits triangles. So the mesh is
// fully determined by (a) the exact potentials at the corners of cells that
// straddle the surface and (b) the sign everywhere else.
//
// Sparse marching proves (b) cheaply with a Lipschitz octree. A block of
// B^3 cells whose 8 corner potentials share a sign and all satisfy
// |f| > L * (sqrt(3)/2) * B * h cannot contain a sign change, provided the
// field changes no faster than L per unit length (every vertex of the block
// lies within (sqrt(3)/2) * B * h of one of its corners). Such "far" blocks
// are filled with +-1e10 of the proven sign; every other block is refined
// down to `block` cells, whose vertices are then evaluated exactly with the
// gather shader (bit-identical to the dense shader's value for that vertex).
// Marching runs the unchanged marchCubes over just the cells of near
// blocks, so it emits exactly the dense path's triangles (in a different,
// equally arbitrary order: the dense path's order already depends on worker
// timing).
//
// `lipschitz` is a safety bound, not a property the SDF is guaranteed to
// have (stretched/scaled sub-fields and the MSDF text can exceed 1), so it
// is deliberately generous; tools/compare-sparse.js checks sparse against
// dense output.
// ---------------------------------------------------------------------------

var GATHER_WIDTH = 2048;
var FAR = 1.0e10;

function createPointsTexture(gl, width) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, width, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
}

// Evaluate mapDistance at `count` global vertices. `points` holds 4 floats
// per vertex: the global vertex index xyz (integers, exact in float32) and
// a pad. Returns a Float32Array of potentials.
CubeMarch.prototype.evaluatePoints = function(points, count, uniforms) {
    var gl = this.scene.gl;
    var W = GATHER_WIDTH;
    if (!this.gatherFb) {
        this.gatherFb = this.scene.createFloatFramebuffer(W, W);
        this.gatherPointsTex = createPointsTexture(gl, W);
        this.gatherStaging = new Float32Array(W * W * 4);
        this.gatherPixels = new Float32Array(W * W * 4);
    }
    var spec = this.volumeSpec;
    var out = new Float32Array(count);
    var perDraw = W * W;
    var pixels = this.gatherPixels;

    for (var off = 0; off < count; off += perDraw) {
        var n = Math.min(perDraw, count - off);
        var rows = Math.ceil(n / W);
        this.gatherStaging.set(points.subarray(off * 4, (off + n) * 4));
        gl.bindTexture(gl.TEXTURE_2D, this.gatherPointsTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, rows, gl.RGBA, gl.FLOAT, this.gatherStaging, 0);

        gl.viewport(0, 0, W, rows);
        this.scene.draw({
            program: this.gatherProg,
            uniforms: Object.assign({}, uniforms, {
                uPoints: this.gatherPointsTex,
                uPointCount: n,
                dims: [0, 0, 0],
                globalOrigin: spec.globalOrigin,
                globalScale: spec.globalScale,
                startVoxel: [0, 0, 0]
            }),
            output: { framebuffer: this.gatherFb.framebuffer, width: W, height: rows }
        });
        gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, pixels);
        for (var i = 0; i < n; i++) {
            out[off + i] = pixels[i * 4];
        }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.scene.width, this.scene.height);
    return out;
};

// Classify every finest block as far-positive (+1), far-negative (-1) or
// near (0) by refining a Lipschitz octree from `coarseBlock` down to
// `block` cells. Returns { sign, nb, block, evaluated }.
CubeMarch.prototype.classifyBlocks = function(opts, evaluate) {
    var N = this.volumeSpec.dims;
    var scale = this.volumeSpec.globalScale;
    var h = Math.max(scale[0], scale[1], scale[2]);
    var F = opts.block;
    var nbf = [Math.ceil(N[0] / F), Math.ceil(N[1] / F), Math.ceil(N[2] / F)];
    var sign = new Int8Array(nbf[0] * nbf[1] * nbf[2]);   // 0 = near
    var evaluated = 0;

    var B = opts.coarseBlock;
    var nb = [Math.ceil(N[0] / B), Math.ceil(N[1] / B), Math.ceil(N[2] / B)];
    // Candidate blocks at the current level, as flat (bx, by, bz) triplets.
    var count = nb[0] * nb[1] * nb[2];
    var cand = new Int32Array(count * 3);
    var c = 0;
    for (var bz = 0; bz < nb[2]; bz++)
        for (var by = 0; by < nb[1]; by++)
            for (var bx = 0; bx < nb[0]; bx++) {
                cand[c++] = bx; cand[c++] = by; cand[c++] = bz;
            }

    while (true) {
        var ln = [nb[0] + 1, nb[1] + 1, nb[2] + 1];       // corner lattice dims
        var lattice = new Float32Array(ln[0] * ln[1] * ln[2]);
        var mark = new Uint8Array(lattice.length);
        var nCand = cand.length / 3;
        var needed = 0;
        var i, k, ox, oy, oz, li;

        for (i = 0; i < nCand; i++) {
            for (k = 0; k < 8; k++) {
                ox = cand[i * 3] + (k & 1);
                oy = cand[i * 3 + 1] + ((k >> 1) & 1);
                oz = cand[i * 3 + 2] + ((k >> 2) & 1);
                li = ox + ln[0] * (oy + ln[1] * oz);
                if (!mark[li]) { mark[li] = 1; needed++; }
            }
        }

        var points = new Float32Array(needed * 4);
        var where = new Int32Array(needed);
        var p = 0;
        for (oz = 0; oz < ln[2]; oz++)
            for (oy = 0; oy < ln[1]; oy++)
                for (ox = 0; ox < ln[0]; ox++) {
                    li = ox + ln[0] * (oy + ln[1] * oz);
                    if (!mark[li]) continue;
                    points[p * 4] = Math.min(ox * B, N[0]);
                    points[p * 4 + 1] = Math.min(oy * B, N[1]);
                    points[p * 4 + 2] = Math.min(oz * B, N[2]);
                    where[p++] = li;
                }
        var values = evaluate(points, needed);
        evaluated += needed;
        for (p = 0; p < needed; p++) lattice[where[p]] = values[p];

        var threshold = opts.lipschitz * 0.5 * Math.sqrt(3) * B * h;
        var ratio = B / F;
        var near = [];
        for (i = 0; i < nCand; i++) {
            bx = cand[i * 3]; by = cand[i * 3 + 1]; bz = cand[i * 3 + 2];
            var pos = 0, neg = 0, minAbs = Infinity;
            for (k = 0; k < 8; k++) {
                li = (bx + (k & 1)) + ln[0] * ((by + ((k >> 1) & 1)) + ln[1] * (bz + ((k >> 2) & 1)));
                var v = lattice[li];
                if (v > 0) pos++; else neg++;
                var a = Math.abs(v);
                if (a < minAbs) minAbs = a;
            }
            if ((pos === 8 || neg === 8) && minAbs > threshold) {
                var s = pos === 8 ? 1 : -1;
                var x1 = Math.min((bx + 1) * ratio, nbf[0]);
                var y1 = Math.min((by + 1) * ratio, nbf[1]);
                var z1 = Math.min((bz + 1) * ratio, nbf[2]);
                for (var fz = bz * ratio; fz < z1; fz++)
                    for (var fy = by * ratio; fy < y1; fy++) {
                        var row = nbf[0] * (fy + nbf[1] * fz);
                        sign.fill(s, row + bx * ratio, row + x1);
                    }
            } else {
                near.push(bx, by, bz);
            }
        }

        if (B === F) break;

        // Refine near blocks into their (up to) 8 children.
        var half = B / 2;
        var cnb = [Math.ceil(N[0] / half), Math.ceil(N[1] / half), Math.ceil(N[2] / half)];
        var next = [];
        for (i = 0; i < near.length; i += 3) {
            for (k = 0; k < 8; k++) {
                ox = near[i] * 2 + (k & 1);
                oy = near[i + 1] * 2 + ((k >> 1) & 1);
                oz = near[i + 2] * 2 + ((k >> 2) & 1);
                if (ox < cnb[0] && oy < cnb[1] && oz < cnb[2]) next.push(ox, oy, oz);
            }
        }
        cand = Int32Array.from(next);
        B = half;
        nb = cnb;
    }

    return { sign: sign, nb: nbf, block: F, evaluated: evaluated };
};

// Potentials + near-cell runs for one sub-volume, from the block signs.
// Returns null when the sub-volume holds no near block.
CubeMarch.prototype.sparseVolume = function(volume, blocks, evaluate) {
    var N = this.volumeSpec.dims;
    var F = blocks.block, nb = blocks.nb, sign = blocks.sign;
    var s = volume.startVoxel, d = volume.dims, vd = volume.vertexDims;
    var potentials = new Float32Array(volume.vertexCount);
    var x, y, z, gx, gy, gz, bx, by, bz, b;

    var bx0 = Math.floor(s[0] / F), bx1 = Math.min(nb[0] - 1, Math.floor((s[0] + d[0]) / F));
    var by0 = Math.floor(s[1] / F), by1 = Math.min(nb[1] - 1, Math.floor((s[1] + d[1]) / F));
    var bz0 = Math.floor(s[2] / F), bz1 = Math.min(nb[2] - 1, Math.floor((s[2] + d[2]) / F));

    // Near blocks overlapping this sub-volume.
    var nearBlocks = [];
    for (bz = bz0; bz <= bz1; bz++)
        for (by = by0; by <= by1; by++)
            for (bx = bx0; bx <= bx1; bx++)
                if (sign[bx + nb[0] * (by + nb[1] * bz)] === 0) nearBlocks.push(bx, by, bz);
    if (nearBlocks.length === 0) return null;

    // Sign fill: each vertex takes the sign of the block that owns it
    // (owner = floor(g / F), clamped). Near-owned vertices are overwritten
    // below; a vertex on a face shared with a near block is too.
    for (z = 0; z < vd[2]; z++) {
        gz = s[2] + z;
        bz = Math.min(Math.floor(gz / F), nb[2] - 1);
        for (y = 0; y < vd[1]; y++) {
            gy = s[1] + y;
            by = Math.min(Math.floor(gy / F), nb[1] - 1);
            var rowBase = vd[0] * (y + vd[1] * z);
            var signRow = nb[0] * (by + nb[1] * bz);
            for (bx = bx0; bx <= bx1; bx++) {
                b = sign[signRow + bx];
                if (b === 0) continue;
                var xa = Math.max(bx * F, s[0]) - s[0];
                var xb = (bx === nb[0] - 1 ? N[0] + 1 : Math.min((bx + 1) * F, s[0] + d[0] + 1)) - s[0];
                xb = Math.min(xb, vd[0]);
                potentials.fill(b > 0 ? FAR : -FAR, rowBase + xa, rowBase + xb);
            }
        }
    }

    // Exact potentials for every vertex of every near block (inclusive
    // vertex box, so shared faces are covered from both sides).
    var mark = new Uint8Array(volume.vertexCount);
    var upper = 0, i;
    for (i = 0; i < nearBlocks.length; i += 3) upper += (F + 1) * (F + 1) * (F + 1);
    var points = new Float32Array(upper * 4);
    var local = new Int32Array(upper);
    var n = 0;
    for (i = 0; i < nearBlocks.length; i += 3) {
        bx = nearBlocks[i]; by = nearBlocks[i + 1]; bz = nearBlocks[i + 2];
        var x0 = Math.max(bx * F, s[0]), x1 = Math.min(Math.min((bx + 1) * F, N[0]), s[0] + d[0]);
        var y0 = Math.max(by * F, s[1]), y1 = Math.min(Math.min((by + 1) * F, N[1]), s[1] + d[1]);
        var z0 = Math.max(bz * F, s[2]), z1 = Math.min(Math.min((bz + 1) * F, N[2]), s[2] + d[2]);
        for (gz = z0; gz <= z1; gz++)
            for (gy = y0; gy <= y1; gy++)
                for (gx = x0; gx <= x1; gx++) {
                    var li = (gx - s[0]) + vd[0] * ((gy - s[1]) + vd[1] * (gz - s[2]));
                    if (mark[li]) continue;
                    mark[li] = 1;
                    points[n * 4] = gx;
                    points[n * 4 + 1] = gy;
                    points[n * 4 + 2] = gz;
                    local[n++] = li;
                }
    }
    var values = evaluate(points, n);
    for (i = 0; i < n; i++) potentials[local[i]] = values[i];

    // Cell runs (local linear cell indices, [start, end)) inside near blocks.
    var runs = [];
    var cells = 0;
    for (z = 0; z < d[2]; z++) {
        bz = Math.floor((s[2] + z) / F);
        for (y = 0; y < d[1]; y++) {
            by = Math.floor((s[1] + y) / F);
            var cellRow = d[0] * (y + d[1] * z);
            var signRow2 = nb[0] * (by + nb[1] * bz);
            for (bx = bx0; bx <= bx1; bx++) {
                if (sign[signRow2 + bx] !== 0) continue;
                var ca = Math.max(bx * F, s[0]) - s[0];
                var cb = Math.min((bx + 1) * F, s[0] + d[0]) - s[0];
                if (cb <= ca) continue;
                var start = cellRow + ca, end = cellRow + cb;
                if (runs.length && runs[runs.length - 1] === start) {
                    runs[runs.length - 1] = end;
                } else {
                    runs.push(start, end);
                }
                cells += cb - ca;
            }
        }
    }

    return { potentials: potentials, runs: runs, cells: cells, evaluated: n };
};

CubeMarch.prototype.marchSparse = function(config, uniforms) {
    var self = this;
    var opts = Object.assign(
        { block: 4, coarseBlock: 64, lipschitz: 4 },
        config.sparse === true ? {} : config.sparse
    );
    var t0 = Date.now();

    this.gatherProg = this.scene.createProgramInfo(
        this.shaderVert,
        this.buildFragment(this.calcPotentialsGatherFrag, config)
    );
    var evaluate = function(points, count) {
        return count ? self.evaluatePoints(points, count, uniforms) : new Float32Array(0);
    };

    var blocks = this.classifyBlocks(opts, evaluate);
    var evaluated = blocks.evaluated;
    var nearCount = 0;
    for (var i = 0; i < blocks.sign.length; i++) if (blocks.sign[i] === 0) nearCount++;
    console.log('[sparse] lipschitz=' + opts.lipschitz + ' block=' + opts.block +
        ' coarse=' + opts.coarseBlock + ': ' + nearCount + '/' + blocks.sign.length +
        ' near blocks, ' + evaluated + ' octree evals, ' + (Date.now() - t0) + 'ms');

    var volumeIndex = 0;
    var nextVolume = function() {
        if (self.aborting) return;
        if (volumeIndex >= self.volumes.length) {
            var dense = (self.volumeSpec.dims[0] + 1) * (self.volumeSpec.dims[1] + 1) * (self.volumeSpec.dims[2] + 1);
            console.log('[sparse] done: ' + evaluated + ' evals (' +
                (100 * evaluated / dense).toFixed(2) + '% of dense ' + dense + '), ' +
                (Date.now() - t0) + 'ms');
            config.hasOwnProperty('onDone') && config.onDone();
            return;
        }
        var volume = self.volumes[volumeIndex];
        volumeIndex += 1;
        var cubes = volume.dims[0] * volume.dims[1] * volume.dims[2];
        var sv = self.sparseVolume(volume, blocks, evaluate);
        if (!sv || sv.cells === 0) {
            self.cubesMarched += cubes;
            config.onProgress(self.cubesMarched, self.totalCubes);
            setTimeout(nextVolume, 0);
            return;
        }
        evaluated += sv.evaluated;
        // Cells outside near blocks are skipped, never marched: count them
        // as done up front so progress still ends at 100%.
        self.cubesMarched += cubes - sv.cells;
        self.marchRunsVolume(volume, sv, config, nextVolume);
    };
    nextVolume();
};

// Like marchVolume, but marches only the given cell runs.
CubeMarch.prototype.marchRunsVolume = function(volume, sv, config, onDone) {
    var initialSpecs = [];
    for (var i = 0; i < this.numWorkers; i++) {
        var buffer = new ArrayBuffer(sv.potentials.byteLength);
        new Float32Array(buffer).set(sv.potentials);
        initialSpecs.push({ transferable: buffer });
    }
    this.workerPool.each('init', initialSpecs);

    // Split the runs into ~256 jobs of similar cell count.
    var target = Math.max(1, Math.ceil(sv.cells / 256));
    var marchSpecs = [];
    var runs = sv.runs;
    var current = [], currentCells = 0;
    for (var r = 0; r < runs.length; r += 2) {
        current.push(runs[r], runs[r + 1]);
        currentCells += runs[r + 1] - runs[r];
        if (currentCells >= target || r + 2 >= runs.length) {
            marchSpecs.push({
                json: {
                    runs: current,
                    cells: currentCells,
                    dims: volume.dims,
                    globalOrigin: volume.globalOrigin,
                    globalScale: volume.globalScale,
                    startVoxel: volume.startVoxel
                }
            });
            current = [];
            currentCells = 0;
        }
    }

    // Job order, as in marchVolume: runs ascend by cell index, so the stream
    // equals the dense path's for the same sub-volume (empty cells emit
    // nothing in either).
    var sections = new Array(marchSpecs.length);
    var update = function(data, configIndex) {
        this.cubesMarched += marchSpecs[configIndex].json.cells;
        sections[configIndex] = data;
        config.onProgress(this.cubesMarched, this.totalCubes);
    };
    var done = function() {
        sections.forEach(function(data) { config.onSection(data); });
        onDone();
    };

    this.workerPool.each('marchRuns', marchSpecs, update.bind(this), done);
};

module.exports = CubeMarch;

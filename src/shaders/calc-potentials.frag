precision highp float;
precision highp int;

#pragma glslify: coordToIndex = require(./components/coord-to-index)

uniform vec2 resolution;

uniform vec3 dims;
uniform float time;
uniform vec3 globalOrigin;
uniform vec3 globalScale;
uniform vec3 startVoxel;

// Custom texture uniforms (inserted at runtime)
INSERT_TEXTURE_DECLARATIONS

out vec4 fragColor;

INSERT_MAP_DISTANCE

vec3 vertFromIndex(int index) {
    int vx = int(dims.x) + 1;
    int vy = int(dims.y) + 1;
    int vxy = vx * vy;
    int iz = index / vxy;
    int irem = index - iz * vxy;
    int iy = irem / vx;
    int ix = irem - iy * vx;
    return globalOrigin + (startVoxel + vec3(float(ix), float(iy), float(iz))) * globalScale;
}

void main() {

    int vertIndex = coordToIndex(gl_FragCoord.xy, resolution.xy);
    vec3 vertDims = dims + vec3(1);

    if (float(vertIndex) >= vertDims.x * vertDims.y * vertDims.z) {
        fragColor = vec4(1.0e10, 0.0, 0.0, 1.0);
        return;
    }

    vec3 vert = vertFromIndex(vertIndex);
    float potential = mapDistance(vert);
    // Guard against NaN/Inf: NaN != NaN in IEEE 754
    if (potential != potential || potential > 1.0e10 || potential < -1.0e10) {
        potential = 1.0e10;
    }
    fragColor = vec4(potential, 0.0, 0.0, 1.0);
}

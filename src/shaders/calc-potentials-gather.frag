precision highp float;
precision highp int;

#pragma glslify: coordToIndex = require(./components/coord-to-index)

// Sparse twin of calc-potentials.frag: instead of deriving the vertex from
// the fragment's position in a dense sub-volume, each fragment reads one
// global vertex index (integers stored exactly as floats, xyz) from
// uPoints and evaluates mapDistance there. The vertex position expression
// is character-for-character the dense shader's, with startVoxel = 0 and
// the global index in place of the local one, so every potential is
// bit-identical to the dense evaluation of the same vertex.

uniform vec2 resolution;

uniform vec3 dims;
uniform float time;
uniform vec3 globalOrigin;
uniform vec3 globalScale;
uniform vec3 startVoxel;

uniform sampler2D uPoints;
uniform float uPointCount;

// Custom texture uniforms (inserted at runtime)
INSERT_TEXTURE_DECLARATIONS

out vec4 fragColor;

INSERT_MAP_DISTANCE

vec3 vertFromPoint(vec3 g) {
    return globalOrigin + (startVoxel + vec3(g.x, g.y, g.z)) * globalScale;
}

void main() {

    int pointIndex = coordToIndex(gl_FragCoord.xy, resolution.xy);

    if (float(pointIndex) >= uPointCount) {
        fragColor = vec4(1.0e10, 0.0, 0.0, 1.0);
        return;
    }

    vec3 g = texelFetch(uPoints, ivec2(gl_FragCoord.xy), 0).xyz;
    vec3 vert = vertFromPoint(g);
    float potential = mapDistance(vert);
    // Guard against NaN/Inf: NaN != NaN in IEEE 754
    if (potential != potential || potential > 1.0e10 || potential < -1.0e10) {
        potential = 1.0e10;
    }
    fragColor = vec4(potential, 0.0, 0.0, 1.0);
}


var maxDimension = function(dims) {
    if (dims[0] > dims[1]) {
        if (dims[0] > dims[2]) {
            return 0;
        }
    } else if (dims[1] > dims[2]) {
        return 1;
    }
    return 2;
};

var splitVolume = function(volume, maxSize) {
    var maxVerts = Math.pow(maxSize, 2);
    var totalDims = volume.dims;
    var origin = volume.bounds[0];
    var scale = [];
    for (var i = 0; i < 3; i++) {
        scale[i] = (volume.bounds[1][i] - volume.bounds[0][i]) / totalDims[i];
    }

    // Recursively split using integer voxel index ranges.
    // Bounds are only computed at leaf level from origin + index * scale,
    // avoiding floating point drift through recursive subdivision.
    function splitRange(start, end) {
        var dims = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
        var vertexCount = (dims[0] + 1) * (dims[1] + 1) * (dims[2] + 1);

        if (vertexCount < maxVerts) {
            var vertexDims = [dims[0] + 1, dims[1] + 1, dims[2] + 1];
            return [{
                dims: dims,
                globalOrigin: origin,
                globalScale: scale,
                startVoxel: start.slice(),
                vertexDims: vertexDims,
                vertexCount: vertexCount,
                size: Math.ceil(Math.sqrt(vertexCount))
            }];
        }

        var axis = maxDimension(dims);
        var splitAt = start[axis] + Math.ceil(dims[axis] / 2);

        var mid1 = end.slice();
        mid1[axis] = splitAt;

        var mid2 = start.slice();
        mid2[axis] = splitAt;

        return splitRange(start, mid1).concat(splitRange(mid2, end));
    }

    return splitRange([0, 0, 0], totalDims.slice());
}

module.exports = splitVolume;

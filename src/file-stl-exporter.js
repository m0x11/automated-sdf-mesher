// Modified STL Exporter that saves to filesystem instead of browser download

var FileSTLWriter = require("./file-stl-writer");

var FileSTLExporter = function(outputDir) {
    this.writer = new FileSTLWriter(outputDir);
}

FileSTLExporter.prototype = {

    maxVerts: 6000000,

    startModel: function(filename) {
        this.part = -1;
        this.filename = filename;
        this.nextPart();
        this.savedFiles = [];
    },

    nextPart: function() {
        this.part += 1;
        this.vertIndex = -1;
        this.numVerts = 0;
        this.numFaces = 0;
        this.faces = new Float32Array(this.maxVerts);
    },

    addSection: function(vertices, faces) {
        var f, v1, v2, v3;
        for (var i = 0; i < faces.length; ++i) {
            f = faces[i];
            v1 = vertices[ f[0] ];
            v2 = vertices[ f[1] ];
            v3 = vertices[ f[2] ];
            this.addFace(v1, v2, v3);
        }
    },

    addFace: function(v1, v2, v3) {
        if (this.numVerts + 9 > this.maxVerts) {
            this.save();
            this.nextPart();
        }

        this.faces[++this.vertIndex] = v1[0];
        this.faces[++this.vertIndex] = v1[1];
        this.faces[++this.vertIndex] = v1[2];
        this.faces[++this.vertIndex] = v2[0];
        this.faces[++this.vertIndex] = v2[1];
        this.faces[++this.vertIndex] = v2[2];
        this.faces[++this.vertIndex] = v3[0];
        this.faces[++this.vertIndex] = v3[1];
        this.faces[++this.vertIndex] = v3[2];

        this.numVerts += 9;
        this.numFaces += 1;
    },

    finishModel: function() {
        this.save();
        delete this.faces;
        return this.savedFiles;
    },

    save: function() {
        var filename = [this.filename, 'part', this.part].join('-') + '.stl';
        var filePath = this.writer.save(this.faces, this.numFaces, filename);
        this.savedFiles.push(filePath);
    }
};

module.exports = FileSTLExporter;
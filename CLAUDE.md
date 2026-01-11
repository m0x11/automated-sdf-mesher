# SDF Mesher - Project Context

## Overview
A WebGL-based marching cubes implementation that converts Signed Distance Functions (SDFs) into STL meshes. Runs in browser with a web UI or via Puppeteer automation.

## Architecture

```
sdf-mesher/
├── index.html           # Entry point
├── auto-mesh.js         # Puppeteer automation script
├── simple-auto.js       # Simpler automation (no texture support)
├── build/               # Browserify bundle output
│   └── index.js
├── src/
│   ├── index.js         # Main app, UI setup, exposes globals
│   ├── cubemarch.js     # Core marching cubes algorithm
│   ├── scene.js         # WebGL context and drawing
│   ├── renderer.js      # Three.js preview renderer
│   ├── stl-exporter.js  # STL file generation
│   ├── stl-writer.js    # Binary STL writing
│   ├── worker-pool.js   # Web worker management
│   ├── split-volume.js  # Volume chunking for large meshes
│   ├── shaders/
│   │   ├── shader.vert
│   │   ├── calc-potentials.frag  # SDF evaluation shader
│   │   └── examples/             # Example SDFs
│   ├── controls/                 # UI components
│   └── workers/
│       └── march.js              # Marching cubes worker
└── package.json
```

## How It Works

1. **SDF Evaluation**: GPU shader evaluates `mapDistance(vec3 p)` at grid vertices
2. **Potential Reading**: Results read back from framebuffer as encoded floats
3. **Marching Cubes**: Web workers process grid cells in parallel
4. **STL Export**: Triangles collected and written to binary STL

## Running

### Web UI
```bash
python3 -m http.server 8000
# Open http://localhost:8000
```

### Automation
```bash
# With texture support (for MSDF text)
node auto-mesh.js <sdf-folder-name>

# Simple (no textures)
node simple-auto.js <sdf-folder-name>
```

## Global Objects (for automation)
The app exposes these on `window` for Puppeteer access:
- `window.cubeMarch` - CubeMarch instance
- `window.exporter` - STLExporter instance
- `window.editor` - GLSL editor instance
- `window.ractive` - UI state manager
- `window.twgl` - WebGL helper library

## Key APIs

### CubeMarch
```javascript
// Set volume dimensions and bounds
cubeMarch.setVolume(
  [resX, resY, resZ],           // Grid resolution
  [[-1,-1,-1], [1,1,1]]         // World bounds
);

// Run marching cubes
cubeMarch.march({
  mapDistance: glslCode,         // SDF shader code
  textureDeclarations: '',       // Optional uniform declarations
  uniforms: { uMyTexture: tex }, // Optional texture uniforms
  onSection: (data) => {},       // Called with vertices/faces
  onProgress: (done, total) => {},
  onDone: () => {}
});
```

### STLExporter
```javascript
exporter.startModel('filename');
exporter.addSection(vertices, faces);
exporter.finishModel();  // Triggers download
```

### Ractive (UI State)
```javascript
ractive.set('bounding.size.width', 2);
ractive.set('download.resolution.x', 500);
ractive.set('progress', 'Generating...');
```

## Shader Integration

The `calc-potentials.frag` shader has placeholders:
```glsl
// Custom texture uniforms (inserted at runtime)
INSERT_TEXTURE_DECLARATIONS

// ... shader code ...

INSERT_MAP_DISTANCE  // Your mapDistance function goes here
```

Your SDF code must define:
```glsl
float mapDistance(vec3 p) {
  // Return signed distance to surface
  return length(p) - 1.0;  // Example: unit sphere
}
```

## Texture Support

For SDFs with textures (e.g., MSDF text):

1. SDF folder needs `texture-declarations.txt`:
   ```glsl
   uniform sampler2D uMsdfTexture;
   ```

2. `auto-mesh.js` loads texture and passes to march():
   ```javascript
   cubeMarch.march({
     mapDistance: sdfCode,
     textureDeclarations: 'uniform sampler2D uMsdfTexture;',
     uniforms: { uMsdfTexture: webglTexture }
   });
   ```

## Volume Splitting

Large volumes are automatically split to fit GPU limits:
- Max texture size typically 4096x4096
- `split-volume.js` chunks the grid
- Each chunk processed sequentially
- Results combined into single STL

## Output

- STL files download directly to browser
- Large meshes split into `*-part-N.stl` files
- Binary STL format

## Building

```bash
npm install
npm run build  # Browserify bundles to build/
```

## Common Issues

### Shader Compilation Errors
- Check browser console for GLSL errors
- Ensure `mapDistance` function exists
- No duplicate uniform declarations

### Memory Issues
- Reduce resolution
- Volume auto-splits but very large grids may fail

### Mesh Has Holes
- SDF may have discontinuities
- Try higher resolution
- Check SDF math at boundaries

## Dependencies
- twgl.js - WebGL helpers
- glslify - GLSL module bundling
- Ractive - UI framework
- glsl-editor - Code editor
- puppeteer - Browser automation (for auto-mesh.js)

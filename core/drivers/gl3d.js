'use strict';

// ---------------------------------------------------------------------------
// GL3DDriver  (drivers/gl3d.js)
//
// Extracted from kernel.js as part of the V7 architecture refactor (Step 1).
// Wraps all GL 3D rendering state and commands.
//
// The driver receives a reference to its host interpreter on construction.
// All calls to evalCalc, trim, appendLine, fs, etc. go through host.
// This maintains 100% behavioural compatibility while cleanly separating
// the Three.js rendering subsystem from the BASIC runtime.
//
// Boot order: kernel.js constructor calls new GL3DDriver(this)
//             and stores it as this._glDrv.
// ---------------------------------------------------------------------------

class GL3DDriver {

    constructor(host) {
        // host = the Interpreter instance that owns this driver
        this._host = host;

        // All GL state is now owned here instead of on the interpreter.
        // kernel.js holds this._gl as a forwarding alias: get _gl() { return this._glDrv._gl; }
        this._gl       = null;
        this._glCanvas = null;
        // Image store is shared with the interpreter (LOADIMG populates it)
        // We read host._images directly — no copy needed.
    }

    // ── Forwarding helpers — keep method bodies identical to original ───────
    get _images()    { return this._host._images; }
    get o()          { return this._host.o; }
    get canvas()     { return this._host.canvas; }
    get width()      { return this._host.width; }
    get height()     { return this._host.height; }
    evalCalc(a,b,c)  { return this._host.evalCalc(a,b,c); }
    trim(s)          { return this._host.trim(s); }
    appendLine(t,n)  { return this._host.appendLine(t,n); }
    get fs()         { return this._host.fs; }
    // Additional host state/methods accessed by GL commands
    get _gfx()              { return this._host._gfx; }
    get _spr()              { return this._host._spr; }
    get _graphicsActive()   { return this._host._graphicsActive; }
    set _graphicsActive(v)  { this._host._graphicsActive = v; }
    _activateGraphics()     { return this._host._activateGraphics(); }
    _gfxFlush()             { return this._host._gfxFlush(); }
    lookup_(n,t)            { return this._host.lookup_(n,t); }

// =======================================================================
// GL — Software 3D Rendering System
//
// A minimal perspective 3D pipeline on top of the existing canvas.
// Supports wireframe and solid (painter's algorithm) rendering.
//
// Commands:
//   GL.INIT                    — initialise / reset 3D state
//   GL.CLS [r,g,b]             — clear canvas (default black)
//   GL.PERSPECTIVE fov         — set field of view in degrees (default 60)
//   GL.CAMERA x,y,z            — position the camera
//   GL.LOOKAT x,y,z            — where the camera points
//   GL.COLOUR r,g,b            — set current draw colour (0-255 each)
//   GL.WIRE                    — wireframe mode
//   GL.SOLID                   — solid fill mode
//   GL.BEGIN                   — start a mesh definition
//   GL.VERTEX x,y,z            — add vertex to current mesh
//   GL.FACE i,j,k [,l]         — add tri/quad face (1-based vertex indices)
//   GL.END                     — finalise mesh, returns id via GL.MESHID
//   GL.TRANSLATE id,x,y,z      — set mesh translation
//   GL.ROTATE id,rx,ry,rz      — set mesh rotation (degrees)
//   GL.SCALE id,sx,sy,sz       — set mesh scale
//   GL.DRAW id                 — render one mesh
//   GL.DRAWALL                 — render all meshes
//   GL.MESHID                  — numeric function: id of last GL.END mesh
// =======================================================================

// ---- GL state init ----
// =========================================================================
// GL SYSTEM — Three.js r128 backend
// All BASIC-facing commands (GL.INIT, GL.VERTEX, GL.FACE etc.) are unchanged.
// The software renderer is replaced with WebGL via Three.js.
//
// Architecture:
//   _gl          — BASIC-level state (fov, cam, colour, meshes dict etc.)
//   _gl.three    — Three.js objects (scene, camera, renderer, lights)
//   _glCanvas    — dedicated WebGL <canvas> overlaid on the terminal
//
// The WebGL canvas sits absolutely over the 2D canvas. GL.INIT creates it.
// GL.CLS clears it. Program end hides it.
// =========================================================================

    _glInit() {
        // Tear down any existing Three.js renderer cleanly
        if (this._gl && this._gl.three) {
            const t = this._gl.three;
            if (t.renderer) { t.renderer.dispose(); t.renderer.forceContextLoss(); }
            if (this._glCanvas && this._glCanvas.parentNode) {
                this._glCanvas.parentNode.removeChild(this._glCanvas);
            }
            this._glCanvas = null;
        }

        this._gl = {
            fov:        60,
            cam:        [0, 0, -5],
            lookat:     [0, 0,  0],
            up:         [0, 1,  0],
            colour:     [255, 255, 255],
            mode:       'wire',
            light:      null,
            ambient:    0.25,
            meshes:     {},
            nextId:     1,
            building:   null,
            lastId:     0,
            three:      null,
            clearR:     0, clearG: 0, clearB: 0,
            // New extended state
            shine:      30,       // specular shininess 0-200
            alpha:      1.0,      // mesh opacity 0-1
            wireColor:  null,     // edge colour for SOLIDWIRE (null = auto)
            fog:        null,     // {r,g,b,near,far} or null
            emissive:   [0,0,0],  // emissive colour
        };
    }

    _glState() { if (!this._gl) this._glInit(); return this._gl; }

    // Create (or reuse) the WebGL canvas and Three.js renderer
    _glSetupThree() {
        const g = this._glState();
        if (g.three) return g.three;

        // Create dedicated WebGL canvas overlaid on the terminal wrapper
        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper) return null;

        const wc = document.createElement('canvas');
        wc.id = 'glkanvas';
        wc.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;';
        wrapper.appendChild(wc);
        this._glCanvas = wc;
        // Raise 2D gfx canvas above GL so PSET/FILLRECT minimap draws on top
        // GFX canvas stays at z-index 2 (always above GL at 1)

        const W = wrapper.clientWidth  || wrapper.offsetWidth  || 800;
        const H = wrapper.clientHeight || wrapper.offsetHeight || 600;

        // Three.js renderer
        const renderer = new THREE.WebGLRenderer({ canvas: wc, antialias: true, alpha: true });
        renderer.setSize(W, H);
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
        renderer.sortObjects = true;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

        // Scene
        const scene = new THREE.Scene();

        // Camera
        const camera = new THREE.PerspectiveCamera(g.fov, W / H, 0.1, 1000);
        const [cx,cy,cz] = g.cam;
        const [lx,ly,lz] = g.lookat;
        camera.position.set(cx, cy, cz);
        camera.lookAt(lx, ly, lz);

        // Ambient light
        const ambientLight = new THREE.AmbientLight(0xffffff, g.ambient);
        scene.add(ambientLight);

        // Directional light (off by default until GL.LIGHT is called)
        const dirLight = new THREE.DirectionalLight(0xffffff, 0);
        dirLight.position.set(1, 1, -1);
        dirLight.castShadow = false;
        scene.add(dirLight);

        g.three = { renderer, scene, camera, ambientLight, dirLight };
        return g.three;
    }

// Sync WebGL canvas size to wrapper (called each frame)
    _glSyncCanvas() {
        const g = this._gl;
        if (!g || !g.three) return;
        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper) return;
        const W = wrapper.clientWidth, H = wrapper.clientHeight;
        if (W > 0 && H > 0) {
            const t = g.three;
            const size = t.renderer.getSize(new THREE.Vector2());
            if (size.x !== W || size.y !== H) {
                t.renderer.setSize(W, H);
                t.camera.aspect = W / H;
                t.camera.updateProjectionMatrix();
                if (this._glCanvas) {
                    this._glCanvas.style.width  = W + 'px';
                    this._glCanvas.style.height = H + 'px';
                }
            }
        }
    }

// Build a THREE.Mesh from a BASIC mesh definition
    _glBuildThreeMesh(mesh, mode, g) {
        if (!g) g = this._glState();
        // Convert BASIC vertex+face definition to BufferGeometry.
        // When a heightMap is set, subdivide each quad face into an NxN grid
        // so displacement has enough vertices to look correct.
        const positions = [], uvs = [];
        const subDiv = 1;
        for (const face of mesh.faces) {
            const vIdx = face.map(i => i - 1);
            // Simple planar UV mapping for each face
            const faceUVs = [[0,0],[1,0],[1,1],[0,1]];
            if (vIdx.length === 3) {
                for (let fi=0; fi<3; fi++) {
                    const v = mesh.verts[vIdx[fi]] || [0,0,0];
                    positions.push(v[0], v[1], v[2]);
                    uvs.push(faceUVs[fi][0], faceUVs[fi][1]);
                }
            } else if (vIdx.length === 4) {
                // Get the 4 corner verts
                const v0=mesh.verts[vIdx[0]]||[0,0,0], v1=mesh.verts[vIdx[1]]||[0,0,0];
                const v2=mesh.verts[vIdx[2]]||[0,0,0], v3=mesh.verts[vIdx[3]]||[0,0,0];
                const n = subDiv;
                for (let row=0; row<n; row++) {
                    for (let col=0; col<n; col++) {
                        // Bilinear interpolation across the quad
                        const lerp = (a,b,t) => a + (b-a)*t;
                        const blerp = (a,b,c,d,s,t) => [
                            lerp(lerp(a[0],b[0],s), lerp(d[0],c[0],s), t),
                            lerp(lerp(a[1],b[1],s), lerp(d[1],c[1],s), t),
                            lerp(lerp(a[2],b[2],s), lerp(d[2],c[2],s), t)
                        ];
                        const s0=col/n, s1=(col+1)/n, t0=row/n, t1=(row+1)/n;
                        const p00=blerp(v0,v1,v2,v3,s0,t0);
                        const p10=blerp(v0,v1,v2,v3,s1,t0);
                        const p11=blerp(v0,v1,v2,v3,s1,t1);
                        const p01=blerp(v0,v1,v2,v3,s0,t1);
                        const u00=[s0,t0], u10=[s1,t0], u11=[s1,t1], u01=[s0,t1];
                        // Two triangles per sub-quad
                        for (const [p,u] of [[p00,u00],[p10,u10],[p11,u11]]) { positions.push(...p); uvs.push(...u); }
                        for (const [p,u] of [[p00,u00],[p11,u11],[p01,u01]]) { positions.push(...p); uvs.push(...u); }
                    }
                }
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
        geo.computeVertexNormals();

        const [r, gv, b] = (mesh.colour || [255,255,255]);
        const color    = new THREE.Color(r/255, gv/255, b/255);
        const opacity  = mesh.alpha  !== undefined ? mesh.alpha  : 1.0;
        const shine    = mesh.shine  !== undefined ? mesh.shine  : 30;
        const emissive = mesh.emissive ? new THREE.Color(mesh.emissive[0]/255, mesh.emissive[1]/255, mesh.emissive[2]/255) : new THREE.Color(0,0,0);
        const transparent = opacity < 1.0;

        // Helper: build a THREE.Texture from a name in the image store or VFS
        const _makeTexture = (name, repeat) => {
            // Resolve: image store (data-URL, Image element, or http URL), then VFS asset
            let stored = (this._images && this._images[name] !== undefined)
                ? this._images[name]
                : (this.fs ? this.fs.getAsset(name) : null);
            if (!stored) return null;
            const tex = new THREE.Texture();
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            const r = repeat || mesh.textureRepeat || 1;
            tex.repeat.set(r, r);
            if (stored && typeof stored === 'object' && stored.tagName === 'IMG') {
                // Already a loaded Image element (CORS case from LOADIMG)
                tex.image = stored;
                tex.needsUpdate = true;
            } else {
                // String: data-URL or http/https URL
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { tex.image = img; tex.needsUpdate = true; };
                img.src = stored;
            }
            return tex;
        };

        // Load base colour texture
        let texture = null;
        if (mesh.textureName) texture = _makeTexture(mesh.textureName, mesh.textureRepeat || 1);

        // Load PBR maps if set
        const normalMap      = mesh.normalMapName   ? _makeTexture(mesh.normalMapName,   mesh.textureRepeat || 1) : null;
        const roughnessMap   = mesh.roughMapName    ? _makeTexture(mesh.roughMapName,    mesh.textureRepeat || 1) : null;
        const aoMap          = mesh.aoMapName       ? _makeTexture(mesh.aoMapName,       mesh.textureRepeat || 1) : null;
        const displacementMap = mesh.heightMapName  ? _makeTexture(mesh.heightMapName,   mesh.textureRepeat || 1) : null;
        const metalnessMap   = mesh.metalMapName    ? _makeTexture(mesh.metalMapName,    mesh.textureRepeat || 1) : null;
        const emissiveMap    = mesh.emissiveMapName ? _makeTexture(mesh.emissiveMapName, mesh.textureRepeat || 1) : null;

        // Use MeshStandardMaterial (full PBR) when any PBR map is set, else MeshPhong
        const hasPBR = !!(normalMap || roughnessMap || aoMap || displacementMap || metalnessMap || emissiveMap);

        const objects = [];

        if (mode === 'wire') {
            const mat = new THREE.MeshBasicMaterial({
                color, wireframe: true, transparent, opacity,
                depthWrite: !transparent, depthTest: true,
            });
            const m = new THREE.Mesh(geo, mat);
            m.castShadow = true; m.receiveShadow = true;
            objects.push(m);
        } else if (mode === 'solid') {
            let mat;
            if (hasPBR) {
                // PBR path — MeshStandardMaterial
                mat = new THREE.MeshStandardMaterial({
                    color: texture ? 0xffffff : color,
                    side: THREE.DoubleSide, roughness: 0.8, metalness: 0.0,
                    emissive, transparent, opacity,
                    depthWrite: !transparent, depthTest: true,
                });
                if (texture)       { mat.map              = texture;       }
                if (normalMap)     { mat.normalMap         = normalMap;     }
                if (roughnessMap)  { mat.roughnessMap      = roughnessMap;  }
                if (metalnessMap)  { mat.metalnessMap      = metalnessMap; mat.metalness = 1.0; }
                if (emissiveMap)   { mat.emissiveMap       = emissiveMap; mat.emissive = new THREE.Color(1,1,1); mat.emissiveIntensity = mesh.emissiveIntensity || 1.0; }
                if (aoMap)         { mat.aoMap             = aoMap; mat.aoMapIntensity = mesh.aoIntensity || 1.0; }
                if (displacementMap) {
                    const dScale = mesh.heightScale || 0.05;
                    mat.displacementMap   = displacementMap;
                    mat.displacementScale = dScale;
                    mat.displacementBias  = -dScale * 0.5;
                }
                // aoMap needs a second UV channel — add uv2 = uv
                if (aoMap) geo.setAttribute('uv2', geo.getAttribute('uv'));
                // envMap applied via GL.ENVMAP command after draw
            } else {
                // Classic path — MeshPhong
                mat = new THREE.MeshPhongMaterial({
                    color, side: THREE.DoubleSide, shininess: shine,
                    emissive, transparent, opacity,
                    depthWrite: !transparent, depthTest: true,
                });
                if (texture) { mat.map = texture; mat.color.set(0xffffff); }
            }
            const m = new THREE.Mesh(geo, mat);
            m.castShadow = true; m.receiveShadow = true;
            objects.push(m);
        } else { // solidwire
            let solidMat;
            if (hasPBR) {
                solidMat = new THREE.MeshStandardMaterial({
                    color: texture ? 0xffffff : color,
                    side: THREE.DoubleSide, roughness: 0.8, metalness: 0.0,
                    emissive, transparent, opacity,
                    depthWrite: !transparent, depthTest: true,
                });
                if (texture)       { solidMat.map              = texture;       }
                if (normalMap)     { solidMat.normalMap         = normalMap;     }
                if (roughnessMap)  { solidMat.roughnessMap      = roughnessMap;  }
                if (metalnessMap)  { solidMat.metalnessMap      = metalnessMap; solidMat.metalness = 1.0; }
                if (emissiveMap)   { solidMat.emissiveMap       = emissiveMap; solidMat.emissive = new THREE.Color(1,1,1); solidMat.emissiveIntensity = mesh.emissiveIntensity || 1.0; }
                if (aoMap)         { solidMat.aoMap             = aoMap; solidMat.aoMapIntensity = mesh.aoIntensity || 1.0; }
                if (displacementMap) {
                    const dScale2 = mesh.heightScale || 0.05;
                    solidMat.displacementMap   = displacementMap;
                    solidMat.displacementScale = dScale2;
                    solidMat.displacementBias  = -dScale2 * 0.5;
                }
                if (aoMap) geo.setAttribute('uv2', geo.getAttribute('uv'));
                // envMap applied via GL.ENVMAP command after draw
            } else {
                solidMat = new THREE.MeshPhongMaterial({
                    color, side: THREE.DoubleSide, shininess: shine,
                    emissive, transparent, opacity,
                    depthWrite: !transparent, depthTest: true,
                });
                if (texture) { solidMat.map = texture; solidMat.color.set(0xffffff); }
            }
            const m = new THREE.Mesh(geo, solidMat);
            m.castShadow = true; m.receiveShadow = true;
            objects.push(m);
            // Edge overlay
            let ec;
            if (mesh.wireColor) {
                ec = new THREE.Color(mesh.wireColor[0]/255, mesh.wireColor[1]/255, mesh.wireColor[2]/255);
            } else {
                ec = new THREE.Color(Math.min(1,r/255+0.25), Math.min(1,gv/255+0.25), Math.min(1,b/255+0.25));
            }
            const edgeGeo = new THREE.EdgesGeometry(geo);
            const edgeMat = new THREE.LineBasicMaterial({ color: ec, transparent, opacity, depthTest: true });
            objects.push(new THREE.LineSegments(edgeGeo, edgeMat));
        }

        return objects;
    }

// Rebuild Three.js objects for a mesh (called on first draw or after mode change)
    _glSyncMesh(mesh, g) {
        const t = g.three;
        // Remove old Three objects from scene
        if (mesh._threeObjects) {
            for (const obj of mesh._threeObjects) {
                t.scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            }
        }
        // Build new objects
        mesh._threeObjects = this._glBuildThreeMesh(mesh, g.mode, g);
        mesh._builtMode    = g.mode;
        // Apply current transform
        for (const obj of mesh._threeObjects) {
            obj.position.set(mesh.tx||0, mesh.ty||0, mesh.tz||0);
            obj.rotation.set(
                (mesh.rx||0) * Math.PI/180,
                (mesh.ry||0) * Math.PI/180,
                (mesh.rz||0) * Math.PI/180
            );
            obj.scale.set(mesh.sx||1, mesh.sy||1, mesh.sz||1);
            t.scene.add(obj);
        }
    }

// ---- GL Commands ---- (BASIC API — unchanged from software renderer) ----


// GLDEBUG — print GL canvas and renderer state to terminal


    cmdGLDEBUG() {
        const c = this._glCanvas;
        const g = this._gl;
        if (!c && !g) { this.appendLine('GL: not initialised', 1); return CMD_OK; }
        this.appendLine('-- GL DEBUG --', 1);
        this.appendLine('canvas: ' + (c ? (c.parentNode ? 'inDOM' : 'detached') + '  display:' + (c.style.display||'block') + '  z:' + c.style.zIndex : 'none'), 1);
        this.appendLine('_gl: ' + (g?'exists':'null') + '  three:' + (g&&g.three?'exists':'null') + '  meshes:' + (g?Object.keys(g.meshes||{}).length:0), 1);
        if (g && g.three) {
            const sz = g.three.renderer.getSize(new THREE.Vector2());
            const gl2 = g.three.renderer.getContext();
            this.appendLine('renderer: ' + sz.x + 'x' + sz.y + '  context.lost:' + (gl2?gl2.isContextLost():'?'), 1);
            this.appendLine('scene.children: ' + g.three.scene.children.length + '  camera: ' + g.three.camera.position.x.toFixed(1)+','+g.three.camera.position.y.toFixed(1)+','+g.three.camera.position.z.toFixed(1), 1);
        }
        const wrapper = document.getElementById('terminal-wrapper');
        const emu = document.getElementById('oEmulator_div');
        const gfx = this._gfx;
        if (wrapper) {
            const ws = window.getComputedStyle(wrapper);
            this.appendLine('wrapper: ' + wrapper.clientWidth+'x'+wrapper.clientHeight + '  overflow-y:'+ws.overflowY + '  z:'+ws.zIndex, 1);
        }
        if (emu) {
            const es = window.getComputedStyle(emu);
            this.appendLine('emuDiv: z:'+es.zIndex + '  overflow:'+es.overflow + '  bg:'+es.backgroundColor, 1);
        }
        if (gfx) {
            const gs = window.getComputedStyle(gfx.canvas);
            this.appendLine('gfxCanvas: ' + gfx.W+'x'+gfx.H + '  z:'+gs.zIndex + '  display:'+(gfx.canvas.style.display||'block'), 1);
        }
        this.appendLine('graphics-active: ' + (this.o ? this.o.classList.contains('graphics-active') : 'n/a'), 1);
        return CMD_OK;
    }

    cmdGL_INIT() {
        this._glInit();
        this._activateGraphics();
        const t = this._glSetupThree();
        if (t) {
            t.renderer.setClearColor(new THREE.Color(0,0,0), 1);
            t.renderer.clear();
        }
        // Ensure the GL canvas is visible (may have been hidden on program stop)
        if (this._glCanvas) this._glCanvas.style.display = '';
        return CMD_OK;
    }

// GL.CLOSE — tear down the GL renderer and restore the text terminal.
// Use this mid-program when you want to return from a GL scene to text mode
// without ending the program. Equivalent to what _onProgramStop does for GL.
    cmdGL_CLOSE() {
        // Dispose renderer and remove canvas
        this._glInit();   // disposes renderer + removes canvas
        this._glCanvas = null;
        // Restore terminal visibility — same as _onProgramStop
        if (this._gfx) {
            this._gfx.buf.fill(0);
            this._gfx.dirty = true;
            this._gfxFlush();
            this._gfx.canvas.style.display = 'none';
        }
        if (this._spr) this._spr.canvas.style.display = 'none';
        if (this.o) this.o.classList.remove('graphics-active');
        this._graphicsActive = false;
        return CMD_OK;
    }

    cmdGL_CLS(param) {
        this._activateGraphics();
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        this._glSyncCanvas();
        const parts = this._glParseFloats(param, 3);
        const r = (parts[0]||0)/255, gv = (parts[1]||0)/255, b = (parts[2]||0)/255;
        g.clearR = parts[0]||0; g.clearG = parts[1]||0; g.clearB = parts[2]||0;
        t.renderer.setClearColor(new THREE.Color(r, gv, b), 1);
        t.renderer.clear();
        return CMD_OK;
    }

    cmdGL_PERSPECTIVE(param) {
        const fov = Number(this.evalCalc(this.trim(String(param||'60')), ASS_NUMBER));
        const g = this._glState();
        g.fov = fov || 60;
        if (g.three) {
            g.three.camera.fov = g.fov;
            g.three.camera.updateProjectionMatrix();
        }
        return CMD_OK;
    }

    cmdGL_CAMERA(param) {
        const p = this._glParseFloats(param, 3);
        const g = this._glState();
        g.cam = [p[0]||0, p[1]||0, p[2]||-5];
        if (g.three) {
            g.three.camera.position.set(g.cam[0], g.cam[1], g.cam[2]);
            g.three.camera.lookAt(g.lookat[0], g.lookat[1], g.lookat[2]);
        }
        return CMD_OK;
    }

    cmdGL_LOOKAT(param) {
        const p = this._glParseFloats(param, 3);
        const g = this._glState();
        g.lookat = [p[0]||0, p[1]||0, p[2]||0];
        if (g.three) {
            g.three.camera.lookAt(g.lookat[0], g.lookat[1], g.lookat[2]);
        }
        return CMD_OK;
    }

    cmdGL_COLOUR(param) {
        const p = this._glParseFloats(param, 3);
        this._glState().colour = [Math.round(p[0]||255), Math.round(p[1]||255), Math.round(p[2]||255)];
        return CMD_OK;
    }

    cmdGL_WIRE()      { this._glState().mode = 'wire';      return CMD_OK; }
    cmdGL_SOLID()     { this._glState().mode = 'solid';     return CMD_OK; }
    cmdGL_SOLIDWIRE() { this._glState().mode = 'solidwire'; return CMD_OK; }

    cmdGL_LIGHT(param) {
        const p = this._glParseFloats(param, 3);
        const g = this._glState();
        // Normalise light direction
        const len = Math.sqrt(p[0]*p[0]+p[1]*p[1]+p[2]*p[2]) || 1;
        g.light = [p[0]/len, p[1]/len, p[2]/len];
        if (g.three) {
            g.three.dirLight.position.set(g.light[0], g.light[1], g.light[2]);
            g.three.dirLight.intensity = (1 - g.ambient) * 0.7;
        }
        return CMD_OK;
    }

    cmdGL_AMBIENT(param) {
        const v = Number(this.evalCalc(this.trim(String(param||'0.25')), ASS_NUMBER));
        const g = this._glState();
        g.ambient = Math.max(0, Math.min(1, v));
        if (g.three) {
            g.three.ambientLight.intensity = g.ambient;
            if (g.light) g.three.dirLight.intensity = (1 - g.ambient) * 0.7;
        }
        return CMD_OK;
    }

    cmdGL_BEGIN() {
        const g = this._glState();
        g.building = {
            verts: [], faces: [],
            colour:    [...g.colour],
            shine:     g.shine,
            alpha:     g.alpha,
            wireColor: g.wireColor ? [...g.wireColor] : null,
            emissive:  [...g.emissive],
            textureName: null,
        };
        return CMD_OK;
    }

    cmdGL_VERTEX(param) {
        const p = this._glParseFloats(param, 3);
        const g = this._glState();
        if (!g.building) return CMD_ESYNTAX;
        g.building.verts.push([p[0]||0, p[1]||0, p[2]||0]);
        return CMD_OK;
    }

    cmdGL_FACE(param) {
        const g = this._glState();
        if (!g.building) return CMD_ESYNTAX;
        const p = this._glParseFloats(param, 4);
        const face = p.filter((v,i) => i < 4 && v > 0).map(Math.round);
        if (face.length >= 3) g.building.faces.push(face);
        return CMD_OK;
    }

    cmdGL_END() {
        const g = this._glState();
        if (!g.building) return CMD_ESYNTAX;
        const id = g.nextId++;
        g.meshes[id] = Object.assign(g.building, {
            id, tx:0, ty:0, tz:0, rx:0, ry:0, rz:0, sx:1, sy:1, sz:1,
            _threeObjects: null, _builtMode: null,
        });
        g.lastId = id;
        g.building = null;
        return CMD_OK;
    }

    cmdGL_TRANSLATE(param) {
        const p = this._glParseFloats(param, 4);
        const g = this._glState();
        const m = g.meshes[Math.round(p[0])];
        if (!m) return CMD_OK;
        m.tx = p[1]||0; m.ty = p[2]||0; m.tz = p[3]||0;
        if (m._threeObjects) {
            for (const obj of m._threeObjects) obj.position.set(m.tx, m.ty, m.tz);
        }
        return CMD_OK;
    }

    cmdGL_ROTATE(param) {
        const p = this._glParseFloats(param, 4);
        const g = this._glState();
        const m = g.meshes[Math.round(p[0])];
        if (!m) return CMD_OK;
        m.rx = p[1]||0; m.ry = p[2]||0; m.rz = p[3]||0;
        if (m._threeObjects) {
            const D = Math.PI/180;
            for (const obj of m._threeObjects)
                obj.rotation.set(m.rx*D, m.ry*D, m.rz*D);
        }
        return CMD_OK;
    }

    cmdGL_SCALE(param) {
        const p = this._glParseFloats(param, 4);
        const g = this._glState();
        const m = g.meshes[Math.round(p[0])];
        if (!m) return CMD_OK;
        m.sx = p[1]||1; m.sy = p[2]||1; m.sz = p[3]||1;
        if (m._threeObjects) {
            for (const obj of m._threeObjects) obj.scale.set(m.sx, m.sy, m.sz);
        }
        return CMD_OK;
    }

    cmdGL_DRAW(param) {
        const g = this._glState();
        const id = Math.round(Number(this.evalCalc(this.trim(String(param||'')), ASS_NUMBER)));
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        // Rebuild mesh if mode changed or not yet built
        if (!m._threeObjects || m._builtMode !== g.mode) this._glSyncMesh(m, g);
        this._glSyncCanvas();
        // Update CubeCameras (envMap / chrome) — hide mesh during capture
        if (t._chromeMeshes && t._chromeMeshes.length > 0) {
            for (const cm of t._chromeMeshes) {
                if (cm._cubeCamera && cm._threeObjects && cm._threeObjects[0]) {
                    cm._threeObjects[0].visible = false;
                    cm._cubeCamera.position.copy(cm._threeObjects[0].position);
                    cm._cubeCamera.update(t.renderer, t.scene);
                    cm._threeObjects[0].visible = true;
                }
            }
        }
        t.renderer.render(t.scene, t.camera);
        return CMD_OK;
    }

    cmdGL_DRAWALL() {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        for (const m of Object.values(g.meshes)) {
            if (!m._threeObjects || m._builtMode !== g.mode) {
                if (!m._isSphere && !m._isChrome) this._glSyncMesh(m, g);
            }
        }
        this._glSyncCanvas();
        // Update CubeCameras for chrome meshes — hide the chrome mesh itself
        // during cube capture to avoid the sphere reflecting itself (black hole).
        if (t._chromeMeshes && t._chromeMeshes.length > 0) {
            for (const cm of t._chromeMeshes) {
                if (cm._cubeCamera && cm._threeObjects && cm._threeObjects[0]) {
                    cm._threeObjects[0].visible = false;
                    cm._cubeCamera.position.copy(cm._threeObjects[0].position);
                    cm._cubeCamera.update(t.renderer, t.scene);
                    cm._threeObjects[0].visible = true;
                }
            }
        }
        t.renderer.render(t.scene, t.camera);
        return CMD_OK;
    }

// ---- Extended GL commands ------------------------------------------------

// GL.SHINE n — set specular shininess for subsequent meshes (0-200)
    cmdGL_SHINE(param) {
        const v = Number(this.evalCalc(this.trim(String(param||'30')), ASS_NUMBER));
        this._glState().shine = Math.max(0, Math.min(200, v));
        return CMD_OK;
    }

// GL.ALPHA n — set opacity for subsequent meshes (0.0-1.0)
    cmdGL_ALPHA(param) {
        const v = Number(this.evalCalc(this.trim(String(param||'1')), ASS_NUMBER));
        this._glState().alpha = Math.max(0, Math.min(1, v));
        return CMD_OK;
    }

// GL.EMISSIVE r,g,b — set emissive glow colour (0-255 each)

// GL.WIRECOLOR r,g,b — set edge colour for SOLIDWIRE mode
    cmdGL_WIRECOLOR(param) {
        const p = this._glParseFloats(param, 3);
        this._glState().wireColor = [Math.round(p[0]||255), Math.round(p[1]||255), Math.round(p[2]||255)];
        return CMD_OK;
    }

// GL.TEXTURE id, name$ [, repeat] — apply stored image as texture
    cmdGL_TEXTURE(param) {
        const g = this._glState();
        const parts = this._glParseFloats(param, 1);
        const id = Math.round(parts[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const raw = this.trim(String(param||''));
        const ci = raw.indexOf(',');
        if (ci < 0) return CMD_OK;
        const rest = this.trim(raw.substring(ci+1));
        // Find optional second comma for repeat
        const ci2 = rest.indexOf(',');
        let nameRaw = ci2 >= 0 ? this.trim(rest.substring(0, ci2)) : rest;
        let repeat  = ci2 >= 0 ? Number(this.evalCalc(this.trim(rest.substring(ci2+1)), ASS_NUMBER)) : 4;
        if (nameRaw.startsWith('"') && nameRaw.endsWith('"')) nameRaw = nameRaw.slice(1,-1);
        else nameRaw = String(this.lookup_(ASS_STRING, nameRaw.toUpperCase()));
        m.textureName   = nameRaw;
        m.textureRepeat = repeat || 4;
        m._builtMode = null;  // force rebuild
        return CMD_OK;
    }

// -----------------------------------------------------------------------
// PBR map commands — apply additional texture maps to a mesh.
// All commands follow the same pattern:
//   GL.NORMALMAP  id, name$   — surface normal map
//   GL.ROUGHMAP   id, name$   — roughness map  (0=mirror, 1=matte)
//   GL.AOMAP      id, name$   — ambient occlusion map
//   GL.HEIGHTMAP  id, name$ [, scale] — displacement/height map
// name$ can be an image-store name (loaded via LOADIMG) or a VFS path
// (e.g. "STONE2/NORMAL.JPG").  Setting any PBR map forces the mesh to
// rebuild using MeshStandardMaterial on next GL.DRAW.
// -----------------------------------------------------------------------
    _glParsePBRParam(param) {
        // Parse "id, name$ [, extra]" — returns {id, name, extra}
        const raw = this.trim(String(param || ''));
        const ci = raw.indexOf(',');
        if (ci < 0) return null;
        const id = Math.round(Number(this.evalCalc(raw.substring(0, ci).trim(), ASS_NUMBER)));
        const rest = raw.substring(ci + 1).trim();
        const ci2 = rest.indexOf(',');
        let nameRaw = ci2 >= 0 ? rest.substring(0, ci2).trim() : rest;
        const extra = ci2 >= 0 ? Number(this.evalCalc(rest.substring(ci2 + 1).trim(), ASS_NUMBER)) : null;
        if (nameRaw.startsWith('"') && nameRaw.endsWith('"')) nameRaw = nameRaw.slice(1, -1);
        else nameRaw = String(this.lookup_(ASS_STRING, nameRaw.toUpperCase()) || nameRaw);
        return { id, name: nameRaw, extra };
    }

    cmdGL_NORMALMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.normalMapName = p.name;
        m._builtMode = null;  // force rebuild
        return CMD_OK;
    }

    cmdGL_ROUGHMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.roughMapName = p.name;
        m._builtMode = null;
        return CMD_OK;
    }

    cmdGL_AOMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.aoMapName    = p.name;
        m.aoIntensity  = p.extra !== null ? p.extra : 1.0;
        m._builtMode   = null;
        return CMD_OK;
    }

    cmdGL_HEIGHTMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.heightMapName = p.name;
        m.heightScale   = p.extra !== null ? p.extra : 0.05;
        m._builtMode    = null;
        return CMD_OK;
    }

    cmdGL_METALMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.metalMapName = p.name;
        m._builtMode   = null;
        return CMD_OK;
    }

    cmdGL_EMISSIVEMAP(param) {
        const g = this._glState();
        const p = this._glParsePBRParam(param);
        if (!p) return CMD_ESYNTAX;
        const m = g.meshes[p.id];
        if (!m) return CMD_OK;
        m.emissiveMapName = p.name;
        m._builtMode      = null;
        return CMD_OK;
    }

// GL.EMISSIVE id, r, g, b  — set emissive colour scalar (0-255 each channel)
// Used without a map to make a mesh glow a solid colour.
// Used WITH GL.EMISSIVEMAP to tint the emissive map colour.
    cmdGL_EMISSIVE(param) {
        const g = this._glState();
        const p = this._glParseFloats(param, 4);
        const id = Math.round(p[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const r = (p[1]||0)/255, gv = (p[2]||0)/255, b = (p[3]||0)/255;
        m.emissiveColor = [p[1]||0, p[2]||0, p[3]||0];
        if (m._threeObjects) {
            for (const obj of m._threeObjects) {
                if (obj.material && obj.material.emissive) {
                    obj.material.emissive.setRGB(r, gv, b);
                    obj.material.needsUpdate = true;
                }
            }
        }
        return CMD_OK;
    }

// GL.EMISSIVEINTENSITY id, value — multiplier on emissive brightness (default 1.0)
// Values > 1 make the glow brighter than the source texture (e.g. 2.0, 3.0)
    cmdGL_EMISSIVEINTENSITY(param) {
        const g = this._glState();
        const p = this._glParseFloats(param, 2);
        const id = Math.round(p[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const val = Math.max(0, p[1] !== undefined ? p[1] : 1.0);
        m.emissiveIntensity = val;
        if (m._threeObjects) {
            for (const obj of m._threeObjects) {
                if (obj.material && obj.material.emissiveIntensity !== undefined) {
                    obj.material.emissiveIntensity = val;
                    obj.material.needsUpdate = true;
                }
            }
        }
        return CMD_OK;
    }

// GL.ROUGHNESS id, value  — set roughness scalar (0.0=mirror, 1.0=matte)
// Overrides roughnessMap. Applied directly to the live material so no rebuild needed.
    cmdGL_ROUGHNESS(param) {
        const g = this._glState();
        const p = this._glParseFloats(param, 2);
        const id = Math.round(p[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const val = Math.max(0, Math.min(1, p[1] !== undefined ? p[1] : 0.5));
        m.roughnessVal = val;
        // Apply immediately to live material if already built
        if (m._threeObjects) {
            for (const obj of m._threeObjects) {
                if (obj.material && obj.material.roughness !== undefined) {
                    obj.material.roughness = val;
                    obj.material.needsUpdate = true;
                }
            }
        }
        return CMD_OK;
    }

// GL.METALNESS id, value  — set metalness scalar (0.0=non-metal, 1.0=full metal)
// Applied directly to the live material, no rebuild needed.
    cmdGL_METALNESS(param) {
        const g = this._glState();
        const p = this._glParseFloats(param, 2);
        const id = Math.round(p[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const val = Math.max(0, Math.min(1, p[1] !== undefined ? p[1] : 1.0));
        m.metalnessVal = val;
        if (m._threeObjects) {
            for (const obj of m._threeObjects) {
                if (obj.material && obj.material.metalness !== undefined) {
                    obj.material.metalness = val;
                    obj.material.needsUpdate = true;
                }
            }
        }
        return CMD_OK;
    }

// GL.ENVMAP id [, size]
// Attach a live CubeCamera environment map to a mesh so metallic/PBR
// materials reflect the scene. size = cube render target resolution
// (64/128/256, default 128 — higher = sharper reflections, more GPU cost).
// Call AFTER GL.DRAW so the mesh already exists as a Three.js object.
// The cube camera updates every frame automatically.
//   GL.ENVMAP 1        — attach with default 128px resolution
//   GL.ENVMAP 1, 256   — sharper reflections
//   GL.ENVMAP 1, 64    — cheapest, good for many objects
    cmdGL_ENVMAP(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 2);
        const id   = Math.round(p[0]);
        const size = p[1] > 0 ? Math.round(p[1]) : 128;
        const m = g.meshes[id];
        if (!m || !m._threeObjects || !m._threeObjects[0]) return CMD_OK;

        // Remove any existing cube camera on this mesh first
        if (m._cubeCamera) {
            t.scene.remove(m._cubeCamera);
            if (m._cubeRT) m._cubeRT.dispose();
        }

        const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
            format:          THREE.RGBAFormat,
            generateMipmaps: true,
            minFilter:       THREE.LinearMipmapLinearFilter,
        });
        const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRT);
        t.scene.add(cubeCamera);

        // Apply envMap to all Three objects on this mesh
        for (const obj of m._threeObjects) {
            if (obj.material) {
                obj.material.envMap          = cubeRT.texture;
                obj.material.envMapIntensity = 1.0;
                obj.material.needsUpdate     = true;
            }
        }

        m._cubeCamera = cubeCamera;
        m._cubeRT     = cubeRT;
        m._isChrome   = true;

        if (!g.three._chromeMeshes) g.three._chromeMeshes = [];
        // Avoid duplicates
        if (!g.three._chromeMeshes.includes(m)) g.three._chromeMeshes.push(m);

        return CMD_OK;
    }

// GL.POINTLIGHT x,y,z [,r,g,b [,intensity [,distance]]] — add a point light
    cmdGL_POINTLIGHT(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 8);
        const r  = p[3] !== undefined && p[3] > 0 ? p[3]/255 : 1;
        const gv = p[4] !== undefined ? p[4]/255 : 1;
        const b  = p[5] !== undefined ? p[5]/255 : 1;
        const intensity = p[6] !== undefined ? p[6] : 2;
        const distance  = p[7] !== undefined ? p[7] : 10; // 0=infinite
        const light = new THREE.PointLight(new THREE.Color(r, gv, b), intensity, distance, 1);
        light.position.set(p[0]||0, p[1]||0, p[2]||0);
        light.castShadow            = true;
        light.shadow.mapSize.width  = 512;
        light.shadow.mapSize.height = 512;
        light.shadow.bias           = -0.002;
        t.scene.add(light);
        if (!g.pointLights) g.pointLights = [];
        g.pointLights.push(light);
        return CMD_OK;
    }

// GL.LIGHTSOFF — remove all point lights from scene
    cmdGL_LIGHTSOFF() {
        const g = this._glState();
        if (g.three && g.pointLights) {
            for (const l of g.pointLights) {
                if (l.shadow && l.shadow.map) l.shadow.map.dispose();
                l.dispose();
                g.three.scene.remove(l);
            }
            g.pointLights = [];
        }
        return CMD_OK;
    }

// GL.HIDE id — remove mesh from scene entirely
    cmdGL_HIDE(param) {
        const g = this._glState();
        const t = g.three;
        const id = Math.round(Number(this.evalCalc(this.trim(String(param||'')), ASS_NUMBER)));
        const m = g.meshes[id];
        if (m && m._threeObjects) {
            for (const o of m._threeObjects) {
                o.visible = false;
                if (t && t.scene) t.scene.remove(o);
            }
        }
        return CMD_OK;
    }

// GL.DISPOSE id — completely remove and free a mesh and all its GPU resources
    cmdGL_DISPOSE(param) {
        const g = this._glState();
        const id = Math.round(Number(this.evalCalc(this.trim(String(param||'')), ASS_NUMBER)));
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        // Loaded models (GL.LOAD) are a Three.js Group hierarchy — walk it and
        // free every child mesh's geometry/material/textures, plus the animation mixer.
        if (m._isLoaded && m._threeObjects && m._threeObjects[0] && m._threeObjects[0].traverse) {
            const t = g.three;
            const model = m._threeObjects[0];
            if (t && t.scene) t.scene.remove(model);
            model.traverse((c) => {
                if (c.isMesh) {
                    if (c.geometry) c.geometry.dispose();
                    const mats = Array.isArray(c.material) ? c.material : (c.material ? [c.material] : []);
                    for (const mat of mats) {
                        if (mat.map)          mat.map.dispose();
                        if (mat.normalMap)    mat.normalMap.dispose();
                        if (mat.roughnessMap) mat.roughnessMap.dispose();
                        if (mat.metalnessMap) mat.metalnessMap.dispose();
                        if (mat.aoMap)        mat.aoMap.dispose();
                        if (mat.emissiveMap)  mat.emissiveMap.dispose();
                        mat.dispose();
                    }
                }
            });
            if (m._mixer) { try { m._mixer.stopAllAction(); } catch (e) {} m._mixer = null; }
            delete g.meshes[id];
            return CMD_OK;
        }
        if (m._threeObjects) {
            const t = g.three;
            for (const obj of m._threeObjects) {
                if (t && t.scene) t.scene.remove(obj);
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    const mat = obj.material;
                    if (mat.map)             mat.map.dispose();
                    if (mat.normalMap)       mat.normalMap.dispose();
                    if (mat.roughnessMap)    mat.roughnessMap.dispose();
                    if (mat.aoMap)           mat.aoMap.dispose();
                    if (mat.displacementMap) mat.displacementMap.dispose();
                    if (mat.metalnessMap)    mat.metalnessMap.dispose();
                    if (mat.emissiveMap)     mat.emissiveMap.dispose();
                    if (mat.envMap)          mat.envMap.dispose();
                    mat.dispose();
                }
            }
        }
        delete g.meshes[id];
        return CMD_OK;
    }

// GL.SHOW id — make a previously hidden mesh visible again
    cmdGL_SHOW(param) {
        const g = this._glState();
        const id = Math.round(Number(this.evalCalc(this.trim(String(param||'')), ASS_NUMBER)));
        const m = g.meshes[id];
        if (m && m._threeObjects) { for (const o of m._threeObjects) o.visible = true; }
        return CMD_OK;
    }

// GL.FOG r,g,b, near, far — enable linear fog
    cmdGL_FOG(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 5);
        const fogColor = new THREE.Color(p[0]/255, p[1]/255, p[2]/255);
        t.scene.fog = new THREE.Fog(fogColor, p[3]||5, p[4]||20);
        t.renderer.setClearColor(fogColor, 1);
        g.fog = { r:p[0], g:p[1], b:p[2], near:p[3], far:p[4] };
        return CMD_OK;
    }

// GL.FOGOFF — disable fog
    cmdGL_FOGOFF() {
        const g = this._glState();
        if (g.three) {
            g.three.scene.fog = null;
            // Restore clear colour
            g.three.renderer.setClearColor(new THREE.Color(g.clearR/255, g.clearG/255, g.clearB/255), 1);
        }
        g.fog = null;
        return CMD_OK;
    }

// GL.SPHERE id, radius, widthSegs, heightSegs — create a sphere mesh
    cmdGL_SPHERE(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 4);
        const radius   = p[0] || 1;
        const wSegs    = Math.round(p[1]) || 16;
        const hSegs    = Math.round(p[2]) || 12;

        const [r,gv,b] = g.colour;
        const color    = new THREE.Color(r/255, gv/255, b/255);
        const opacity  = g.alpha;
        const transparent = opacity < 1.0;
        const geo = new THREE.SphereGeometry(radius, wSegs, hSegs);

        const mat = (g.mode === 'wire')
            ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent, opacity })
            : new THREE.MeshPhongMaterial({ color, side: THREE.DoubleSide,
                shininess: g.shine, transparent, opacity,
                emissive: new THREE.Color(g.emissive[0]/255, g.emissive[1]/255, g.emissive[2]/255),
                depthWrite: !transparent });

        const mesh3 = new THREE.Mesh(geo, mat);
        mesh3.castShadow    = true;
        mesh3.receiveShadow = true;
        t.scene.add(mesh3);

        // Register as a BASIC mesh
        const id = g.nextId++;
        const fakeMesh = { id, verts:[], faces:[], colour:[r,gv,b],
            shine:g.shine, alpha:g.alpha, emissive:[...g.emissive],
            tx:0,ty:0,tz:0, rx:0,ry:0,rz:0, sx:1,sy:1,sz:1,
            _threeObjects:[mesh3], _builtMode: g.mode, _isSphere: true };
        g.meshes[id] = fakeMesh;
        g.lastId = id;
        return CMD_OK;
    }

// GL.BOX w, h, d — create a box mesh with given width, height, depth
// Uses current GL colour, shine, emissive, alpha and mode settings.
    cmdGL_BOX(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 3);
        const w = p[0] || 1;
        const h = p[1] || w;
        const d = p[2] || w;

        const [r,gv,b] = g.colour;
        const color    = new THREE.Color(r/255, gv/255, b/255);
        const opacity  = g.alpha;
        const transparent = opacity < 1.0;
        const geo = new THREE.BoxGeometry(w, h, d);

        const mat = (g.mode === 'wire')
            ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent, opacity })
            : new THREE.MeshPhongMaterial({ color, side: THREE.DoubleSide,
                shininess: g.shine, transparent, opacity,
                emissive: new THREE.Color(g.emissive[0]/255, g.emissive[1]/255, g.emissive[2]/255),
                depthWrite: !transparent });

        const mesh3 = new THREE.Mesh(geo, mat);
        mesh3.castShadow    = false;
        mesh3.receiveShadow = false;
        t.scene.add(mesh3);

        const id = g.nextId++;
        const fakeMesh = { id, verts:[], faces:[], colour:[r,gv,b],
            shine:g.shine, alpha:g.alpha, emissive:[...g.emissive],
            tx:0,ty:0,tz:0, rx:0,ry:0,rz:0, sx:1,sy:1,sz:1,
            _threeObjects:[mesh3], _builtMode: g.mode, _isSphere: true };
        g.meshes[id] = fakeMesh;
        g.lastId = id;
        return CMD_OK;
    }

// GL.LOAD url$ — load a GLTF (.gltf) / GLB (.glb) model and add it to the scene.
// Only GLTF/GLB is supported (not OBJ/FBX/STL).  Sets GL.MESHID to the loaded
// model's id, so GL.TRANSLATE/ROTATE/SCALE/HIDE/DISPOSE work on it.  Loading is
// async, so the interpreter is paused (host._glLoadPending) until the model is
// ready, then resumed — that way the line after GL.LOAD sees the right GL.MESHID.
    cmdGL_LOAD(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        // Resolve the url argument: "literal" string or a string variable.
        let url = this.trim(String(param || ''));
        if (url.startsWith('"') && url.endsWith('"')) url = url.slice(1, -1);
        else url = String(this.lookup_(ASS_STRING, url.toUpperCase()) || url);
        url = url.trim();
        if (!url) return CMD_ESYNTAX;
        if (typeof THREE === 'undefined' || !THREE.GLTFLoader) {
            this.appendLine('GL.LOAD: GLTFLoader not available', 1);
            return CMD_OK;
        }
        const host = this._host;
        host._glLoadPending = true;
        const resume = () => { host._glLoadPending = false; if (host.running) host.tick(1); };
        const loader = new THREE.GLTFLoader();
        loader.load(url,
            (gltf) => {
                try {
                    const model = gltf.scene;
                    model.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
                    t.scene.add(model);
                    const id = g.nextId++;
                    const fm = { id, verts: [], faces: [], colour: [255, 255, 255],
                        shine: 30, alpha: 1.0, emissive: [0, 0, 0],
                        tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
                        _threeObjects: [model], _builtMode: g.mode, _isSphere: true, _isLoaded: true };
                    if (gltf.animations && gltf.animations.length > 0) {
                        fm._animations = gltf.animations;
                        fm._mixer = new THREE.AnimationMixer(model);
                    }
                    g.meshes[id] = fm;
                    g.lastId = id;
                } catch (e) {
                    this.appendLine('GL.LOAD: error placing model — ' + e.message, 1);
                    if (typeof console !== 'undefined') console.error('GL.LOAD place error:', e);
                }
                resume();
            },
            () => {},
            (err) => {
                this.appendLine('GL.LOAD error: ' + (err && err.message ? err.message : url), 1);
                if (typeof console !== 'undefined') console.error('GL.LOAD error loading', url, err);
                resume();
            }
        );
        return CMD_OK;
    }

// GL.CHROME id [, roughness] — apply a real-time reflective chrome/mirror
// material to a mesh using a CubeCamera that captures the scene each frame.
// roughness: 0.0=perfect mirror, 0.1=brushed chrome (default 0.05)
    cmdGL_CHROME(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const p = this._glParseFloats(param, 2);
        const id        = Math.round(p[0]);
        const roughness = p[1] !== undefined && p[1] > 0 ? p[1] : 0.05;
        const m = g.meshes[id];
        if (!m || !m._threeObjects || !m._threeObjects[0]) return CMD_OK;

        const mesh3 = m._threeObjects[0];

        // Create a WebGLCubeRenderTarget (256 = good quality/perf balance)
        const cubeRT = new THREE.WebGLCubeRenderTarget(256, {
            format:     THREE.RGBAFormat,
            generateMipmaps: true,
            minFilter:  THREE.LinearMipmapLinearFilter,
        });
        const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRT);
        t.scene.add(cubeCamera);

        // MeshStandardMaterial — metalness=1 + envMap gives real chrome look
        const [r,gv,b] = (m.colour || [220,230,255]);
        const chromeMat = new THREE.MeshStandardMaterial({
            color:           new THREE.Color(r/255, gv/255, b/255),
            metalness:       1.0,
            roughness:       roughness,
            envMap:          cubeRT.texture,
            envMapIntensity: 1.0,
        });

        // Replace the mesh material
        mesh3.material.dispose();
        mesh3.material       = chromeMat;
        mesh3.castShadow     = true;
        mesh3.receiveShadow  = true;

        // Store CubeCamera reference on mesh for per-frame updates
        m._cubeCamera  = cubeCamera;
        m._cubeRT      = cubeRT;
        m._isChrome    = true;

        // Register a pre-render hook — update cube camera each frame before main render
        if (!g.three._chromeMeshes) g.three._chromeMeshes = [];
        g.three._chromeMeshes.push(m);

        return CMD_OK;
    }

// Helper: parse up to n floats from a comma-separated param string
    _glParseFloats(param, n) {
        if (!param) return new Array(n).fill(0);
        const raw = this.trim(String(param));
        const result = [];
        let inQ = false, start = 0;
        for (let i = 0; i <= raw.length; i++) {
            if (raw[i] === '"') { inQ = !inQ; continue; }
            if (!inQ && (raw[i] === ',' || i === raw.length)) {
                const token = this.trim(raw.substring(start, i));
                result.push(token ? Number(this.evalCalc(token, ASS_NUMBER)) : 0);
                start = i + 1;
                if (result.length >= n) break;
            }
        }
        while (result.length < n) result.push(0);
        return result;
    }

}

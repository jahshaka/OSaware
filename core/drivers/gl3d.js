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
            if (t.composer && t.composer.dispose) t.composer.dispose();
            if (t.renderer) { t.renderer.dispose(); t.renderer.forceContextLoss(); }
            if (this._glCanvas && this._glCanvas.parentNode) {
                this._glCanvas.parentNode.removeChild(this._glCanvas);
            }
            this._glCanvas = null;
        }
        if (this._fpsDiv) { try { this._fpsDiv.remove(); } catch (e) {} this._fpsDiv = null; }
        if (this._rfpsRAF) { try { cancelAnimationFrame(this._rfpsRAF); } catch (e) {} this._rfpsRAF = 0; }
        if (this._rfpsDiv) { try { this._rfpsDiv.remove(); } catch (e) {} this._rfpsDiv = null; }

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
            forceWire:  false,    // GL.WIREALL — render every mesh as unlit wireframe
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
        const camera = new THREE.PerspectiveCamera(g.fov, W / H, 0.1, g.far || 1000);
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
            // Reuse a cached Vector2 — getSize() would otherwise allocate every frame.
            if (!g._sizeTmp) g._sizeTmp = new THREE.Vector2();
            const size = t.renderer.getSize(g._sizeTmp);
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
        // Honour GL.WIREALL for meshes (re)built while wireframe-everything is active
        if (g.forceWire) {
            for (const obj of mesh._threeObjects) {
                obj.traverse(o => {
                    if (!o.material) return;
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    for (const m of mats) if (m && 'wireframe' in m) m.wireframe = true;
                });
            }
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
        // Reuse a cached Color — setClearColor accepts a mutable Color, so we
        // avoid allocating a fresh one per frame.
        if (!g._clearColor) g._clearColor = new THREE.Color();
        g._clearColor.setRGB(r, gv, b);
        t.renderer.setClearColor(g._clearColor, 1);
        t.renderer.clear();
        return CMD_OK;
    }

    cmdGL_PERSPECTIVE(param) {
        const g = this._glState();
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 2);
        g.fov = p[0] || 60;
        if (ntok > 1 && p[1] > 0) g.far = p[1];   // optional far clip plane
        if (g.three) {
            g.three.camera.fov = g.fov;
            if (g.far) g.three.camera.far = g.far;
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
            this._glReorientCamera();
        }
        return CMD_OK;
    }

    cmdGL_LOOKAT(param) {
        const p = this._glParseFloats(param, 3);
        const g = this._glState();
        g.lookat = [p[0]||0, p[1]||0, p[2]||0];
        if (g.three) this._glReorientCamera();
        return CMD_OK;
    }

    // GL.CAMERAROLL deg — bank the camera, rolling it `deg` degrees about its
    // view axis (0 = level horizon). Persists until changed; GL.INIT resets it.
    // Used by flight-style programs (SKYFOX) so the horizon tilts on a turn.
    cmdGL_CAMERAROLL(param) {
        const g = this._glState();
        const deg = Number(this.evalCalc(this.trim(String(param != null ? param : '0')), ASS_NUMBER)) || 0;
        g.camRoll = deg * Math.PI / 180;
        if (g.three) this._glReorientCamera();
        return CMD_OK;
    }

    // Aim the camera at g.lookat, applying g.camRoll as a bank about the view
    // axis — rolls the `up` vector so Three.js lookAt tilts the whole horizon.
    _glReorientCamera() {
        const g = this._gl;
        if (!g || !g.three) return;
        const cam  = g.three.camera;
        const lk   = g.lookat || [0, 0, 0];
        const roll = g.camRoll || 0;
        if (!roll) {
            cam.up.set(0, 1, 0);
            cam.lookAt(lk[0], lk[1], lk[2]);
            return;
        }
        const cp = g.cam || [0, 0, 0];
        let fx = lk[0]-cp[0], fy = lk[1]-cp[1], fz = lk[2]-cp[2];
        const fl = Math.sqrt(fx*fx + fy*fy + fz*fz) || 1;
        fx/=fl; fy/=fl; fz/=fl;
        // right = normalize(forward × worldUp), worldUp = (0,1,0)
        let rx = -fz, rz = fx;
        const rl = Math.sqrt(rx*rx + rz*rz) || 1;
        rx/=rl; rz/=rl;
        // trueUp = right × forward  (right has zero Y component)
        const ux = -rz*fy;
        const uy = rz*fx - rx*fz;
        const uz = rx*fy;
        const c = Math.cos(roll), s = Math.sin(roll);
        cam.up.set(ux*c + rx*s, uy*c, uz*c + rz*s);
        cam.lookAt(lk[0], lk[1], lk[2]);
    }

    cmdGL_COLOUR(param) {
        const p = this._glParseFloats(param, 3);
        const c = v => Math.max(0, Math.min(255, Math.round(v || 0)));
        // NOTE: 0 is a valid channel value — do NOT default it to 255 (that turned
        // GL.COLOUR 0,0,0 white and GL.COLOUR 0,n,n pink/magenta).
        this._glState().colour = [c(p[0]), c(p[1]), c(p[2])];
        return CMD_OK;
    }

    cmdGL_WIRE()      { this._glState().mode = 'wire';      return CMD_OK; }
    cmdGL_SOLID()     { this._glState().mode = 'solid';     return CMD_OK; }
    cmdGL_SOLIDWIRE() { this._glState().mode = 'solidwire'; return CMD_OK; }

    // GL.WIREALL flag — 1: render every mesh in the scene as a wireframe with no
    // lighting (full ambient, directional light off);  0: restore shading + lights.
    cmdGL_WIREALL(param) {
        const flag = !!Math.round(Number(this.evalCalc(this.trim(String(param||'0')), ASS_NUMBER)));
        const g = this._glState();
        g.forceWire = flag;
        const t = g.three;
        if (t && t.scene) {
            t.scene.traverse(obj => {
                if (!obj.material) return;
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) if (m && 'wireframe' in m) m.wireframe = flag;
            });
            if (flag) {
                if (t._savedAmbInt === undefined && t.ambientLight) t._savedAmbInt = t.ambientLight.intensity;
                if (t._savedDirInt === undefined && t.dirLight)     t._savedDirInt = t.dirLight.intensity;
                if (t.ambientLight) t.ambientLight.intensity = 1.0;
                if (t.dirLight)     t.dirLight.intensity     = 0;
            } else {
                if (t.ambientLight && t._savedAmbInt !== undefined) t.ambientLight.intensity = t._savedAmbInt;
                if (t.dirLight     && t._savedDirInt !== undefined) t.dirLight.intensity     = t._savedDirInt;
                t._savedAmbInt = undefined; t._savedDirInt = undefined;
            }
        }
        return CMD_OK;
    }

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

    // GL.LIGHTOFF — turn the directional light off (ambient + emissives still apply)
    cmdGL_LIGHTOFF() {
        const g = this._glState();
        g.light = null;
        if (g.three && g.three.dirLight) g.three.dirLight.intensity = 0;
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
            // YXZ order = yaw, then pitch and roll about the craft's OWN
            // (body) axes — the standard aerospace sequence. Pitch stays a
            // clean nose-up/down no matter which way the craft is heading.
            // Single-axis rotations are identical under any order, so other
            // programs (TRON, decorative spinners) are unaffected.
            for (const obj of m._threeObjects)
                obj.rotation.set(m.rx*D, m.ry*D, m.rz*D, 'YXZ');
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
        this._glRenderFrame(t);
        return CMD_OK;
    }

    cmdGL_DRAWALL() {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        for (const m of Object.values(g.meshes)) {
            if (!m._threeObjects || m._builtMode !== g.mode) {
                if (!m._isSphere && !m._isChrome && !m._isTemplate) this._glSyncMesh(m, g);
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
        this._glRenderFrame(t);
        return CMD_OK;
    }

    // Render one frame — through the bloom EffectComposer if active, else direct.
    // Also drives the optional ticks/sec overlay (set up by GL.FPS — note this
    // counts GL.DRAWALL invocations, not painted frames; see GL.RFPS for that).
    // Sets the kernel's _glJustRendered flag so the next _scheduleNextTick can
    // promote a short setTimeout to requestAnimationFrame for vsync alignment.
    _glRenderFrame(t) {
        if (this._gl && this._gl.fpsOn && this._fpsDiv) {
            const g = this._gl;
            g._fpsFrames = (g._fpsFrames || 0) + 1;
            const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            if (!g._fpsLast) g._fpsLast = now;
            const dt = now - g._fpsLast;
            if (dt >= 500) {
                this._fpsDiv.textContent = 'Ticks per second: ' + Math.round(g._fpsFrames * 1000 / dt);
                g._fpsFrames = 0;
                g._fpsLast = now;
            }
        }
        if (this._gl && (this._gl._clouds || this._gl._sky)) {
            const nw = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            if (this._gl._clouds) {
                const cl = this._gl._clouds;
                cl.material.uniforms.uTime.value = nw * 0.001;
                cl.position.x = t.camera.position.x;   // cloud box follows the
                cl.position.z = t.camera.position.z;   // camera; noise is world-space
            }
            if (this._gl._sky) this._gl._sky.material.uniforms.time.value = nw * 0.001;
        }
        if (t.composer) t.composer.render();
        else t.renderer.render(t.scene, t.camera);
        this._glJustRendered = true;
    }

    // Ensure an EffectComposer (RenderPass only) exists on `t`. Once active, frames render through
    // it and the canvas's hardware MSAA is bypassed (so GL.AA controls anti-aliasing instead).
    _glEnsureComposer(t) {
        if (t.composer) return t.composer;
        if (!THREE.EffectComposer || !THREE.RenderPass) return null;
        const c = new THREE.EffectComposer(t.renderer);
        c.addPass(new THREE.RenderPass(t.scene, t.camera));
        t.composer = c;
        return c;
    }

    // GL.BLOOM strength [, radius [, threshold]] — post-process bloom glow. strength 0 = off.
    cmdGL_BLOOM(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 3);
        const strength = p[0] || 0;
        if (strength <= 0) {
            if (t.composer && t.bloomPass) { t.composer.removePass(t.bloomPass); t.bloomPass = null; }
            return CMD_OK;
        }
        if (!THREE.UnrealBloomPass) return CMD_OK; // post-fx libs not loaded
        const c = this._glEnsureComposer(t);
        if (!c) return CMD_OK;
        const radius    = ntok > 1 ? p[1] : 0.4;
        const threshold = ntok > 2 ? p[2] : 0.3;
        if (!t.bloomPass) {
            const sz = new THREE.Vector2(); t.renderer.getDrawingBufferSize(sz);
            t.bloomPass = new THREE.UnrealBloomPass(sz, strength, radius, threshold);
            c.insertPass(t.bloomPass, 1);   // right after the RenderPass
        } else {
            t.bloomPass.strength = strength; t.bloomPass.radius = radius; t.bloomPass.threshold = threshold;
        }
        return CMD_OK;
    }

    // GL.AA flag — anti-aliasing via an FXAA post-process pass. 1 = on, 0 = off (aliased).
    // Uses the EffectComposer (creating it if needed); cheap, so it doesn't cost the speed.
    cmdGL_AA(param) {
        const on = !!Math.round(Number(this.evalCalc(this.trim(String(param != null ? param : '0')), ASS_NUMBER)));
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        g.aaOn = on;
        if (on) {
            if (!THREE.FXAAShader || !THREE.ShaderPass) return CMD_OK;
            const c = this._glEnsureComposer(t);
            if (!c) return CMD_OK;
            if (!t.fxaaPass) {
                const sz = new THREE.Vector2(); t.renderer.getDrawingBufferSize(sz);
                t.fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
                t.fxaaPass.material.uniforms['resolution'].value.set(1 / Math.max(1, sz.x), 1 / Math.max(1, sz.y));
                c.addPass(t.fxaaPass);   // append — runs after the scene render + bloom
            }
        } else if (t.composer && t.fxaaPass) {
            t.composer.removePass(t.fxaaPass);
            t.fxaaPass = null;
        }
        return CMD_OK;
    }

    // GL.FPS flag — 1: show a "Ticks per second: N" overlay (top-right); 0: hide it.
    // Counts GL.DRAWALL invocations (kernel cadence), NOT painted frames. For
    // the real, vsync-aligned framerate use GL.RFPS instead.
    // System-level — the counting and the overlay live here, not in BASIC.
    cmdGL_FPS(param) {
        const on = !!Math.round(Number(this.evalCalc(this.trim(String(param != null ? param : '0')), ASS_NUMBER)));
        const g = this._glState();
        g.fpsOn = on;
        if (on) {
            if (!this._fpsDiv) {
                const d = document.createElement('div');
                d.style.cssText = 'position:fixed;top:28px;right:10px;font-family:monospace;font-size:14px;color:#3f7;text-shadow:0 0 4px #000,0 0 4px #000;z-index:99999;pointer-events:none;';
                d.textContent = 'Ticks per second: --';
                document.body.appendChild(d);
                this._fpsDiv = d;
            }
            this._fpsDiv.style.display = 'block';
            g._fpsFrames = 0; g._fpsLast = 0;
        } else if (this._fpsDiv) {
            this._fpsDiv.style.display = 'none';
        }
        return CMD_OK;
    }

    // Hide both FPS overlays and stop the RFPS rAF loop. Called from the
    // terminal's _onProgramStop so a program that ended (or was Ctrl+C'd)
    // mid-flight never leaves a floating counter on screen for the next
    // program / OK prompt.
    _hideFpsOverlays() {
        if (this._fpsDiv) {
            this._fpsDiv.style.display = 'none';
            if (this._gl) this._gl.fpsOn = false;
        }
        if (this._rfpsDiv) this._rfpsDiv.style.display = 'none';
        if (this._rfpsRAF) { cancelAnimationFrame(this._rfpsRAF); this._rfpsRAF = 0; }
    }

    // GL.RFPS flag — 1: show a "Frames per second: N" overlay measured against
    // requestAnimationFrame (true painted-frame rate); 0: hide it.
    // Independent of GL command activity — keeps ticking even when BASIC is
    // idle in a SLEEP, so you see what the browser is actually painting.
    cmdGL_RFPS(param) {
        const on = !!Math.round(Number(this.evalCalc(this.trim(String(param != null ? param : '0')), ASS_NUMBER)));
        if (on) {
            if (!this._rfpsDiv) {
                const d = document.createElement('div');
                d.style.cssText = 'position:fixed;top:6px;right:10px;font-family:monospace;font-size:14px;color:#3f7;text-shadow:0 0 4px #000,0 0 4px #000;z-index:99999;pointer-events:none;';
                d.textContent = 'Frames per second: --';
                document.body.appendChild(d);
                this._rfpsDiv = d;
            }
            this._rfpsDiv.style.display = 'block';
            this._rfpsFrames = 0;
            this._rfpsLast = 0;
            if (this._rfpsRAF) cancelAnimationFrame(this._rfpsRAF);
            const loop = () => {
                if (!this._rfpsDiv || this._rfpsDiv.style.display === 'none') {
                    this._rfpsRAF = 0;
                    return;
                }
                this._rfpsFrames = (this._rfpsFrames || 0) + 1;
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                if (!this._rfpsLast) this._rfpsLast = now;
                const dt = now - this._rfpsLast;
                if (dt >= 500) {
                    this._rfpsDiv.textContent = 'Frames per second: ' + Math.round(this._rfpsFrames * 1000 / dt);
                    this._rfpsFrames = 0;
                    this._rfpsLast = now;
                }
                this._rfpsRAF = requestAnimationFrame(loop);
            };
            this._rfpsRAF = requestAnimationFrame(loop);
        } else if (this._rfpsDiv) {
            this._rfpsDiv.style.display = 'none';
            if (this._rfpsRAF) { cancelAnimationFrame(this._rfpsRAF); this._rfpsRAF = 0; }
        }
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
        const c = v => Math.max(0, Math.min(255, Math.round(v || 0)));
        this._glState().wireColor = [c(p[0]), c(p[1]), c(p[2])];
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
        const c = v => Math.max(0, Math.min(255, Math.round(v || 0)));
        const ntok = String(param || '').split(',').length;
        if (ntok <= 3) {
            // GL.EMISSIVE r,g,b — self-glow colour for subsequently built meshes
            const p = this._glParseFloats(param, 3);
            g.emissive = [c(p[0]), c(p[1]), c(p[2])];
            return CMD_OK;
        }
        // GL.EMISSIVE id, r, g, b — recolour an existing mesh's emissive (used with GL.EMISSIVEMAP)
        const p = this._glParseFloats(param, 4);
        const id = Math.round(p[0]);
        const m = g.meshes[id];
        if (!m) return CMD_OK;
        const r = c(p[1])/255, gv = c(p[2])/255, b = c(p[3])/255;
        m.emissiveColor = [c(p[1]), c(p[2]), c(p[3])];
        if (m._threeObjects) {
            for (const obj of m._threeObjects) {
                obj.traverse(o => {
                    if (!o.material) return;
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    for (const mm of mats) {
                        if (mm && mm.emissive) { mm.emissive.setRGB(r, gv, b); mm.needsUpdate = true; }
                    }
                });
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
            // traverse() so this also reaches the child meshes of a GL.LOAD
            // model — its _threeObjects[0] is a pivot Group, not a mesh, so a
            // flat .material check would silently skip every loaded model.
            for (const obj of m._threeObjects) {
                obj.traverse((c) => {
                    if (!c.material) return;
                    const mats = Array.isArray(c.material) ? c.material : [c.material];
                    for (const mt of mats) {
                        if (mt && mt.emissiveIntensity !== undefined) {
                            mt.emissiveIntensity = val;
                            mt.needsUpdate = true;
                        }
                    }
                });
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
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 8);
        const cc = v => Math.max(0, Math.min(255, v)) / 255;
        // r/g/b default to white only when actually omitted (0 is a valid channel)
        const r  = ntok > 3 ? cc(p[3]) : 1;
        const gv = ntok > 4 ? cc(p[4]) : 1;
        const b  = ntok > 5 ? cc(p[5]) : 1;
        const intensity = ntok > 6 ? p[6] : 2;
        const distance  = ntok > 7 ? p[7] : 10; // 0=infinite
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

    // GL.HEADLIGHT x,y,z [, r,g,b [, intensity [, distance]]]
    // Like GL.POINTLIGHT, but a single cached light (with shadow map) that the
    // command repositions on every call instead of allocating a new one. The
    // first call creates the light + 512x512 shadow render target; subsequent
    // calls only update position/colour/intensity/distance. Designed for the
    // common "torchlight follows the player" pattern, replacing the per-frame
    // GL.LIGHTSOFF + GL.POINTLIGHT pair (which was burning a fresh shadow map
    // every frame). Survives in the scene until GL.LIGHTSOFF / GL.INIT.
    cmdGL_HEADLIGHT(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 8);
        const cc = v => Math.max(0, Math.min(255, v)) / 255;
        const r  = ntok > 3 ? cc(p[3]) : 1;
        const gv = ntok > 4 ? cc(p[4]) : 1;
        const b  = ntok > 5 ? cc(p[5]) : 1;
        const intensity = ntok > 6 ? p[6] : 2;
        const distance  = ntok > 7 ? p[7] : 10;
        let light = g._headlight;
        if (!light) {
            light = new THREE.PointLight(new THREE.Color(r, gv, b), intensity, distance, 1);
            light.castShadow = true;
            light.shadow.mapSize.width  = 512;
            light.shadow.mapSize.height = 512;
            light.shadow.bias = -0.002;
            t.scene.add(light);
            g._headlight = light;
        } else {
            light.color.setRGB(r, gv, b);
            light.intensity = intensity;
            light.distance  = distance;
        }
        light.position.set(p[0]||0, p[1]||0, p[2]||0);
        return CMD_OK;
    }

    // GL.RECTLIGHT x,y,z, w,h [, r,g,b [, intensity]] — rectangular area light, faces straight down.
    // NOTE: RectAreaLight only affects MeshStandardMaterial / MeshPhysicalMaterial (e.g. loaded GLTF
    // models) — it does NOT light MeshPhong geometry (GL.BEGIN/END meshes). Cleared by GL.LIGHTSOFF.
    cmdGL_RECTLIGHT(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        if (THREE.RectAreaLightUniformsLib && !g._rectLibInit) { THREE.RectAreaLightUniformsLib.init(); g._rectLibInit = true; }
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 9);
        const cc = v => Math.max(0, Math.min(255, v)) / 255;
        const w = ntok > 3 ? (p[3] || 1) : 1;
        const h = ntok > 4 ? (p[4] || 1) : 1;
        const r  = ntok > 5 ? cc(p[5]) : 1;
        const gv = ntok > 6 ? cc(p[6]) : 1;
        const b  = ntok > 7 ? cc(p[7]) : 1;
        const intensity = ntok > 8 ? p[8] : 5;
        const light = new THREE.RectAreaLight(new THREE.Color(r, gv, b), intensity, w, h);
        light.position.set(p[0]||0, p[1]||0, p[2]||0);
        light.lookAt((p[0]||0), (p[1]||0) - 100, (p[2]||0));  // emit straight down
        t.scene.add(light);
        if (!g.rectLights) g.rectLights = [];
        g.rectLights.push(light);
        return CMD_OK;
    }

// GL.LIGHTSOFF — remove all point lights, rect lights, and the headlight
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
        if (g.three && g.rectLights) {
            for (const l of g.rectLights) { l.dispose(); g.three.scene.remove(l); }
            g.rectLights = [];
        }
        if (g.three && g._headlight) {
            const l = g._headlight;
            if (l.shadow && l.shadow.map) l.shadow.map.dispose();
            l.dispose();
            g.three.scene.remove(l);
            g._headlight = null;
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
        // keep GL.TERRAIN's own (shader-baked) fog in sync with the scene fog
        if (g._terrain && g._terrain.material.uniforms && g._terrain.material.uniforms.uFog) {
            const tu = g._terrain.material.uniforms;
            tu.uFog.value.copy(fogColor);
            tu.uFogNear.value = p[3] || 5;
            tu.uFogFar.value  = p[4] || 20;
        }
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
        // push GL.TERRAIN's shader fog out of range so it reads as off too
        if (g._terrain && g._terrain.material.uniforms && g._terrain.material.uniforms.uFog) {
            g._terrain.material.uniforms.uFogNear.value = 1.0e8;
            g._terrain.material.uniforms.uFogFar.value  = 1.0e9;
        }
        return CMD_OK;
    }

// GL.CLOUDS flag [, coverage [, altitude [, thickness]]] — raymarched
// volumetric clouds. A self-contained ShaderMaterial on a camera-following
// box; no external libraries. flag 0 removes the layer. coverage is 0..1 sky
// cover, altitude is the cloud band's base Y, thickness its height. The
// raymarch cost scales with on-screen cloud area — step counts are kept
// modest (see _cloudFragSrc); lower them if it costs too much speed.
    cmdGL_CLOUDS(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 4);
        if (g._clouds) {
            t.scene.remove(g._clouds);
            if (g._clouds.geometry) g._clouds.geometry.dispose();
            if (g._clouds.material) g._clouds.material.dispose();
            g._clouds = null;
        }
        if (!(p[0] > 0)) return CMD_OK;
        const coverage  = ntok > 1 ? Math.max(0, Math.min(1, p[1])) : 0.5;
        const altitude  = ntok > 2 ? p[2] : 50;
        const thickness = ntok > 3 ? Math.max(2, p[3]) : 40;
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:     { value: 0 },
                uCoverage: { value: coverage },
                uBase:     { value: altitude },
                uTop:      { value: altitude + thickness },
                uSunDir:   { value: new THREE.Vector3(0.45, 0.78, 0.44).normalize() },
                uCloudCol: { value: new THREE.Color(1.0, 1.0, 1.04) },
                uShadeCol: { value: new THREE.Color(0.40, 0.45, 0.58) }
            },
            vertexShader:   this._cloudVertSrc(),
            fragmentShader: this._cloudFragSrc(),
            transparent: true,
            depthWrite:  false,
            depthTest:   true,
            side:        THREE.BackSide
        });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(9000, thickness, 9000), mat);
        mesh.position.set(0, altitude + thickness * 0.5, 0);
        mesh.frustumCulled = false;
        mesh.renderOrder   = 999;
        t.scene.add(mesh);
        g._clouds = mesh;
        return CMD_OK;
    }

    _cloudVertSrc() {
        return `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
    }

    _cloudFragSrc() {
        return `
varying vec3 vWorld;
uniform float uTime;
uniform float uCoverage;
uniform float uBase;
uniform float uTop;
uniform vec3  uSunDir;
uniform vec3  uCloudCol;
uniform vec3  uShadeCol;
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i+vec3(0.0,0.0,0.0)), hash(i+vec3(1.0,0.0,0.0)), f.x),
                 mix(hash(i+vec3(0.0,1.0,0.0)), hash(i+vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(hash(i+vec3(0.0,0.0,1.0)), hash(i+vec3(1.0,0.0,1.0)), f.x),
                 mix(hash(i+vec3(0.0,1.0,1.0)), hash(i+vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 9.1;
    a *= 0.5;
  }
  return v;
}
float cloud(vec3 p) {
  vec3 q = p * 0.012 + vec3(uTime * 0.015, uTime * 0.004, uTime * 0.01);
  float n = fbm(q);
  float d = n - (1.0 - uCoverage);
  float h = clamp((p.y - uBase) / (uTop - uBase), 0.0, 1.0);
  float fall = smoothstep(0.0, 0.18, h) * smoothstep(1.0, 0.55, h);
  return clamp(d, 0.0, 1.0) * fall;
}
void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  float t0;
  float t1;
  if (abs(rd.y) < 0.0001) {
    if (ro.y < uBase || ro.y > uTop) discard;
    t0 = 0.0;
    t1 = 4000.0;
  } else {
    float ta = (uBase - ro.y) / rd.y;
    float tb = (uTop - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  if (t1 <= t0) discard;
  t1 = min(t1, t0 + 12000.0);
  const int STEPS = 40;
  float dt = (t1 - t0) / float(STEPS);
  float t = t0 + dt * hash(vWorld);
  float trans = 1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 pos = ro + rd * t;
    float dens = cloud(pos);
    if (dens > 0.01) {
      float ls = 0.0;
      vec3 lp = pos;
      for (int j = 0; j < 4; j++) {
        lp += uSunDir * 26.0;
        ls += cloud(lp);
      }
      float light = exp(-ls * 1.4);
      vec3 c = mix(uShadeCol, uCloudCol, light);
      float od = dens * dt * 0.06 * (1.0 - smoothstep(3500.0, 13000.0, t));
      float ab = 1.0 - exp(-od);
      col += trans * ab * c;
      trans *= 1.0 - ab;
    }
    if (trans < 0.03) break;
    t += dt;
  }
  float alpha = 1.0 - trans;
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(col, alpha);
}`;
    }

// GL.SKY flag [, elevation [, azimuth [, turbidity [, cloudCover]]]] — Preetham
// atmospheric sky dome + sun + procedural (screen-projected, non-volumetric)
// clouds, via the vendored three.js Sky addon. flag 0 removes it. elevation /
// azimuth place the sun in degrees; turbidity is haze (1-20); cloudCover 0..1.
// Pairs with GL.CLOUDS — Sky gives the high painted backdrop, GL.CLOUDS the
// near volumetric layer — for depth.
    cmdGL_SKY(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 5);
        if (g._sky) {
            t.scene.remove(g._sky);
            if (g._sky.material) g._sky.material.dispose();
            if (g._sky.geometry) g._sky.geometry.dispose();
            g._sky = null;
        }
        if (!(p[0] > 0)) return CMD_OK;
        if (typeof THREE.Sky !== 'function') {
            this.appendLine('GL.SKY: Sky addon not loaded', 1);
            return CMD_OK;
        }
        // defaults match the official three.js webgl_shaders_sky example
        const elevation = ntok > 1 ? p[1] : 2;
        const azimuth   = ntok > 2 ? p[2] : 180;
        const turbidity = ntok > 3 ? p[3] : 10;
        const cover     = ntok > 4 ? Math.max(0, Math.min(1, p[4])) : 0.4;
        const sky = new THREE.Sky();
        sky.scale.setScalar(450000);
        sky.frustumCulled = false;
        const u = sky.material.uniforms;
        u['turbidity'].value       = turbidity;
        u['rayleigh'].value        = 3;
        u['mieCoefficient'].value  = 0.005;
        u['mieDirectionalG'].value = 0.7;
        u['cloudCoverage'].value   = cover;
        const phi   = (90 - elevation) * Math.PI / 180;
        const theta = azimuth * Math.PI / 180;
        u['sunPosition'].value.setFromSphericalCoords(1, phi, theta);
        t.scene.add(sky);
        g._sky = sky;
        return CMD_OK;
    }

// GL.TERRAIN flag [, size [, segments [, height [, cx [, cz]]]]] — replaces a
// flat floor with a static noise heightmap. Wireframe-hills look: a solid
// surface shaded dark valleys -> blue peaks, with a barycentric triangle
// wireframe. segments = grid resolution per side; height = peak height;
// cx/cz = world centre. Adapted from the terrain.zip sample — de-scrolled,
// CPU-baked heightmap, self-contained (no external libraries).
    cmdGL_TERRAIN(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        const ntok = String(param || '').split(',').length;
        const p = this._glParseFloats(param, 8);
        const disposeTerrain = () => {
            if (!g._terrain) return;
            t.scene.remove(g._terrain);
            if (g._terrain.geometry) g._terrain.geometry.dispose();
            if (g._terrain.material) g._terrain.material.dispose();
            g._terrain = null;
        };
        if (!(p[0] > 0)) { disposeTerrain(); return CMD_OK; }
        const size   = ntok > 1 ? p[1] : 2000;
        const segs   = ntok > 2 ? Math.max(2, Math.min(240, Math.round(p[2]))) : 64;
        const height = ntok > 3 ? p[3] : 30;
        const hills  = ntok > 4 ? Math.max(1, p[4]) : 16;
        const cx     = ntok > 5 ? p[5] : 0;
        const cz     = ntok > 6 ? p[6] : 0;
        const mode   = ntok > 7 ? (p[7] > 0 ? 1 : 0) : 1;   // 1 = grid, 0 = shaded
        // identical geometry already built -> just flip grid/shaded mode, no rebuild
        if (g._terrain && g._terrain._tparams && g._terrain.parent === t.scene) {
            const tp = g._terrain._tparams;
            if (tp[0] === size && tp[1] === segs && tp[2] === height &&
                tp[3] === hills && tp[4] === cx && tp[5] === cz) {
                g._terrain.material.uniforms.uGrid.value = mode;
                return CMD_OK;
            }
        }
        disposeTerrain();
        // value-noise FBM heightmap
        const frac = (v) => v - Math.floor(v);
        const hash = (x, z) => frac(Math.sin(x * 127.1 + z * 311.7) * 43758.5453);
        const vnoise = (x, z) => {
            const xi = Math.floor(x), zi = Math.floor(z);
            const xf = x - xi, zf = z - zi;
            const u = xf * xf * (3 - 2 * xf), w = zf * zf * (3 - 2 * zf);
            const a = hash(xi, zi),     b = hash(xi + 1, zi);
            const c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
            return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
        };
        const fbm = (x, z) => {
            let v = 0, amp = 0.5, f = 1, norm = 0;
            for (let i = 0; i < 5; i++) { v += amp * vnoise(x * f, z * f); norm += amp; f *= 2; amp *= 0.68; }
            return v / norm;   // slower amp falloff -> rougher, less-smoothed hills
        };
        const freq = hills / size;
        const heightAt = (x, z) => {
            let n = fbm(x * freq, z * freq);
            n = n < 0 ? 0 : (n > 1 ? 1 : n);
            return Math.pow(n, 1.3) * height;       // gentle valley flatten, rolling hills
        };
        // precompute the (segs+1)^2 height grid
        const half = size * 0.5, step = size / segs;
        const hg = [];
        for (let iz = 0; iz <= segs; iz++) {
            const row = [];
            for (let ix = 0; ix <= segs; ix++) row.push(heightAt(-half + ix * step, -half + iz * step));
            hg.push(row);
        }
        // non-indexed grid; each triangle vertex carries a barycentric centre
        const pos = [], cen = [];
        for (let iz = 0; iz < segs; iz++) {
            for (let ix = 0; ix < segs; ix++) {
                const x0 = -half + ix * step, x1 = x0 + step;
                const z0 = -half + iz * step, z1 = z0 + step;
                const y00 = hg[iz][ix],         y10 = hg[iz][ix + 1];
                const y11 = hg[iz + 1][ix + 1], y01 = hg[iz + 1][ix];
                pos.push(x0, y00, z0,  x1, y10, z0,  x1, y11, z1);
                pos.push(x0, y00, z0,  x1, y11, z1,  x0, y01, z1);
                cen.push(1,0,0, 0,1,0, 0,0,1,  1,0,0, 0,1,0, 0,0,1);
            }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('center',   new THREE.Float32BufferAttribute(cen, 3));
        // distance fog — match the scene fog (GL.FOG) so terrain fades into it
        const fg = g.fog;
        const fogColor = fg ? new THREE.Color(fg.r / 255, fg.g / 255, fg.b / 255)
                            : new THREE.Color(0.62, 0.66, 0.74);
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uLow:  { value: new THREE.Color(0.016, 0.024, 0.063) },
                uHigh: { value: new THREE.Color(0.10, 0.32, 0.78) },
                uWire: { value: new THREE.Color(0.35, 0.62, 1.0) },
                uMaxH: { value: Math.max(1, height) },
                uGrid:    { value: mode },
                uFog:     { value: fogColor },
                uFogNear: { value: fg ? fg.near : 300 },
                uFogFar:  { value: fg ? fg.far  : 1600 }
            },
            vertexShader:   this._terrainVertSrc(),
            fragmentShader: this._terrainFragSrc(),
            side: THREE.DoubleSide,
            extensions: { derivatives: true }
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cx, 0, cz);
        mesh.frustumCulled = false;
        mesh._tparams = [size, segs, height, hills, cx, cz];
        t.scene.add(mesh);
        g._terrain = mesh;
        return CMD_OK;
    }

    _terrainVertSrc() {
        return `
attribute vec3 center;
varying vec3 vCenter;
varying float vH;
varying float vDist;
void main() {
  vCenter = center;
  vH = position.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
    }

    _terrainFragSrc() {
        return `
varying vec3 vCenter;
varying float vH;
varying float vDist;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uWire;
uniform float uMaxH;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform float uGrid;
float edgeFactor() {
  vec3 d = fwidth(vCenter);
  vec3 a3 = smoothstep(vec3(0.0), d * 1.3, vCenter);
  return min(min(a3.x, a3.y), a3.z);
}
void main() {
  float h = clamp(vH / uMaxH, 0.0, 1.0);
  vec3 base = mix(uLow, uHigh, h);
  float e = edgeFactor();
  vec3 col = mix(base, mix(uWire, base, e), uGrid);
  col = mix(col, uFog, smoothstep(uFogNear, uFogFar, vDist));
  gl_FragColor = vec4(col, 1.0);
}`;
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

// GL.POLYHEDRON type$, radius — Kepler–Poinsot star polyhedron.
// `type$` is one of:
//   "SSD" — small stellated dodecahedron  {5/2, 5}  (12 stubby pentagonal pyramids on an inner dodec)
//   "GSD" — great stellated dodecahedron  {5/2, 3}  (12 sharp pentagonal pyramids on a smaller inner dodec)
//   "GI"  — great icosahedron             {3, 5/2}  (20 triangular pyramids on an inner icos)
//   "GD"  — great dodecahedron            {5, 5/2}  (icos with inward triangular dimples on each face)
// `radius` is the circumradius (distance from centre to outermost surface
// point — spike tip for SSD/GSD/GI, icos vertex for GD).
// Uses current GL colour / shine / emissive / alpha and mode settings.
// Each builder produces 60 triangles; visible silhouettes match the standard
// Kepler–Poinsot proportions to within φ-based golden-ratio scaling.
    cmdGL_POLYHEDRON(param) {
        const g = this._glState();
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;

        // Parse type$ (first arg, string) and radius (second arg, number).
        const raw = this.trim(String(param||''));
        if (!raw) return CMD_OK;
        const ci = raw.indexOf(',');
        let typeRaw = ci >= 0 ? this.trim(raw.substring(0, ci)) : raw;
        const restRaw = ci >= 0 ? this.trim(raw.substring(ci+1)) : '';
        if (typeRaw.startsWith('"') && typeRaw.endsWith('"')) typeRaw = typeRaw.slice(1,-1);
        else typeRaw = String(this.lookup_(ASS_STRING, typeRaw.toUpperCase()) || typeRaw);
        const type = String(typeRaw).trim().toUpperCase();
        const radius = restRaw ? Number(this.evalCalc(restRaw, ASS_NUMBER)) || 1 : 1;

        const phi = (1 + Math.sqrt(5)) / 2;
        const inv = 1 / phi;
        const sq3 = Math.sqrt(3);
        const icosLen = Math.sqrt(1 + phi*phi);

        // ---- Inner polyhedron vertex sets (unit circumradius, before scale) ----
        const dodecUnit = [
            [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
            [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
            [0, inv, phi], [0, inv, -phi], [0, -inv, phi], [0, -inv, -phi],
            [inv, phi, 0], [inv, -phi, 0], [-inv, phi, 0], [-inv, -phi, 0],
            [phi, 0, inv], [phi, 0, -inv], [-phi, 0, inv], [-phi, 0, -inv],
        ].map(v => [v[0]/sq3, v[1]/sq3, v[2]/sq3]);

        const icosUnit = [
            [0, 1, phi], [0, 1, -phi], [0, -1, phi], [0, -1, -phi],
            [1, phi, 0], [1, -phi, 0], [-1, phi, 0], [-1, -phi, 0],
            [phi, 0, 1], [phi, 0, -1], [-phi, 0, 1], [-phi, 0, -1],
        ].map(v => [v[0]/icosLen, v[1]/icosLen, v[2]/icosLen]);

        // Face normals (unit length) for each base polyhedron:
        // Dodec faces: 12 directions (permuted icos-vertex set — see GSD bug
        //   from earlier audit; the standard icos set (0,±1,±φ) is wrong for
        //   the dodec vertex convention above).
        const dodecFaceNormals = [
            [0, phi, 1], [0, phi, -1], [0, -phi, 1], [0, -phi, -1],
            [1, 0, phi], [-1, 0, phi], [1, 0, -phi], [-1, 0, -phi],
            [phi, 1, 0], [phi, -1, 0], [-phi, 1, 0], [-phi, -1, 0],
        ].map(n => [n[0]/icosLen, n[1]/icosLen, n[2]/icosLen]);

        // Icos faces: 20 outward normal directions. NOT just the dodec vertex
        // set — for the standard-Cartesian icos/dodec coords used here, those
        // aren't truly dual; the icos face normals are the X↔Y-swapped variant
        // of the dodec verts. Verified analytically: face {v0,v2,v8} has
        // centroid at (1/φ, 0, φ)/√3, NOT (φ, 0, 1/φ)/√3 (a dodec vertex dir).
        // 8 cube corners + 12 swapped-φ directions = 20 face normals.
        const icosFaceNormals = [
            [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
            [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
            [0, phi, inv], [0, phi, -inv], [0, -phi, inv], [0, -phi, -inv],
            [inv, 0, phi], [-inv, 0, phi], [inv, 0, -phi], [-inv, 0, -phi],
            [phi, inv, 0], [phi, -inv, 0], [-phi, inv, 0], [-phi, -inv, 0],
        ].map(n => {
            const m = Math.sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);
            return [n[0]/m, n[1]/m, n[2]/m];
        });

        // ---- Pick configuration for the requested polyhedron ----
        // innerScale: scale factor on unit-circumradius inner verts.
        // faceVerts:  5 (pentagon base) or 3 (triangle base).
        // spikeDist:  distance from origin to spike tip along face normal.
        //             >0 → outward stellation,  >0 but < face_inradius → inward dimple.
        let innerVerts, faceNormals, faceVerts, spikeDist;
        switch (type) {
        case 'SSD':
            // Spike tip at radius; inner dodec sized so its inradius·φ ≈ radius.
            innerVerts  = dodecUnit.map(v => [v[0]*(radius/phi), v[1]*(radius/phi), v[2]*(radius/phi)]);
            faceNormals = dodecFaceNormals;
            faceVerts   = 5;
            spikeDist   = radius;
            break;
        case 'GSD':
            innerVerts  = dodecUnit.map(v => [v[0]*(radius/(phi*phi)), v[1]*(radius/(phi*phi)), v[2]*(radius/(phi*phi))]);
            faceNormals = dodecFaceNormals;
            faceVerts   = 5;
            spikeDist   = radius;
            break;
        case 'GI':
            // 20 triangular pyramids on a small inner icos; spike tips at radius.
            // Use the same φ² shrink as GSD so the spikes read as sharp star-points
            // rather than a knobbly icos — short spikes were misreading as
            // "backwards faces" from grazing angles.
            innerVerts  = icosUnit.map(v => [v[0]*(radius/(phi*phi)), v[1]*(radius/(phi*phi)), v[2]*(radius/(phi*phi))]);
            faceNormals = icosFaceNormals;
            faceVerts   = 3;
            spikeDist   = radius;
            break;
        case 'GD':
            // Icos at full radius; each triangular face dimples inward.
            // Icos inradius ≈ 0.795·R; place dimple bottom at ≈ 0.4·R so the
            // valleys are deep but don't pierce the opposite face.
            innerVerts  = icosUnit.map(v => [v[0]*radius, v[1]*radius, v[2]*radius]);
            faceNormals = icosFaceNormals;
            faceVerts   = 3;
            spikeDist   = radius * 0.40;
            break;
        default:
            this.appendLine('Unknown polyhedron type: ' + type + ' (use SSD, GSD, GI, or GD)', 1);
            return CMD_OK;
        }

        // ---- Build geometry: for each face, fan from spike tip to base edges ----
        const positions = [];
        for (const n of faceNormals) {
            // Top `faceVerts` verts by dot with n form this face's base.
            const sorted = innerVerts.map(v => ({ v, d: v[0]*n[0] + v[1]*n[1] + v[2]*n[2] }))
                                     .sort((a, b) => b.d - a.d)
                                     .slice(0, faceVerts)
                                     .map(x => x.v);
            const cx = sorted.reduce((s, v) => s + v[0], 0) / faceVerts;
            const cy = sorted.reduce((s, v) => s + v[1], 0) / faceVerts;
            const cz = sorted.reduce((s, v) => s + v[2], 0) / faceVerts;
            // (r0, r1, n) right-handed basis in the face plane — angles ↑ go CCW from +n side.
            let r0x = sorted[0][0]-cx, r0y = sorted[0][1]-cy, r0z = sorted[0][2]-cz;
            const r0len = Math.sqrt(r0x*r0x + r0y*r0y + r0z*r0z);
            r0x/=r0len; r0y/=r0len; r0z/=r0len;
            const r1x = n[1]*r0z - n[2]*r0y;
            const r1y = n[2]*r0x - n[0]*r0z;
            const r1z = n[0]*r0y - n[1]*r0x;
            const ordered = sorted.map(v => {
                const dx = v[0]-cx, dy = v[1]-cy, dz = v[2]-cz;
                const a = dx*r0x + dy*r0y + dz*r0z;
                const b = dx*r1x + dy*r1y + dz*r1z;
                return { v, ang: Math.atan2(b, a) };
            }).sort((a, b) => a.ang - b.ang).map(x => x.v);
            const tx = n[0]*spikeDist, ty = n[1]*spikeDist, tz = n[2]*spikeDist;
            // Same winding for outward spike and inward dimple. For a dimple,
            // the wall's outward normal points INTO the dimple opening (toward
            // the viewer looking in) — same +n hemisphere as an outward spike's
            // side. (v0,v1,tip) with CCW base from +n side gives this in both cases.
            for (let k = 0; k < faceVerts; k++) {
                const v0 = ordered[k];
                const v1 = ordered[(k+1) % faceVerts];
                positions.push(v0[0], v0[1], v0[2],
                               v1[0], v1[1], v1[2],
                               tx, ty, tz);
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.computeVertexNormals();

        const [r, gv, b] = g.colour;
        const color = new THREE.Color(r/255, gv/255, b/255);
        const opacity = g.alpha;
        const transparent = opacity < 1.0;
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
        // Arguments:  url$ [, rotX, rotY, rotZ]
        // url$ is a "literal" or a string variable. The optional rotations are a
        // one-time startup orientation (degrees) baked into the model node, so a
        // craft authored facing any direction sits correct in the clean rig.
        let raw = this.trim(String(param || ''));
        let url, rest = '';
        if (raw.charAt(0) === '"') {
            const close = raw.indexOf('"', 1);
            if (close < 0) return CMD_ESYNTAX;
            url = raw.slice(1, close);
            rest = raw.slice(close + 1);
        } else {
            const ci = raw.indexOf(',');
            if (ci >= 0) { url = raw.slice(0, ci); rest = raw.slice(ci); }
            else url = raw;
            url = String(this.lookup_(ASS_STRING, this.trim(url).toUpperCase()) || url);
        }
        url = this.trim(url);
        if (!url) return CMD_ESYNTAX;
        let corrX = 0, corrY = 0, corrZ = 0;
        rest = this.trim(rest);
        if (rest.charAt(0) === ',') rest = this.trim(rest.slice(1));
        if (rest) {
            const rp = rest.split(',');
            if (rp[0] != null && this.trim(rp[0]) !== '') corrX = Number(this.evalCalc(this.trim(rp[0]), ASS_NUMBER)) || 0;
            if (rp[1] != null && this.trim(rp[1]) !== '') corrY = Number(this.evalCalc(this.trim(rp[1]), ASS_NUMBER)) || 0;
            if (rp[2] != null && this.trim(rp[2]) !== '') corrZ = Number(this.evalCalc(this.trim(rp[2]), ASS_NUMBER)) || 0;
        }
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
                    // Two-node rig: inner model node + outer pivot Group.
                    //  - The model node carries a one-time startup rotation
                    //    (the optional GL.LOAD rot args) — its "own" rotation,
                    //    correcting whatever orientation the GLB was authored in.
                    //  - The pivot is re-centred on the *corrected* model's
                    //    bounding box, so the pivot origin is the geometric
                    //    centre. GL.ROTATE / GL.SCALE drive the pivot only — a
                    //    clean control frame, identical for any model swapped in.
                    model.position.set(0, 0, 0);
                    model.rotation.set(corrX * Math.PI / 180,
                                       corrY * Math.PI / 180,
                                       corrZ * Math.PI / 180);
                    model.updateMatrixWorld(true);
                    const box = new THREE.Box3().setFromObject(model);
                    const ctr = box.getCenter(new THREE.Vector3());
                    model.position.set(-ctr.x, -ctr.y, -ctr.z);
                    const pivot = new THREE.Group();
                    pivot.add(model);
                    t.scene.add(pivot);
                    const id = g.nextId++;
                    const fm = { id, verts: [], faces: [], colour: [255, 255, 255],
                        shine: 30, alpha: 1.0, emissive: [0, 0, 0],
                        tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1,
                        _threeObjects: [pivot], _builtMode: g.mode, _isSphere: true, _isLoaded: true };
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

// GL.INSTANCE srcId, x, y, z, dirX, dirY, dirZ
// Adds one GPU instance of mesh srcId at (x,y,z), with the template's local +X axis
// mapped onto the vector (dirX,dirY,dirZ) — so a unit segment 0..1 along +X becomes
// a segment of that length pointing that way. Local +Y stays world-vertical; local
// +Z becomes the *horizontal vector perpendicular to the X direction* (unit length),
// so any cross-section width in the template stays sideways-to-the-path. (Ideal for
// ribbons / beams / blades: the cross-section stays upright no matter how the path
// slopes, so consecutive segments share an exact edge — no seams.) The first call
// for a given srcId promotes that mesh into a THREE.InstancedMesh and removes the
// original from the scene — it becomes an invisible template whose geometry+material
// every instance shares. Subsequent calls just write one matrix and bump the count;
// the matrix buffer auto-doubles on overflow, so there's no hard segment cap.
    cmdGL_INSTANCE(param) {
        const g = this._glState();
        const p = this._glParseFloats(param, 7);
        const m = g.meshes[Math.round(p[0])];
        if (!m) return CMD_OK;
        const t = g.three || this._glSetupThree();
        if (!t) return CMD_OK;
        if (!m._instanced) {
            if (!m._threeObjects || m._builtMode !== g.mode) this._glSyncMesh(m, g);
            const src = m._threeObjects && m._threeObjects[0];
            if (!src || !src.geometry || !src.material) return CMD_OK;
            const inst = new THREE.InstancedMesh(src.geometry, src.material, 2048);
            inst.count = 0;
            inst.frustumCulled = false;
            for (const obj of m._threeObjects) t.scene.remove(obj);
            m._isTemplate = true;
            t.scene.add(inst);
            m._instanced = inst;
            if (!t._instMat) {
                t._instMat = new THREE.Matrix4();
                t._instX   = new THREE.Vector3();
                t._instY   = new THREE.Vector3(0, 1, 0);   // local Y -> world up
                t._instZ   = new THREE.Vector3(0, 0, 1);   // local Z -> path's horizontal perpendicular (set per call)
            }
        }
        let inst = m._instanced;
        const i = inst.count;
        // Grow (double) the matrix buffer rather than dropping instances on overflow.
        if (i >= inst.instanceMatrix.count) {
            const inst2 = new THREE.InstancedMesh(inst.geometry, inst.material, inst.instanceMatrix.count * 2);
            inst2.frustumCulled = false;
            for (let k = 0; k < i; k++) { inst.getMatrixAt(k, t._instMat); inst2.setMatrixAt(k, t._instMat); }
            inst2.count = i;
            inst2.instanceMatrix.needsUpdate = true;
            t.scene.remove(inst);
            if (typeof inst.dispose === 'function') inst.dispose();
            t.scene.add(inst2);
            m._instanced = inst2;
            inst = inst2;
        }
        let dx = p[4] || 0, dy = p[5] || 0, dz = p[6] || 0;
        if (dx === 0 && dy === 0 && dz === 0) dx = 1;        // degenerate guard
        t._instX.set(dx, dy, dz);
        const hl = Math.hypot(dx, dz);
        if (hl > 1e-6) t._instZ.set(-dz / hl, 0, dx / hl);   // unit horizontal perpendicular of (dx,_,dz)
        else t._instZ.set(0, 0, 1);
        t._instMat.makeBasis(t._instX, t._instY, t._instZ);
        t._instMat.setPosition(p[1] || 0, p[2] || 0, p[3] || 0);
        inst.setMatrixAt(i, t._instMat);
        inst.count = i + 1;
        inst.instanceMatrix.needsUpdate = true;
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

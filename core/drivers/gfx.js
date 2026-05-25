'use strict';

// ---------------------------------------------------------------------------
// GfxDriver  (drivers/gfx.js)
//
// Extracted from kernel.js as part of the V7 architecture refactor (Step 2b).
// Owns all 2D pixel drawing: CIRCLE, RECT, LINE, PSET, PAINT, COLOUR,
// the Three.js DataTexture pixel buffer, image store (LOADIMG/DISPLAY),
// and _activateGraphics.
// ---------------------------------------------------------------------------

class GfxDriver {

    constructor(host) {
        this._host           = host;
        this._gfx            = null;   // Three.js DataTexture 2D scene
        this._gfxColourTable = null;   // pre-built RGBA lookup for palette
        this._colourCache    = {};     // colour index → [r,g,b,a] cache
    }

    // ── Host state forwarders ──────────────────────────────────────────────
    get o()                { return this._host.o; }
    set o(v)          { this._host.o = v; }
    get canvas()           { return this._host.canvas; }
    set canvas(v)          { this._host.canvas = v; }
    get context()          { return this._host.context; }
    set context(v)          { this._host.context = v; }
    get width()            { return this._host.width; }
    set width(v)          { this._host.width = v; }
    get height()           { return this._host.height; }
    set height(v)          { this._host.height = v; }
    get colours()          { return this._host.colours; }
    set colours(v)          { this._host.colours = v; }
    get colour_fg_cursor() { return this._host.colour_fg_cursor; }
    set colour_fg_cursor(v)          { this._host.colour_fg_cursor = v; }
    get colour_bg_cursor() { return this._host.colour_bg_cursor; }
    set colour_bg_cursor(v)          { this._host.colour_bg_cursor = v; }
    get colour_bg()        { return this._host.colour_bg; }
    set colour_bg(v)          { this._host.colour_bg = v; }
    get _graphicsActive()  { return this._host._graphicsActive; }
    set _graphicsActive(v) { this._host._graphicsActive = v; }
    get _images()          { return this._host._images; }
    set _images(v)         { this._host._images = v; }
    get _spr()             { return this._host._spr; }
    get _glCanvas()        { return this._host._glCanvas; }
    get _objects()         { return this._host._objects; }
    set _objects(v)        { this._host._objects = v; }
    get _labels()          { return this._host._labels; }
    get running()          { return this._host.running; }
    set running(v)          { this._host.running = v; }
    get run_line()         { return this._host.run_line; }
    set run_line(v)        { this._host.run_line = v; }
    get want_ai()          { return this._host.want_ai; }
    set want_ai(v)         { this._host.want_ai = v; }
    get execute_timer()    { return this._host.execute_timer; }
    set execute_timer(v)   { this._host.execute_timer = v; }
    get prompt()           { return this._host.prompt; }
    set prompt(v)          { this._host.prompt = v; }
    get lines()            { return this._host.lines; }
    set lines(v)          { this._host.lines = v; }
    // Terminal input state (used by cmdLOCATE / _screenCls)
    get line_typed()       { return this._host.line_typed; }
    set line_typed(v)          { this._host.line_typed = v; }
    get cursor_pos()       { return this._host.cursor_pos; }
    set cursor_pos(v)          { this._host.cursor_pos = v; }
    get char_index()       { return this._host.char_index; }
    set char_index(v)          { this._host.char_index = v; }
    get want_input()       { return this._host.want_input; }
    set want_input(v)          { this._host.want_input = v; }
    get input_var()        { return this._host.input_var; }
    set input_var(v)          { this._host.input_var = v; }
    get input_var_type()   { return this._host.input_var_type; }
    set input_var_type(v)          { this._host.input_var_type = v; }
    get history()          { return this._host.history; }
    set history(v)          { this._host.history = v; }
    get history_line()     { return this._host.history_line; }
    set history_line(v)          { this._host.history_line = v; }

    // ── Host method forwarders ─────────────────────────────────────────────
    trim(s)                   { return this._host.trim(s); }
    appendLine(t, n)          { return this._host.appendLine(t, n); }
    evalCalc(a, b, c)         { return this._host.evalCalc(a, b, c); }
    lookup(n)                 { return this._host.lookup(n); }
    blink()                   { return this._host.blink(); }
    get fs()                  { return this._host.fs; }
    _scheduleNextTick()       { return this._host._scheduleNextTick(); }
    _skipToNextLine()         { return this._host._skipToNextLine(); }
    _redrawInputLine()        { return this._host._redrawInputLine(); }
    _scanLabels()             { return this._host._scanLabels(); }

    cmdCOLOUR(colours) {
        if (colours[0] != null) this.colour_fg_cursor = colours[0];
        if (colours[1] != null) this.colour_bg_cursor = colours[1];
        if (colours[2] != null) {
            this.colour_bg = colours[2];
            const target = this.canvas || this.o;
            if (target) target.style.background = this.colours[this.colour_bg];
        }
        return CMD_OK;
    }

    cmdCIRCLE(params) {
        if (params.length < 3) return CMD_ESYNTAX;
        this._activateGraphics();
        const cx  = Number(params[0]), cy  = Number(params[1]);
        const r   = Number(params[2]);
        const col = params.length > 3 ? Number(params[3]) : this.colour_fg_cursor;
        this._gfxScene();
        this._gfxCircle(cx, cy, r, this._gfxColour(col));
        this._gfxFlush();
        return CMD_OK;
    }

    cmdPOINT(params) {
        if (params.length < 2) return CMD_ESYNTAX;
        return this.cmdCIRCLE([params[0], params[1], 1]);
    }

// FILLCIRCLE x, y, r [, col] — draw a solid filled circle.
    cmdFILLCIRCLE(params) {
        if (params.length < 3) return CMD_ESYNTAX;
        this._activateGraphics();
        const col = params.length > 3 ? Number(params[3]) : this.colour_fg_cursor;
        this._gfxScene();
        this._gfxFillCircle(Number(params[0]), Number(params[1]),
                            Number(params[2]), this._gfxColour(col));
        this._gfxFlush();
        return CMD_OK;
    }

    cmdRECT(params) {
        if (params.length < 4) return CMD_ESYNTAX;
        this._activateGraphics();
        const col  = params.length > 4 ? Number(params[4]) : this.colour_fg_cursor;
        this._gfxScene();
        this._gfxRect(Number(params[0]), Number(params[1]),
                      Number(params[2]), Number(params[3]), this._gfxColour(col));
        this._gfxFlush();
        return CMD_OK;
    }

// FILLRECT x1,y1,x2,y2[,col] — draw a solid filled rectangle.
    cmdFILLRECT(params) {
        if (params.length < 4) return CMD_ESYNTAX;
        this._activateGraphics();
        const col  = params.length > 4 ? Number(params[4]) : this.colour_fg_cursor;
        this._gfxScene();
        this._gfxFillRect(Number(params[0]), Number(params[1]),
                          Number(params[2]), Number(params[3]), this._gfxColour(col));
        this._gfxFlush();
        return CMD_OK;
    }

    cmdLINE(params) {
        if (params.length < 2) return CMD_ESYNTAX;
        this._activateGraphics();
        const col = params.length > 4 ? Number(params[4]) : this.colour_fg_cursor;
        const rgba = this._gfxColour(col);
        this._gfxScene();
        const x0 = Number(params[0]), y0 = Number(params[1]);
        const x1 = params.length >= 4 ? Number(params[2]) : x0;
        const y1 = params.length >= 4 ? Number(params[3]) : y0;
        this._gfxLine(x0, y0, x1, y1, rgba);
        this._gfxFlush();
        return CMD_OK;
    }

// -----------------------------------------------------------------------
// EDIT COMMAND
// -----------------------------------------------------------------------

// EDIT <lineNo>  –  pull an existing line down to the input prompt so the
// user can edit it in place and press Enter to commit.
// If the line does not exist, the prompt is pre-filled with just the line
// number so the user can type a new line at that position.
    cmdEDIT(params) {
        if (!params || params[0] == null) return CMD_ESYNTAX;

        // Accept line number or label name
        let lineNo = parseInt(params[0], 10);
        if (isNaN(lineNo)) {
            const lbl = String(params[0]).trim();
            this._scanLabels();
            lineNo = this._labels[lbl.toUpperCase()] ?? -1;
            if (lineNo < 0) {
                this.appendLine(`Label not found: ${lbl}`, 1);
                return CMD_OK;
            }
        }
        if (lineNo < 0 || lineNo >= MAX_LINES) return CMD_ESYNTAX;

        const existing = this.lines[lineNo] !== '' ? this.lines[lineNo] : '';
        const prefill  = lineNo + (existing ? ' ' + existing : ' ');

        this.appendLine(prefill, 0);
        this.line_typed   = prefill;
        this.cursor_pos   = prefill.length;
        this.char_index   = prefill.length;
        this.history_line = this.history.addLine(prefill);

        this.want_input     = 1;
        this.input_var      = '__EDIT__';
        this.input_var_type = ASS_STRING;

        this._redrawInputLine();
        return CMD_OK;
    }

// -----------------------------------------------------------------------
// TIER 3 COMMANDS
// -----------------------------------------------------------------------

// _activateGraphics — called by any graphics command on first use.
// Switches the terminal div to transparent so the canvas shows through.
// Only fires once per program run.
    _activateGraphics() {
        if (this._graphicsActive) return;
        this._graphicsActive = true;
        // Show the gfx canvas — ensure it's transparent so GL shows through.
        // cls() fills it with opaque background colour, so we must clear it here.
        const g = this._gfxScene();
        if (g) {
            g.buf.fill(0);   // fully transparent
            g.dirty = true;
            this._gfxFlush();
            g.canvas.style.display = '';
            if (g._imgZ) g._imgZ = 0.01;
        }
        // Re-show sprite canvas if it was hidden by _onProgramStop
        if (this._spr) this._spr.canvas.style.display = '';
        // Make terminal transparent so the WebGL canvases show through
        if (this.o) this.o.classList.add('graphics-active');
    }

    cmdPSET(params) {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        // Fast path: if graphics already active and gfx scene ready, inline the plot
        // to avoid 4 function calls per pixel (critical for Mandelbrot performance)
        if (this._graphicsActive && this._gfx) {
            const g = this._gfx;
            const x = Math.round(Number(params[0]));
            const y = Math.round(Number(params[1]));
            if (x >= 0 && y >= 0 && x < g.W && y < g.H) {
                const col = params.length > 2 ? Number(params[2]) : this.colour_fg_cursor;
                const i = (y * g.W + x) * 4;
                // col === -1 → clear pixel (transparent — lets GL/canvas show through)
                if (col === -1) {
                    g.buf[i] = 0; g.buf[i+1] = 0; g.buf[i+2] = 0; g.buf[i+3] = 0;
                    g.dirty = true;
                    return CMD_OK;
                }
                // Use pre-built colour table if available, else fall back
                const ct = this._gfxColourTable;
                const rgba = (ct && col >= 0 && col < ct.length)
                    ? ct[col]
                    : this._gfxColour(col);
                g.buf[i] = rgba[0]; g.buf[i+1] = rgba[1]; g.buf[i+2] = rgba[2]; g.buf[i+3] = 255;
                g.dirty = true;
                return CMD_OK;
            }
        }
        this._activateGraphics();
        const col = params.length > 2 ? Number(params[2]) : this.colour_fg_cursor;
        this._gfxScene();
        this._gfxPlot(Number(params[0]), Number(params[1]), this._gfxColour(col));
        return CMD_OK;
    }

    cmdPRESET(params) {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        this._activateGraphics();
        const col = params.length > 2 ? Number(params[2]) : this.colour_bg;
        this._gfxScene();
        this._gfxPlot(Number(params[0]), Number(params[1]), this._gfxColour(col));
        return CMD_OK;
    }

    cmdPAINT(params) {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        this._activateGraphics();
        const x   = Math.floor(Number(params[0]));
        const y   = Math.floor(Number(params[1]));
        const col = params.length > 2 ? Number(params[2]) : this.colour_fg_cursor;
        const borderCol = params.length > 3 ? Number(params[3]) : null;
        this._gfxScene();
        const rgba       = this._gfxColour(col);
        const borderRgba = borderCol !== null ? this._gfxColour(borderCol) : null;
        this._gfxPaint(x, y, rgba, borderRgba);
        this._gfxFlush();
        return CMD_OK;
    }

// -----------------------------------------------------------------------
// IMAGE x, y, url$ [, w, h]
// Draw an image from a URL onto the canvas at position x,y.
// Optional w,h scale the image; without them the natural size is used.
// Execution pauses while the image loads, then resumes automatically.
// -----------------------------------------------------------------------
    cmdIMAGE(param) {
        if (!param) return CMD_ESYNTAX;

        // Parse param: either IMAGE "url"  (auto-fit)
        //              or     IMAGE x, y, "url" [, w, h]  (positioned)
        const raw = this.trim(String(param));
        const args = [];
        let inQ = false, start = 0;
        for (let i = 0; i <= raw.length; i++) {
            if (raw[i] === '"') { inQ = !inQ; continue; }
            if (!inQ && (raw[i] === ',' || i === raw.length)) {
                args.push(this.trim(raw.substring(start, i)));
                start = i + 1;
            }
        }

        // Single-arg form: IMAGE "url" — auto-fit to canvas, centred
        const isSingleArg = args.length === 1 ||
            (args.length > 0 && (args[0].startsWith('"') || args[0].includes('/') || args[0].includes('.')));

        let x, y, w, h, url;

        if (isSingleArg || args.length < 3) {
            // Auto-fit mode: scale to fill canvas preserving aspect ratio
            const urlArg = args[0];
            if (urlArg.startsWith('"') && urlArg.endsWith('"')) url = urlArg.slice(1, -1);
            else url = String(this.lookup(urlArg) || urlArg);
            x = 0; y = 0; w = 0; h = 0;  // resolved in onload
        } else {
            x   = Number(this.evalCalc(args[0], ASS_NUMBER));
            y   = Number(this.evalCalc(args[1], ASS_NUMBER));
            w   = args.length > 3 ? Number(this.evalCalc(args[3], ASS_NUMBER)) : 0;
            h   = args.length > 4 ? Number(this.evalCalc(args[4], ASS_NUMBER)) : 0;
            const urlArg = args[2];
            if (urlArg.startsWith('"') && urlArg.endsWith('"')) url = urlArg.slice(1, -1);
            else url = String(this.lookup(urlArg) || urlArg);
        }
        if (!url) return CMD_ESYNTAX;

        this.want_ai = 1;
        if (this.execute_timer) { clearTimeout(this.execute_timer); this.execute_timer = 0; }

        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            this._activateGraphics();
            const cw = this.width || 800;
            const ch = this.height || 600;
            // Natural size centred, scale down only if larger than canvas
            if (x === 0 && y === 0 && w === 0 && h === 0) {
                if (img.naturalWidth > cw || img.naturalHeight > ch) {
                    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
                    w = Math.round(img.naturalWidth  * scale);
                    h = Math.round(img.naturalHeight * scale);
                } else {
                    w = img.naturalWidth;
                    h = img.naturalHeight;
                }
                x = Math.round((cw - w) / 2);
                y = Math.round((ch - h) / 2);
            }
            if (this._gfxScene()) {
                this._gfxDrawImage(img, x, y, w, h);
            } else if (this.context) {
                const dw = w > 0 ? w : (img.naturalWidth || img.width);
                const dh = h > 0 ? h : (img.naturalHeight || img.height);
                if (w > 0 && h > 0) this.context.drawImage(img, x, y, dw, dh);
                else                 this.context.drawImage(img, x, y);
            }
            this.want_ai = 0;
            if (this.running) {
                this.run_line++;
                this._skipToNextLine();
                this._scheduleNextTick();
            } else {
                this.appendLine(this.prompt, 0);
                this.blink();
            }
        };

        img.onerror = () => {
            this.want_ai = 0;
            this.appendLine('IMAGE ERROR: cannot load ' + url, 1);
            if (this.running) {
                this.run_line++;
                this._skipToNextLine();
                this._scheduleNextTick();
            } else {
                this.appendLine(this.prompt, 0);
                this.blink();
            }
        };

        // Resolve through VFS asset store first (avoids CORS on file:// protocol)
        const resolved = this._imgResolve(url);
        img.src = resolved || url;
        return CMD_OK;
    }

// =======================================================================
// IMAGE STORE — VFS-backed image cache for LOADIMG / DISPLAY / OBJECT.SHAPE
//
// Images are stored by name as data-URLs (base64) or http URLs.
// They can be displayed to the canvas with DISPLAY, or used as sprite
// source data for OBJECT.SHAPE.
//
// Commands:
//   LOADIMG "name","url"         — fetch URL, store in image store
//   DISPLAY "name"[,x,y[,w,h]]  — draw stored image to canvas
//   IMGLIST                      — print names of all stored images
//   IMGFREE "name"               — remove image from store
//
// OBJECT.SHAPE extension:
//   OBJECT.SHAPE id, "name"      — if name exists in image store,
//                                   build sprite pixels from that image
// =======================================================================

// Internal helpers
    _imgStore()  { if (!this._images) this._images = {}; return this._images; }

    // _imgLoad — load a URL into an Image element, call cb(img) on success.
    // Uses want_ai to pause BASIC execution during the async fetch.
    _imgLoad(url, cb, errcb) {
        this.want_ai = 1;
        if (this.execute_timer) { clearTimeout(this.execute_timer); this.execute_timer = 0; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => { this.want_ai = 0; cb(img); };
        img.onerror = () => {
            this.want_ai = 0;
            if (errcb) errcb();
            else this.appendLine('IMAGE ERROR: cannot load ' + url, 1);
            if (this.running) { this.run_line++; this._skipToNextLine(); this._scheduleNextTick(); }
            else { this.appendLine(this.prompt, 0); this.blink(); }
        };
        img.src = url;
    }

// _imgResume — resume BASIC execution after async image operation.
    _imgResume() {
        if (this.running) { this.run_line++; this._skipToNextLine(); this._scheduleNextTick(); }
        else { this.appendLine(this.prompt, 0); this.blink(); }
    }

// _imgResolve — resolve a name to a stored image (data-URL, Image element, or URL string).
// Returns the stored value (string or Image), or null if not found.
    _imgResolve(nameOrUrl) {
        const store = this._imgStore();
        const bare = nameOrUrl.replace(/^"|"$/g, '').trim();
        // Check store by original name, then by bare name
        if (store[nameOrUrl] !== undefined) return store[nameOrUrl];
        if (store[bare]      !== undefined) return store[bare];
        // Check VFS asset store for path-like names (not network URLs)
        const isNetwork = /^https?:\/\//i.test(bare);
        if (!isNetwork && bare.includes('/') && this.fs) {
            const assetData = this.fs.getAsset(bare);
            if (assetData) return assetData;
        }
        // Fall back to treating as a direct URL
        return bare || null;
    }

// LOADIMG "name", "url" — fetch URL and store as data-URL in the image store.
// Supports:
//   VFS asset paths:  "MAZE3D/STONE.PNG"  (synchronous, data-URL from VFS)
//   HTTP/HTTPS URLs:  "http://..."         (async fetch, stores Image element)
//   Data URLs:        "data:image/..."     (direct store)
    cmdLOADIMG(param) {
        const args = this._splitArgs(param, 2);
        if (args.length < 2) return CMD_ESYNTAX;
        const name = args[0];
        let url  = args[1];
        if (!name || !url) return CMD_ESYNTAX;

        // Strip any remaining outer quotes (defensive)
        const bare = url.replace(/^"|"$/g, '').trim();

        // ── Data URL: store directly, no fetch needed ─────────────────────
        if (bare.startsWith('data:')) {
            this._imgStore()[name] = bare;
            return CMD_OK;
        }

        // ── VFS asset path (contains '/' but NOT a network URL) ───────────
        const isNetwork = /^https?:\/\//i.test(bare) || /^\/\//i.test(bare);
        if (!isNetwork && bare.includes('/') && this.fs) {
            const assetData = this.fs.getAsset(bare);
            if (assetData) {
                this._imgStore()[name] = assetData;
                return CMD_OK;
            }
        }

        // ── HTTP/HTTPS or relative URL: async Image fetch ─────────────────
        this._imgLoad(bare, (img) => {
            // Try to convert to data-URL for safe re-use
            const oc = document.createElement('canvas');
            oc.width  = img.width  || img.naturalWidth  || 1;
            oc.height = img.height || img.naturalHeight || 1;
            const ctx = oc.getContext('2d');
            try {
                ctx.drawImage(img, 0, 0);
                this._imgStore()[name] = oc.toDataURL('image/png');
            } catch (e) {
                // CORS tainted canvas — store the Image element directly
                // DISPLAY and GL.TEXTURE will use it via a cached Image object
                this._imgStore()[name] = img;
            }
            this._imgResume();
        }, () => {
            // Error already reported by _imgLoad
            this._imgResume();
        });
        return CMD_OK;
    }

// DISPLAY "name" [,x,y [,w,h]] — draw a stored image to the canvas.
    cmdDISPLAY(param) {
        const args = this._splitArgs(param, 5);
        if (!args[0]) return CMD_ESYNTAX;
        const name = args[0];
        const x    = args.length > 1 ? Number(this.evalCalc(args[1], ASS_NUMBER)) : 0;
        const y    = args.length > 2 ? Number(this.evalCalc(args[2], ASS_NUMBER)) : 0;
        const w    = args.length > 3 ? Number(this.evalCalc(args[3], ASS_NUMBER)) : 0;
        const h    = args.length > 4 ? Number(this.evalCalc(args[4], ASS_NUMBER)) : 0;

        const url = this._imgResolve(name);
        if (!url) { this.appendLine('DISPLAY: image not found: ' + name, 1); return CMD_OK; }

        const doRender = (img) => {
            this._activateGraphics();
            const g = this._gfxScene();
            if (g) {
                const oc = document.createElement('canvas');
                const dw = w > 0 ? w : img.naturalWidth  || img.width;
                const dh = h > 0 ? h : img.naturalHeight || img.height;
                oc.width = dw; oc.height = dh;
                const octx = oc.getContext('2d');
                if (w > 0 && h > 0) octx.drawImage(img, 0, 0, w, h);
                else                octx.drawImage(img, 0, 0);
                const imgData = octx.getImageData(0, 0, dw, dh).data;
                const ox = Math.round(x), oy = Math.round(y);
                for (let row = 0; row < dh; row++) {
                    for (let col = 0; col < dw; col++) {
                        const si = (row * dw + col) * 4;
                        if (imgData[si+3] < 128) continue;
                        this._gfxPlot(ox + col, oy + row,
                            [imgData[si], imgData[si+1], imgData[si+2], 255]);
                    }
                }
                this._gfxFlush();
            } else if (this.context) {
                if (w > 0 && h > 0) this.context.drawImage(img, x, y, w, h);
                else                 this.context.drawImage(img, x, y);
            }
        };

        // If the stored value is already an Image element (CORS case from LOADIMG),
        // render it directly — synchronously since it's already loaded.
        if (url && typeof url === 'object' && url.tagName === 'IMG') {
            doRender(url);
            return CMD_OK;
        }

        // Data URL — create Image synchronously, no network fetch needed.
        if (typeof url === 'string' && url.startsWith('data:')) {
            const img = new Image();
            img.onload = () => doRender(img);
            img.src = url;
            return CMD_OK;
        }

        // Remote URL (http/https) or relative — async fetch, pause execution.
        this._imgLoad(url, (img) => {
            doRender(img);
            this._imgResume();
        });
        return CMD_OK;
    }

// IMGLIST — print names of all stored images.
    cmdIMGLIST() {
        const store = this._imgStore();
        const names = Object.keys(store);
        if (names.length === 0) { this.appendLine('  (no images loaded)', 1); return CMD_OK; }
        for (const n of names) {
            const src = store[n];
            const info = src.startsWith('data:') ? `${src.length} bytes` : src.substring(0, 40);
            this.appendLine(`  ${n.padEnd(16)} ${info}`, 1);
        }
        return CMD_OK;
    }

// IMGFREE "name" — remove image from store.
    cmdIMGFREE(param) {
        const name = this._resolveStrArg(param);
        if (name && this._imgStore()[name]) delete this._imgStore()[name];
        return CMD_OK;
    }

// _splitArgs — split param string on commas outside quotes, evaluate string args.
    _splitArgs(param, maxN) {
        const raw = this.trim(String(param || ''));
        const result = [];
        let inQ = false, start = 0;
        for (let i = 0; i <= raw.length; i++) {
            if (raw[i] === '"') { inQ = !inQ; continue; }
            if (!inQ && (raw[i] === ',' || i === raw.length)) {
                let tok = this.trim(raw.substring(start, i));
                // Evaluate string: quoted literal → strip quotes; variable → lookup
                if (tok.startsWith('"') && tok.endsWith('"')) {
                    tok = tok.slice(1, -1);
                } else if (tok && !tok.match(/^-?[\d.]+$/)) {
                    tok = String(this.lookup(tok) || tok);
                }
                result.push(tok);
                start = i + 1;
                if (result.length >= maxN) break;
            }
        }
        return result;
    }

// _resolveStrArg — resolve a single string argument (quoted or variable).
    _resolveStrArg(param) {
        const raw = this.trim(String(param || ''));
        if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
        return String(this.lookup(raw) || raw);
    }

// =======================================================================
// OBJECT.SHAPE from image — if the shape definition is an image store name,
// load the image and build sprite pixels from it.
// Called from cmdOBJECT_SHAPE when def$ doesn't look like "w,h,HEX..."
// =======================================================================
    _objShapeFromImage(obj, nameOrUrl) {
        const url = this._imgResolve(nameOrUrl);
        if (!url) {
            this.appendLine('OBJECT.SHAPE: image not found: ' + nameOrUrl, 1);
            this._imgResume();
            return;
        }
        this._imgLoad(url, (img) => {
            // Draw to offscreen canvas and extract pixels
            const oc  = document.createElement('canvas');
            oc.width  = img.width;
            oc.height = img.height;
            const octx = oc.getContext('2d');
            octx.drawImage(img, 0, 0);
            const data = octx.getImageData(0, 0, oc.width, oc.height).data;
            const pixels = [];
            for (let r = 0; r < oc.height; r++) {
                pixels[r] = [];
                for (let c = 0; c < oc.width; c++) {
                    const i4 = (r * oc.width + c) * 4;
                    const a = data[i4+3];
                    if (a < 16) { pixels[r][c] = null; continue; }  // transparent
                    const rr = data[i4].toString(16).padStart(2,'0');
                    const gg = data[i4+1].toString(16).padStart(2,'0');
                    const bb = data[i4+2].toString(16).padStart(2,'0');
                    pixels[r][c] = '#' + rr + gg + bb;
                }
            }
            obj.pixels = pixels; obj.w = oc.width; obj.h = oc.height;
            this._activateGraphics();
            this._imgResume();
        }, () => {
            // Error - already handled by _imgLoad
        });
    }


//
// Objects are canvas-based sprites. Each has:
//   id        — integer id (1..n)
//   pixels    — 2D array [row][col] = colour index (0=transparent)
//   w, h      — pixel dimensions
//   x, y      — canvas position (top-left corner)
//   vx, vy    — velocity in pixels/second
//   ax, ay    — acceleration in pixels/second²
//   on        — visible flag
//   priority  — z-order (higher = drawn on top)
//
// Shape string format (our own readable extension of Amiga's binary blob):
//   "w,h,RRGGBBRRGGBB..."  — w*h hex RGB triples, left-to-right top-to-bottom
//   Colour "000000" = transparent
//
// Example 8x8 red square:
//   OBJECT.SHAPE 1, "8,8,FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000FF0000"
// =======================================================================

// _objGet — return (or create) an object record by id.
    _objGet(id) {
        if (!this._objects) this._objects = {};
        if (!this._objects[id]) {
            this._objects[id] = {
                id, pixels: null, w: 0, h: 0,
                x: -1000, y: -1000, vx: 0, vy: 0, ax: 0, ay: 0,
                on: false, priority: 0,
                scale: 1, flipH: false, flipV: false, rotation: 0,
                _lastDraw: null,   // {x,y,w,h} of last drawn area for erase
            };
        }
        return this._objects[id];
    }

// =======================================================================
// Phase 2 — Three.js DataTexture 2D canvas
//
// All pixel-level draw commands (PSET, LINE, CIRCLE, RECT, FILLRECT,
// PAINT) write into a CPU-side Uint8Array pixel buffer.
// A single THREE.DataTexture + fullscreen PlaneGeometry quad uploads the
// buffer to the GPU once per "flush" call.
// This replaces all Canvas 2D context drawing while keeping the same
// BASIC command signatures unchanged.
//
// PAINT (flood fill) stays CPU-side and writes into the same buffer.
// POINT(x,y) reads from the buffer directly.
// CLS clears the buffer.
// =======================================================================

// Initialise (or return) the Three.js 2D drawing scene
    _gfxScene() {
        if (this._gfx) return this._gfx;
        if (typeof THREE === 'undefined') return null;

        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper) return null;

        const W = this.canvas ? this.canvas.width  : (wrapper.clientWidth  || 800);
        const H = this.canvas ? this.canvas.height : (wrapper.clientHeight || 600);

        // Dedicated WebGL canvas — sits between the 2D canvas and the sprite canvas
        const wc = document.createElement('canvas');
        wc.id = 'gfxkanvas';
        wc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2;';
        wc.style.width  = W + 'px';
        wc.style.height = H + 'px';
        wrapper.appendChild(wc);

        const renderer = new THREE.WebGLRenderer({ canvas: wc, antialias: false, alpha: true });
        renderer.setSize(W, H);
        renderer.setPixelRatio(1);
        renderer.setClearColor(0x000000, 0);  // transparent — canvas handles background

        // Orthographic camera mapping pixel coords (origin top-left, y-down)
        const camera = new THREE.OrthographicCamera(0, W, 0, -H, -1, 1);

        const scene = new THREE.Scene();

        // Pixel buffer — RGBA Uint8Array
        const buf  = new Uint8Array(W * H * 4);  // starts fully transparent
        const tex  = new THREE.DataTexture(buf, W, H);
        tex.needsUpdate = true;
        tex.flipY = true;  // DataTexture row 0 = bottom; flipY corrects to top-left origin

        // Fullscreen quad covering the whole ortho viewport
        const geo  = new THREE.PlaneGeometry(W, H);
        const mat  = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, depthTest: false, depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        // PlaneGeometry is centred — position at centre of ortho view
        mesh.position.set(W / 2, -H / 2, 0);
        scene.add(mesh);

        // Dirty flag — avoid redundant GPU uploads
        let dirty = false;

        this._gfx = { renderer, scene, camera, buf, tex, mesh, W, H, canvas: wc, dirty };

        // Pre-build RGBA colour table for all palette entries — avoids
        // hex parsing and array allocation on every PSET call
        this._gfxColourTable = this.colours.map((css, i) => {
            if (!css) return [0, 0, 0, 255];
            if (css.startsWith('#') && css.length === 7) {
                return [
                    parseInt(css.slice(1,3), 16),
                    parseInt(css.slice(3,5), 16),
                    parseInt(css.slice(5,7), 16),
                    255
                ];
            }
            // CSS named colour — resolve via _gfxColour which uses offscreen canvas
            return this._gfxColour(i);
        });

        // If GL is already running, sit above it
        // GFX stays at z-index 2 — GL is at 1, terminal at 4
        return this._gfx;
    }

// _gfxSyncSize — resize the gfx canvas, pixel buffer, DataTexture quad and
// orthographic camera to match the current terminal-wrapper size.
// Called by _activateGraphics and by the resize handler.
    _gfxSyncSize() {
        const g = this._gfx;
        if (!g) return;
        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper) return;
        const W = this.canvas ? this.canvas.width  : wrapper.clientWidth  || 800;
        const H = this.canvas ? this.canvas.height : wrapper.clientHeight || 600;
        if (W === g.W && H === g.H) return;   // nothing changed

        g.W = W; g.H = H;

        // Rebuild pixel buffer at new size
        g.buf = new Uint8Array(W * H * 4);
        g.tex.dispose();
        g.tex = new THREE.DataTexture(g.buf, W, H);
        g.tex.flipY = true;
        g.tex.needsUpdate = true;

        // Update the fullscreen quad geometry and position
        g.scene.remove(g.mesh);
        g.mesh.geometry.dispose();
        g.mesh.material.dispose();
        const geo  = new THREE.PlaneGeometry(W, H);
        const mat  = new THREE.MeshBasicMaterial({
            map: g.tex, transparent: true, depthTest: false, depthWrite: false
        });
        g.mesh = new THREE.Mesh(geo, mat);
        g.mesh.position.set(W / 2, -H / 2, 0);
        g.scene.add(g.mesh);

        // Resize renderer and update ortho camera frustum
        g.renderer.setSize(W, H);
        g.canvas.style.width  = W + 'px';
        g.canvas.style.height = H + 'px';
        g.camera.right  =  W;
        g.camera.bottom = -H;
        g.camera.updateProjectionMatrix();
        g.dirty = true;
    }

// _gfxDrawImage — draw an image onto the gfx scene as a GPU CanvasTexture quad.
// This is O(1) GPU work regardless of image size — no CPU pixel loop.
// The quad is added to the scene with a unique z so multiple images stack correctly.
    _gfxDrawImage(img, x, y, w, h) {
        const g = this._gfxScene();
        if (!g) return;
        x = Math.round(x); y = Math.round(y);

        // Draw image into an offscreen canvas (needed for CanvasTexture)
        const oc = document.createElement('canvas');
        oc.width  = w > 0 ? w : (img.naturalWidth  || img.width  || 1);
        oc.height = h > 0 ? h : (img.naturalHeight || img.height || 1);
        const octx = oc.getContext('2d');
        octx.drawImage(img, 0, 0, oc.width, oc.height);

        const tex = new THREE.CanvasTexture(oc);
        tex.needsUpdate = true;
        tex.flipY = true;  // match DataTexture convention

        const iw = oc.width, ih = oc.height;
        const geo = new THREE.PlaneGeometry(iw, ih);
        const mat = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, depthTest: false, depthWrite: false
        });
        const mesh = new THREE.Mesh(geo, mat);

        // z-order: images sit just above the DataTexture layer
        if (!g._imgZ) g._imgZ = 0.01;
        g._imgZ += 0.001;
        mesh.position.set(x + iw / 2, -(y + ih / 2), g._imgZ);
        g.scene.add(mesh);

        // Track for cleanup on CLS
        if (!g._imgMeshes) g._imgMeshes = [];
        g._imgMeshes.push({ mesh, geo, mat, tex });

        g.renderer.render(g.scene, g.camera);
    }

// _gfxClearImages — remove all image quads (called on CLS / program stop)
    _gfxClearImages() {
        const g = this._gfx;
        if (!g || !g._imgMeshes) return;
        for (const { mesh, geo, mat, tex } of g._imgMeshes) {
            g.scene.remove(mesh);
            geo.dispose(); mat.dispose(); tex.dispose();
        }
        g._imgMeshes = [];
        g._imgZ = 0.01;
    }

// Parse a BASIC colour index → [r, g, b, 255]
    _gfxColour(colIdx) {
        const css = this.colours[colIdx] || this.colours[this.colour_fg_cursor] || '#00FF00';
        // Already a #RRGGBB hex string
        if (css.startsWith('#') && css.length === 7) {
            return [
                parseInt(css.slice(1,3), 16),
                parseInt(css.slice(3,5), 16),
                parseInt(css.slice(5,7), 16),
                255,
            ];
        }
        // CSS named colour — resolve via an offscreen canvas (cached)
        if (!this._colourCache) this._colourCache = {};
        if (!this._colourCache[css]) {
            const oc = document.createElement('canvas');
            oc.width = oc.height = 1;
            const ctx = oc.getContext('2d');
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            this._colourCache[css] = [d[0], d[1], d[2], 255];
        }
        return this._colourCache[css];
    }

// Write one pixel into the buffer (bounds-checked)
    _gfxPlot(x, y, rgba) {
        const g = this._gfx;
        if (!g) return;
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= g.W || y >= g.H) return;
        const i = (y * g.W + x) * 4;
        g.buf[i] = rgba[0]; g.buf[i+1] = rgba[1]; g.buf[i+2] = rgba[2]; g.buf[i+3] = rgba[3];
        g.dirty = true;
    }

// Read one pixel from the buffer — used by POINT(x,y)
    _gfxRead(x, y) {
        const g = this._gfx;
        if (!g) return [0, 0, 0, 0];
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= g.W || y >= g.H) return [0, 0, 0, 0];
        const i = (y * g.W + x) * 4;
        return [g.buf[i], g.buf[i+1], g.buf[i+2], g.buf[i+3]];
    }

// Upload dirty buffer to GPU and render
    _gfxFlush() {
        const g = this._gfx;
        if (!g) return;
        if (g.dirty) {
            g.tex.needsUpdate = true;
            g.dirty = false;
        }
        g.renderer.render(g.scene, g.camera);
    }

// Clear the entire pixel buffer to the current background colour
    _gfxClear() {
        const g = this._gfxScene();
        if (!g) return;
        const bg = this._gfxColour(this.colour_bg);
        const [r, gv, b] = bg;
        const len = g.W * g.H * 4;
        for (let i = 0; i < len; i += 4) {
            g.buf[i] = r; g.buf[i+1] = gv; g.buf[i+2] = b; g.buf[i+3] = 255;
        }
        g.dirty = true;
        this._gfxFlush();
    }

// Bresenham line into pixel buffer
    _gfxLine(x0, y0, x1, y1, rgba) {
        x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
        const dx=Math.abs(x1-x0), dy=Math.abs(y1-y0);
        const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
        let err=dx-dy;
        while (true) {
            this._gfxPlot(x0, y0, rgba);
            if (x0===x1 && y0===y1) break;
            const e2=2*err;
            if (e2>-dy){err-=dy; x0+=sx;}
            if (e2< dx){err+=dx; y0+=sy;}
        }
    }

// Midpoint circle outline into pixel buffer
    _gfxCircle(cx, cy, r, rgba) {
        cx=Math.round(cx); cy=Math.round(cy); r=Math.round(r);
        let x=0, y=r, d=3-2*r;
        const p = (px,py) => this._gfxPlot(px, py, rgba);
        while (x<=y) {
            p(cx+x,cy+y); p(cx-x,cy+y); p(cx+x,cy-y); p(cx-x,cy-y);
            p(cx+y,cy+x); p(cx-y,cy+x); p(cx+y,cy-x); p(cx-y,cy-x);
            if (d<0){d+=4*x+6;}else{d+=4*(x-y)+10; y--;}
            x++;
        }
    }

// Filled rect into pixel buffer
    _gfxFillRect(x1, y1, x2, y2, rgba) {
        const g = this._gfx;
        if (!g) return;
        const lx=Math.max(0,Math.round(Math.min(x1,x2)));
        const rx=Math.min(g.W-1,Math.round(Math.max(x1,x2)));
        const ty=Math.max(0,Math.round(Math.min(y1,y2)));
        const by=Math.min(g.H-1,Math.round(Math.max(y1,y2)));
        for (let y=ty; y<=by; y++) {
            const rowBase = y * g.W * 4;
            for (let x=lx; x<=rx; x++) {
                const i = rowBase + x*4;
                g.buf[i]=rgba[0]; g.buf[i+1]=rgba[1]; g.buf[i+2]=rgba[2]; g.buf[i+3]=rgba[3];
            }
        }
        g.dirty = true;
    }

// Rect outline into pixel buffer
    _gfxRect(x1, y1, x2, y2, rgba) {
        this._gfxLine(x1,y1,x2,y1,rgba);
        this._gfxLine(x2,y1,x2,y2,rgba);
        this._gfxLine(x2,y2,x1,y2,rgba);
        this._gfxLine(x1,y2,x1,y1,rgba);
    }

// Filled circle (scan-line) into pixel buffer
    _gfxFillCircle(cx, cy, r, rgba) {
        cx = Math.round(cx); cy = Math.round(cy); r = Math.round(Math.abs(r));
        for (let dy = -r; dy <= r; dy++) {
            const dx = Math.round(Math.sqrt(r * r - dy * dy));
            this._gfxFillRect(cx - dx, cy + dy, cx + dx, cy + dy, rgba);
        }
    }

// Flood fill into pixel buffer (4-connected, iterative)
    _gfxPaint(sx, sy, rgba, borderRgba) {
        const g = this._gfx;
        if (!g) return;
        const W=g.W, H=g.H, buf=g.buf;
        sx=Math.round(sx); sy=Math.round(sy);
        if (sx<0||sy<0||sx>=W||sy>=H) return;
        const i0 = (sy*W+sx)*4;
        const tR=buf[i0], tG=buf[i0+1], tB=buf[i0+2], tA=buf[i0+3];
        // Already the fill colour — nothing to do
        if (tR===rgba[0]&&tG===rgba[1]&&tB===rgba[2]) return;
        const hasBorder = borderRgba !== null;
        const bR=hasBorder?borderRgba[0]:0, bG=hasBorder?borderRgba[1]:0, bB=hasBorder?borderRgba[2]:0;
        const stack = [sx + sy * W];
        const seen  = new Uint8Array(W * H);
        while (stack.length) {
            const idx = stack.pop();
            if (seen[idx]) continue;
            seen[idx] = 1;
            const i = idx * 4;
            if (hasBorder && buf[i]===bR && buf[i+1]===bG && buf[i+2]===bB) continue;
            if (buf[i]!==tR || buf[i+1]!==tG || buf[i+2]!==tB || buf[i+3]!==tA) continue;
            buf[i]=rgba[0]; buf[i+1]=rgba[1]; buf[i+2]=rgba[2]; buf[i+3]=rgba[3];
            const x=idx%W, y=Math.floor(idx/W);
            if (x>0)   stack.push(idx-1);
            if (x<W-1) stack.push(idx+1);
            if (y>0)   stack.push(idx-W);
            if (y<H-1) stack.push(idx+W);
        }
        g.dirty = true;
    }


}

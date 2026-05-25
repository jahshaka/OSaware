'use strict';

// ---------------------------------------------------------------------------
// OSAWARE Interpreter  (kernel.js)
// Unified kernel — reverted from failed compiler split.
// ---------------------------------------------------------------------------

class Interpreter {




    // Constructor
    // -----------------------------------------------------------------------
    constructor(id, width, height, type, initText, cols, rows, initCmd, fontSize, canvasCtx) {

        // Bootstrap process memory FIRST so all proxy getters/setters work
        // immediately. The Kernel will replace this with a tracked instance
        // via attachMemory() once registerProcess() is called.
        this._mem = new ProcessMemory();

        // Terminal driver — owns all I/O, DOM, cursor, keyboard
        this._term = new TerminalDriver(this, id, width, height, type, initText, cols, rows, initCmd, fontSize, canvasCtx);

        this.version   = '0.2.5-modern';
        this.dStartTime = Date.now();



        // DOM references (set in setup())


        // Cursor / display state

        // Run-time flags
        this.execute_timer  = 0;
        this._timer_is_raf  = false;  // true when execute_timer is a rAF handle (not setTimeout)
        this._glJustRendered = false; // set by _glRenderFrame, consumed by _scheduleNextTick
        this._resizePending  = false; // pauses BASIC after FULLSCREEN/OVERSCAN until canvas dims settle
        this._fullscreenSavedState = undefined; // single-slot save for FULLSCREEN ENTER/EXIT
        this.processing_line = 0;
        this.done           = 0;
        this.status         = -1;

        // Init-text (displayed on startup for c64 / dos themes)

        // Prompt / error strings (overridden per theme)


        // Error trapping (ON ERROR GOTO / RESUME)

        // Block IF state stack (ELSEIF / END IF)

        // WHILE stack

        // ON n GOTO/GOSUB table

        // Trace and RNG seed

        // Tier 3 state
        this._printWidth = 0;
        this._runAfterLoad  = false;   // true when RUN <file> is loading async
        this._inBatch       = false;   // true when executing inside batch loop

        // Screen buffer for LOCATE-based positioned output.
        // Activated on first LOCATE call; cleared by CLS.

        // OBJECT (sprite/bob) system — Amiga BASIC-compatible.
        this._objects          = {};    // id → object record
        this._collisionQueue   = [];    // pending collision events
        this._collisionEnabled = false;
        this._onCollisionLine  = null;  // line number of ON COLLISION handler
        this._collisionPending = false; // flag for tick() to fire event handler
        this._glLoadPending    = false; // true while GL.LOAD is fetching a model — tick() pauses
        this._objClip          = null;  // clipping rectangle
        this._objAnimTimer     = null;  // setInterval handle

        // GL 3D rendering system state (initialised on first GL.INIT).
        this._images = {};   // image store — populated by LOADIMG
        // IPC Syscall Bus — Step 3 of V7 refactor
        this.kernel    = new KernelBus();

        // OS Kernel — Step 5 of V7 refactor
        this.os        = new Kernel(this.kernel);
        this._pid      = this.os.registerProcess(this);  // register as PID 1

        this._glDrv   = new GL3DDriver(this);   // GL 3D driver   — Step 1 of V7 refactor
        this._audioDrv = new AudioDriver(this);  // Audio driver   — Step 2 of V7 refactor
        this._netDrv   = new NetDriver(this);    // Network driver — Step 2 of V7 refactor
        this._gfxDrv   = new GfxDriver(this);   // GFX 2D driver  — Step 2b of V7 refactor
        this._shell    = new ShellRuntime(this); // Shell runtime  — Step 4 of V7 refactor
        this._winDrv   = new WindowDriver(this); // Window IPC driver

        // Register all driver syscall handlers on the bus
        this._registerDriverSyscalls();


        // Mouse state (Amiga BASIC compatible)

        // When true the terminal is scrollable — increaseLine() does NOT strip
        // nodes from the top; content accumulates so the user can scroll up.

        // Keyboard / input

        // History

        // Line-printer emulator

        // Virtual filesystem
        this.fs = new VirtualFs();

        // ---------------------------------------------------------------------------
        // BASIC program memory
        // ---------------------------------------------------------------------------

        // ---------------------------------------------------------------------------
        // Variable storage  (parallel arrays: [name, value])
        // ---------------------------------------------------------------------------

        // ---------------------------------------------------------------------------
        // Flow-control state
        // ---------------------------------------------------------------------------



        // DATA / READ state

        // ---------------------------------------------------------------------------
        // AI state
        // ---------------------------------------------------------------------------
        this.ai_key      = null;   // Anthropic API key — entered at runtime, never persisted
        this.ai_messages = [];     // conversation history for the current session
        this.ai_system   = '';     // custom system prompt set via AISYSTEM ('' = built-in default)
        this.ai_model    = '';     // model override set via AIMODEL ('' = _aiDefaultModel)
        this.ai_temp     = null;   // temperature 0..1 set via AITEMP (null = let the API choose)
        this.ai_tokens   = 0;      // max output tokens set via AITOKENS (0 = 1024)
        this.ai_web      = false;  // AIWEB ON: give AI/AINUM the server-side web_search tool
        this._aiDefaultModel = 'claude-haiku-4-5-20251001';   // bump here when a faster model ships
        this.want_ai     = 0;      // flag: BASIC execution paused waiting for AI response
        this.want_auth   = 0;      // flag: BASIC execution paused waiting for DEVLOGIN/DEVLOGOUT/etc

        // Text-measurement helper div (created lazily)
        this._measureDiv = null;

        // Bind the key handlers so we can add/remove listeners cleanly.
        this._boundIgnoreKeyHandler = (e) => this.ignoreKeyHandler(e);

        // Build the command table after all methods are defined.
        this._buildCommandTable();
        this._buildCommandMap();

        // Store initCmd — executed after DOM is ready (in execute())
        this._initCmd = initCmd || null;
    }

    // -----------------------------------------------------------------------
    // line_assigned / line_unassigned  (now use a Set for O(1) performance)
    // -----------------------------------------------------------------------
    line_assigned(lineNo) {
        this.lines_assigned.add(Number(lineNo));
    }

    line_unassigned(lineNo) {
        this.lines_assigned.delete(Number(lineNo));
    }

    // -----------------------------------------------------------------------
    // zapVariables  –  reset all variable storage to a virgin state.
    // -----------------------------------------------------------------------

    _skipToNextLine() {
        while (this.run_line < MAX_LINES && this.lines[this.run_line] === '') {
            this.run_line++;
        }
    }


    // Expression cache removed (CSP blocks new Function())

        _buildCommandMap() {
        this._cmdMap = new Map();
        // Build longest-first so multi-word keywords win over shorter prefixes.
        const sorted = [...this.command_table].sort((a, b) => b[0].length - a[0].length);
        for (const entry of sorted) {
            this._cmdMap.set(entry[0].toUpperCase(), entry);
        }
    }

    // Schedule the next tick via closure (no eval-string).
    _scheduleNextTick() {
        if (this.execute_timer !== 0) return;
        if (this._resizePending) return;  // resize callback will re-schedule
        // Flush any pending pixel buffer changes before yielding to the browser
        if (this._gfx && this._gfx.dirty) this._gfxFlush();
        const delay = this.sleepy_time > 0 ? this.sleepy_time : this.run_delay;
        this.sleepy_time = 0;
        // GL render path: when a GL frame just rendered and the requested
        // delay is short (≤17ms — i.e. "next frame please"), schedule via
        // requestAnimationFrame so paints align with the display refresh
        // instead of beating against setTimeout's clamping.
        if (this._glJustRendered && delay > 0 && delay <= 17 &&
            typeof requestAnimationFrame === 'function') {
            this._glJustRendered = false;
            this._timer_is_raf = true;
            this.execute_timer = requestAnimationFrame(() => this.tick(1));
            return;
        }
        this._glJustRendered = false;
        this._timer_is_raf = false;
        this.execute_timer = setTimeout(() => this.tick(1), delay);
    }

    // Cancel whichever kind of timer (setTimeout or rAF) is currently scheduled.
    _cancelNextTick() {
        if (!this.execute_timer) return;
        if (this._timer_is_raf) cancelAnimationFrame(this.execute_timer);
        else clearTimeout(this.execute_timer);
        this.execute_timer = 0;
        this._timer_is_raf = false;
    }

    // -----------------------------------------------------------------------
    // COMMAND HANDLERS
    // -----------------------------------------------------------------------

    cmdNULL()             { return CMD_OK; }
    cmdEND()              { return CMD_END; }

    // EDIT <lineNo|label> — pull an existing line into the input for editing.
    cmdEDIT(params) {
        if (!params || params[0] == null) return CMD_ESYNTAX;

        // Accept line number or label name (labels are case-sensitive — Model B)
        let lineNo = parseInt(params[0], 10);
        if (isNaN(lineNo)) {
            const lbl = String(params[0]).trim();
            this._scanLabels();
            lineNo = (this._labels && this._labels[lbl]) ?? -1;
            if (lineNo < 0) {
                this.appendLine('Label not found: ' + lbl, 1);
                return CMD_OK;
            }
        }
        if (lineNo < 0 || lineNo >= MAX_LINES) return CMD_ESYNTAX;

        const existing = (this.lines[lineNo] && this.lines[lineNo] !== '')
            ? this.lines[lineNo] : '';
        const prefill = lineNo + (existing ? ' ' + existing : ' ');

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

    cmdSLEEP(params) {
        if (!params) return CMD_ESYNTAX;
        const ms = Number(params[0]);
        // Flush the DataTexture pixel buffer before sleeping so the
        // frame is visible immediately (e.g. Mandelbrot scanlines).
        if (this._gfx && this._gfx.dirty) this._gfxFlush();
        this.sleepy_time = ms <= 0 ? 1 : ms;
        return CMD_OK;
    }

    cmdDELAY(params) {
        this.run_delay = (params && Number(params[0]) > 0) ? Number(params[0]) : 5;
        return CMD_OK;
    }

    cmdDATA(params) {
        // When running, _scanData() pre-loads all DATA at RUN time.
        // Executing a DATA line at runtime is a no-op — data is already loaded.
        // data_count === -1 means direct/interactive mode, so still allow it there.
        if (this.running && this.data_count >= 0) return CMD_OK;
        if (this.data_count === -1 || !this.data) {
            this.data          = [];
            this.data_count    = 0;
            this.data_position = 0;
        }
        if (!params) return CMD_ESYNTAX;
        for (const p of params) {
            this.data.push(this.trim(p));
            this.data_count++;
        }
        return CMD_OK;
    }

    cmdDEF(params) {
        if (!params || params.length === 0) return CMD_OK;
        const raw = String(params);

        const eqPos = raw.indexOf('=');
        if (eqPos <= 0) return CMD_ESYNTAX;

        let before = raw.substring(0, eqPos);
        let after  = raw.substring(eqPos + 1);

        const p1    = before.indexOf('(');
        const p2    = before.indexOf(')');
        const token = before.substring(p1 + 1, p2);
        before      = before.substring(0, p1);

        // Replace all occurrences of the token identifier with the placeholder 'token'.
        // Escape token before embedding in RegExp to prevent regex injection.
        const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(?<![A-Za-z0-9])${escapedToken}(?![A-Za-z0-9])`, 'g');
        after = after.replace(re, 'token');

        this.assign_(ASS_FUNCTION, before, after);
        return CMD_OK;
    }

    cmdREAD(params) {
        if (!params) return CMD_ESYNTAX;
        if (!this.data || this.data.length <= this.data_position) return CMD_EDATA;

        for (const varName of params) {
            if (this.data_position >= this.data.length) return CMD_EDATA;
            let val = this.data[this.data_position];
            if (String(val).startsWith('"') && String(val).endsWith('"')) {
                val = String(val).slice(1, -1);
            }
            this.assign(varName, val);
            this.data_position++;
        }
        return CMD_OK;
    }


    // =======================================================================
    // Shell — delegated to ShellRuntime (core/shell.js)
    // Step 4 of V7 architecture refactor: extracted 2026-04
    // =======================================================================
    cmdMEM()             { return this._shell.cmdMEM(); }
    cmdINFO()            { return this._shell.cmdINFO(); }
    cmdHWINFO()          { return this._shell.cmdHWINFO(); }
    cmdLABELS()          { return this._shell.cmdLABELS(); }
    cmdHELP(p)           { return this._shell.cmdHELP(p); }
    cmdVIEW(p)           { return this._shell.cmdVIEW(p); }
    cmdCLEARSCREEN()     { return this._shell.cmdCLEARSCREEN(); }
    cmdLIST(p)           { return this._shell.cmdLIST(p); }
    cmdLLIST(p)          { return this._shell.cmdLLIST(p); }
    cmdSAVE(p)           { return this._shell.cmdSAVE(p); }
    cmdFILES(p)          { return this._shell.cmdFILES(p); }
    cmdDELUSER(p)        { return this._shell.cmdDELUSER(p); }
    cmdVFSPUT(p)         { return this._shell.cmdVFSPUT(p); }
    cmdVFSGET(p)         { return this._shell.cmdVFSGET(p); }
    cmdREADTEXT(p)       { return this._shell.cmdREADTEXT(p); }
    cmdVFSIMG(p)         { return this._shell.cmdVFSIMG(p); }
    cmdVFSDEL(p)         { return this._shell.cmdVFSDEL(p); }
    cmdDIR(p)            { return this._shell.cmdDIR(p); }
    cmdLOAD(p)           { return this._shell.cmdLOAD(p); }
    cmdRESET()           { return this._shell.cmdRESET(); }
    cmdRESIZE(p)         { return this._shell.cmdRESIZE(p); }
    cmdNEW()             { return this._shell.cmdNEW(); }
    cmdMERGE(p)          { return this._shell.cmdMERGE(p); }
    cmdRUN(p)            { return this._shell.cmdRUN(p); }
    cmdCONT()            { return this._shell.cmdCONT(); }
    cmdHISTORY()         { return this._shell.cmdHISTORY(); }
    cmdLAUNCH(p)          { return this._shell.cmdLAUNCH(p); }

    // ── Auth commands — delegates to shell, which calls AuthService ────
    cmdDEVLOGIN(p)       { return this._shell.cmdDEVLOGIN(p); }
    cmdDEVLOGOUT(p)      { return this._shell.cmdDEVLOGOUT(p); }
    cmdDEVWHOAMI(p)      { return this._shell.cmdDEVWHOAMI(p); }
    cmdLOGIN(p)          { return this._shell.cmdLOGIN(p); }
    cmdLOGOUT(p)         { return this._shell.cmdLOGOUT(p); }
    cmdREGISTER(p)       { return this._shell.cmdREGISTER(p); }
    cmdPASSWORD(p)       { return this._shell.cmdPASSWORD(p); }
    cmdDELETEACCOUNT(p)  { return this._shell.cmdDELETEACCOUNT(p); }
    cmdWHOAMI(p)         { return this._shell.cmdWHOAMI(p); }

    // ── Window IPC — delegates to WindowDriver via bus ────────────────
    cmdWINDOW_SEND(p)     { return this.kernel.post({syscall:'window.send',param:p}); }
    cmdWINDOW_CLOSE(p)    { return this.kernel.post({syscall:'window.close',param:p}); }
    cmdWINDOW_REPLY(p)    { return this.kernel.post({syscall:'window.reply',param:p}); }
    cmdON_WINDOW(p)       { return this.kernel.post({syscall:'window.onmsg',param:p}); }
    get _winDrv()         { return this.__winDrv; }
    set _winDrv(v)        { this.__winDrv = v; }
    cmdTRON()            { return this._shell.cmdTRON(); }
    cmdTROFF()           { return this._shell.cmdTROFF(); }
    cmdDIM(p)            { return this._shell.cmdDIM(p); }
    help(p)              { return this._shell.help(p); }

    cmdGOSUB(param) {
        if (!param) return CMD_ESYNTAX;
        this.gosub_level++;
        this.gosubs[this.gosub_level] = this.run_line + 1;
        const t = this._resolveLabel(param);
        return t >= 0 ? t : Number(param);
    }

    cmdRETURN() {
        if (this.gosub_level > -1) {
            const ret = this.gosubs[this.gosub_level];
            this.gosubs[this.gosub_level] = null;
            this.gosub_level--;
            return ret;
        }
        return CMD_OK;
    }

    cmdGOTO(param) {
        const target = this._resolveLabel(param);
        if (!this.running && !this._inBatch) { this._gotoLine(target); return CMD_OK; }

        // If jumping forward past a FOR/NEXT block, decrement for_level.
        if (target > -1 && this.for_level > -1) {
            for (let i = this.run_line; i < target; i++) {
                if (String(this.lines[i]).trim().substring(0, 4).toUpperCase() === 'NEXT') {
                    this.fors[this.for_level] = null;
                    this.for_level--;
                    if (this.for_level > -1) this.for_var = this.fors[this.for_level][0];
                }
            }
        }
        return target;
    }

    cmdPRINT(param) {
        this.print(param || '\n', 0);
        return CMD_OK;
    }

    // FIX: was referencing undefined `param` instead of `params[0]`.
    cmdNPRINT(params) {
        if (params && params.length > 0) {
            this.print(params[0] || '\n', 0);
        }
        return CMD_OK;
    }

    cmdLPRINT(param) {
        this.print(param || '\n', 1);
        return CMD_OK;
    }

    cmdINPUT(params) {
        let sInput = params[0];
        this.want_input = 1;
        // Clear stale input and stamp when INPUT started.
        // The keyHandler uses this to reject keypresses that fired
        // before this INPUT began (e.g. the key that exited a demo).
        this.line_typed    = '';
        this.cursor_pos    = 0;
        this.quoted        = 0;
        if (params[1] != null) {
            this.print(params[0] + ';', 0);
            sInput = params[1];
        }
        this.input_var      = sInput;
        this.input_var_type = sInput.endsWith('$') ? ASS_STRING : ASS_NUMBER;
        this.char_index     = -1;
        this._markInputStart();
        this.blink();
        return CMD_OK;
    }

    cmdBREAK() {
        // SWITCH/CASE break — exit the current SWITCH block
        if (this._select_stack.length > 0) {
            const frame = this._select_stack[this._select_stack.length - 1];
            if (frame.switchMode) {
                frame.matched  = true;
                frame.skipping = true;
                frame.broken   = true;
                return CMD_OK;
            }
        }
        // FOR loop break — force loop variable past end to exit on next NEXT
        if (this.for_level > -1) {
            this.fors[this.for_level][4] = this.fors[this.for_level][2] +
                (this.fors[this.for_level][5] > 0 ? 1 : -1);
        }
        return CMD_OK;
    }

    cmdNEXT(params) {
        if (!params) params = [];
        if (params[0] == null) params[0] = 'DUMMY';

        for (let i = 0; i < params.length; i++) {
            if (this.for_level > -1) {
                this.fors[this.for_level][4] += this.fors[this.for_level][5];
                this.assign_(ASS_NUMBER, this.fors[this.for_level][0], this.fors[this.for_level][4]);

                const step    = this.fors[this.for_level][5];
                const cur     = this.fors[this.for_level][4];
                const limit   = this.fors[this.for_level][2];
                const done    = (step > 0 && cur > limit) || (step < 0 && cur < limit);

                if (done) {
                    this.fors[this.for_level] = null;
                    this.for_level--;
                    if (this.for_level > -1) this.for_var = this.fors[this.for_level][0];
                } else {
                    return Number(this.fors[this.for_level][3]);
                }
            }
        }
        return CMD_OK;
    }

    cmdFOR(line) {
        const parts = this.extractForParts(line);
        if (!parts) return CMD_OK;

        const forVar = parts[0];
        const iStart = Number(this.evalCalc(parts[1], ASS_NUMBER));
        const iEnd   = Number(this.evalCalc(parts[2], ASS_NUMBER));
        const iStep  = parts.length > 3 ? Number(this.evalCalc(parts[3], ASS_NUMBER)) : 1;

        // Already in this loop? Skip re-entry.
        if (this.for_level > -1 && this.for_var === forVar) return CMD_OK;

        this.for_level++;
        if (forVar !== '') {
            this.for_var = forVar;
            this.fors[this.for_level] = [forVar, iStart, iEnd, this.run_line, iStart, iStep];
            this.assign_(ASS_NUMBER, forVar, iStart);
        }
        return CMD_OK;
    }

    cmdIF(line) {
        const upper = line.toUpperCase();
        const thenPos = upper.indexOf('THEN');

        // Block IF: nothing (or only whitespace/comment) after THEN
        // → push a frame and let subsequent lines be skipped/executed.
        if (thenPos > 0) {
            const afterThen = line.substring(thenPos + 4).trim();
            if (afterThen === '' || afterThen.toUpperCase().startsWith('REM')) {
                const condition = line.substring(0, thenPos).trim();
                const result    = this.checkCondition(condition);
                this._if_stack.push({ done: result, skipping: !result });
                return CMD_OK;
            }
        }

        // Single-line IF — original behaviour.
        const parts = this.extractIfParts(line);
        if (!parts) return CMD_OK;

        const condition  = parts[0];
        const thenBranch = parts[1];
        const elseBranch = parts.length > 2 ? parts[2] : null;

        if (this.checkCondition(condition)) {
            this.if_line = thenBranch;
            if (!this.running) this.tick(1);
        } else if (elseBranch) {
            this.if_line = elseBranch;
            if (!this.running) this.tick(1);
        }
        return CMD_OK;
    }

    // Graphics commands

    // =======================================================================
    // GFX 2D — delegated to GfxDriver (core/drivers/gfx.js)
    // Step 2b of V7 architecture refactor: extracted 2026-04
    // =======================================================================
    get _gfx()               { return this._gfxDrv._gfx; }
    set _gfx(v)              { this._gfxDrv._gfx = v; this._term._gfx = v; }
    get _gfxColourTable()    { return this._gfxDrv._gfxColourTable; }
    set _gfxColourTable(v)   { this._gfxDrv._gfxColourTable = v; }
    get _colourCache()       { return this._gfxDrv._colourCache; }
    set _colourCache(v)      { this._gfxDrv._colourCache = v; }

    _activateGraphics()            { return this._gfxDrv._activateGraphics(); }
    _gfxScene()                    { return this._gfxDrv._gfxScene(); }
    _gfxSyncSize()                 { return this._gfxDrv._gfxSyncSize(); }
    _gfxClearImages()              { return this._gfxDrv._gfxClearImages(); }
    _gfxFlush()                    { return this._gfxDrv._gfxFlush(); }
    _gfxClear()                    { return this._gfxDrv._gfxClear(); }
    _gfxColour(c)                  { return this._gfxDrv._gfxColour(c); }
    _gfxRead(x, y)                 { return this._gfxDrv._gfxRead(x, y); }
    _gfxLine(x0,y0,x1,y1,r)       { return this._gfxDrv._gfxLine(x0,y0,x1,y1,r); }
    _gfxCircle(cx,cy,r,rgba)       { return this._gfxDrv._gfxCircle(cx,cy,r,rgba); }
    _gfxFillRect(x1,y1,x2,y2,r)   { return this._gfxDrv._gfxFillRect(x1,y1,x2,y2,r); }
    _gfxRect(x1,y1,x2,y2,r)       { return this._gfxDrv._gfxRect(x1,y1,x2,y2,r); }
    _gfxFillCircle(cx,cy,r,rgba)   { return this._gfxDrv._gfxFillCircle(cx,cy,r,rgba); }
    _gfxPaint(sx,sy,r,b)           { return this._gfxDrv._gfxPaint(sx,sy,r,b); }
    _gfxPlot(x,y,rgba)             { return this._gfxDrv._gfxPlot(x,y,rgba); }
    _imgStore()                    { return this._gfxDrv._imgStore(); }
    _imgLoad(url,cb,errcb)         { return this._gfxDrv._imgLoad(url,cb,errcb); }
    _objCreate(id)                 { return this._gfxDrv._objCreate(id); }
    cmdCOLOUR(p)               { return this.kernel.post({syscall:'gfx.colour',param:p}); }
    cmdCIRCLE(p)               { return this.kernel.post({syscall:'gfx.circle',param:p}); }
    cmdPOINT(p)                { return this.kernel.post({syscall:'gfx.point2',param:p}); }
    cmdFILLCIRCLE(p)           { return this.kernel.post({syscall:'gfx.fillcircle',param:p}); }
    cmdRECT(p)                 { return this.kernel.post({syscall:'gfx.rect',param:p}); }
    cmdFILLRECT(p)             { return this.kernel.post({syscall:'gfx.fillrect',param:p}); }
    cmdLINE(p)                 { return this.kernel.post({syscall:'gfx.line',param:p}); }
    cmdPSET(p)                 { return this.kernel.post({syscall:'gfx.pset',param:p}); }
    cmdPRESET(p)               { return this.kernel.post({syscall:'gfx.preset',param:p}); }
    cmdPAINT(p)                { return this.kernel.post({syscall:'gfx.paint',param:p}); }
    cmdIMAGE(p)               { return this.kernel.post({syscall:'gfx.image',param:p}); }
    cmdLOADIMG(p)              { return this.kernel.post({syscall:'gfx.loadimg',param:p}); }
    cmdDISPLAY(p)              { return this.kernel.post({syscall:'gfx.display',param:p}); }
    cmdIMGLIST(p)              { return this.kernel.post({syscall:'gfx.imglist',param:p}); }
    cmdIMGFREE(p)              { return this.kernel.post({syscall:'gfx.imgfree',param:p}); }

    // -----------------------------------------------------------------------
    // SOUND frequency, duration [, volume [, voice]]

    // =======================================================================
    // Audio — delegated to AudioDriver (core/drivers/audio.js)
    // Step 2 of V7 architecture refactor: extracted 2026-04
    // =======================================================================
    get _audioCtx()      { return this._audioDrv._audioCtx; }
    set _audioCtx(v)     { this._audioDrv._audioCtx = v; }
    get _soundWait()     { return this._audioDrv._soundWait; }
    set _soundWait(v)    { this._audioDrv._soundWait = v; }
    get _soundQueue()    { return this._audioDrv._soundQueue; }
    set _soundQueue(v)   { this._audioDrv._soundQueue = v; }
    get _waveTables()    { return this._audioDrv._waveTables; }
    set _waveTables(v)   { this._audioDrv._waveTables = v; }

    _getAudioCtx()       { return this._audioDrv._getAudioCtx(); }
    _playSoundEntry(e)   { return this._audioDrv._playSoundEntry(e); }
    _flushSoundQueue()   { return this._audioDrv._flushSoundQueue(); }
    cmdSOUND(p)                { return this.kernel.post({syscall:'sound.play',param:p}); }
    cmdWAVE(p)                 { return this.kernel.post({syscall:'sound.wave',param:p}); }

    cmdPOKE(params)  {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        this._memory[Number(params[0]) & 0xFFFF] = Number(params[1]) & 0xFF;
        return CMD_OK;
    }
    cmdPOKEW(params) {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        const a = Number(params[0]) & 0xFFFF, v = Number(params[1]) & 0xFFFF;
        this._memory[a] = v & 0xFF; this._memory[(a+1)&0xFFFF] = (v>>8)&0xFF;
        return CMD_OK;
    }
    cmdPOKEL(params) {
        if (!params || params.length < 2) return CMD_ESYNTAX;
        const a = Number(params[0]) & 0xFFFF, v = Number(params[1]) >>> 0;
        this._memory[a]=(v)&0xFF; this._memory[(a+1)&0xFFFF]=(v>>8)&0xFF;
        this._memory[(a+2)&0xFFFF]=(v>>16)&0xFF; this._memory[(a+3)&0xFFFF]=(v>>24)&0xFF;
        return CMD_OK;
    }

    cmdOPTIONBASE(params) {
        const n = params && params[0] != null ? Number(params[0]) : -1;
        if (n !== 0 && n !== 1) return CMD_ESYNTAX;
        this._optionBase = n;
        return CMD_OK;
    }

    cmdWIDTH(params) {
        this._printWidth = (!params || params[0] == null) ? 0 : Number(params[0]);
        return CMD_OK;
    }

    cmdLSET(param) {
        if (!param) return CMD_ESYNTAX;
        const eq = param.indexOf('=');
        if (eq < 0) return CMD_ESYNTAX;
        const vn  = this.trim(param.substring(0, eq));
        const val = String(this.getValue(param.substring(eq+1).trim(), 0, param.length, ASS_STRING));
        const cur = String(this.lookup_(ASS_STRING, vn) || '');
        const w   = Math.max(cur.length, val.length);
        this.assign_(ASS_STRING, vn, val.padEnd(w).substring(0, w));
        return CMD_OK;
    }
    cmdRSET(param) {
        if (!param) return CMD_ESYNTAX;
        const eq = param.indexOf('=');
        if (eq < 0) return CMD_ESYNTAX;
        const vn  = this.trim(param.substring(0, eq));
        const val = String(this.getValue(param.substring(eq+1).trim(), 0, param.length, ASS_STRING));
        const cur = String(this.lookup_(ASS_STRING, vn) || '');
        const w   = Math.max(cur.length, val.length);
        this.assign_(ASS_STRING, vn, val.padStart(w).substring(0, w));
        return CMD_OK;
    }

    cmdPRINTUSING(param) {
        if (!param) return CMD_ESYNTAX;
        const semi = param.indexOf(';');
        if (semi < 0) return CMD_ESYNTAX;
        let fmt = this.trim(param.substring(0, semi));
        if (fmt.startsWith('"') && fmt.endsWith('"')) fmt = fmt.slice(1, -1);
        else fmt = String(this.lookup(fmt));
        const rest = param.substring(semi + 1);
        const vals = rest.split(';').map(t => {
            const s = this.trim(t);
            return this.getValue(s, 0, s.length, ASS_ANY);
        });
        let vi = 0;
        let out = fmt
            .replace(/%+/g, m => String(vals[vi++]??'').substring(0, m.length).padEnd(m.length))
            .replace(/(\$?)([#,]+(?:\.[#]+)?)/g, (m, dollar, nf) => {
                const n = Number(vals[vi++]??0);
                const dp = nf.indexOf('.');
                const dec = dp >= 0 ? nf.length - dp - 1 : 0;
                let s = n.toFixed(dec);
                if (nf.includes(',')) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
                if (dollar) s = '$' + s;
                return s.padStart(m.length).substring(Math.max(0, s.length - m.length));
            });
        this.appendLine(out, 1);
        return CMD_OK;
    }

    _scanData() {
        // Pre-load all DATA statements in line-number order before execution.
        // Standard BASIC behaviour: READ can access DATA from any line,
        // even lines that haven't been executed yet.
        this.data          = [];
        this.data_count    = 0;
        this.data_position = 0;
        // P8: iterate only assigned lines instead of all 10,000 slots
        const sortedLines = [...this.lines_assigned].sort((a, b) => a - b);
        for (const i of sortedLines) {
            const line = this.lines[i];
            if (line && line.toUpperCase().startsWith('DATA')) {
                const params = this.findParameters(line.substring(4), 1, ',');
                if (params) {
                    for (const p of params) {
                        this.data.push(this.trim(String(p ?? '')));
                        this.data_count++;
                    }
                }
            }
        }
    }

    // _scanLabels — build label→lineNumber map at RUN time.
    // A label is the entire content of a line: "MainLoop:" or "ClickHandler:"
    // Labels must start with a letter, contain letters/digits/periods, end with colon.
    // The line MUST have a line number: e.g. "75 MainLoop:"
    //
    // Labels are CASE-SENSITIVE (Model B): "MainLoop" and "mainloop" are distinct.
    _scanLabels() {
        this._labels = {};
        const LABEL_RE = /^([A-Za-z][A-Za-z0-9.]{0,39}):$/;
        // P8: iterate only assigned lines instead of all 10,000 slots
        for (const i of this.lines_assigned) {
            const raw = this.lines[i];
            if (!raw) continue;
            const t = raw.trim();
            const m = LABEL_RE.exec(t);
            if (m) {
                const lbl = m[1];
                // Don't register SWITCH keywords as labels (DEFAULT:, CASE x:)
                // Keyword check is case-insensitive — those are language tokens.
                const lblU = lbl.toUpperCase();
                if (lblU !== 'DEFAULT' && !lblU.startsWith('CASE'))
                    this._labels[lbl] = i;
            }
        }
    }

    // _resolveLabel — convert a GOTO/GOSUB target to a line number.
    // Accepts a numeric string ("1000") or a label name ("MainLoop").
    // Returns the line number, or -1 if not found.
    // Labels are CASE-SENSITIVE — "MainLoop" only matches "MainLoop".
    _resolveLabel(target) {
        if (!target) return -1;
        const t = this.trim(String(target));
        const n = Number(t);
        if (t !== '' && !isNaN(n)) return n;
        // Label lookup — case-sensitive, lazy scan if not yet built
        if (!this._labels || Object.keys(this._labels).length === 0) this._scanLabels();
        const ln = this._labels[t];
        return ln !== undefined ? ln : -1;
    }

    _scanSubs() {
        this._subs = {};
        // P8: sort assigned lines numerically so we scan in order
        const sortedLines = [...this.lines_assigned].sort((a, b) => a - b);
        for (let si = 0; si < sortedLines.length; si++) {
            const i     = sortedLines[si];
            const line  = (this.lines[i] || '').trim();
            const upper = line.toUpperCase();
            const isFunc = upper.startsWith('FUNCTION ');
            const isSub  = upper.startsWith('SUB ');
            if (!isSub && !isFunc) continue;
            const kw   = isFunc ? 'FUNCTION ' : 'SUB ';
            // Strip trailing STATIC keyword from declaration line
            let sig = line.substring(kw.length).trim();
            const isAllStatic = sig.toUpperCase().endsWith(' STATIC');
            if (isAllStatic) sig = sig.substring(0, sig.length - 7).trim();
            const po   = sig.indexOf('(');
            const name = po >= 0 ? this.trim(sig.substring(0, po)) : sig.split(' ')[0].trim();
            const pstr = po >= 0 ? sig.substring(po+1, sig.lastIndexOf(')')) : '';
            const params = pstr ? pstr.split(',').map(p => this.trim(p)).filter(Boolean) : [];
            // Find END SUB/FUNCTION by scanning forward through sorted assigned lines
            let j = i + 1, ei = si + 1;
            while (ei < sortedLines.length) {
                j = sortedLines[ei];
                const jl = (this.lines[j]||'').trim().toUpperCase();
                if (jl==='END SUB'||jl==='END FUNCTION'||jl==='ENDSUB'||jl==='ENDFUNCTION') break;
                ei++;
            }
            this._subs[name] = { name, params, startLine: i, endLine: j, isFunc, isAllStatic };
            si = ei;  // skip to END SUB line, outer loop will do si++
        }
    }

    cmdDECLARE(param) { return CMD_OK; }  // forward decl — no-op

    // -----------------------------------------------------------------------
    // SHARED var1, var2  — declare variables shared with main program
    // Must appear inside a SUB/FUNCTION body.
    // -----------------------------------------------------------------------
    cmdSHARED(param) {
        if (!param || this._sub_stack.length === 0) return CMD_OK;
        const frame = this._sub_stack[this._sub_stack.length - 1];
        for (const v of param.split(',')) {
            // Variable names are case-sensitive (Model B) — preserve user case.
            const vn = this.trim(v).replace(/\(\s*\)$/, '');  // strip () from array names
            frame.shared.add(vn);
            // Bring the main-program value into scope now
            const mainVal = frame.savedGlobals[vn];
            if (mainVal !== undefined) {
                if (typeof mainVal === 'string') {
                    this.variables_strings.set(vn, mainVal);
                } else {
                    this.variables_numbers.set(vn, mainVal);
                }
            }
            // Also restore numeric arrays (stored with ARR: prefix)
            const arrVal = frame.savedGlobals['ARR:' + vn];
            if (arrVal !== undefined) {
                this.variables_arr_numbers.set(vn, arrVal);
            }
            const arrStrVal = frame.savedGlobals['ARR$:' + vn];
            if (arrStrVal !== undefined) {
                this.variables_arr_strings.set(vn, arrStrVal);
            }
        }
        return CMD_OK;
    }

    // -----------------------------------------------------------------------
    // STATIC var1, var2  — inside a SUB, mark specific vars as static locals
    // (their values persist between calls)
    // -----------------------------------------------------------------------
    cmdSTATIC(param) {
        if (!param || this._sub_stack.length === 0) return CMD_OK;
        const frame   = this._sub_stack[this._sub_stack.length - 1];
        const subKey  = frame.subName;
        for (const v of param.split(',')) {
            // Variable names are case-sensitive (Model B) — preserve user case.
            const vn = this.trim(v);
            frame.explicitStatics.add(vn);
            // Restore persisted value if available
            const stored = this._static_vars[subKey + '.' + vn];
            if (stored !== undefined) {
                if (typeof stored === 'string') this.variables_strings.set(vn, stored);
                else this.variables_numbers.set(vn, stored);
            }
        }
        return CMD_OK;
    }

    // -----------------------------------------------------------------------
    // CALL subName(args) / subName args
    // Proper variable isolation:
    //   - Save ALL current globals into frame.savedGlobals
    //   - Clear variable maps (fresh scope)
    //   - Bind parameters (by ref: store caller varname; by value: store value)
    //   - SHARED vars will be brought back in by cmdSHARED
    //   - ALL-STATIC subs restore their saved local state
    // -----------------------------------------------------------------------
    cmdCALL(param) {
        if (!param) return CMD_ESYNTAX;
        const raw = this.trim(param);
        const po  = raw.indexOf('(');
        let subName, argStr;
        // SUB names are case-sensitive (Model B) — preserve original case for lookup.
        if (po >= 0) {
            subName = this.trim(raw.substring(0, po));
            argStr  = raw.substring(po+1, raw.lastIndexOf(')'));
        } else {
            const sp = raw.indexOf(' ');
            subName = sp > 0 ? raw.substring(0, sp) : raw;
            argStr  = sp > 0 ? raw.substring(sp+1) : '';
        }

        const sub = this._subs[subName];
        if (!sub) { this.appendLine('SUB NOT FOUND: ' + subName, 1); return CMD_ESYNTAX; }

        // Parse arguments — detect pass-by-value (wrapped in parens)
        const argTokens = argStr ? this._splitArgsParen(argStr) : [];
        const byRef  = [];  // caller variable name (for pass-by-ref writeback)
        const byVal  = [];  // evaluated value

        for (let i = 0; i < argTokens.length; i++) {
            const t = this.trim(argTokens[i]);
            const isByVal = t.startsWith('(') && t.endsWith(')');
            if (isByVal) {
                byRef.push(null);
                byVal.push(this.evalCalc(t.slice(1,-1), ASS_ANY));
            } else {
                // Pass by reference — store the caller's variable name in original case
                // so writeback at _returnFromSub finds the case-sensitive caller var.
                byRef.push(t);
                byVal.push(this.lookup(t));
            }
        }

        // Snapshot ALL current global variables
        const savedNums    = new Map(this.variables_numbers);
        const savedStrs    = new Map(this.variables_strings);
        const savedArrNums = new Map([...this.variables_arr_numbers].map(([k,v]) => [k, [...v]]));
        const savedArrStrs = new Map([...this.variables_arr_strings].map(([k,v]) => [k, [...v]]));

        // Build savedGlobals flat map for SHARED to reference.
        // Keys are original-case variable names — cmdSHARED will look them up
        // by the case the user typed in the SHARED declaration.
        // Arrays stored with prefix 'ARR:' to distinguish from scalars.
        const savedGlobals = {};
        for (const [k,v] of savedNums)    savedGlobals[k]        = v;
        for (const [k,v] of savedStrs)    savedGlobals[k]        = v;
        for (const [k,v] of savedArrNums) savedGlobals['ARR:'+k] = v;
        for (const [k,v] of savedArrStrs) savedGlobals['ARR$:'+k]= v;

        // Clear variable scope — fresh locals
        this.variables_numbers     = new Map();
        this.variables_strings     = new Map();
        this.variables_arr_numbers = new Map();
        this.variables_arr_strings = new Map();

        // Restore STATIC locals for this sub (if isAllStatic).
        // Keys are 'subName.varName' — both halves are now case-sensitive.
        if (sub.isAllStatic) {
            for (const [key, val] of Object.entries(this._static_vars)) {
                if (key.startsWith(subName + '.')) {
                    const vn = key.substring(subName.length + 1);
                    if (typeof val === 'string') this.variables_strings.set(vn, val);
                    else this.variables_numbers.set(vn, val);
                }
            }
        }

        // Bind parameters to local scope.
        // Parameter names are case-sensitive — bind under the case declared in
        // the SUB header so the body's variable references match.
        sub.params.forEach((pn, idx) => {
            const val = byVal[idx] ?? (pn.endsWith('$') ? '' : 0);
            const pnClean = pn.replace(/\(\s*\)$/, '');
            if (pn.endsWith('$') || (typeof val === 'string')) {
                this.variables_strings.set(pnClean, String(val));
            } else {
                this.variables_numbers.set(pnClean, Number(val));
            }
        });

        const frame = {
            returnLine:     this.run_line + 1,
            subName,
            byRef,
            paramNames:     sub.params.map(p => p.replace(/\(\s*\)$/, '')),
            savedNums,
            savedStrs,
            savedArrNums,
            savedArrStrs,
            savedGlobals,
            shared:         new Set(),
            explicitStatics: new Set(),
            isAllStatic:    sub.isAllStatic || false,
        };

        this._sub_stack.push(frame);
        this._in_sub = true;
        return sub.startLine + 1;
    }

    // Split arg string respecting nested parens
    _splitArgsParen(s) {
        // Paren-depth-aware arg splitter — used by cmdCALL to split argument list
        const parts = [];
        let depth = 0, cur = '';
        for (const ch of s) {
            if (ch === '(') { depth++; cur += ch; }
            else if (ch === ')') { depth--; cur += ch; }
            else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
            else cur += ch;
        }
        if (cur.trim()) parts.push(cur);
        return parts;
    }

    cmdENDSUB()      { return this._returnFromSub(); }
    cmdENDFUNCTION() { return this._returnFromSub(); }
    cmdEXITSUB()     { return this._returnFromSub(); }

    _returnFromSub() {
        if (this._sub_stack.length === 0) return CMD_OK;
        const frame = this._sub_stack.pop();
        const { subName, byRef, paramNames, savedNums, savedStrs,
                savedArrNums, savedArrStrs, shared, explicitStatics, isAllStatic } = frame;

        // Save STATIC locals — isAllStatic: save everything; else save explicit statics
        const saveStatics = isAllStatic
            ? [...this.variables_numbers, ...this.variables_strings]
            : [];
        if (isAllStatic) {
            for (const [k, v] of this.variables_numbers) {
                this._static_vars[subName + '.' + k] = v;
            }
            for (const [k, v] of this.variables_strings) {
                this._static_vars[subName + '.' + k] = v;
            }
        } else {
            for (const vn of explicitStatics) {
                const numVal = this.variables_numbers.get(vn);
                const strVal = this.variables_strings.get(vn);
                if (numVal !== undefined) this._static_vars[subName + '.' + vn] = numVal;
                if (strVal !== undefined) this._static_vars[subName + '.' + vn] = strVal;
            }
        }

        // Collect SHARED variable values before restoring globals
        const sharedNums = new Map();
        const sharedStrs = new Map();
        const sharedArrNums = new Map();
        const sharedArrStrs = new Map();
        for (const vn of shared) {
            const n = this.variables_numbers.get(vn);
            const s = this.variables_strings.get(vn);
            const an = this.variables_arr_numbers.get(vn);
            const as_ = this.variables_arr_strings.get(vn);
            if (n  !== undefined) sharedNums.set(vn, n);
            if (s  !== undefined) sharedStrs.set(vn, s);
            if (an !== undefined) sharedArrNums.set(vn, an);
            if (as_ !== undefined) sharedArrStrs.set(vn, as_);
        }

        // Write back pass-by-reference parameter changes to caller
        const refUpdates = {};
        paramNames.forEach((pn, idx) => {
            const callerVar = byRef[idx];
            if (!callerVar) return;  // was pass-by-value
            const numVal = this.variables_numbers.get(pn);
            const strVal = this.variables_strings.get(pn);
            if (numVal !== undefined) refUpdates[callerVar] = { type: 'num', val: numVal };
            else if (strVal !== undefined) refUpdates[callerVar] = { type: 'str', val: strVal };
        });

        // Restore global variable scope
        this.variables_numbers     = savedNums;
        this.variables_strings     = savedStrs;
        this.variables_arr_numbers = savedArrNums;
        this.variables_arr_strings = savedArrStrs;

        // Apply SHARED changes back to global scope
        for (const [k, v] of sharedNums)    this.variables_numbers.set(k, v);
        for (const [k, v] of sharedStrs)    this.variables_strings.set(k, v);
        for (const [k, v] of sharedArrNums) this.variables_arr_numbers.set(k, v);
        for (const [k, v] of sharedArrStrs) this.variables_arr_strings.set(k, v);

        // Apply pass-by-reference updates
        for (const [callerVar, upd] of Object.entries(refUpdates)) {
            if (upd.type === 'num') this.variables_numbers.set(callerVar, upd.val);
            else this.variables_strings.set(callerVar, upd.val);
        }

        this._in_sub = this._sub_stack.length > 0;
        if (frame._afterReturn) this.line_remaining = frame._afterReturn;
        return frame.returnLine;
    }

    // -----------------------------------------------------------------------
    // TIER 2 COMMANDS
    // -----------------------------------------------------------------------

    // ------------------------------------------------------------------
    // ELSEIF / ELSE / END IF  — block-structured IF
    //
    // Block IF works differently from single-line IF: when we see
    //   IF cond THEN          (no statement after THEN)
    // we push a frame onto _if_stack and skip or execute subsequent lines
    // until we hit ELSEIF, ELSE, or END IF.
    //
    // The interpreter calls cmdIF for every IF line.  We detect block-IF
    // (nothing after THEN) vs single-line IF (something after THEN) here.
    // ------------------------------------------------------------------

    cmdELSEIF(line) {
        // If the current block was already satisfied, skip through to END IF.
        if (this._if_stack.length === 0) {
            this.appendLine('ELSEIF WITHOUT IF', 1); return CMD_ESYNTAX;
        }
        const frame = this._if_stack[this._if_stack.length - 1];
        if (frame.done) {
            frame.skipping = true;
        } else {
            // Evaluate the new condition.
            const thenPos = line.toUpperCase().indexOf('THEN');
            const cond = thenPos > 0 ? line.substring(0, thenPos).trim() : line.trim();
            if (this.checkCondition(cond)) {
                frame.skipping = false;
                frame.done     = true;
            } else {
                frame.skipping = true;
            }
        }
        return CMD_OK;
    }

    cmdENDIF() {
        if (this._if_stack.length > 0) this._if_stack.pop();
        return CMD_OK;
    }

    // ------------------------------------------------------------------
    // WHILE expr / WEND
    // ------------------------------------------------------------------
    cmdWHILE(expr) {
        if (!expr || !expr.trim()) return CMD_ESYNTAX;
        if (this.checkCondition(expr.trim())) {
            // Push the loop start so WEND knows where to jump back.
            this._while_stack.push({ line: this.run_line, expr: expr.trim() });
        } else {
            // Skip forward to matching WEND.
            let depth = 1;
            let i = this.run_line + 1;
            while (i < MAX_LINES && depth > 0) {
                const l = (this.lines[i] || '').trim().toUpperCase();
                if (l.startsWith('WHILE')) depth++;
                if (l.startsWith('WEND'))  depth--;
                i++;
            }
            this.run_line = i - 1;
        }
        return CMD_OK;
    }

    cmdWEND() {
        if (this._while_stack.length === 0) {
            this.appendLine('WEND WITHOUT WHILE', 1); return CMD_ESYNTAX;
        }
        const frame = this._while_stack[this._while_stack.length - 1];
        if (this.checkCondition(frame.expr)) {
            return frame.line;   // jump back to WHILE line
        } else {
            this._while_stack.pop();
        }
        return CMD_OK;
    }

    // ------------------------------------------------------------------
    // SELECT CASE / CASE / CASE ELSE / END SELECT
    // ------------------------------------------------------------------
    cmdSELECTCASE(expr) {
        if (!expr || !expr.trim()) return CMD_ESYNTAX;
        const val = this.evalCalc(expr.trim(), ASS_ANY);
        this._select_stack.push({ val, matched: false, skipping: false, broken: false, switchMode: false });
        return CMD_OK;
    }

    cmdCASE(param) {
        if (this._select_stack.length === 0) {
            this.appendLine('CASE WITHOUT SELECT', 1); return CMD_ESYNTAX;
        }
        const frame = this._select_stack[this._select_stack.length - 1];
        if (frame.matched) {
            if (!frame.switchMode) {
                // SELECT CASE style: always skip remaining cases once matched.
                frame.skipping = true; return CMD_OK;
            }
            // SWITCH style: skip if BREAK was seen, fall-through if not.
            if (frame.broken) { frame.skipping = true; return CMD_OK; }
            // No BREAK yet — consecutive CASEs share body (fall-through).
            frame.skipping = false;
            return CMD_OK;
        }
        let p   = (param || '').trim();
        if (p.endsWith(':')) p = p.slice(0, -1).trim();  // allow CASE 1: syntax
        const pUp = p.toUpperCase();
        const fVal = frame.val;
        let matched = false;
        if (pUp === 'ELSE') {
            matched = true;
        } else if (pUp.startsWith('IS ')) {
            matched = this.checkCondition(String(fVal) + p.substring(3).trim());
        } else if (pUp.includes(' TO ')) {
            const toIdx = pUp.indexOf(' TO ');
            const lo = this.evalCalc(p.substring(0, toIdx).trim(), ASS_ANY);
            const hi = this.evalCalc(p.substring(toIdx + 4).trim(), ASS_ANY);
            matched = fVal >= lo && fVal <= hi;
        } else {
            for (const part of p.split(',')) {
                const v = this.evalCalc(part.trim(), ASS_ANY);
                if (typeof fVal === 'string' ? fVal === String(v) : Number(fVal) === Number(v)) {
                    matched = true; break;
                }
            }
        }
        frame.matched  = matched ? true : frame.matched;
        frame.skipping = !matched;
        return CMD_OK;
    }

    cmdENDSELECT() {
        if (this._select_stack.length > 0) this._select_stack.pop();
        return CMD_OK;
    }

    // BREAK — used inside SWITCH/SELECT to stop executing further cases.
    // Sets matched=true, skipping=true, and broken=true.
    // broken=true means: "a BREAK was seen, don't allow fall-through on next CASE".

    // SWITCH(expr) — alias for SELECT CASE, strips optional parens
    cmdSWITCH(expr) {
        expr = (expr || '').trim();
        // Strip outer parens: switch(x) -> x
        if (expr.startsWith('(') && expr.endsWith(')')) expr = expr.slice(1, -1).trim();
        if (!expr) return CMD_ESYNTAX;
        const val = this.evalCalc(expr, ASS_ANY);
        this._select_stack.push({ val, matched: false, skipping: false, broken: false, switchMode: true });
        return CMD_OK;
    }

    // CASE x: — alias for CASE, strips trailing colon
    // DEFAULT: — alias for CASE ELSE
    cmdCASECOLON(param) {
        param = (param || '').trim();
        if (param.endsWith(':')) param = param.slice(0, -1).trim();
        return this.cmdCASE(param);
    }

    // ------------------------------------------------------------------
    // ON n GOTO line1, line2, ...
    // ON n GOSUB line1, line2, ...
    // ------------------------------------------------------------------
    cmdONGOTO(param) {
        if (!param) return CMD_ESYNTAX;
        // Detect ON n GOSUB vs ON n GOTO and dispatch correctly.
        const upper = param.toUpperCase();
        const isSub = upper.indexOf('GOSUB') >= 0;
        return this._onBranch(param, isSub);
    }
    cmdONGOSUB(param) { return this._onBranch(param, true); }

    _onBranch(param, isSub) {
        if (!param) return CMD_ESYNTAX;
        // param looks like: "X GOTO 100,200,300" or "X GOSUB 100,200,300"
        const upper = param.toUpperCase();
        const kw    = isSub ? 'GOSUB' : 'GOTO';
        const kwPos = upper.indexOf(kw);
        if (kwPos < 0) return CMD_ESYNTAX;
        const nExpr = param.substring(0, kwPos).trim();
        const lines = param.substring(kwPos + kw.length).split(',').map(s => parseInt(s.trim(), 10));
        const n     = Math.floor(Number(this.evalCalc(nExpr, ASS_NUMBER, 0)));
        if (n < 1 || n > lines.length) return CMD_OK;  // out of range = fall through
        const target = lines[n - 1];
        if (isSub) {
            this.gosub_level++;
            this.gosubs[this.gosub_level] = this.run_line + 1;
        }
        return target;
    }

    // ------------------------------------------------------------------
    // ON ERROR GOTO line  /  ON ERROR GOTO 0 (disable)
    // ------------------------------------------------------------------
    cmdONERROR(param) {
        if (!param) return CMD_ESYNTAX;
        const upper = param.trim().toUpperCase();
        if (upper.startsWith('GOTO')) {
            const targetStr = param.trim().substring(4).trim();
            const resolved  = this._resolveLabel(targetStr);
            this._error_trap_line = resolved >= 0 ? resolved : -1;
        }
        return CMD_OK;
    }

    // ------------------------------------------------------------------
    // RESUME [NEXT | line]
    // ------------------------------------------------------------------
    cmdRESUME(param) {
        this._in_error = false;
        const p = this.trim(String(param || '')).toUpperCase();
        if (p === 'NEXT') {
            return this._error_resume_line + 1;
        } else if (p === '') {
            return this._error_resume_line;
        } else {
            const n = parseInt(p, 10);
            return isNaN(n) ? CMD_OK : n;
        }
    }

    // Internal — trigger an error (called from interpret on unhandled errors)
    _triggerError(code, line) {
        this._last_err = code;
        this._last_erl = line;
        this._error_resume_line = line;
        if (this._error_trap_line >= 0 && !this._in_error) {
            this._in_error = true;
            this.run_line  = this._error_trap_line;
            return true;   // handled
        }
        return false;      // unhandled — caller should display error
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // LOCATE row, col  — position cursor on a fixed character grid.
    // First call activates screen buffer mode; CLS deactivates it.
    // ------------------------------------------------------------------

    // =======================================================================
    // Terminal I/O — delegated to TerminalDriver (core/drivers/terminal.js)
    // Step 5 of V7 architecture refactor: extracted 2026-04
    // =======================================================================

    // ── Terminal-owned state (proxy through to driver) ────────────────────
    get o()                    { return this._term.o; }
    set o(v)                   { this._term.o = v; }
    get canvas()               { return this._term.canvas; }
    set canvas(v)              { this._term.canvas = v; }
    get context()              { return this._term.context; }
    set context(v)             { this._term.context = v; }
    get colours()              { return this._term.colours; }
    set colours(v)             { this._term.colours = v; }
    get colour_fg_cursor()     { return this._term.colour_fg_cursor; }
    set colour_fg_cursor(v)    { this._term.colour_fg_cursor = v; }
    get colour_bg_cursor()     { return this._term.colour_bg_cursor; }
    set colour_bg_cursor(v)    { this._term.colour_bg_cursor = v; }
    get colour_bg()            { return this._term.colour_bg; }
    set colour_bg(v)           { this._term.colour_bg = v; }
    get cursor()               { return this._term.cursor; }
    set cursor(v)              { this._term.cursor = v; }
    get current_cursor()       { return this._term.current_cursor; }
    set current_cursor(v)      { this._term.current_cursor = v; }
    get cursor_delay()         { return this._term.cursor_delay; }
    set cursor_delay(v)        { this._term.cursor_delay = v; }
    get cursor_timer()         { return this._term.cursor_timer; }
    set cursor_timer(v)        { this._term.cursor_timer = v; }
    get current_line()         { return this._term.current_line; }
    set current_line(v)        { this._term.current_line = v; }
    get char_index()           { return this._term.char_index; }
    set char_index(v)          { this._term.char_index = v; }
    get line_index()           { return this._term.line_index; }
    set line_index(v)          { this._term.line_index = v; }
    get cols()                 { return this._term.cols; }
    set cols(v)                { this._term.cols = v; }
    get rows()                 { return this._term.rows; }
    set rows(v)                { this._term.rows = v; }
    get init_cols()            { return this._term.init_cols; }
    set init_cols(v)           { this._term.init_cols = v; }
    get init_rows()            { return this._term.init_rows; }
    set init_rows(v)           { this._term.init_rows = v; }
    get prompt()               { return this._term.prompt; }
    set prompt(v)              { this._term.prompt = v; }
    get error_type()           { return this._term.error_type; }
    set error_type(v)          { this._term.error_type = v; }
    get error_file()           { return this._term.error_file; }
    set error_file(v)          { this._term.error_file = v; }
    get error_syntax()         { return this._term.error_syntax; }
    set error_syntax(v)        { this._term.error_syntax = v; }
    get error_break()          { return this._term.error_break; }
    set error_break(v)         { this._term.error_break = v; }
    get error_data()           { return this._term.error_data; }
    set error_data(v)          { this._term.error_data = v; }
    get error_save()           { return this._term.error_save; }
    set error_save(v)          { this._term.error_save = v; }
    get error_division_by_zero() { return this._term.error_division_by_zero; }
    set error_division_by_zero(v){ this._term.error_division_by_zero = v; }
    get at()                   { return this._term.at; }
    set at(v)                  { this._term.at = v; }
    get current_error()        { return this._term.current_error; }
    set current_error(v)       { this._term.current_error = v; }
    get prefix()               { return this._term.prefix; }
    set prefix(v)              { this._term.prefix = v; }
    get init_text()            { return this._term.init_text; }
    set init_text(v)           { this._term.init_text = v; }
    get init()                 { return this._term.init; }
    set init(v)                { this._term.init = v; }
    get init_delay()           { return this._term.init_delay; }
    set init_delay(v)          { this._term.init_delay = v; }
    get _locateMode()          { return this._term._locateMode; }
    set _locateMode(v)         { this._term._locateMode = v; }
    get _screenBuf()           { return this._term._screenBuf; }
    set _screenBuf(v)          { this._term._screenBuf = v; }
    get _screenEl()            { return this._term._screenEl; }
    set _screenEl(v)           { this._term._screenEl = v; }
    get _curRow()              { return this._term._curRow; }
    set _curRow(v)             { this._term._curRow = v; }
    get _curCol()              { return this._term._curCol; }
    set _curCol(v)             { this._term._curCol = v; }
    get _scrollable()          { return this._term._scrollable; }
    set _scrollable(v)         { this._term._scrollable = v; }
    get _scrollPending()       { return this._term._scrollPending; }
    set _scrollPending(v)      { this._term._scrollPending = v; }
    get _measureDiv()          { return this._term._measureDiv; }
    set _measureDiv(v)         { this._term._measureDiv = v; }
    get _mouse()               { return this._term._mouse; }
    set _mouse(v)              { this._term._mouse = v; }
    get _mouseEnabled()        { return this._term._mouseEnabled; }
    set _mouseEnabled(v)       { this._term._mouseEnabled = v; }
    get _mouseGosub()          { return this._term._mouseGosub; }
    set _mouseGosub(v)         { this._term._mouseGosub = v; }
    get line_typed()           { return this._term.line_typed; }
    set line_typed(v)          { this._term.line_typed = v; }
    get cursor_pos()           { return this._term.cursor_pos; }
    set cursor_pos(v)          { this._term.cursor_pos = v; }
    get quoted()               { return this._term.quoted; }
    set quoted(v)              { this._term.quoted = v; }
    get want_password()        { return this._term.want_password; }
    set want_password(v)       { this._term.want_password = v; }
    get want_password_line_mode()  { return this._term.want_password_line_mode; }
    set want_password_line_mode(v) { this._term.want_password_line_mode = v; }
    promptPassword(cb, text)   { return this._term.promptPassword(cb, text); }
    get want_text_line_mode()  { return this._term.want_text_line_mode; }
    set want_text_line_mode(v) { this._term.want_text_line_mode = v; }
    promptText(cb, text)       { return this._term.promptText(cb, text); }
    get want_input()           { return this._term.want_input; }
    set want_input(v)          { this._term.want_input = v; }
    get input_var_type()       { return this._term.input_var_type; }
    set input_var_type(v)      { this._term.input_var_type = v; }
    get want_keypress()        { return this._term.want_keypress; }
    set want_keypress(v)       { this._term.want_keypress = v; }
    get input_var()            { return this._term.input_var; }
    set input_var(v)           { this._term.input_var = v; }
    get last_key_pressed()     { return this._term.last_key_pressed; }
    set last_key_pressed(v)    { this._term.last_key_pressed = v; }
    get _keysHeld()            { return this._term._keysHeld; }
    set _keysHeld(v)           { this._term._keysHeld = v; }
    get _inputGrace()          { return this._term._inputGrace; }
    set _inputGrace(v)         { this._term._inputGrace = v; }
    get history()              { return this._term.history; }
    set history(v)             { this._term.history = v; }
    get history_line()         { return this._term.history_line; }
    set history_line(v)        { this._term.history_line = v; }
    get lprinter()             { return this._term.lprinter; }
    set lprinter(v)            { this._term.lprinter = v; }
    get width()                { return this._term.width; }
    set width(v)               { this._term.width = v; }
    get height()               { return this._term.height; }
    set height(v)              { this._term.height = v; }
    get font_size()            { return this._term.font_size; }
    set font_size(v)           { this._term.font_size = v; }
    get divId()                { return this._term.divId; }
    get type()                 { return this._term.type; }
    get ai_key()               { return this._term.ai_key; }
    set ai_key(v)              { this._term.ai_key = v; }
    get _graphicsActive()      { return this._term._graphicsActive; }
    set _graphicsActive(v)     { this._term._graphicsActive = v; }
    get _spr()                 { return this.__spr; }   // sprite scene — owned by interpreter
    set _spr(v)                { this.__spr = v; }
    get _boundKeyHandler()     { return this._term._boundKeyHandler; }

    // ── Terminal method delegates ──────────────────────────────────────────
    appendLine(t, n)           { return this._term.appendLine(t, n); }
    appendCharacter(c)         { return this._term.appendCharacter(c); }
    increaseColBy(n)           { return this._term.increaseColBy(n); }
    increaseLine()             { return this._term.increaseLine(); }
    appendCursor()             { return this._term.appendCursor(); }
    removeCursor()             { return this._term.removeCursor(); }
    blink()                    { return this._term.blink(); }
    cls()                      { return this._term.cls(); }
    _scrollToBottom()          { return this._term._scrollToBottom(); }
    _forceScrollToBottom()     { return this._term._forceScrollToBottom(); }
    _onProgramStop() {
        this._term._onProgramStop();
        // Emit kernel lifecycle event so bus listeners (e.g. GL canvas hide) fire
        this.kernel.emit('program.stop');

        // ── Restore shell memory (PID 1) ───────────────────────────────────
        // Unregister the program PID and swap back to the shell's ProcessMemory.
        // The shell's lines[], variables etc are untouched — exactly as a real OS
        // would restore the shell context after a child process exits.
        if (this.os && this._programPid !== null) {
            const rec = this.os._processes.get(this._programPid);
            if (rec) rec.state = 'stopped';
            this.os._processes.delete(this._programPid);
            this._programPid = null;
        }
        if (this._shellMem && this._mem !== this._shellMem) {
            this.swapMemory(this._shellMem);
        }
    }
    _markInputStart()          { return this._term._markInputStart(); }
    _removeAfterSentinel()     { return this._term._removeAfterSentinel(); }
    _redrawInputLine()         { return this._term._redrawInputLine(); }
    ignoreKeyHandler(e)        { return this._term.ignoreKeyHandler(e); }
    keyHandler(e)              { return this._term.keyHandler(e); }
    reset_(s)                  { return this._term.reset_(s); }
    setup()                    { return this._term.setup(); }
    initialize()               { return this._term.initialize(); }
    cmdLOCATE(p)               { return this._term.cmdLOCATE(p); }
    _screenWrite(c)            { return this._term._screenWrite(c); }
    _screenRender()            { return this._term._screenRender(); }
    _screenCls()               { return this._term._screenCls(); }


    // ------------------------------------------------------------------
    // CSRLIN — return current cursor line number
    // ------------------------------------------------------------------
    // (Handled as a numeric variable in lookup_)

    // ------------------------------------------------------------------
    // STOP — pause execution (like BREAK but sets resume point)
    // ------------------------------------------------------------------
    cmdSTOP() {
        this._error_resume_line = this.run_line;
        this.running    = 0;
        this.just_stopped = 1;
        this._onProgramStop();
        this.appendLine('BREAK AT ' + this.run_line, 1);
        this.appendLine(this.prompt, 0);
        this.blink();
        return CMD_END;
    }

    // ------------------------------------------------------------------
    // LBOUND / UBOUND as commands (alias — they also work as functions)
    // ------------------------------------------------------------------
    cmdLBOUND(params) { return CMD_OK; }
    cmdUBOUND(params) { return CMD_OK; }

    // ------------------------------------------------------------------
    // RANDOMIZE TIMER shortcut (already handled in cmdRANDOMIZE,
    // but ensure TIMER keyword resolves correctly)
    // ------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // TIER 1 COMMANDS  (Amiga BASIC parity additions)
    // -----------------------------------------------------------------------

    // FULLSCREEN [ON|OFF|ENTER|EXIT] — set, toggle, or app-bracket fullscreen mode.
    //
    // ON / OFF / (no arg)  — direct set/toggle (legacy behaviour)
    // ENTER                — save the user's current fullscreen state (once, lazily)
    //                        and switch to fullscreen. Idempotent across repeated calls
    //                        — re-entering an app's start menu won't clobber the save.
    // EXIT                 — restore the saved state and clear the save slot. No-op
    //                        if nothing was ever saved.
    //
    // The CSS class flip is synchronous, but the resize chain that updates
    // canvas.width/height is async (~50ms outer + ~60ms inner debounce in
    // boot.js's onResize). _applyFullscreen pauses BASIC execution between
    // those points so subsequent reads of WIDTH/HEIGHT always see the post-
    // resize dimensions. Skipped entirely when the requested state matches
    // the current state (no flicker, no useless pause).
    cmdFULLSCREEN(param) {
        const arg = this.trim(String(param || '')).toUpperCase();
        const body = document.body;
        if (arg === 'ENTER') {
            if (this._fullscreenSavedState === undefined) {
                this._fullscreenSavedState = body.classList.contains('fullscreen');
            }
            return this._applyFullscreen('ON');
        }
        if (arg === 'EXIT') {
            if (this._fullscreenSavedState !== undefined) {
                const target = this._fullscreenSavedState ? 'ON' : 'OFF';
                this._fullscreenSavedState = undefined;
                return this._applyFullscreen(target);
            }
            return CMD_OK;
        }
        return this._applyFullscreen(arg);
    }

    _applyFullscreen(arg) {
        const body = document.body;
        const btn  = document.getElementById('fs-toggle');
        const wasFs = body.classList.contains('fullscreen');
        // Exit overscan if active when entering fullscreen
        body.classList.remove('overscan');
        const osBtn = document.getElementById('os-toggle');
        if (osBtn) osBtn.textContent = 'OVERSCAN';
        let isFs;
        if (arg === 'ON')       { body.classList.add('fullscreen');    isFs = true; }
        else if (arg === 'OFF') { body.classList.remove('fullscreen'); isFs = false; }
        else                    { isFs = body.classList.toggle('fullscreen'); }
        if (btn) btn.textContent = isFs ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
        // Only run the resize-pause dance if state actually changed.
        if (isFs !== wasFs) this._beginResizePause(true);
        return CMD_OK;
    }

    cmdOVERSCAN(param) {
        const arg = this.trim(String(param || '')).toUpperCase();
        const body = document.body;
        const btn  = document.getElementById('os-toggle');
        // Exit fullscreen if active when entering overscan
        body.classList.remove('fullscreen');
        const fsBtn = document.getElementById('fs-toggle');
        if (fsBtn) fsBtn.textContent = 'FULLSCREEN';
        let isOs;
        if (arg === 'ON')       { body.classList.add('overscan');    isOs = true; }
        else if (arg === 'OFF') { body.classList.remove('overscan'); isOs = false; }
        else                    { isOs = body.classList.toggle('overscan'); }
        if (btn) btn.textContent = isOs ? 'EXIT OVERSCAN' : 'OVERSCAN';
        this._beginResizePause(true);
        return CMD_OK;
    }

    // Pause the BASIC tick loop until the async _osaware_resize chain has
    // applied new canvas dimensions, then resume scheduling. Shared between
    // cmdFULLSCREEN and cmdOVERSCAN. Falls back to a plain setTimeout if the
    // host page never wired up window._osaware_resize.
    _beginResizePause(fromFullscreen) {
        const resume = () => {
            this._resizePending = false;
            if (this.running) this._scheduleNextTick();
        };
        this._resizePending = true;
        this._cancelNextTick();
        setTimeout(() => {
            if (window._osaware_resize) window._osaware_resize(!!fromFullscreen, resume);
            else resume();
        }, 50);
    }

    cmdUI(param) {
        const arg = this.trim(String(param || '')).toUpperCase();
        const el = this.o;
        if (!el) return CMD_OK;
        if (arg === 'OFF' || arg === '0') {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
        } else {
            el.style.opacity = '1';
            el.style.pointerEvents = '';
        }
        return CMD_OK;
    }

    // _glSyncCanvas — ensure canvas pixel dimensions match its CSS display size.
    // Called at the start of each GL.CLS so GL programs auto-fill the viewport.
    _glSyncCanvas() {
        if (!this.canvas) return;
        const wrapper = this.canvas.parentElement;
        if (!wrapper) return;
        const cw = wrapper.clientWidth  || wrapper.offsetWidth;
        const ch = wrapper.clientHeight || wrapper.offsetHeight;
        if (cw > 0 && ch > 0 && (this.canvas.width !== cw || this.canvas.height !== ch)) {
            this.canvas.width  = cw;
            this.canvas.height = ch;
            this.canvas.style.width  = cw + 'px';
            this.canvas.style.height = ch + 'px';
            // Update interpreter's own width/height trackers
            this.width  = cw;
            this.height = ch;
            // Refresh context reference after resize
            this.context = this.canvas.getContext('2d');
        }
    }


    cmdBEEP()                  { return this.kernel.post({syscall:'sound.beep'}); }

    cmdSWAP(params) {
        if (!params || params[0] == null || params[1] == null) return CMD_ESYNTAX;
        const nameA = this.trim(String(params[0]));
        const nameB = this.trim(String(params[1]));
        const valA  = this.lookup(nameA);
        const valB  = this.lookup(nameB);
        this.assign(nameA, valB);
        this.assign(nameB, valA);
        return CMD_OK;
    }

    cmdRANDOMIZE(params) {
        if (params && params[0] != null) {
            const raw  = String(params[0]).trim().toUpperCase();
            const seed = (raw === 'TIMER') ? Date.now() : (Number(params[0]) || Date.now());
            this._rng_seed = (Math.abs(seed) & 0x7FFFFFFF) || 1;
        } else {
            this.appendLine('Random number seed? ', 0);
            this.want_input     = 1;
            this.input_var      = '__RANDOMIZE__';
            this.input_var_type = ASS_NUMBER;
            this.char_index     = -1;
            this.blink();
        }
        return CMD_OK;
    }

    _seededRandom() {
        if (this._rng_seed == null) return Math.random();
        this._rng_seed = (this._rng_seed * 16807) % 2147483647;
        return (this._rng_seed - 1) / 2147483646;
    }

    cmdWRITE(param) {
        if (!param) { this.appendLine('', 1); return CMD_OK; }
        const tokens = param.split(',');
        const out = tokens.map(tok => {
            tok = this.trim(tok);
            const val = this.getValue(tok, 0, tok.length, ASS_ANY);
            return (typeof val === 'string') ? '"' + val + '"' : String(val);
        }).join(',');
        this.appendLine(out, 1);
        return CMD_OK;
    }

    cmdERASE(params) {
        if (!params) return CMD_ESYNTAX;
        for (const p of params) {
            const name = this.trim(String(p));
            this.variables_arr_numbers = this.variables_arr_numbers.filter(e => e[0] !== name);
            this.variables_arr_strings = this.variables_arr_strings.filter(e => e[0] !== name);
        }
        return CMD_OK;
    }

    cmdCLEAR() {
        this.zapVariables();
        this.variables_func  = [];
        this.data            = null;
        this.data_count      = -1;
        this.data_position   = 0;
        this.for_level       = -1;
        this.gosub_level     = -1;
        this.gosubs          = [];
        return CMD_OK;
    }

    cmdDELETE(param) {
        if (!param) return CMD_ESYNTAX;
        const raw  = this.trim(String(param));
        const dash = raw.indexOf('-');
        let s, f;
        if (dash > 0) {
            s = parseInt(raw.substring(0, dash), 10);
            f = parseInt(raw.substring(dash + 1), 10);
        } else {
            s = f = parseInt(raw, 10);
        }
        if (isNaN(s) || isNaN(f)) return CMD_ESYNTAX;
        for (let i = s; i <= f; i++) {
            this.lines[i] = '';
            this.line_unassigned(i);
        }
        return CMD_OK;
    }

    cmdRESTORE(params) {
        const startLine = (params && params[0] != null && Number(params[0]) > 0)
            ? Number(params[0]) : 0;

        if (this.running && this.data && this.data_count >= 0) {
            // Data was pre-loaded by _scanData(). Find the position of the
            // first item that came from >= startLine by re-scanning line numbers.
            // Simpler approach: rebuild from startLine (fast, correct).
            const newData = [];
            for (let i = startLine; i < MAX_LINES; i++) {
                const line = this.lines[i];
                if (line && line.toUpperCase().startsWith('DATA')) {
                    const p = this.findParameters(line.substring(4), 1, ',');
                    if (p) for (const v of p) newData.push(this.trim(String(v ?? '')));
                }
            }
            this.data          = newData;
            this.data_count    = newData.length;
            this.data_position = 0;
        } else {
            // Interactive / direct mode — re-scan from scratch.
            this.data          = null;
            this.data_count    = -1;
            this.data_position = 0;
            for (let i = startLine; i < MAX_LINES; i++) {
                if (this.lines[i] && this.lines[i].toUpperCase().startsWith('DATA')) {
                    this.cmdDATA(this.findParameters(this.lines[i].substring(4), 1, ','));
                }
            }
            this.data_position = 0;
        }
        return CMD_OK;
    }

    cmdLINEINPUT(param) {
        if (!param) return CMD_ESYNTAX;
        let sInput = this.trim(param);
        if (sInput.startsWith('"')) {
            const endQ = sInput.indexOf('"', 1);
            if (endQ > 0) {
                this.appendLine(sInput.substring(1, endQ), 0);
                sInput = this.trim(sInput.substring(endQ + 1));
                if (sInput.startsWith(';')) sInput = this.trim(sInput.substring(1));
            }
        }
        this.want_input     = 1;
        this.input_var      = sInput;
        this.input_var_type = ASS_STRING;
        this.char_index     = -1;
        this.blink();
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

    // _imgLoad — load a URL into an Image element, call cb(img) on success.
    // Uses want_ai to pause BASIC execution during the async fetch.

    // _imgResume — resume BASIC execution after async image operation.
    _imgResume() {
        if (this.running) { this.run_line++; this._skipToNextLine(); this._scheduleNextTick(); }
        else { this.appendLine(this.prompt, 0); this.blink(); }
    }

    // _imgResolve — resolve a name/url arg to either a stored image data-URL,
    // a VFS asset path, or a direct URL. Returns the URL string or null.
    _imgResolve(nameOrUrl) {
        const store = this._imgStore();
        if (store[nameOrUrl]) return store[nameOrUrl];
        // Also check without quotes
        const bare = nameOrUrl.replace(/^"|"$/g, '');
        if (store[bare]) return store[bare];
        // Check VFS asset store (paths containing '/')
        if (bare.includes('/') && this.fs) {
            const assetData = this.fs.getAsset(bare);
            if (assetData) return assetData;
        }
        // Fall back to treating it as a direct URL
        return bare || null;
    }

    // LOADIMG "name", "url" — fetch URL and store as data-URL in the image store.

    // DISPLAY "name" [,x,y [,w,h]] — draw a stored image to the canvas.

    // IMGLIST — print names of all stored images.

    // IMGFREE "name" — remove image from store.

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

    // -----------------------------------------------------------------------
    // Three.js Sprite Engine — hardware-accelerated OBJECT rendering
    // Uses an orthographic WebGL canvas (between 2D canvas and GL canvas).
    // Sprites are PlaneGeometry + MeshBasicMaterial with a DataTexture.
    // -----------------------------------------------------------------------

    // Initialise (or return) the ortho Three.js scene used for sprites
    _spriteScene() {
        if (this._spr) return this._spr;

        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper || typeof THREE === 'undefined') return null;

        const W = wrapper.clientWidth  || 800;
        const H = wrapper.clientHeight || 600;

        // Dedicated canvas — sits above the 2D canvas, below the GL canvas
        const wc = document.createElement('canvas');
        wc.id = 'spritekanvas';
        wc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
        wc.style.width  = W + 'px';
        wc.style.height = H + 'px';
        wrapper.appendChild(wc);

        const renderer = new THREE.WebGLRenderer({ canvas: wc, antialias: false, alpha: true });
        renderer.setSize(W, H);
        renderer.setPixelRatio(1);           // pixel-perfect sprites
        renderer.setClearColor(0x000000, 0); // fully transparent background

        // Orthographic camera: origin top-left, y-down (matches BASIC coords)
        const camera = new THREE.OrthographicCamera(0, W, 0, -H, -1, 1);
        camera.position.set(0, 0, 0);

        const scene = new THREE.Scene();

        this._spr = { renderer, scene, camera, W, H, canvas: wc };

        // Keep in sync with terminal-wrapper size
        window.addEventListener('resize', () => this._sprSyncSize());
        window.addEventListener('resize', () => this._gfxSyncSize());
        return this._spr;
    }

    _sprSyncSize() {
        const s = this._spr;
        if (!s) return;
        const wrapper = document.getElementById('terminal-wrapper');
        if (!wrapper) return;
        const W = wrapper.clientWidth, H = wrapper.clientHeight;
        if (W === s.W && H === s.H) return;
        s.W = W; s.H = H;
        s.renderer.setSize(W, H);
        s.canvas.style.width  = W + 'px';
        s.canvas.style.height = H + 'px';
        s.camera.right  =  W;
        s.camera.bottom = -H;
        s.camera.updateProjectionMatrix();
    }

    // Build or rebuild the Three.js mesh for one sprite object
    _sprBuildMesh(obj) {
        const s = this._spriteScene();
        if (!s || !obj.pixels) return;

        // Remove old mesh if any
        if (obj._mesh) {
            s.scene.remove(obj._mesh);
            obj._mesh.geometry.dispose();
            obj._mesh.material.dispose();
            if (obj._texture) obj._texture.dispose();
            obj._mesh = null; obj._texture = null;
        }

        const w = obj.w, h = obj.h;

        // Build RGBA pixel buffer from the parsed pixels array
        const data = new Uint8Array(w * h * 4);
        for (let r = 0; r < h; r++) {
            const row = obj.pixels[r];
            for (let c = 0; c < w; c++) {
                const col = row[c];
                const off = (r * w + c) * 4;
                if (!col) {
                    data[off] = data[off+1] = data[off+2] = data[off+3] = 0;
                } else {
                    data[off]   = parseInt(col.slice(1,3), 16);
                    data[off+1] = parseInt(col.slice(3,5), 16);
                    data[off+2] = parseInt(col.slice(5,7), 16);
                    data[off+3] = 255;
                }
            }
        }

        const tex = new THREE.DataTexture(data, w, h);
        tex.needsUpdate = true;
        tex.magFilter = THREE.NearestFilter; // pixel-perfect, no blur

        const sc = obj.scale || 1;
        const dw = w * sc, dh = h * sc;
        const geo = new THREE.PlaneGeometry(dw, dh);
        const mat = new THREE.MeshBasicMaterial({
            map: tex, transparent: true, depthTest: false, depthWrite: false,
        });

        const mesh = new THREE.Mesh(geo, mat);
        // PlaneGeometry is centred; offset so x,y is top-left corner
        // In ortho camera: y is negative-down, origin top-left
        mesh.position.set(obj.x + dw/2, -(obj.y + dh/2), obj.priority * 0.001);
        mesh.scale.x = obj.flipH ? -1 : 1;
        mesh.scale.y = obj.flipV ? -1 : 1;
        mesh.rotation.z = -(obj.rotation || 0) * Math.PI / 180;
        obj._builtScale = sc;
        s.scene.add(mesh);

        obj._mesh    = mesh;
        obj._texture = tex;
        obj._pixelsRef = obj.pixels;
    }

    // _objDraw — update mesh position (no-op if not visible; mesh is always in scene when on)
    _objDraw(obj) {
        if (!obj.on) return;
        const sc = obj.scale || 1;
        if (!obj._mesh || obj._pixelsRef !== obj.pixels || obj._builtScale !== sc) {
            this._sprBuildMesh(obj);
        }
        if (obj._mesh) {
            const dw = obj.w * sc, dh = obj.h * sc;
            obj._mesh.position.set(
                Math.round(obj.x) + dw/2,
                -(Math.round(obj.y) + dh/2),
                obj.priority * 0.001
            );
            obj._mesh.scale.x = obj.flipH ? -1 : 1;
            obj._mesh.scale.y = obj.flipV ? -1 : 1;
            obj._mesh.rotation.z = -(obj.rotation || 0) * Math.PI / 180;
            obj._mesh.visible = true;
        }
        // Ensure sprite canvas is visible (may have been hidden by _onProgramStop)
        if (this._spr && this._spr.canvas.style.display === 'none') {
            this._spr.canvas.style.display = '';
        }
        this._sprRender();
    }

    // _objErase — hide the mesh (don't destroy it)
    _objErase(obj) {
        if (obj._mesh) obj._mesh.visible = false;
        this._sprRender();
        obj._lastDraw = null;
    }

    // _objRedrawAll — ensure all visible objects are shown at correct positions
    _objRedrawAll() {
        if (!this._objects) return;
        for (const obj of Object.values(this._objects)) {
            if (obj.on && obj.pixels) {
                const sc = obj.scale || 1;
                if (!obj._mesh || obj._pixelsRef !== obj.pixels || obj._builtScale !== sc) this._sprBuildMesh(obj);
                if (obj._mesh) {
                    const dw = obj.w * sc, dh = obj.h * sc;
                    obj._mesh.position.set(
                        Math.round(obj.x) + dw/2,
                        -(Math.round(obj.y) + dh/2),
                        obj.priority * 0.001
                    );
                    obj._mesh.scale.x = obj.flipH ? -1 : 1;
                    obj._mesh.scale.y = obj.flipV ? -1 : 1;
                    obj._mesh.rotation.z = -(obj.rotation || 0) * Math.PI / 180;
                    obj._mesh.visible = true;
                }
            }
        }
        this._sprRender();
    }

    // _sprRender — render the sprite scene (called after any change)
    _sprRender() {
        const s = this._spr;
        if (!s) return;
        this._sprSyncSize();
        s.renderer.render(s.scene, s.camera);
    }

    // _objCheckCollisions — check all on-screen objects for border/object collisions.
    // Pushes entries onto this._collisionQueue: {id, other} where other is:
    //   another object id, or -1=top, -2=left, -3=bottom, -4=right border.
    _objCheckCollisions() {
        if (!this._objects) return;
        const w = this.canvas ? this.canvas.width  : this.width;
        const h = this.canvas ? this.canvas.height : this.height;
        if (!this._collisionQueue) this._collisionQueue = [];

        const objs = Object.values(this._objects).filter(o => o.on && o.pixels);

        for (const obj of objs) {
            const sc = obj.scale || 1;
            const x1 = Math.round(obj.x), y1 = Math.round(obj.y);
            const x2 = x1 + obj.w * sc, y2 = y1 + obj.h * sc;

            // Border collisions
            if (y1 <= 0)  this._collisionQueue.push({ id: obj.id, other: -1 });
            if (x1 <= 0)  this._collisionQueue.push({ id: obj.id, other: -2 });
            if (y2 >= h)  this._collisionQueue.push({ id: obj.id, other: -3 });
            if (x2 >= w)  this._collisionQueue.push({ id: obj.id, other: -4 });

            // Object-vs-object (bounding box)
            for (const other of objs) {
                if (other.id <= obj.id) continue;  // avoid double-reporting
                const osc = other.scale || 1;
                const ox1 = Math.round(other.x), oy1 = Math.round(other.y);
                const ox2 = ox1 + other.w * osc, oy2 = oy1 + other.h * osc;
                if (x1 < ox2 && x2 > ox1 && y1 < oy2 && y2 > oy1) {
                    this._collisionQueue.push({ id: obj.id,   other: other.id });
                    this._collisionQueue.push({ id: other.id, other: obj.id   });
                }
            }
        }

        // Fire ON COLLISION GOSUB if queue has entries and handler is set
        if (this._collisionQueue.length > 0 && this._onCollisionLine && this._collisionEnabled) {
            this._collisionPending = true;  // tick() will pick this up safely
        }
    }

    // _objAnimTick — called by the animation interval to move objects.
    _objAnimStep(dtSec) {
        if (!this._objects) return;
        let anyOn = false;
        for (const obj of Object.values(this._objects)) {
            if (!obj.on || !obj.pixels) continue;
            anyOn = true;
            this._objErase(obj);
            obj.vx += obj.ax * dtSec;
            obj.vy += obj.ay * dtSec;
            obj.x  += obj.vx * dtSec;
            obj.y  += obj.vy * dtSec;
        }
        if (anyOn) {
            this._objRedrawAll();
            this._objCheckCollisions();
        }
    }

    // _objStartAnim / _objStopAnim — manage the animation interval.
    _objStartAnim() {
        if (this._objAnimTimer) return;
        let last = performance.now();
        const tick = () => {
            if (!this._objAnimTimer) return;  // stopped
            const now = performance.now();
            const dt  = Math.min((now - last) / 1000, 0.1);
            last = now;
            this._objAnimStep(dt);
            this._objAnimTimer = requestAnimationFrame(tick);
        };
        this._objAnimTimer = requestAnimationFrame(tick);
    }

    _objStopAnim() {
        if (this._objAnimTimer) {
            cancelAnimationFrame(this._objAnimTimer);
            this._objAnimTimer = null;
        }
    }

    // _fireEventGosub — trigger an event handler GOSUB (simplified; fires once).
    _fireEventGosub(targetLine) {
        if (!this.running || this.want_input) return;
        // Push current position as a gosub return, jump to handler.
        this.gosub_level++;
        this.gosubs[this.gosub_level] = this.run_line + 1;
        this.run_line = targetLine;
    }

    // -----------------------------------------------------------------------
    // OBJECT.SHAPE  id, def$        — define object from shape string
    // OBJECT.SHAPE  id1, id2        — clone shape from id2 to id1
    // -----------------------------------------------------------------------
    cmdOBJECT_SHAPE(param) {
        const raw = this.trim(String(param || ''));
        // Split: first arg is id, rest is definition
        const commaPos = raw.indexOf(',');
        if (commaPos < 0) return CMD_ESYNTAX;
        const id  = Math.floor(Number(this.evalCalc(raw.substring(0, commaPos).trim(), ASS_NUMBER)));
        const rest = this.trim(raw.substring(commaPos + 1));

        const obj = this._objGet(id);

        // Syntax 2: OBJECT.SHAPE id1, id2 (clone)
        const asNum = Number(rest);
        if (!isNaN(asNum) && !rest.startsWith('"')) {
            const src = this._objGet(Math.floor(asNum));
            obj.pixels = src.pixels;
            obj.w = src.w; obj.h = src.h;
            return CMD_OK;
        }

        // Syntax 1: OBJECT.SHAPE id, "w,h,HEXDATA" or "imagename"
        let def = rest;
        if (def.startsWith('"') && def.endsWith('"')) def = def.slice(1, -1);
        else {
            // It's a string variable
            def = String(this.lookup(rest) || '');
        }

        // Check if it looks like an image name (no comma → not w,h,HEX format)
        // or if it's in the image store
        const firstComma = def.indexOf(',');
        const looksLikeHex = firstComma > 0 && firstComma < 5;
        if (!looksLikeHex || this._imgStore()[def]) {
            // Treat as image name — async load, pauses execution
            this._objShapeFromImage(obj, def);
            return CMD_OK;
        }

        const parts = def.split(',');
        if (parts.length < 3) return CMD_ESYNTAX;
        const w = parseInt(parts[0]), h = parseInt(parts[1]);
        if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return CMD_ESYNTAX;

        const hex = parts[2];
        const pixels = [];
        let pos = 0;
        for (let r = 0; r < h; r++) {
            pixels[r] = [];
            for (let c = 0; c < w; c++) {
                const rgb = hex.substring(pos, pos + 6);
                pos += 6;
                pixels[r][c] = (rgb === '000000' || rgb === '') ? null : '#' + rgb;
            }
        }
        obj.pixels = pixels; obj.w = w; obj.h = h;
        this._activateGraphics();
        return CMD_OK;
    }

    // OBJECT.ON [id,...] / OBJECT.OFF [id,...]
    cmdOBJECT_ON(param)  { return this._objOnOff(param, true);  }
    cmdOBJECT_OFF(param) { return this._objOnOff(param, false); }
    _objOnOff(param, on) {
        const ids = this._objParseIds(param);
        const targets = ids.length > 0 ? ids : Object.keys(this._objects || {}).map(Number);
        for (const id of targets) {
            const obj = this._objGet(id);
            if (!on) this._objErase(obj);
            obj.on = on;
            if (on) this._objDraw(obj);
        }
        return CMD_OK;
    }

    // OBJECT.X id, value  /  OBJECT.Y id, value  (set)
    // Used as function: OBJECT.X(id) — handled in compiler lookup
    cmdOBJECT_X(param) { return this._objSetXY(param, 'x'); }
    cmdOBJECT_Y(param) { return this._objSetXY(param, 'y'); }
    _objSetXY(param, axis) {
        const [id, val] = this._objParseIdVal(param);
        if (id === null) return CMD_ESYNTAX;
        const obj = this._objGet(id);
        this._objErase(obj);
        obj[axis] = val;
        if (obj.on) this._objDraw(obj);
        return CMD_OK;
    }

    // OBJECT.VX / OBJECT.VY — velocity
    cmdOBJECT_VX(param) { return this._objSetProp(param, 'vx'); }
    cmdOBJECT_VY(param) { return this._objSetProp(param, 'vy'); }

    // OBJECT.AX / OBJECT.AY — acceleration
    cmdOBJECT_AX(param) { return this._objSetProp(param, 'ax'); }
    cmdOBJECT_AY(param) { return this._objSetProp(param, 'ay'); }

    // OBJECT.PRIORITY — z-order
    cmdOBJECT_PRIORITY(param) { return this._objSetProp(param, 'priority'); }

    // OBJECT.SCALE id, factor — integer upscale of sprite (e.g. 2 = 2x)
    cmdOBJECT_SCALE(param) {
        const [id, val] = this._objParseIdVal(param);
        if (id === null) return CMD_ESYNTAX;
        let sc = Math.floor(Number(val));
        if (!isFinite(sc) || sc < 1) sc = 1;
        const obj = this._objGet(id);
        this._objErase(obj);
        obj.scale = sc;
        if (obj.on) this._objDraw(obj);
        return CMD_OK;
    }

    // OBJECT.FLIP id, axis — axis=0 horizontal, axis=1 vertical
    cmdOBJECT_FLIP(param) {
        const [id, val] = this._objParseIdVal(param);
        if (id === null) return CMD_ESYNTAX;
        const axis = Math.floor(Number(val));
        const obj = this._objGet(id);
        if (axis === 0)      obj.flipH = !obj.flipH;
        else if (axis === 1) obj.flipV = !obj.flipV;
        else return CMD_ESYNTAX;
        if (obj.on) this._objDraw(obj);
        return CMD_OK;
    }

    // OBJECT.ROTATE id, degrees — set absolute rotation in degrees (0=none, 90=CW quarter-turn)
    cmdOBJECT_ROTATE(param) {
        const [id, val] = this._objParseIdVal(param);
        if (id === null) return CMD_ESYNTAX;
        const deg = Number(val);
        if (!isFinite(deg)) return CMD_ESYNTAX;
        const obj = this._objGet(id);
        obj.rotation = deg;
        if (obj.on) this._objDraw(obj);
        return CMD_OK;
    }

    _objSetProp(param, prop) {
        const [id, val] = this._objParseIdVal(param);
        if (id === null) return CMD_ESYNTAX;
        this._objGet(id)[prop] = val;
        return CMD_OK;
    }

    // OBJECT.START [id,...] — begin animation loop for objects with velocity
    cmdOBJECT_START(param) {
        const ids = this._objParseIds(param);
        const targets = ids.length > 0 ? ids : Object.keys(this._objects || {}).map(Number);
        for (const id of targets) this._objGet(id).on = true;
        this._activateGraphics();
        this._objStartAnim();
        return CMD_OK;
    }

    // OBJECT.STOP [id,...] — freeze objects (stop animation)
    cmdOBJECT_STOP(param) {
        const ids = this._objParseIds(param);
        if (ids.length === 0) {
            this._objStopAnim();
        } else {
            // Stop specific objects by zeroing velocity
            for (const id of ids) {
                const o = this._objGet(id);
                o.vx = 0; o.vy = 0; o.ax = 0; o.ay = 0;
            }
        }
        return CMD_OK;
    }

    // OBJECT.CLOSE [id,...] — release objects
    cmdOBJECT_CLOSE(param) {
        if (!this._objects) return CMD_OK;
        const ids = this._objParseIds(param);
        const targets = ids.length > 0 ? ids : Object.keys(this._objects).map(Number);
        for (const id of targets) {
            const obj = this._objects[id];
            if (obj) {
                if (obj._mesh) {
                    if (this._spr) this._spr.scene.remove(obj._mesh);
                    obj._mesh.geometry.dispose();
                    obj._mesh.material.dispose();
                    if (obj._texture) obj._texture.dispose();
                    obj._mesh = null; obj._texture = null;
                }
                delete this._objects[id];
            }
        }
        if (Object.keys(this._objects).length === 0) this._objStopAnim();
        if (this._spr) this._sprRender();
        return CMD_OK;
    }

    // OBJECT.HIT id [,MeMask] [,HitMask] — collision mask (simplified: just store)
    cmdOBJECT_HIT(param) {
        const parts = (param || '').split(',').map(p => this.trim(p));
        if (!parts[0]) return CMD_ESYNTAX;
        const id = Math.floor(Number(this.evalCalc(parts[0], ASS_NUMBER)));
        const obj = this._objGet(id);
        obj.meMask  = parts[1] ? Number(this.evalCalc(parts[1], ASS_NUMBER)) : 0xFFFF;
        obj.hitMask = parts[2] ? Number(this.evalCalc(parts[2], ASS_NUMBER)) : 0xFFFF;
        return CMD_OK;
    }

    // OBJECT.CLIP (x1,y1)-(x2,y2) — set clip rectangle (stored for future use)
    cmdOBJECT_CLIP(param) {
        // Parse "(x1,y1)-(x2,y2)"
        const m = String(param || '').match(/\(([^)]+)\)-\(([^)]+)\)/);
        if (!m) return CMD_ESYNTAX;
        const [x1, y1] = m[1].split(',').map(v => Number(this.evalCalc(this.trim(v), ASS_NUMBER)));
        const [x2, y2] = m[2].split(',').map(v => Number(this.evalCalc(this.trim(v), ASS_NUMBER)));
        this._objClip = { x1, y1, x2, y2 };
        return CMD_OK;
    }

    // COLLISION ON/OFF/STOP
    cmdCOLLISION_ON()   { this._collisionEnabled = true;  return CMD_OK; }
    cmdCOLLISION_OFF()  { this._collisionEnabled = false; return CMD_OK; }
    cmdCOLLISION_STOP() { this._collisionEnabled = false; return CMD_OK; }

    // ON COLLISION GOSUB label — store the handler line
    cmdON_COLLISION(param) {
        const raw = this.trim(String(param || ''));
        const gosubIdx = raw.toUpperCase().indexOf('GOSUB');
        if (gosubIdx < 0) return CMD_ESYNTAX;
        const target = this.trim(raw.substring(gosubIdx + 5));
        const resolved = this._resolveLabel(target);
        this._onCollisionLine = resolved >= 0 ? resolved : null;
        return CMD_OK;
    }

    // ON MOUSE GOSUB label — set the subroutine for mouse button events
    cmdON_MOUSE(param) {
        const raw = this.trim(String(param || ''));
        const gosubIdx = raw.toUpperCase().indexOf('GOSUB');
        if (gosubIdx < 0) return CMD_ESYNTAX;
        const target = this.trim(raw.substring(gosubIdx + 5));
        const resolved = this._resolveLabel(target);
        this._mouseGosub = resolved >= 0 ? resolved : -1;
        return CMD_OK;
    }

    // ---- Helper parsers ----
    _objParseIds(param) {
        if (!param || !this.trim(param)) return [];
        return this.trim(String(param)).split(',')
            .map(p => Math.floor(Number(this.evalCalc(this.trim(p), ASS_NUMBER))))
            .filter(n => !isNaN(n) && n > 0);
    }

    _objParseIdVal(param) {
        const raw = this.trim(String(param || ''));
        const commaPos = raw.indexOf(',');
        if (commaPos < 0) return [null, null];
        const id  = Math.floor(Number(this.evalCalc(raw.substring(0, commaPos).trim(), ASS_NUMBER)));
        const val = Number(this.evalCalc(raw.substring(commaPos + 1).trim(), ASS_NUMBER));
        return [id, val];
    }

    // -----------------------------------------------------------------------
    // OBJECT system cleanup on program stop / run
    // -----------------------------------------------------------------------
    _objCleanup() {
        this._objStopAnim();
        if (this._objects) {
            for (const obj of Object.values(this._objects)) {
                if (obj._mesh) {
                    if (this._spr) this._spr.scene.remove(obj._mesh);
                    obj._mesh.geometry.dispose();
                    obj._mesh.material.dispose();
                    if (obj._texture) obj._texture.dispose();
                    obj._mesh = null; obj._texture = null;
                }
            }
        }
        this._objects          = {};
        this._collisionQueue   = [];
        this._collisionEnabled = false;
        this._onCollisionLine  = null;
        this._objClip          = null;
        this._objAnimTimer     = null;
        // Re-render empty scene to clear the canvas
        if (this._spr) this._spr.renderer.render(this._spr.scene, this._spr.camera);
    }



    // ── Process Memory Interface — Step 6 of V7 refactor ──────────────────
    // The Kernel allocates an isolated ProcessMemory for this process.
    // All BASIC program state (variables, program lines, flow control)
    // is stored in _mem, not on the Interpreter instance directly.
    // This enables future multitasking: swap _mem to switch processes.

    attachMemory(mem) {
        this._mem     = mem;
        this._shellMem = mem;  // keep reference to shell memory (PID 1's ProcessMemory)
        this._programPid = null;  // PID of currently running program (null = shell)
    }

    // Program store
    get lines()               { return this._mem.lines; }
    set lines(v)              { this._mem.lines = v; }
    get lines_assigned()      { return this._mem.lines_assigned; }
    set lines_assigned(v)     { this._mem.lines_assigned = v; }
    get _lineCache()          { return this._mem._lineCache; }
    set _lineCache(v)         { this._mem._lineCache = v; }
    get _labels()             { return this._mem._labels; }
    set _labels(v)            { this._mem._labels = v; }
    get _subs()               { return this._mem._subs; }
    set _subs(v)              { this._mem._subs = v; }
    get _dimInfo()            { return this._mem._dimInfo; }
    set _dimInfo(v)           { this._mem._dimInfo = v; }
    get _arrMax()             { return this._mem._arrMax; }
    set _arrMax(v)            { this._mem._arrMax = v; }

    // Variable heap
    get variables_numbers()     { return this._mem.variables_numbers; }
    set variables_numbers(v)    { this._mem.variables_numbers = v; }
    get variables_strings()     { return this._mem.variables_strings; }
    set variables_strings(v)    { this._mem.variables_strings = v; }
    get variables_arr_numbers() { return this._mem.variables_arr_numbers; }
    set variables_arr_numbers(v){ this._mem.variables_arr_numbers = v; }
    get variables_arr_strings() { return this._mem.variables_arr_strings; }
    set variables_arr_strings(v){ this._mem.variables_arr_strings = v; }
    get variables_func()        { return this._mem.variables_func; }
    set variables_func(v)       { this._mem.variables_func = v; }

    // Flow control stacks
    get gosub_level()         { return this._mem.gosub_level; }
    set gosub_level(v)        { this._mem.gosub_level = v; }
    get gosubs()              { return this._mem.gosubs; }
    set gosubs(v)             { this._mem.gosubs = v; }
    get for_level()           { return this._mem.for_level; }
    set for_level(v)          { this._mem.for_level = v; }
    get fors()                { return this._mem.fors; }
    set fors(v)               { this._mem.fors = v; }
    get for_var()             { return this._mem.for_var; }
    set for_var(v)            { this._mem.for_var = v; }
    get _if_stack()           { return this._mem._if_stack; }
    set _if_stack(v)          { this._mem._if_stack = v; }
    get _select_stack()       { return this._mem._select_stack; }
    set _select_stack(v)      { this._mem._select_stack = v; }
    get _while_stack()        { return this._mem._while_stack; }
    set _while_stack(v)       { this._mem._while_stack = v; }
    get _sub_stack()          { return this._mem._sub_stack; }
    set _sub_stack(v)         { this._mem._sub_stack = v; }
    get _in_sub()             { return this._mem._in_sub; }
    set _in_sub(v)            { this._mem._in_sub = v; }
    get _shared_vars()        { return this._mem._shared_vars; }
    set _shared_vars(v)       { this._mem._shared_vars = v; }
    get _static_vars()        { return this._mem._static_vars; }
    set _static_vars(v)       { this._mem._static_vars = v; }
    get _on_goto_table()      { return this._mem._on_goto_table; }
    set _on_goto_table(v)     { this._mem._on_goto_table = v; }
    get _func_result()        { return this._mem._func_result; }
    set _func_result(v)       { this._mem._func_result = v; }

    // Execution state
    get run_line()            { return this._mem.run_line; }
    set run_line(v)           { this._mem.run_line = v; }
    get running()             { return this._mem.running; }
    set running(v)            { this._mem.running = v; }
    get if_line()             { return this._mem.if_line; }
    set if_line(v)            { this._mem.if_line = v; }
    get line_remaining()      { return this._mem.line_remaining; }
    set line_remaining(v)     { this._mem.line_remaining = v; }
    get just_stopped()        { return this._mem.just_stopped; }
    set just_stopped(v)       { this._mem.just_stopped = v; }
    get data()                { return this._mem.data; }
    set data(v)               { this._mem.data = v; }
    get data_count()          { return this._mem.data_count; }
    set data_count(v)         { this._mem.data_count = v; }
    get data_position()       { return this._mem.data_position; }
    set data_position(v)      { this._mem.data_position = v; }
    get _error_trap_line()    { return this._mem._error_trap_line; }
    set _error_trap_line(v)   { this._mem._error_trap_line = v; }
    get _error_resume_line()  { return this._mem._error_resume_line; }
    set _error_resume_line(v) { this._mem._error_resume_line = v; }
    get _last_err()           { return this._mem._last_err; }
    set _last_err(v)          { this._mem._last_err = v; }
    get _last_erl()           { return this._mem._last_erl; }
    set _last_erl(v)          { this._mem._last_erl = v; }
    get _in_error()           { return this._mem._in_error; }
    set _in_error(v)          { this._mem._in_error = v; }

    // BASIC heap + misc
    get _memory()             { return this._mem._memory; }
    set _memory(v)            { this._mem._memory = v; }
    get _optionBase()         { return this._mem._optionBase; }
    set _optionBase(v)        { this._mem._optionBase = v; }
    get _trace()              { return this._mem._trace; }
    set _trace(v)             { this._mem._trace = v; }
    get _rng_seed()           { return this._mem._rng_seed; }
    set _rng_seed(v)          { this._mem._rng_seed = v; }

    // Convenience: swap to a different process memory context (future multitasking)
    swapMemory(mem) {
        const old = this._mem;
        this._mem = mem;
        return old;
    }

    // =======================================================================
    // _registerDriverSyscalls — Step 3 of V7 refactor
    // Registers all driver syscall handlers on the kernel bus at boot.
    // Drivers expose a registerSyscalls(bus) method; we call each one here.
    // After this, all driver I/O flows through this.kernel.post/call().
    // =======================================================================
    _registerDriverSyscalls() {
        const bus = this.kernel;

        // ── GL 3D ────────────────────────────────────────────────────────
        const gl = this._glDrv;
        bus.on('gl.init',              (m) => gl.cmdGL_INIT(m.param));
        bus.on('gl.close',             (m) => gl.cmdGL_CLOSE(m.param));
        bus.on('gl.cls',               (m) => gl.cmdGL_CLS(m.param));
        bus.on('gl.perspective',       (m) => gl.cmdGL_PERSPECTIVE(m.param));
        bus.on('gl.camera',            (m) => gl.cmdGL_CAMERA(m.param));
        bus.on('gl.lookat',            (m) => gl.cmdGL_LOOKAT(m.param));
        bus.on('gl.cameraroll',        (m) => gl.cmdGL_CAMERAROLL(m.param));
        bus.on('gl.colour',            (m) => gl.cmdGL_COLOUR(m.param));
        bus.on('gl.wire',              ()  => gl.cmdGL_WIRE());
        bus.on('gl.solid',             ()  => gl.cmdGL_SOLID());
        bus.on('gl.solidwire',         ()  => gl.cmdGL_SOLIDWIRE());
        bus.on('gl.wireall',           (m) => gl.cmdGL_WIREALL(m.param));
        bus.on('gl.light',             (m) => gl.cmdGL_LIGHT(m.param));
        bus.on('gl.lightoff',          ()  => gl.cmdGL_LIGHTOFF());
        bus.on('gl.ambient',           (m) => gl.cmdGL_AMBIENT(m.param));
        bus.on('gl.bloom',             (m) => gl.cmdGL_BLOOM(m.param));
        bus.on('gl.fps',               (m) => gl.cmdGL_FPS(m.param));
        bus.on('gl.rfps',              (m) => gl.cmdGL_RFPS(m.param));
        bus.on('gl.aa',                (m) => gl.cmdGL_AA(m.param));
        bus.on('gl.begin',             ()  => gl.cmdGL_BEGIN());
        bus.on('gl.vertex',            (m) => gl.cmdGL_VERTEX(m.param));
        bus.on('gl.face',              (m) => gl.cmdGL_FACE(m.param));
        bus.on('gl.end',               ()  => gl.cmdGL_END());
        bus.on('gl.translate',         (m) => gl.cmdGL_TRANSLATE(m.param));
        bus.on('gl.rotate',            (m) => gl.cmdGL_ROTATE(m.param));
        bus.on('gl.scale',             (m) => gl.cmdGL_SCALE(m.param));
        bus.on('gl.instance',          (m) => gl.cmdGL_INSTANCE(m.param));
        bus.on('gl.insthide',          (m) => gl.cmdGL_INSTHIDE(m.param));
        bus.on('gl.draw',              (m) => gl.cmdGL_DRAW(m.param));
        bus.on('gl.drawall',           ()  => gl.cmdGL_DRAWALL());
        bus.on('gl.shine',             (m) => gl.cmdGL_SHINE(m.param));
        bus.on('gl.alpha',             (m) => gl.cmdGL_ALPHA(m.param));
        bus.on('gl.emissive',          (m) => gl.cmdGL_EMISSIVE(m.param));
        bus.on('gl.wirecolor',         (m) => gl.cmdGL_WIRECOLOR(m.param));
        bus.on('gl.texture',           (m) => gl.cmdGL_TEXTURE(m.param));
        bus.on('gl.normalmap',         (m) => gl.cmdGL_NORMALMAP(m.param));
        bus.on('gl.roughmap',          (m) => gl.cmdGL_ROUGHMAP(m.param));
        bus.on('gl.aomap',             (m) => gl.cmdGL_AOMAP(m.param));
        bus.on('gl.heightmap',         (m) => gl.cmdGL_HEIGHTMAP(m.param));
        bus.on('gl.metalmap',          (m) => gl.cmdGL_METALMAP(m.param));
        bus.on('gl.emissivemap',       (m) => gl.cmdGL_EMISSIVEMAP(m.param));
        bus.on('gl.emissiveintensity', (m) => gl.cmdGL_EMISSIVEINTENSITY(m.param));
        bus.on('gl.roughness',         (m) => gl.cmdGL_ROUGHNESS(m.param));
        bus.on('gl.metalness',         (m) => gl.cmdGL_METALNESS(m.param));
        bus.on('gl.envmap',            (m) => gl.cmdGL_ENVMAP(m.param));
        bus.on('gl.pointlight',        (m) => gl.cmdGL_POINTLIGHT(m.param));
        bus.on('gl.headlight',         (m) => gl.cmdGL_HEADLIGHT(m.param));
        bus.on('gl.clouds',            (m) => gl.cmdGL_CLOUDS(m.param));
        bus.on('gl.sky',               (m) => gl.cmdGL_SKY(m.param));
        bus.on('gl.terrain',           (m) => gl.cmdGL_TERRAIN(m.param));
        bus.on('gl.probe',             (m) => gl.cmdGL_PROBE(m.param));
        bus.on('gl.scanfwd',           (m) => gl.cmdGL_SCANFWD(m.param));
        bus.on('gl.obstacle',          (m) => gl.cmdGL_OBSTACLE(m.param));
        bus.on('gl.obstaclehit',       (m) => gl.cmdGL_OBSTACLEHIT(m.param));
        bus.on('gl.obstacleclear',     ()  => gl.cmdGL_OBSTACLECLEAR());
        bus.on('aig.navigate',         (m) => gl.cmdAIG_NAVIGATE(m.param));
        bus.on('gl.rectlight',         (m) => gl.cmdGL_RECTLIGHT(m.param));
        bus.on('gl.lightsoff',         ()  => gl.cmdGL_LIGHTSOFF());
        bus.on('gl.hide',              (m) => gl.cmdGL_HIDE(m.param));
        bus.on('gl.dispose',           (m) => gl.cmdGL_DISPOSE(m.param));
        bus.on('gl.show',              (m) => gl.cmdGL_SHOW(m.param));
        bus.on('gl.fog',               (m) => gl.cmdGL_FOG(m.param));
        bus.on('gl.fogoff',            ()  => gl.cmdGL_FOGOFF());
        bus.on('gl.sphere',            (m) => gl.cmdGL_SPHERE(m.param));
        bus.on('gl.box',               (m) => gl.cmdGL_BOX(m.param));
        bus.on('gl.cylinder',          (m) => gl.cmdGL_CYLINDER(m.param));
        bus.on('gl.polyhedron',        (m) => gl.cmdGL_POLYHEDRON(m.param));
        bus.on('gl.load',              (m) => gl.cmdGL_LOAD(m.param));
        bus.on('gl.chrome',            (m) => gl.cmdGL_CHROME(m.param));
        bus.on('gl.debug',             ()  => gl.cmdGLDEBUG());

        // ── GFX 2D ───────────────────────────────────────────────────────
        const gfx = this._gfxDrv;
        bus.on('gfx.colour',    (m) => gfx.cmdCOLOUR(m.param));
        bus.on('gfx.circle',    (m) => gfx.cmdCIRCLE(m.param));
        bus.on('gfx.point2',    (m) => gfx.cmdPOINT(m.param));
        bus.on('gfx.fillcircle',(m) => gfx.cmdFILLCIRCLE(m.param));
        bus.on('gfx.rect',      (m) => gfx.cmdRECT(m.param));
        bus.on('gfx.fillrect',  (m) => gfx.cmdFILLRECT(m.param));
        bus.on('gfx.line',      (m) => gfx.cmdLINE(m.param));
        bus.on('gfx.pset',      (m) => gfx.cmdPSET(m.param));
        bus.on('gfx.preset',    (m) => gfx.cmdPRESET(m.param));
        bus.on('gfx.paint',     (m) => gfx.cmdPAINT(m.param));
        bus.on('gfx.image',     (m) => gfx.cmdIMAGE(m.param));
        bus.on('gfx.loadimg',   (m) => gfx.cmdLOADIMG(m.param));
        bus.on('gfx.display',   (m) => gfx.cmdDISPLAY(m.param));
        bus.on('gfx.imglist',   (m) => gfx.cmdIMGLIST(m.param));
        bus.on('gfx.imgfree',   (m) => gfx.cmdIMGFREE(m.param));
        bus.on('gfx.cls',       ()  => gfx._gfxClear());
        bus.on('gfx.point',     (m) => gfx._gfxRead(m.x, m.y)); // returns value via call()

        // ── Audio ────────────────────────────────────────────────────────
        const aud = this._audioDrv;
        bus.on('sound.play',    (m) => aud.cmdSOUND(m.param));
        bus.on('sound.wave',    (m) => aud.cmdWAVE(m.param));
        bus.on('sound.beep',    ()  => aud.cmdBEEP());

        // ── Network ──────────────────────────────────────────────────────
        const net = this._netDrv;
        bus.on('net.open',      (m) => net.cmdWS_OPEN(m.param));
        bus.on('net.send',      (m) => net.cmdWS_SEND(m.param));
        bus.on('net.close',     ()  => net.cmdWS_CLOSE());
        bus.on('net.clear',     ()  => net.cmdWS_CLEAR());
        bus.on('net.onmsg',     (m) => net.cmdWS_ONMSG(m.param));
        bus.on('net.recv',      ()  => net._wsRecv());       // call() — returns string
        bus.on('net.status',    ()  => net._wsStatus);       // call() — returns number

        // ── Window IPC ───────────────────────────────────────────────────
        const win = this._winDrv;
        bus.on('window.launch',  (m) => { const pid = win.cmdLAUNCH(m.param); return pid; });
        bus.on('window.send',    (m) => win.cmdWINDOW_SEND(m.param));
        bus.on('window.close',   (m) => win.cmdWINDOW_CLOSE(m.param));
        bus.on('window.reply',   (m) => win.cmdWINDOW_REPLY(m.param));
        bus.on('window.onmsg',   (m) => win.cmdON_WINDOW(m.param));
        bus.on('window.status',  (m) => win.windowStatus(m.pid));  // call()

        // ── Kernel lifecycle events (emitted by kernel, heard by drivers) ─
        bus.listen('program.stop', () => {
            if (gl._glCanvas) gl._glCanvas.style.display = 'none';
        });
    }


    // =======================================================================
    // GL 3D — delegated to GL3DDriver (core/drivers/gl3d.js)
    // Step 1 of V7 architecture refactor: extracted 2026-04
    // Delegates now route through the kernel bus (Step 3).
    // =======================================================================

    // Internal GL state accessors — delegate to driver
    get _gl()       { return this._glDrv._gl; }
    set _gl(v)      { this._glDrv._gl = v; }
    get _glCanvas() { return this._glDrv._glCanvas; }
    set _glCanvas(v){ this._glDrv._glCanvas = v; }

    _glInit()                  { return this._glDrv._glInit(); }
    _glState()                 { return this._glDrv._glState(); }
    _glSetupThree()            { return this._glDrv._glSetupThree(); }
    _glBuildThreeMesh(m,md,g)  { return this._glDrv._glBuildThreeMesh(m,md,g); }
    _glSyncMesh(m,g)           { return this._glDrv._glSyncMesh(m,g); }
    _glParseFloats(p,n)        { return this._glDrv._glParseFloats(p,n); }
    _glParsePBRParam(p)        { return this._glDrv._glParsePBRParam(p); }
    cmdGLDEBUG()               { return this.kernel.post({syscall:'gl.debug'}); }
    cmdGL_INIT(p)              { return this.kernel.post({syscall:'gl.init',param:p}); }
    cmdGL_CLOSE(p)             { return this.kernel.post({syscall:'gl.close',param:p}); }
    cmdGL_CLS(p)               { return this.kernel.post({syscall:'gl.cls',param:p}); }
    cmdGL_PERSPECTIVE(p)       { return this.kernel.post({syscall:'gl.perspective',param:p}); }
    cmdGL_CAMERA(p)            { return this.kernel.post({syscall:'gl.camera',param:p}); }
    cmdGL_LOOKAT(p)            { return this.kernel.post({syscall:'gl.lookat',param:p}); }
    cmdGL_CAMERAROLL(p)        { return this.kernel.post({syscall:'gl.cameraroll',param:p}); }
    cmdGL_COLOUR(p)            { return this.kernel.post({syscall:'gl.colour',param:p}); }
    cmdGL_WIRE()               { return this.kernel.post({syscall:'gl.wire'}); }
    cmdGL_SOLID()              { return this.kernel.post({syscall:'gl.solid'}); }
    cmdGL_SOLIDWIRE()          { return this.kernel.post({syscall:'gl.solidwire'}); }
    cmdGL_WIREALL(p)           { return this.kernel.post({syscall:'gl.wireall',param:p}); }
    cmdGL_LIGHT(p)             { return this.kernel.post({syscall:'gl.light',param:p}); }
    cmdGL_LIGHTOFF()           { return this.kernel.post({syscall:'gl.lightoff'}); }
    cmdGL_AMBIENT(p)           { return this.kernel.post({syscall:'gl.ambient',param:p}); }
    cmdGL_BLOOM(p)             { return this.kernel.post({syscall:'gl.bloom',param:p}); }
    cmdGL_FPS(p)               { return this.kernel.post({syscall:'gl.fps',param:p}); }
    cmdGL_RFPS(p)              { return this.kernel.post({syscall:'gl.rfps',param:p}); }
    cmdGL_AA(p)                { return this.kernel.post({syscall:'gl.aa',param:p}); }
    cmdGL_BEGIN()              { return this.kernel.post({syscall:'gl.begin'}); }
    cmdGL_VERTEX(p)            { return this.kernel.post({syscall:'gl.vertex',param:p}); }
    cmdGL_FACE(p)              { return this.kernel.post({syscall:'gl.face',param:p}); }
    cmdGL_END()                { return this.kernel.post({syscall:'gl.end'}); }
    cmdGL_TRANSLATE(p)         { return this.kernel.post({syscall:'gl.translate',param:p}); }
    cmdGL_ROTATE(p)            { return this.kernel.post({syscall:'gl.rotate',param:p}); }
    cmdGL_SCALE(p)             { return this.kernel.post({syscall:'gl.scale',param:p}); }
    cmdGL_INSTANCE(p)          { return this.kernel.post({syscall:'gl.instance',param:p}); }
    cmdGL_INSTHIDE(p)          { return this.kernel.post({syscall:'gl.insthide',param:p}); }
    cmdGL_DRAW(p)              { return this.kernel.post({syscall:'gl.draw',param:p}); }
    cmdGL_DRAWALL()            { return this.kernel.post({syscall:'gl.drawall'}); }
    cmdGL_SHINE(p)             { return this.kernel.post({syscall:'gl.shine',param:p}); }
    cmdGL_ALPHA(p)             { return this.kernel.post({syscall:'gl.alpha',param:p}); }
    cmdGL_WIRECOLOR(p)         { return this.kernel.post({syscall:'gl.wirecolor',param:p}); }
    cmdGL_TEXTURE(p)           { return this.kernel.post({syscall:'gl.texture',param:p}); }
    cmdGL_NORMALMAP(p)         { return this.kernel.post({syscall:'gl.normalmap',param:p}); }
    cmdGL_ROUGHMAP(p)          { return this.kernel.post({syscall:'gl.roughmap',param:p}); }
    cmdGL_AOMAP(p)             { return this.kernel.post({syscall:'gl.aomap',param:p}); }
    cmdGL_HEIGHTMAP(p)         { return this.kernel.post({syscall:'gl.heightmap',param:p}); }
    cmdGL_METALMAP(p)          { return this.kernel.post({syscall:'gl.metalmap',param:p}); }
    cmdGL_EMISSIVEMAP(p)       { return this.kernel.post({syscall:'gl.emissivemap',param:p}); }
    cmdGL_EMISSIVE(p)          { return this.kernel.post({syscall:'gl.emissive',param:p}); }
    cmdGL_EMISSIVEINTENSITY(p) { return this.kernel.post({syscall:'gl.emissiveintensity',param:p}); }
    cmdGL_ROUGHNESS(p)         { return this.kernel.post({syscall:'gl.roughness',param:p}); }
    cmdGL_METALNESS(p)         { return this.kernel.post({syscall:'gl.metalness',param:p}); }
    cmdGL_ENVMAP(p)            { return this.kernel.post({syscall:'gl.envmap',param:p}); }
    cmdGL_POINTLIGHT(p)        { return this.kernel.post({syscall:'gl.pointlight',param:p}); }
    cmdGL_HEADLIGHT(p)         { return this.kernel.post({syscall:'gl.headlight',param:p}); }
    cmdGL_CLOUDS(p)            { return this.kernel.post({syscall:'gl.clouds',param:p}); }
    cmdGL_SKY(p)               { return this.kernel.post({syscall:'gl.sky',param:p}); }
    cmdGL_TERRAIN(p)           { return this.kernel.post({syscall:'gl.terrain',param:p}); }
    cmdGL_PROBE(p)             { return this.kernel.post({syscall:'gl.probe',param:p}); }
    cmdGL_SCANFWD(p)           { return this.kernel.post({syscall:'gl.scanfwd',param:p}); }
    cmdGL_OBSTACLE(p)          { return this.kernel.post({syscall:'gl.obstacle',param:p}); }
    cmdGL_OBSTACLEHIT(p)       { return this.kernel.post({syscall:'gl.obstaclehit',param:p}); }
    cmdGL_OBSTACLECLEAR()      { return this.kernel.post({syscall:'gl.obstacleclear'}); }
    cmdAIG_NAVIGATE(p)         { return this.kernel.post({syscall:'aig.navigate',param:p}); }
    cmdGL_RECTLIGHT(p)         { return this.kernel.post({syscall:'gl.rectlight',param:p}); }
    cmdGL_LIGHTSOFF()          { return this.kernel.post({syscall:'gl.lightsoff'}); }
    cmdGL_HIDE(p)              { return this.kernel.post({syscall:'gl.hide',param:p}); }
    cmdGL_DISPOSE(p)           { return this.kernel.post({syscall:'gl.dispose',param:p}); }
    cmdGL_SHOW(p)              { return this.kernel.post({syscall:'gl.show',param:p}); }
    cmdGL_FOG(p)               { return this.kernel.post({syscall:'gl.fog',param:p}); }
    cmdGL_FOGOFF()             { return this.kernel.post({syscall:'gl.fogoff'}); }
    cmdGL_SPHERE(p)            { return this.kernel.post({syscall:'gl.sphere',param:p}); }
    cmdGL_BOX(p)               { return this.kernel.post({syscall:'gl.box',param:p}); }
    cmdGL_CYLINDER(p)          { return this.kernel.post({syscall:'gl.cylinder',param:p}); }
    cmdGL_POLYHEDRON(p)        { return this.kernel.post({syscall:'gl.polyhedron',param:p}); }
    cmdGL_LOAD(p)              { return this.kernel.post({syscall:'gl.load',param:p}); }
    cmdGL_CHROME(p)            { return this.kernel.post({syscall:'gl.chrome',param:p}); }


    // AIKEY — store the Anthropic API key for this session.
    cmdAIKEY(param) {
        const raw = this.trim(String(param || ''));
        if (raw.startsWith('"') && raw.endsWith('"')) {
            this.ai_key = raw.slice(1, -1);
            this.appendLine('API key set.', 1);
            return CMD_OK;
        }
        // No key inline — prompt securely with password masking.
        this.appendLine('Enter Anthropic API key: ', 0);
        this.want_input     = 1;
        this.want_password  = 1;
        this.input_var      = '__AIKEY__';
        this.input_var_type = ASS_STRING;
        this.char_index     = -1;
        this.blink();
        return CMD_OK;
    }

    // AICLEAR        — wipe conversation history (start a fresh context).
    // AICLEAR ALL    — also reset AISYSTEM / AIMODEL / AITEMP / AITOKENS back to defaults.
    cmdAICLEAR(param) {
        this.ai_messages = [];
        const all = this.trim(String(param || '')).toUpperCase() === 'ALL';
        if (all) {
            this.ai_system = '';
            this.ai_model  = '';
            this.ai_temp   = null;
            this.ai_tokens = 0;
            this.ai_web    = false;
            this.appendLine('AI conversation cleared; system/model/temp/tokens/web reset to defaults.', 1);
        } else {
            this.appendLine('AI conversation cleared.', 1);
        }
        return CMD_OK;
    }

    // AISYSTEM "text"   — set the system prompt (your persona / raw context / data the model
    //                     should always know). Replaces the built-in default. Accepts a string
    //                     literal or a string variable.
    // AISYSTEM @"file"  — load the prompt from a VFS file/program (its line text, joined by \n).
    //                     Save it first with SAVE "file", then AISYSTEM @"file".
    // AISYSTEM ""       — reset to the built-in default.
    // AISYSTEM          — show the current system prompt.
    cmdAISYSTEM(param) {
        const raw = this.trim(String(param || ''));
        if (raw === '') {
            const cur = this.ai_system || '(default — you are an AI assistant inside a BASIC terminal)';
            this.appendLine('AI system prompt: ' + cur, 1);
            return CMD_OK;
        }
        if (raw === '""' || raw === "''") {
            this.ai_system = '';
            this.appendLine('AI system prompt reset to default.', 1);
            return CMD_OK;
        }
        if (raw.startsWith('@')) {
            const fn = this.trim(raw.substring(1)).replace(/^["']|["']$/g, '');
            if (!fn) return CMD_ESYNTAX;
            const resumePrompt = () => {
                if (this.running) this._scheduleNextTick();
                else { this.appendLine(this.prompt, 0); this.blink(); }
            };
            let result;
            try { result = this.fs.loadFile(fn, this); } catch (e) { result = -1; }
            if (result && typeof result.then === 'function') {       // async load — pause execution
                this.want_ai = 1;
                this._cancelNextTick();
                result.then((a) => {
                    this.want_ai = 0;
                    if (a && typeof a !== 'number') this._aiSystemFromFile(a, fn);
                    else this.appendLine('AISYSTEM: could not read "' + fn + '"', 1);
                    resumePrompt();
                }).catch(() => {
                    this.want_ai = 0;
                    this.appendLine('AISYSTEM: could not read "' + fn + '"', 1);
                    resumePrompt();
                });
                return CMD_OK;
            }
            if (!result || typeof result === 'number') { this.appendLine('AISYSTEM: could not read "' + fn + '"', 1); return CMD_OK; }
            this._aiSystemFromFile(result, fn);
            return CMD_OK;
        }
        let text;
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
            text = raw.slice(1, -1);
        } else {
            text = String(this.lookup(raw) || raw);
        }
        this.ai_system = text;
        this.appendLine('AI system prompt set (' + text.length + ' chars).', 1);
        return CMD_OK;
    }

    // _aiSystemFromFile — set ai_system from a loaded VFS line array (joins the non-empty
    // line texts in order, dropping the line numbers).
    _aiSystemFromFile(linesArr, fn) {
        const parts = [];
        for (let i = 0; i < linesArr.length; i++) if (linesArr[i] && linesArr[i] !== '') parts.push(linesArr[i]);
        this.ai_system = parts.join('\n');
        this.appendLine('AI system prompt loaded from "' + fn + '" (' + this.ai_system.length + ' chars).', 1);
    }

    // AIMODEL name   — pick the model. Aliases: FAST/HAIKU, SMART/SONNET, BEST/OPUS, DEFAULT.
    //                  Any other value is used as a literal Anthropic model id.
    // AIMODEL        — show the current model.
    cmdAIMODEL(param) {
        const raw = this.trim(String(param || '')).replace(/^["']|["']$/g, '');
        if (raw === '') { this.appendLine('AI model: ' + (this.ai_model || this._aiDefaultModel), 1); return CMD_OK; }
        const map = {
            FAST:    this._aiDefaultModel, HAIKU:  this._aiDefaultModel, DEFAULT: '',
            SMART:   'claude-sonnet-4-6',  SONNET: 'claude-sonnet-4-6',
            BEST:    'claude-opus-4-7',    OPUS:   'claude-opus-4-7',
        };
        const u = raw.toUpperCase();
        this.ai_model = (u in map) ? map[u] : raw;
        this.appendLine('AI model: ' + (this.ai_model || this._aiDefaultModel), 1);
        return CMD_OK;
    }

    // AITEMP n   — sampling temperature 0..1 (0 = deterministic, best for pulling data).
    // AITEMP     — show it.  Out-of-range value resets to the API default.
    cmdAITEMP(param) {
        const raw = this.trim(String(param || ''));
        if (raw === '') { this.appendLine('AI temperature: ' + (this.ai_temp == null ? '(API default)' : this.ai_temp), 1); return CMD_OK; }
        const n = parseFloat(raw);
        if (isNaN(n) || n < 0 || n > 1) { this.ai_temp = null; this.appendLine('AI temperature reset to API default.', 1); return CMD_OK; }
        this.ai_temp = n;
        this.appendLine('AI temperature: ' + n, 1);
        return CMD_OK;
    }

    // AITOKENS n  — max output tokens (1..8192).  AITOKENS shows it; 0 or bad value resets to 1024.
    cmdAITOKENS(param) {
        const raw = this.trim(String(param || ''));
        if (raw === '') { this.appendLine('AI max tokens: ' + (this.ai_tokens || 1024), 1); return CMD_OK; }
        let n = parseInt(raw, 10);
        if (isNaN(n) || n < 1) { this.ai_tokens = 0; this.appendLine('AI max tokens reset to 1024.', 1); return CMD_OK; }
        if (n > 8192) n = 8192;
        this.ai_tokens = n;
        this.appendLine('AI max tokens: ' + n, 1);
        return CMD_OK;
    }

    // AIWEB ON | OFF | (no arg) — when ON, AI/AINUM requests carry Anthropic's server-side
    // web_search tool, so Claude can look things up itself (e.g. AI "what is the price of bitcoin", P$).
    // OFF by default (web search adds latency and a per-search cost). AICLEAR ALL resets it.
    cmdAIWEB(param) {
        const arg = this.trim(String(param || '')).toUpperCase();
        if (arg === '')      { this.appendLine('AI web search: ' + (this.ai_web ? 'ON' : 'OFF'), 1); return CMD_OK; }
        if (arg === 'ON'  || arg === '1') { this.ai_web = true;  this.appendLine('AI web search ON — Claude can search the web to answer.', 1); return CMD_OK; }
        if (arg === 'OFF' || arg === '0') { this.ai_web = false; this.appendLine('AI web search OFF.', 1); return CMD_OK; }
        return CMD_ESYNTAX;
    }

    // WEBGET url$, RESULT$ — HTTP GET from the open web (https assumed if no scheme).
    //   RESULT$  receives the response body text (capped at 1 MB).
    //   WEBSTATUS receives the HTTP status code (0 on a network/CORS error).
    //   WEBERR$   is "" on success or holds the error text — test it in programs.
    //   url$ / RESULT$ are a quoted string or a string variable.
    // Browser CORS rules apply: only sites that send Access-Control-Allow-Origin
    // headers will work (most public JSON APIs do; many ordinary web pages do not).
    cmdWEBGET(param) {
        const raw = this.trim(String(param || ''));
        if (!raw) return CMD_ESYNTAX;
        // split:  url , RESULT$    (url may be quoted or a variable)
        let urlPart, resVar = null;
        if (raw.startsWith('"')) {
            const q = raw.indexOf('"', 1);
            if (q > 0) {
                urlPart = raw.substring(0, q + 1);
                const after = this.trim(raw.substring(q + 1));
                if (after.startsWith(',')) resVar = this.trim(after.substring(1));
            } else { urlPart = raw; }
        } else {
            const c = raw.indexOf(',');
            if (c > 0) { urlPart = this.trim(raw.substring(0, c)); resVar = this.trim(raw.substring(c + 1)); }
            else urlPart = raw;
        }
        if (!resVar) { this.appendLine('WEBGET needs a result variable:  WEBGET url$, R$', 1); return CMD_ESYNTAX; }
        let url;
        if (urlPart.startsWith('"') && urlPart.endsWith('"')) url = urlPart.slice(1, -1);
        else url = String(this.lookup(urlPart) || urlPart);
        url = this.trim(url);
        if (!url) { this.appendLine('WEBGET: empty URL', 1); return CMD_ESYNTAX; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

        this.assign_(ASS_STRING, 'WEBERR$', '');
        this.assign_(ASS_NUMBER, 'WEBSTATUS', 0);

        // pause BASIC execution while the request is in flight
        this.want_ai = 1;
        this._cancelNextTick();
        const finish = () => {
            this.want_ai = 0;
            if (this.running) this._scheduleNextTick();
            else { this.appendLine(this.prompt, 0); this.blink(); }
        };

        const MAXLEN = 1048576;                       // 1 MB body cap
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 20000);
        fetch(url, { method: 'GET', signal: controller.signal })
            .then(async (resp) => {
                this.assign_(ASS_NUMBER, 'WEBSTATUS', resp.status || 0);
                let body = await resp.text();         // signal still active — the abort also covers the body
                clearTimeout(tid);
                if (body.length > MAXLEN) body = body.slice(0, MAXLEN) + '\n...[truncated at 1 MB]';
                this.assign_(ASS_STRING, resVar, body);
                if (!resp.ok) this.assign_(ASS_STRING, 'WEBERR$', 'HTTP ' + resp.status);
                finish();
            })
            .catch((err) => {
                clearTimeout(tid);
                const msg = (err && err.name === 'AbortError') ? 'timeout (20s)' : (String((err && err.message) || err) || 'error');
                this.assign_(ASS_STRING, 'WEBERR$', msg);
                this.assign_(ASS_STRING, resVar, '');
                const hint = (msg === 'Failed to fetch') ? '  (the site may not allow cross-origin requests)' : '';
                this.appendLine('WEB ERROR: ' + msg + hint, 1);
                finish();
            });
        return CMD_OK;
    }

    // =======================================================================
    // WEBSOCKET SYSTEM
    //
    // Commands:
    //   WS.OPEN url$         — open connection (pauses until open/error)
    //   WS.SEND msg$         — send a text message
    //   WS.CLOSE             — close the connection
    //   WS.STATUS            — 0=closed 1=connecting 2=open 3=error (numeric var)
    //   WS.RECV$             — pop next message from queue ("" if empty)
    //   WS.ONMSG lbl         — GOSUB lbl whenever a message arrives
    //   WS.CLEAR             — clear the message queue
    // =======================================================================


    // =======================================================================
    // Network (WebSocket) — delegated to NetDriver (core/drivers/net.js)
    // Step 2 of V7 architecture refactor: extracted 2026-04
    // =======================================================================
    get _ws()            { return this._netDrv._ws; }
    set _ws(v)           { this._netDrv._ws = v; }
    get _wsStatus()      { return this.kernel.call({syscall:'net.status'}); }
    set _wsStatus(v)     { this._netDrv._wsStatus = v; }
    get _wsQueue()       { return this._netDrv._wsQueue; }
    set _wsQueue(v)      { this._netDrv._wsQueue = v; }
    get _wsOnMsg()       { return this._netDrv._wsOnMsg; }
    set _wsOnMsg(v)      { this._netDrv._wsOnMsg = v; }

    _wsInit()            { return this._netDrv._wsInit(); }
    _wsResume()          { return this._netDrv._wsResume(); }
    _wsRecv()            { return this.kernel.call({syscall:'net.recv'}); }
    cmdWS_OPEN(p)              { return this.kernel.post({syscall:'net.open',param:p}); }
    cmdWS_SEND(p)              { return this.kernel.post({syscall:'net.send',param:p}); }
    cmdWS_CLOSE()              { return this.kernel.post({syscall:'net.close'}); }
    cmdWS_CLEAR()              { return this.kernel.post({syscall:'net.clear'}); }
    cmdWS_ONMSG(p)             { return this.kernel.post({syscall:'net.onmsg',param:p}); }

    // =======================================================================
    // MOUSE SYSTEM  (Amiga BASIC compatible)
    //
    // MOUSE ON              — enable mouse event trapping
    // MOUSE OFF             — disable mouse event trapping
    // MOUSE STOP            — suspend (queue but don't fire GOSUB)
    // ON MOUSE GOSUB lbl    — set subroutine for button press events
    //
    // MOUSE(0)  button status: 0=up 1=click 2=dblclick -1=held (clears on read)
    // MOUSE(1)  current cursor X  (canvas-relative pixels)
    // MOUSE(2)  current cursor Y
    // MOUSE(3)  X where button was last pressed
    // MOUSE(4)  Y where button was last pressed
    // MOUSE(5)  X at last release (or current pos if held)
    // MOUSE(6)  Y at last release
    // =======================================================================

    cmdMOUSE(param) {
        const arg = this.trim(String(param || '')).toUpperCase();
        if (arg === 'ON')   { this._mouseEnabled = 1; return CMD_OK; }
        if (arg === 'OFF')  { this._mouseEnabled = 0; return CMD_OK; }
        if (arg === 'STOP') { this._mouseEnabled = 2; return CMD_OK; }
        return CMD_OK;
    }

    // AI — send a prompt and stream the reply into the terminal.
    cmdAI(param) {
        return this._aiDispatch(param, 'text');
    }

    cmdAINUM(param) {
        return this._aiDispatch(param, 'number');
    }

    // _aiDispatch — shared handler for AI and AINUM.
    // Syntax: AI "prompt" [, RESULT$]
    //         AINUM "prompt", VAR
    _aiDispatch(param, mode) {
        const raw = this.trim(String(param || ''));
        if (!raw) return CMD_ESYNTAX;

        // Split prompt from optional result variable.
        // Prompt may be a quoted string or a variable name.
        // Find the comma OUTSIDE the prompt string.
        let promptPart = raw;
        let resultVar  = null;

        if (raw.startsWith('"')) {
            const closeQ = raw.indexOf('"', 1);
            if (closeQ > 0 && closeQ < raw.length - 1) {
                const afterQ = raw.substring(closeQ + 1).trim();
                if (afterQ.startsWith(',')) {
                    promptPart = raw.substring(0, closeQ + 1);
                    resultVar  = this.trim(afterQ.substring(1));
                }
            }
        } else {
            const commaPos = raw.indexOf(',');
            if (commaPos > 0) {
                promptPart = raw.substring(0, commaPos).trim();
                resultVar  = this.trim(raw.substring(commaPos + 1));
            }
        }

        // Resolve prompt text.
        let text;
        if (promptPart.startsWith('"') && promptPart.endsWith('"')) {
            text = promptPart.slice(1, -1);
        } else {
            text = String(this.lookup(promptPart) || promptPart);
        }

        if (!this.ai_key) {
            this.appendLine('No API key set. Type AIKEY to enter your Anthropic key.', 1);
            this.assign_(ASS_STRING, 'AIERR$', 'no API key');
            return CMD_OK;
        }
        // AIERR$ holds the last AI error message ("" on success) so a program can test it.
        this.assign_(ASS_STRING, 'AIERR$', '');

        // Pause the BASIC execution loop.
        this.want_ai = 1;
        this._cancelNextTick();

        // Keep the conversation history bounded (token-limit / cost). Trim oldest
        // turns, keeping the array starting on a 'user' message.
        if (this.ai_messages.length >= 40) {
            this.ai_messages = this.ai_messages.slice(-38);
            if (this.ai_messages[0] && this.ai_messages[0].role !== 'user') this.ai_messages.shift();
        }
        this.ai_messages.push({ role: 'user', content: text });

        // Only print streaming output when not storing to a variable.
        const silent  = (resultVar !== null);
        const numMode = (mode === 'number');
        if (!silent) this.appendLine('AI: ', 0);

        const finish = () => {
            this.want_ai = 0;
            if (!silent) this.appendLine('', 1);
            // The tick loop already advanced run_line when this handler returned
            // CMD_OK; don't double-advance here. Same invariant as _runAuthOp.
            if (this.running) this._scheduleNextTick();
            else { this.appendLine(this.prompt, 0); this.blink(); }
        };

        this._callAnthropicAPI(silent, numMode).then((fullText) => {
            if (resultVar) {
                if (numMode) {
                    const n = parseFloat(fullText.trim());
                    this.assign_(ASS_NUMBER, resultVar, isNaN(n) ? 0 : n);
                } else {
                    this.assign_(ASS_STRING, resultVar, fullText.trim());
                }
            }
            finish();
        }).catch((err) => {
            const msg = String((err && err.message) || err) || 'error';
            this.assign_(ASS_STRING, 'AIERR$', msg);
            if (resultVar) {                       // leave a defined value the program can test
                if (numMode) this.assign_(ASS_NUMBER, resultVar, 0);
                else         this.assign_(ASS_STRING, resultVar, '');
            }
            this.appendLine('AI ERROR: ' + msg, 1);
            finish();
        });

        return CMD_OK;
    }

    // _callAnthropicAPI — streams a response from the configured model (default claude-haiku-4-5).
    // silent=true     suppresses character-by-character output (used when storing to a var).
    // numberMode=true appends a "reply with only a number" instruction to the system prompt.
    async _callAnthropicAPI(silent = false, numberMode = false) {
        const fmtHint = '\n\nReply in plain text only — no markdown, no bullet points, no headers.';
        const baseSys = this.ai_system ||
            'You are a helpful AI assistant running inside a BASIC interpreter terminal. ' +
            'Keep responses concise and terminal-friendly.';
        const numHint = numberMode
            ? '\n\nThe caller needs a single numeric answer. Reply with ONLY a number — digits, an ' +
              'optional decimal point and an optional leading minus sign. No words, units, or other text.'
            : '';
        const webHint = this.ai_web
            ? '\n\nIf the answer needs current, factual, or external information, use the web search ' +
              'tool to look it up rather than guessing. Then give the answer plainly.'
            : '';
        const reqBody = {
            model:      this.ai_model || this._aiDefaultModel,
            max_tokens: this.ai_tokens || (this.ai_web ? 4096 : 1024),   // web answers run long; give them room
            system:     baseSys + fmtHint + numHint + webHint,
            messages:   this.ai_messages,
            stream:     true,
        };
        if (this.ai_temp != null) reqBody.temperature = this.ai_temp;
        // AIWEB ON — let Claude search the web itself (server-side tool; Anthropic runs the search).
        if (this.ai_web) reqBody.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

        // AbortController gives us a hard timeout (longer when web search may be in play).
        // Without it a hung or slow response blocks the BASIC program forever.
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), this.ai_web ? 60000 : 30000);
        let response;
        try {
            response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type':            'application/json',
                    'x-api-key':               this.ai_key,
                    'anthropic-version':       '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true',
                },
                body: JSON.stringify(reqBody),
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
            throw new Error(err?.error?.message || response.statusText);
        }

        const reader   = response.body.getReader();
        const decoder  = new TextDecoder();
        let   fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }
                if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                    const token = parsed.delta.text;
                    fullText += token;
                    if (!silent) {
                        for (const ch of token) {
                            this.appendCharacter(ch);
                        }
                    }
                }
            }
        }

        if (fullText) {
            this.ai_messages.push({ role: 'assistant', content: fullText });
        }
        return fullText;
    }

    // -----------------------------------------------------------------------
    // _buildCommandTable
    // -----------------------------------------------------------------------
    _buildCommandTable() {
        // Format: [keyword, numParams, handlerMethod, selfHandling, separator, rawParams]
        this.command_table = [
            ['REM',    0,  (p) => this.cmdNULL(p)],
            ['MEM',    0,  ()  => this.cmdMEM()],
            ['INFO',   0,  ()  => this.cmdINFO()],
            ['HWINFO', 0,  ()  => this.cmdHWINFO()],
            ['LABELS', 0,  ()  => this.cmdLABELS()],
            ['HISTORY', 0,  ()  => this.cmdHISTORY()],
            ['HELP',   1,  (p) => this.cmdHELP(p),           0, ',', 1],
            ['VIEW',   0,  (p) => this.cmdVIEW(p),           1],
            ['NEW',    0,  ()  => this.cmdNEW()],
            ['MERGE',  0,  (p) => this.cmdMERGE(p),          1],
            ['LIST',   0,  (p) => this.cmdLIST(p),          1],
            ['FILES',  0,  (p) => this.cmdFILES(p)],
            ['DELUSER',1,  (p) => this.cmdDELUSER(p)],
            ['LLIST',  0,  (p) => this.cmdLLIST(p),         1],
            ['RESET',  0,  ()  => this.cmdRESET()],
            ['RESIZE', 1,  (p) => this.cmdRESIZE(p)],
            ['CLS',    0,  ()  => this.cmdCLEARSCREEN()],
            ['CLR',    0,  ()  => this.cmdCLEARSCREEN()],
            ['CLSSCR', 0,  ()  => this.cmdCLEARSCREEN()],
            ['INPUT',  2,  (p) => this.cmdINPUT(p),           0, ';', 1],
            ['SLEEP',  1,  (p) => this.cmdSLEEP(p)],
            ['DELAY',  1,  (p) => this.cmdDELAY(p)],
            ['DIM',   -1,  (p) => this.cmdDIM(p),             0, ',', 1],
            ['DIR',    0,  (p) => this.cmdDIR(p),             1],
            ['VFSPUT',  0,  (p) => this.cmdVFSPUT(p),          1],
            ['VFSDEL',  0,  (p) => this.cmdVFSDEL(p),          1],
            ['READTEXT',0,  (p) => this.cmdREADTEXT(p),         1],
            ['VFSIMG',  0,  (p) => this.cmdVFSIMG(p),          1],
            // Auth commands — DEV* for the mock sandbox, plain for future production
            // DELETEACCOUNT must come BEFORE the generic DELETE command (~line 3065)
            // so prefix matching picks the longer name first.
            ['DEVLOGIN',      0, (p) => this.cmdDEVLOGIN(p),        1],
            ['DEVLOGOUT',     0, (p) => this.cmdDEVLOGOUT(p),       1],
            ['DEVWHOAMI',     0, (p) => this.cmdDEVWHOAMI(p),       1],
            ['DELETEACCOUNT', 0, (p) => this.cmdDELETEACCOUNT(p),   1],
            ['LOGIN',         0, (p) => this.cmdLOGIN(p),           1],
            ['LOGOUT',        0, (p) => this.cmdLOGOUT(p),          1],
            ['REGISTER',      0, (p) => this.cmdREGISTER(p),        1],
            ['PASSWORD',      0, (p) => this.cmdPASSWORD(p),        1],
            ['WHOAMI',        0, (p) => this.cmdWHOAMI(p),          1],
            ['DATA',  -1,  (p) => this.cmdDATA(p),            0, ',', 1],
            ['READ',  -1,  (p) => this.cmdREAD(p),            0, ',', 1],
            ['DEF',   -1,  (p) => this.cmdDEF(p),             1],
            ['COLOUR', 3,  (p) => this.cmdCOLOUR(p)],
            ['COLOR',  3,  (p) => this.cmdCOLOUR(p)],
            ['CIRCLE', 3,  (p) => this.cmdCIRCLE(p)],
            ['LINE',   4,  (p) => this.cmdLINE(p)],
            ['FILLRECT',   4,  (p) => this.cmdFILLRECT(p)],
            ['FILLCIRCLE', 3,  (p) => this.cmdFILLCIRCLE(p)],
            ['RECT',     4,  (p) => this.cmdRECT(p)],
            ['POINT',  2,  (p) => this.cmdPOINT(p)],
            ['LPRINT',  0,  (p) => this.cmdLPRINT(p),         1],
            ['LAUNCH',      0, (p) => this.cmdLAUNCH(p),          1],
            ['WINDOW.SEND',  0, (p) => this.cmdWINDOW_SEND(p),     1],
            ['WINDOW.CLOSE', 0, (p) => this.cmdWINDOW_CLOSE(p),    1],
            ['WINDOW.REPLY', 0, (p) => this.cmdWINDOW_REPLY(p),    1],
            ['ON WINDOW',    0, (p) => this.cmdON_WINDOW(p),        1],
            ['NPRINT', 2,  (p) => this.cmdNPRINT(p),          1],
            ['PRINT',  0,  (p) => this.cmdPRINT(p),           1],
            ['?',      0,  (p) => this.cmdPRINT(p),           1],
            ['END',    0,  ()  => this.cmdEND()],
            ['GOSUB',  0,  (p) => this.cmdGOSUB(p),    1],
            ['RETURN', 0,  ()  => this.cmdRETURN()],
            ['GOTO',   0,  (p) => this.cmdGOTO(p),     1],
            ['IF',     0,  (p) => this.cmdIF(p),              1],
            ['FOR',    0,  (p) => this.cmdFOR(p),             1],
            ['NEXT',  -1,  (p) => this.cmdNEXT(p)],

            // Tier 3
            ['SOUND',        0,  (p) => this.cmdSOUND(p),   1],
            ['WAVE',         0,  (p) => this.cmdWAVE(p),   1],
            ['POKE',         2,  (p) => this.cmdPOKE(p)],
            ['POKEW',        2,  (p) => this.cmdPOKEW(p)],
            ['POKEL',        2,  (p) => this.cmdPOKEL(p)],
            ['OPTION BASE',  1,  (p) => this.cmdOPTIONBASE(p)],
            ['WIDTH',        1,  (p) => this.cmdWIDTH(p)],
            ['LSET',         0,  (p) => this.cmdLSET(p),         1],
            ['RSET',         0,  (p) => this.cmdRSET(p),         1],
            ['PRINT USING',  0,  (p) => this.cmdPRINTUSING(p),  1],
            ['SHARED',       0,  (p) => this.cmdSHARED(p),       1],
            ['STATIC',       0,  (p) => this.cmdSTATIC(p),       1],
            ['DECLARE',      0,  (p) => this.cmdDECLARE(p),      1],
            ['CALL',         0,  (p) => this.cmdCALL(p),         1],
            ['END SUB',      0,  ()  => this.cmdENDSUB()],
            ['ENDSUB',       0,  ()  => this.cmdENDSUB()],
            ['END FUNCTION', 0,  ()  => this.cmdENDFUNCTION()],
            ['ENDFUNCTION',  0,  ()  => this.cmdENDFUNCTION()],
            ['EXIT SUB',     0,  ()  => this.cmdEXITSUB()],

            // Tier 2 — block IF, WHILE, ON n, error trapping
            ['ELSEIF',      0,  (p) => this.cmdELSEIF(p),      1],
            ['ELSE IF',     0,  (p) => this.cmdELSEIF(p),      1],
            ['END IF',      0,  ()  => this.cmdENDIF()],
            ['ENDIF',       0,  ()  => this.cmdENDIF()],
            ['WHILE',       0,  (p) => this.cmdWHILE(p),        1],
            ['SWITCH',      0,  (p) => this.cmdSWITCH(p),        1],
            ['DEFAULT:',    0,  ()  => this.cmdCASE('ELSE')],
            ['DEFAULT:',    0,  ()  => this.cmdCASE('ELSE')],
            ['DEFAULT',     0,  ()  => this.cmdCASE('ELSE')],
            ['END SWITCH',  0,  ()  => this.cmdENDSELECT()],
            ['ENDSWITCH',   0,  ()  => this.cmdENDSELECT()],
            ['BREAK',       0,  ()  => this.cmdBREAK()],
            ['CASE',        0,  (p) => this.cmdCASE(p),          1],
            ['WEND',        0,  ()  => this.cmdWEND()],
            ['ON ERROR',    0,  (p) => this.cmdONERROR(p),      1],
            ['ON',          0,  (p) => this.cmdONGOTO(p),       1],
            ['RESUME',      0,  (p) => this.cmdRESUME(p),       1],
            ['LOCATE',      2,  (p) => this.cmdLOCATE(p)],
            ['STOP',        0,  ()  => this.cmdSTOP()],

            // Tier 1 — Amiga BASIC parity
            ['BEEP',        0,  ()  => this.cmdBEEP()],
            ['FULLSCREEN',  0,  (p) => this.cmdFULLSCREEN(p), 1],
            ['UI',          0,  (p) => this.cmdUI(p),         1],
            ['OVERSCAN',    0,  (p) => this.cmdOVERSCAN(p),   1],
            ['SWAP',        2,  (p) => this.cmdSWAP(p),        0, ',', 1],
            ['RANDOMIZE',   1,  (p) => this.cmdRANDOMIZE(p),   0, ',', 1],
            ['CONT',        0,  ()  => this.cmdCONT()],
            ['TRON',        0,  ()  => this.cmdTRON()],
            ['TROFF',       0,  ()  => this.cmdTROFF()],
            ['WRITE',       0,  (p) => this.cmdWRITE(p),        1],
            ['ERASE',      -1,  (p) => this.cmdERASE(p),        0, ',', 1],
            ['CLEAR',       0,  ()  => this.cmdCLEAR()],
            ['DELETE',      0,  (p) => this.cmdDELETE(p),       1],
            ['RESTORE',     1,  (p) => this.cmdRESTORE(p)],
            ['LINE INPUT',  0,  (p) => this.cmdLINEINPUT(p),    1],
            ['PSET',        3,  (p) => this.cmdPSET(p)],
            ['PRESET',      3,  (p) => this.cmdPRESET(p)],
            ['PAINT',       3,  (p) => this.cmdPAINT(p)],
            ['IMAGE',       0,  (p) => this.cmdIMAGE(p),     1],
            ['LOADIMG',     0,  (p) => this.cmdLOADIMG(p),   1],
            ['DISPLAY',     0,  (p) => this.cmdDISPLAY(p),   1],
            ['IMGLIST',     0,  ()  => this.cmdIMGLIST()],
            ['IMGFREE',     0,  (p) => this.cmdIMGFREE(p),   1],
            ['EDIT',   1,  (p) => this.cmdEDIT(p)],

            // OBJECT system (Amiga BASIC-compatible sprites/bobs)
            // Longest names first so the command table match is unambiguous.
            ['OBJECT.SHAPE',    0,  (p) => this.cmdOBJECT_SHAPE(p),    1],
            ['OBJECT.START',    0,  (p) => this.cmdOBJECT_START(p),    1],
            ['OBJECT.STOP',     0,  (p) => this.cmdOBJECT_STOP(p),     1],
            ['OBJECT.CLOSE',    0,  (p) => this.cmdOBJECT_CLOSE(p),    1],
            ['OBJECT.PRIORITY', 0,  (p) => this.cmdOBJECT_PRIORITY(p), 1],
            ['OBJECT.SCALE',    0,  (p) => this.cmdOBJECT_SCALE(p),    1],
            ['OBJECT.FLIP',     0,  (p) => this.cmdOBJECT_FLIP(p),     1],
            ['OBJECT.ROTATE',   0,  (p) => this.cmdOBJECT_ROTATE(p),   1],
            ['OBJECT.PLANES',   0,  (p) => CMD_OK,                      1],
            ['OBJECT.CLIP',     0,  (p) => this.cmdOBJECT_CLIP(p),     1],
            ['OBJECT.HIT',      0,  (p) => this.cmdOBJECT_HIT(p),      1],
            ['OBJECT.OFF',      0,  (p) => this.cmdOBJECT_OFF(p),      1],
            ['OBJECT.ON',       0,  (p) => this.cmdOBJECT_ON(p),       1],
            ['OBJECT.VX',       0,  (p) => this.cmdOBJECT_VX(p),       1],
            ['OBJECT.VY',       0,  (p) => this.cmdOBJECT_VY(p),       1],
            ['OBJECT.AX',       0,  (p) => this.cmdOBJECT_AX(p),       1],
            ['OBJECT.AY',       0,  (p) => this.cmdOBJECT_AY(p),       1],
            ['OBJECT.X',        0,  (p) => this.cmdOBJECT_X(p),        1],
            ['OBJECT.Y',        0,  (p) => this.cmdOBJECT_Y(p),        1],
            ['COLLISION ON',    0,  ()  => this.cmdCOLLISION_ON()],
            ['COLLISION OFF',   0,  ()  => this.cmdCOLLISION_OFF()],
            ['COLLISION STOP',  0,  ()  => this.cmdCOLLISION_STOP()],
            ['ON COLLISION',    0,  (p) => this.cmdON_COLLISION(p),     1],
            ['ON MOUSE',        0,  (p) => this.cmdON_MOUSE(p),         1],

            // GL 3D rendering system — longest names first
            ['GL.PERSPECTIVE', 0,  (p) => this.cmdGL_PERSPECTIVE(p),   1],
            ['GL.TRANSLATE',   0,  (p) => this.cmdGL_TRANSLATE(p),     1],
            ['GL.INSTANCE',    0,  (p) => this.cmdGL_INSTANCE(p),      1],
            ['GL.INSTHIDE',    0,  (p) => this.cmdGL_INSTHIDE(p),      1],
            ['GL.SOLIDWIRE',   0,  ()  => this.cmdGL_SOLIDWIRE()],
            ['GL.DRAWALL',     0,  ()  => this.cmdGL_DRAWALL()],
            ['GL.AMBIENT',     0,  (p) => this.cmdGL_AMBIENT(p),       1],
            ['GL.BLOOM',       0,  (p) => this.cmdGL_BLOOM(p),         1],
            ['GL.FPS',         0,  (p) => this.cmdGL_FPS(p),           1],
            ['GL.RFPS',        0,  (p) => this.cmdGL_RFPS(p),          1],
            ['GL.AA',          0,  (p) => this.cmdGL_AA(p),            1],
            ['GL.LOOKAT',      0,  (p) => this.cmdGL_LOOKAT(p),        1],
            ['GL.CAMERA',      0,  (p) => this.cmdGL_CAMERA(p),        1],
            ['GL.CAMERAROLL',  0,  (p) => this.cmdGL_CAMERAROLL(p),    1],
            ['GL.COLOUR',      0,  (p) => this.cmdGL_COLOUR(p),        1],
            ['GL.VERTEX',      0,  (p) => this.cmdGL_VERTEX(p),        1],
            ['GL.LIGHT',       0,  (p) => this.cmdGL_LIGHT(p),         1],
            ['GL.LIGHTOFF',    0,  ()  => this.cmdGL_LIGHTOFF()],
            ['GL.COLOR',       0,  (p) => this.cmdGL_COLOUR(p),        1],
            ['GL.ROTATE',      0,  (p) => this.cmdGL_ROTATE(p),        1],
            ['GL.SCALE',       0,  (p) => this.cmdGL_SCALE(p),         1],
            ['GL.SOLID',       0,  ()  => this.cmdGL_SOLID()],
            ['GL.BEGIN',       0,  ()  => this.cmdGL_BEGIN()],
            ['GL.DRAW',        0,  (p) => this.cmdGL_DRAW(p),          1],
            ['GL.FACE',        0,  (p) => this.cmdGL_FACE(p),          1],
            ['GL.WIRE',        0,  ()  => this.cmdGL_WIRE()],
            ['GL.WIREALL',     0,  (p) => this.cmdGL_WIREALL(p),       1],
            ['GL.INIT',        0,  ()  => this.cmdGL_INIT()],
            ['GL.CLOSE',       0,  ()  => this.cmdGL_CLOSE()],
            ['GLDEBUG',        0,  ()  => this.cmdGLDEBUG(),         1],
            ['GL.END',         0,  ()  => this.cmdGL_END()],
            ['GL.CLS',         0,  (p) => this.cmdGL_CLS(p),           1],
            ['GL.SHINE',       0,  (p) => this.cmdGL_SHINE(p),         1],
            ['GL.ALPHA',       0,  (p) => this.cmdGL_ALPHA(p),         1],            ['GL.WIRECOLOR',   0,  (p) => this.cmdGL_WIRECOLOR(p),     1],
            ['GL.TEXTURE',     0,  (p) => this.cmdGL_TEXTURE(p),       1],
            ['GL.POINTLIGHT',  0,  (p) => this.cmdGL_POINTLIGHT(p),    1],
            ['GL.HEADLIGHT',   0,  (p) => this.cmdGL_HEADLIGHT(p),     1],
            ['GL.CLOUDS',      0,  (p) => this.cmdGL_CLOUDS(p),        1],
            ['GL.SKY',         0,  (p) => this.cmdGL_SKY(p),           1],
            ['GL.TERRAIN',     0,  (p) => this.cmdGL_TERRAIN(p),       1],
            ['GL.PROBE',       0,  (p) => this.cmdGL_PROBE(p),         1],
            ['GL.SCANFWD',     0,  (p) => this.cmdGL_SCANFWD(p),       1],
            ['GL.OBSTACLE',    0,  (p) => this.cmdGL_OBSTACLE(p),      1],
            ['GL.OBSTACLEHIT', 0,  (p) => this.cmdGL_OBSTACLEHIT(p),   1],
            ['GL.OBSTACLECLEAR', 0, ()  => this.cmdGL_OBSTACLECLEAR()],
            ['AIG_NAVIGATE',   0,  (p) => this.cmdAIG_NAVIGATE(p),     1],
            ['GL.RECTLIGHT',   0,  (p) => this.cmdGL_RECTLIGHT(p),     1],
            ['GL.LIGHTSOFF',   0,  ()  => this.cmdGL_LIGHTSOFF()],
            ['GL.HIDE',        0,  (p) => this.cmdGL_HIDE(p),        1],
            ['GL.DISPOSE',     0,  (p) => this.cmdGL_DISPOSE(p),     1],
            ['GL.SHOW',        0,  (p) => this.cmdGL_SHOW(p),        1],
            ['GL.FOG',         0,  (p) => this.cmdGL_FOG(p),           1],
            ['GL.FOGOFF',      0,  ()  => this.cmdGL_FOGOFF()],
            ['GL.SPHERE',      0,  (p) => this.cmdGL_SPHERE(p),        1],
            ['GL.BOX',         0,  (p) => this.cmdGL_BOX(p),           1],
            ['GL.CYLINDER',    0,  (p) => this.cmdGL_CYLINDER(p),      1],
            ['GL.POLYHEDRON',  0,  (p) => this.cmdGL_POLYHEDRON(p),    1],
            ['GL.LOAD',        0,  (p) => this.cmdGL_LOAD(p),          1],
            ['GL.CHROME',      0,  (p) => this.cmdGL_CHROME(p),        1],
            ['GL.NORMALMAP',   0,  (p) => this.cmdGL_NORMALMAP(p),     1],
            ['GL.ROUGHMAP',    0,  (p) => this.cmdGL_ROUGHMAP(p),      1],
            ['GL.AOMAP',       0,  (p) => this.cmdGL_AOMAP(p),         1],
            ['GL.HEIGHTMAP',   0,  (p) => this.cmdGL_HEIGHTMAP(p),     1],
            ['GL.METALMAP',    0,  (p) => this.cmdGL_METALMAP(p),      1],
            ['GL.EMISSIVEMAP', 0,  (p) => this.cmdGL_EMISSIVEMAP(p),  1],
            ['GL.EMISSIVE',    0,  (p) => this.cmdGL_EMISSIVE(p),     1],
            ['GL.EMISSIVEINTENSITY', 0, (p) => this.cmdGL_EMISSIVEINTENSITY(p), 1],
            ['GL.ROUGHNESS',   0,  (p) => this.cmdGL_ROUGHNESS(p),    1],
            ['GL.METALNESS',   0,  (p) => this.cmdGL_METALNESS(p),    1],
            ['GL.ENVMAP',      0,  (p) => this.cmdGL_ENVMAP(p),        1],

            // AI commands
            ['AIKEY',    0,  (p) => this.cmdAIKEY(p),    1],
            ['AICLEAR',  0,  (p) => this.cmdAICLEAR(p),  1],
            ['AISYSTEM', 0,  (p) => this.cmdAISYSTEM(p), 1],
            ['AIMODEL',  0,  (p) => this.cmdAIMODEL(p),  1],
            ['AITOKENS', 0,  (p) => this.cmdAITOKENS(p), 1],
            ['AITEMP',   0,  (p) => this.cmdAITEMP(p),   1],
            ['AIWEB',    0,  (p) => this.cmdAIWEB(p),    1],
            ['WEBGET',   0,  (p) => this.cmdWEBGET(p),   1],
            ['WS.OPEN',  0,  (p) => this.cmdWS_OPEN(p),  1],
            ['WS.SEND',  0,  (p) => this.cmdWS_SEND(p),  1],
            ['WS.CLOSE', 0,  ()  => this.cmdWS_CLOSE()],
            ['WS.CLEAR', 0,  ()  => this.cmdWS_CLEAR()],
            ['WS.ONMSG', 0,  (p) => this.cmdWS_ONMSG(p), 1],
            ['MOUSE',    0,  (p) => this.cmdMOUSE(p),    1],
            ['AINUM',   0,  (p) => this.cmdAINUM(p),   1],
            ['AI',      0,  (p) => this.cmdAI(p),      1],
        ];
    }

    // -----------------------------------------------------------------------
    // extractForParts  –  parse "I=1TO10STEP2" → [varname, start, end, step]
    // -----------------------------------------------------------------------
    extractForParts(line) {
        const result = [];
        let s = line;

        // Extract variable name (before =)
        let pos = s.indexOf('=');
        if (pos <= 0) return null;
        result.push(this.trim(s.substring(0, pos)));
        s = s.substring(pos + 1);

        // Find TO keyword — must be surrounded by spaces or start/end
        // to avoid matching "TO" inside variable names like "TOTAL"
        const sUp = s.toUpperCase();
        let toPos = -1;
        for (let i = 0; i < sUp.length - 1; i++) {
            if (sUp[i] === 'T' && sUp[i+1] === 'O') {
                const before = i === 0 || /[^A-Z0-9]/.test(sUp[i-1]);
                const after  = i+2 >= sUp.length || /[^A-Z0-9]/.test(sUp[i+2]);
                if (before && after) { toPos = i; break; }
            }
        }
        if (toPos <= 0) return null;
        result.push(this.trim(s.substring(0, toPos)));
        s = s.substring(toPos + 2);

        // Find optional STEP keyword — must be word-bounded
        const sUp2 = s.toUpperCase();
        let stepPos = -1;
        for (let i = 0; i < sUp2.length - 3; i++) {
            if (sUp2.substring(i, i+4) === 'STEP') {
                const before = i === 0 || /[^A-Z0-9]/.test(sUp2[i-1]);
                const after  = i+4 >= sUp2.length || /[^A-Z0-9]/.test(sUp2[i+4]);
                if (before && after) { stepPos = i; break; }
            }
        }
        if (stepPos > 0) {
            result.push(this.trim(s.substring(0, stepPos)));
            result.push(this.trim(s.substring(stepPos + 4)));
        } else {
            result.push(this.trim(s));
        }
        return result.length >= 3 ? result : null;
    }

    // -----------------------------------------------------------------------
    // extractIfParts  –  parse "condition THEN branch [ELSE branch]"
    // -----------------------------------------------------------------------
    extractIfParts(line) {
        const upper = line.toUpperCase();

        // Find the first THEN that is NOT inside a quoted string.
        // Using a scanner instead of indexOf so we skip 'THEN' substrings inside
        // "string literals" and can word-bound the match.
        const findKw = (s, kw, from) => {
            const U = s.toUpperCase();
            let inQ = false;
            for (let i = from; i <= U.length - kw.length; i++) {
                const ch = s[i];
                if (ch === '"') { inQ = !inQ; continue; }
                if (inQ) continue;
                if (U.substr(i, kw.length) !== kw) continue;
                // word-boundary checks: char before & after must be non-identifier
                const prev = i === 0 ? ' ' : s[i - 1];
                const next = s[i + kw.length] === undefined ? ' ' : s[i + kw.length];
                const isId = (c) => /[A-Za-z0-9_$.]/.test(c);
                if (!isId(prev) && !isId(next)) return i;
            }
            return -1;
        };

        let thenPos = findKw(line, 'THEN', 0);
        let skipLen = 4;

        // Support IF cond GOTO n  (no THEN keyword — common BASIC idiom)
        if (thenPos <= 0) {
            const gotoPos = upper.search(/\bGOTO\b/);
            if (gotoPos > 0) { thenPos = gotoPos; skipLen = 0; }
        }
        if (thenPos <= 0) return null;

        const condition = line.substring(0, thenPos);
        let rest        = line.substring(thenPos + skipLen);

        const result = [condition];

        // Find the ELSE matching the OUTER THEN. Each inner IF ... THEN opens a
        // nesting level that claims its own ELSE (dangling-else: ELSE binds to
        // the nearest preceding THEN, not the outermost).
        let depth = 0;
        let elsePos = -1;
        let scan = 0;
        while (scan < rest.length) {
            const thenAt = findKw(rest, 'THEN', scan);
            const elseAt = findKw(rest, 'ELSE', scan);
            // Earliest next keyword wins
            let nextPos, isThen;
            if (thenAt === -1 && elseAt === -1) break;
            if (thenAt !== -1 && (elseAt === -1 || thenAt < elseAt)) {
                nextPos = thenAt; isThen = true;
            } else {
                nextPos = elseAt; isThen = false;
            }
            if (isThen) {
                depth++;
                scan = nextPos + 4;
            } else {
                if (depth === 0) { elsePos = nextPos; break; }
                depth--;
                scan = nextPos + 4;
            }
        }

        if (elsePos > 0) {
            let thenBranch = rest.substring(0, elsePos);
            let elseBranch = this.trim(rest.substring(elsePos + 4));
            if (Number(thenBranch) >= 0) thenBranch = 'GOTO ' + thenBranch;
            if (Number(elseBranch) >= 0) elseBranch = 'GOTO ' + elseBranch;
            result.push(thenBranch, elseBranch);
        } else {
            if (Number(rest) >= 0) rest = 'GOTO ' + rest;
            result.push(rest);
        }
        return result.length >= 2 ? result : null;
    }

    // -----------------------------------------------------------------------
    // parseCode  –  dispatch a cleaned BASIC statement to the right handler.
    // -----------------------------------------------------------------------
    parseCode(sWork) {
        const upper3 = sWork.substring(0, 3).toUpperCase();
        const upper4 = sWork.substring(0, 4).toUpperCase();

        // Pure label definition e.g. "MainLoop:" — silently skip, no-op.
        // Exclude SWITCH keywords: DEFAULT: and CASE x:
        const _sw = sWork.trim().toUpperCase();
        if (!(_sw === 'DEFAULT:' || _sw.startsWith('CASE ')) && /^[A-Za-z][A-Za-z0-9.]{0,39}:$/.test(sWork.trim())) return CMD_OK;

        // LET assignment
        if (upper3 === 'LET') {
            const eqPos = sWork.indexOf('=');
            if (eqPos > 0) {
                const err = this.parseAssign(this.trim(sWork.substring(3)));
                if (err) this.appendLine(err, 1);
                return CMD_OK;
            }
            return CMD_ESYNTAX;
        }

        // ELSE (block-IF) — flip skipping state.
        if (upper4 === 'ELSE' || sWork.trim().toUpperCase() === 'ELSE') {
            if (this._if_stack.length > 0) {
                const frame = this._if_stack[this._if_stack.length - 1];
                frame.skipping = frame.done;
            }
            return CMD_OK;
        }

        // RUN / LOAD / SAVE are handled separately because they may contain ':' in params.
        if (upper3 === 'RUN')  return this.cmdRUN(this.trim(sWork.substring(3)));
        if (upper4 === 'LOAD' && sWork.substring(0, 7).toUpperCase() !== 'LOADIMG') {
            let sParam = this.trim(sWork.substring(4));
            if (sParam.endsWith('$')) sParam = String(this.getValue(sParam, 0, sParam.length, ASS_STRING));
            this.cmdLOAD(sParam);
            return CMD_END;
        }
        if (upper4 === 'SAVE') return this.cmdSAVE(this.trim(sWork.substring(4)));

        // Fast O(1) command lookup via Map — try longest prefix first.
        const sUpper = sWork.toUpperCase();
        let entry = null;
        for (let tryLen = Math.min(sWork.length, 24); tryLen >= 1; tryLen--) {
            if (tryLen < sWork.length) {
                const ch = sWork[tryLen];
                // Valid keyword terminators: space, (, comma, end-of-string.
                // Single-char keywords (like ?) match regardless of what follows.
                if (tryLen > 1 && ch !== ' ' && ch !== '(' && ch !== ',') continue;
            }
            const found = this._cmdMap.get(sUpper.substring(0, tryLen));
            if (found) { entry = found; break; }
        }
        if (entry) {
            const len          = entry[0].length;
            const selfHandling = entry[3];
            const handler      = entry[2];
            if (selfHandling) return handler(this.trim(sWork.substring(len)));
            const numParams = entry[1];
            if (numParams === 0) return handler();
            const sep    = entry[4] ?? ',';
            const isRaw  = entry[5] ?? 0;
            const aParams = this.findParameters(sWork.substring(len), isRaw, sep);
            return handler(aParams);
        }

        // Implicit assignment (no keyword, e.g. "A=5+B").
        const eqPos = sWork.indexOf('=');
        if (eqPos > 0 && eqPos < sWork.length - 1) {
            const err = this.parseAssign(sWork);
            if (err) this.appendLine(err, 1);
            return CMD_OK;
        }

        // Implicit SUB call — "SubName arg1, arg2" without CALL keyword
        // SUB names are case-sensitive (Model B).
        {
            const sp  = sWork.indexOf(' ');
            const sn  = sp > 0 ? sWork.substring(0, sp) : sWork;
            if (this._subs && this._subs[sn]) {
                const argPart = sp > 0 ? sWork.substring(sp + 1) : '';
                return this.cmdCALL(sn + '(' + argPart + ')');
            }
        }

        return CMD_ESYNTAX;
    }

    // -----------------------------------------------------------------------
    // interpret  –  the main entry point; tokenises and dispatches one line.
    // FIX: removed dead `aCommands` split; single colon-scan now used.
    // -----------------------------------------------------------------------
    interpret(a, noOutput) {
        if (!a) return -1;

        // Tolerate leading whitespace after line numbers so source can be visually indented.
        // (Line numbers are stripped before interpret() runs; what arrives here may begin with spaces.)
        if (a.charCodeAt(0) === 32 || a.charCodeAt(0) === 9) {
            a = a.replace(/^[ \t]+/, '');
            if (!a) return -1;
        }

        // Skip SUB/FUNCTION bodies during normal execution.
        {
            const _ut = a.trim().toUpperCase();
            if (_ut.startsWith('SUB ') || _ut.startsWith('FUNCTION ')) {
                const _kw = _ut.startsWith('SUB ') ? 4 : 9;
                const _sn = _ut.substring(_kw).split(/[( ]/)[0].trim();
                const _sd = this._subs[_sn];
                if (_sd) return _sd.endLine + 1;
            }
        }

        // Block-IF skipping: if we're inside a skipped branch, only
        // pass through ELSEIF, ELSE, END IF, and nested IF (for depth).
        if (this._if_stack.length > 0 && this._if_stack[this._if_stack.length-1].skipping) {
            const uLine = a.trim().toUpperCase();
            const passThrough = uLine.startsWith('ELSEIF') || uLine.startsWith('ELSE IF') ||
                                uLine.startsWith('ELSE')   || uLine.startsWith('END IF') ||
                                uLine.startsWith('ENDIF')  || uLine.startsWith('IF');
            if (!passThrough) return CMD_OK;
        }

        // SELECT CASE skipping: skip non-matching CASE bodies.
        if (this._select_stack.length > 0 && this._select_stack[this._select_stack.length-1].skipping) {
            const uLine2 = a.trim().toUpperCase();
            const passThrough2 = uLine2.startsWith('CASE') || uLine2.startsWith('SWITCH') ||
                                 uLine2.startsWith('END SWITCH') || uLine2.startsWith('ENDSWITCH') ||
                                 uLine2.startsWith('DEFAULT');
            if (!passThrough2) return CMD_OK;
        }

        // Find the first ':' not inside quotes — statement separator.
        let iSepPos = -1;
        let inQuote = false;
        for (let ip = 0; ip < a.length; ip++) {
            if (a[ip] === '"') { inQuote = !inQuote; continue; }
            if (!inQuote && a[ip] === ':') { iSepPos = ip; break; }
        }

        // Pure label definition e.g. "MainLoop:" — the colon is the LAST char.
        // Skip silently so execution falls through to the next line.
        // Exclude SWITCH keywords that end with colon (DEFAULT:, CASE x:).
        const _trimA = a.trim().toUpperCase();
        const _isSwitchKeyword = _trimA === 'DEFAULT:' || _trimA.startsWith('CASE ');
        if (!_isSwitchKeyword && iSepPos === a.trim().length - 1 && /^[A-Za-z][A-Za-z0-9.]{0,39}:$/.test(a.trim())) {
            return CMD_OK;
        }

        let sRemainingLine = null;
        let iMore = 0;

        // Determine the first token (before the first space).
        let spacePos = a.indexOf(' ');
        const firstToken = spacePos > 0 ? a.substring(0, spacePos) : a;

        // Some commands own everything that follows (even colons).
        const isOwner = ['SAVE', 'RUN', 'LOAD', 'REM', 'IF'].includes(firstToken.toUpperCase());

        if (iSepPos > 0 && !isOwner) {
            const lineNo = Number(firstToken);
            if (!(firstToken === '0' || lineNo > 0)) {
                sRemainingLine = a.substring(iSepPos + 1);
                a = a.substring(0, iSepPos);
                iMore = 1;
            }
        }

        // Re-derive first token after truncating at colon.
        spacePos = a.indexOf(' ');
        const sLineOrCommand    = spacePos > 0 ? a.substring(0, spacePos) : a;
        const sCommandParameters = spacePos > 0 ? a.substring(spacePos + 1) : '';

        const lineNo = Number(sLineOrCommand);
        const isLineNumber = (sLineOrCommand === '0' || lineNo > 0);

        let iRetVal = -1;

        if (isLineNumber) {
            // Store or delete a BASIC line.
            // A line with only spaces (e.g. "100 ") stores as a blank line — 
            // useful for adding breathing room to a program listing.
            // A bare line number with nothing after (e.g. "100") deletes the line.
            const rest = a.substring(sLineOrCommand.length + 1);
            const hasContent = a.length > sLineOrCommand.length; // anything after line number
            if (hasContent) {
                this.lines[lineNo] = rest.trimEnd(); // store blank or content
                if (this._lineCache) this._lineCache[lineNo] = null;
                this.line_assigned(lineNo);
            } else {
                this.lines[lineNo] = '';
                if (this._lineCache) this._lineCache[lineNo] = null;
                this.line_unassigned(lineNo);
            }
            iMore = 0;
        } else {
            let iReady = this.parseCode(this.trim(a));

            if (iReady >= 0) {
                return iReady;
            }

            switch (iReady) {
                case CMD_END:     return -2;
                case CMD_OK:      iReady = 1; break;
                case CMD_ESYNTAX:
                    this.appendLine(this.error_syntax + (this.running ? ' ' + this.at + ' ' + this.run_line : ''), 1);
                    return -2;
                case CMD_EDATA:
                    this.appendLine(this.error_data + (this.running ? ' ' + this.at + ' ' + this.run_line : ''), 1);
                    return -2;
                default:          iReady = 1; break;
            }

            if (!noOutput && iMore === 0 && iReady === 1 && !this.running && !this.want_input && !this.want_password_line_mode && !this.want_text_line_mode) {
                this.just_stopped = 0;
                this.appendLine(this.prompt, 0);
                if (!this.cursor_timer) {
                    this.cursor_timer = setTimeout(() => this.blink(), this.cursor_delay);
                }
            }
        }

        if (iMore && sRemainingLine && sRemainingLine.trim() !== '') {
            this.line_remaining  = this.trim(sRemainingLine);
            this.processing_line = 1;
            const remResult = this.interpret(this.line_remaining);
            this.processing_line = 0;
            // Propagate jump targets (GOTO/GOSUB/RETURN) and CMD_END from
            // the remainder back to tick() so run_line is set correctly.
            // Without this, RETURN inside "A=1 : RETURN" discards the return address.
            if (remResult >= 0 || remResult === -2) {
                this.line_remaining = '';
                return remResult;
            }
        } else {
            this.line_remaining = '';
        }

        return iRetVal;
    }

    // -----------------------------------------------------------------------
    // print  –  evaluate and display a PRINT argument string.
    // -----------------------------------------------------------------------
    print(printLine, lprint) {
        let iCr     = 1;
        let iLastCr = 1;

        // Semicolon-separated tokens.
        const endsWithSemi = printLine.endsWith(';');
        const tokens = printLine.split(';');

        if (tokens.length > 1 || endsWithSemi) {
            iCr = 0;
        }
        if (endsWithSemi) iLastCr = 0;

        tokens.forEach((tok, idx) => {
            const nowCr = idx < tokens.length - 1 ? iCr : iLastCr;
            let sToken = '';

            if (tok.trim()) {
                const t = tok.trim();
                // Check for operators OUTSIDE of quoted strings.
                const hasOper = /[+\-*/%^]/.test(t.replace(/"[^"]*"/g, ''));
                if (hasOper) {
                    // Expression with operators — evaluate fully (handles "str"+var+"str")
                    sToken = String(this.evalCalc(t, ASS_ANY) ?? '');
                } else if (t.startsWith('"')) {
                    // Plain string literal — extract content between quotes
                    sToken = t.substring(1, t.lastIndexOf('"'));
                } else {
                    sToken = String(this.getValue(t, 0, t.length, ASS_ANY) ?? '');
                }
            }

            if (lprint) {
                this.lprinter.print(sToken, nowCr);
                window.focus();
            } else {
                this.appendLine(sToken, nowCr);
            }
        });
    }

    // -----------------------------------------------------------------------
    // DOM OUTPUT METHODS
    // -----------------------------------------------------------------------

    // _scrollToBottom  –  in idle/scrollable mode, snap to the bottom.
    // Uses requestAnimationFrame to debounce: no matter how many times it is
    // called in one event loop tick, the actual DOM scroll only happens once,
    // after the browser has finished laying out the new content.

    execute() {
        // Update kernel process state
        if (this.os) {
            const rec = this.os.activeProcess();
            if (rec) rec.state = 'running';
        }
        switch (this.status) {
            case 0:
                break;
            default:
            case -1:
                if (!document.getElementById(this.divId)) {
                    // No div yet — nothing to do.
                }
                this.setup();
                this.status = 0;
                if (this.initialize() && this.init_delay > 0) {
                    this.execute_timer = setTimeout(() => this.execute(), this.init_delay);
                    return;
                }
                // DOM is ready — safe to run startup command now
                if (this._initCmd) {
                    const cmd = this._initCmd;
                    this._initCmd = null;
                    setTimeout(() => this.interpret(cmd), 50);
                    return;
                }
                break;
        }

        if (!this.done) {
            const timeout = this.init_delay || (Math.random() * 400 + 100);
            this.execute_timer = setTimeout(() => this.execute(), timeout);
        }
    }

    start() {
        // Delegate to kernel — kernel calls process.execute()
        if (this.os) { this.os.start(); } else { this.execute(); }
    }

    kill() {
        this._cancelNextTick();
        clearTimeout(this.cursor_timer);
        this.cursor_timer  = 0;
        // Update kernel process state
        if (this.os) {
            const rec = this.os.activeProcess();
            if (rec) rec.state = 'stopped';
        }
    }

    pause() { this.kill(); }

    resume() {
        this.execute_timer = setTimeout(() => this.execute(), 500);
        this.blink();
        // Update kernel process state
        if (this.os) {
            const rec = this.os.activeProcess();
            if (rec) rec.state = 'running';
        }
    }

    zap() {
        this.kill();
        while (this.o.firstChild) this.o.removeChild(this.o.firstChild);
    }

    // Return this process's PID (assigned by kernel at registration)
    get pid() { return this._pid; }

    // Return the kernel process table (for MEM/INFO display)
    get processTable() { return this.os ? this.os.listProcesses() : []; }

    // -----------------------------------------------------------------------
    // HELP






    // -----------------------------------------------------------------------
    // COMPILER METHODS (zapVariables → checkCondition)
    // Provided at runtime by compiler.js via prototype mixin.
    // -----------------------------------------------------------------------


    // -----------------------------------------------------------------------
    // FLOW CONTROL HELPERS
    // -----------------------------------------------------------------------



    // -----------------------------------------------------------------------
    // RUNTIME METHODS (execution engine)
    // -----------------------------------------------------------------------

    _gotoLine(lineNo) {
        if (!this.running) {
            this.removeCursor();
            clearTimeout(this.cursor_timer);
            this.cursor_timer = 0;
            this.running = 1;
        }
        this.run_line         = lineNo;
        this.last_key_pressed = 0;
        this._keysHeld = {};   // keyCode → true while key held   // flush INKEY buffer
        if (this.running) this.tick(1);
        return CMD_OK;
    }

        run() {
        this.char_index  = 0;

        // ── Per-program process isolation ──────────────────────────────────
        // Allocate a fresh ProcessMemory for this program run.
        // The program lines were loaded into _mem by cmdLOAD — copy them over,
        // then swap to the new isolated memory. Shell memory (PID 1) is preserved.
        if (this.os && this._shellMem) {
            // If a previous program PID exists, unregister it
            if (this._programPid !== null) {
                this.os._processes.delete(this._programPid);
                this._programPid = null;
            }

            // Create fresh memory for the new program
            const progMem = new ProcessMemory();
            // Transfer the loaded program lines from current shell memory
            progMem.lines          = this._mem.lines;
            progMem.lines_assigned = this._mem.lines_assigned;

            // Register as a new kernel process
            const pid = this.os._nextPid++;
            const progName = this._lastLoadedName || 'program';
            this.os._processes.set(pid, {
                pid, process: this, memory: progMem, state: 'running', priority: 0,
                name: progName
            });
            this._programPid = pid;

            // Swap to program memory — all variable/flow state now isolated
            this.swapMemory(progMem);
        }

        this.zapVariables();
        this.data          = null;
        this.data_position = 0;
        this.data_count    = -1;
        this.for_level     = -1;
        this.last_key_pressed = 0;
        this._keysHeld = {};
        this.gosubs        = [];
        this.gosub_level   = -1;
        this._sub_stack    = [];
        this._in_sub       = false;
        this._shared_vars  = new Set();
        this._graphicsActive = false;
        this._func_result  = null;
        this._if_stack     = [];
        this._select_stack = [];
        this._while_stack  = [];
        this.line_remaining = '';
        this.if_line       = '';
        this.want_input    = 0;
        this.want_ai       = 0;
        this.want_auth     = 0;
        this.sleepy_time   = 0;
        this.run_delay     = 5;
        this.last_key_pressed = 0;
        this._keysHeld = {};
        this.quoted        = 0;
        this.line_typed    = '';
        this.cursor_pos    = 0;
        if (this._locateMode) this._screenCls();
        if (this._objAnimTimer) this._objCleanup();
        if (this.o) this.o.classList.remove('graphics-active');
        this._onProgramStop();     // reset colours to defaults
        this._scanSubs();
        this._scanData();
        this._scanLabels();
        this._buildLineCache();
        this._gotoLine(0);
    }

    // -----------------------------------------------------------------------
    // _buildLineCache — pre-compile each BASIC line into {entry, paramOffset}
    // so tick() can skip the tryLen/toUpperCase/substring loop each frame.
    // Called once at RUN time. Invalidated by NEW/LOAD/EDIT.
    // -----------------------------------------------------------------------
    _buildLineCache() {
        this._lineCache = new Array(MAX_LINES);
        const lines = this.lines;
        // Only iterate line numbers that are actually assigned — avoids scanning
        // 10,000 empty slots for small programs (the common case).
        const toProcess = this.lines_assigned.size > 0
            ? [...this.lines_assigned].sort((a, b) => a - b)
            : Array.from({ length: MAX_LINES }, (_, i) => i);
        for (const ln of toProcess) {
            const raw = lines[ln];
            if (!raw || raw === '') continue;
            const t = raw.trim();
            if (!t || t[0] === "'") continue;  // empty or comment

            const up3 = t.length >= 3 ? t.substring(0,3).toUpperCase() : '';
            const up4 = t.length >= 4 ? t.substring(0,4).toUpperCase() : '';

            // Skip lines that need full dynamic dispatch
            if (up3 === 'REM' || up3 === 'LET' || up3 === 'RUN' ||
                up4 === 'LOAD' || up4 === 'SAVE' || up4 === 'DATA' ||
                t.toUpperCase().startsWith('IF ') || t.toUpperCase().startsWith('IF\t') ||
                t.toUpperCase().startsWith('ON ') || t.indexOf(':') >= 0) {
                continue;  // use normal dispatch
            }

            // Try to find the command entry
            const sUpper = t.toUpperCase();
            let entry = null;
            for (let tl = Math.min(t.length, 24); tl >= 1; tl--) {
                if (tl < t.length) {
                    const ch = t[tl];
                    if (tl > 1 && ch !== ' ' && ch !== '(' && ch !== ',' && ch !== ':') continue;
                }
                const found = this._cmdMap.get(sUpper.substring(0, tl));
                if (found) { entry = found; break; }
            }
            if (entry) {
                this._lineCache[ln] = { entry, raw: t, paramStr: this.trim(t.substring(entry[0].length)) };
            }
            // Assignment lines (no keyword) - mark for fast path
            // Store metadata now, lazily parse expression tree on first execution
            else if (t.indexOf('=') > 0) {
                const eqPos = t.indexOf('=');
                // Skip compound assignments (+=, -=, *=, /=). The '=' here is part of
                // the compound op, not a plain assignment — splitting on it would create
                // a bogus varName ending in +/-/*//, breaking the assignment entirely.
                // Let these fall through to interpret()/parseAssign which handles them.
                const chBeforeEq = eqPos > 0 ? t[eqPos - 1] : '';
                if (chBeforeEq === '+' || chBeforeEq === '-' ||
                    chBeforeEq === '*' || chBeforeEq === '/') {
                    continue;
                }
                // Variables are case-sensitive — preserve original case in the cache.
                const varName = t.substring(0, eqPos).trim();
                const rhs = t.substring(eqPos + 1).trim();
                const rhsUp = rhs.toUpperCase();
                const isVolatile = rhsUp.includes('TIMER') || rhsUp.includes('INKEY') ||
                                   rhsUp.includes('SECONDS') || rhsUp.includes('RND') ||
                                   rhsUp.includes('MOUSE') || rhsUp.includes('KEYDOWN');
                const hasFunc = /[A-Z]\w*\s*\(/i.test(rhs);
                const isSimpleNum = !varName.endsWith('$') && varName.indexOf('(') < 0;
                const canCache = isSimpleNum && !isVolatile && !hasFunc;
                // exprNode starts null — parsed lazily on first tick execution
                this._lineCache[ln] = { assign: true, raw: t, varName, rhs, canCache, exprNode: null };
            }
        }
    }

    // -----------------------------------------------------------------------
    // tick  –  execute one BASIC statement.
    // FIX: bounds check added before the skip-empty-lines loop.
    // -----------------------------------------------------------------------
    tick(a) {
        if (this.want_keypress || this.want_input || this._glLoadPending || this._resizePending) return;

        // Check for pending ON COLLISION GOSUB event (set by the animation timer).
        if (this._collisionPending && this._onCollisionLine && this.running &&
            !this.want_input && this.line_remaining === '') {
            this._collisionPending = false;
            this._fireEventGosub(this._onCollisionLine);
        }

        let iStopped = 0;

        // Handle remaining statements on the current colon-separated line.
        if (!this.want_keypress && this.line_remaining !== '') {
            let sTemp = this.line_remaining;
            const colonPos = sTemp.indexOf(':');
            if (colonPos > 0) {
                this.line_remaining = sTemp.substring(colonPos + 1).trim();
                sTemp = sTemp.substring(0, colonPos);
            } else {
                this.line_remaining = '';
            }

            const iNewLine = this.interpret(sTemp);
            if (this.running) {
                if      (iNewLine === -2 || iNewLine === CMD_END) { this.running = 0; this.just_stopped = 1; }
                else if (iNewLine >= 0)   { this.run_line = iNewLine; }
            }

            if (this.line_remaining !== '') {
                // Schedule remaining colon-separated statements via setTimeout
                // rather than calling tick() directly — this lets the browser
                // repaint between statements and prevents canvas updates being
                // batched until the entire logical line finishes.
                if (this.running) {
                    this.execute_timer = 0;  // FIX: must clear before _scheduleNextTick
                    this._skipToNextLine();
                    this._scheduleNextTick();
                }
            } else if (this.running) {
                this.execute_timer = 0;  // FIX: must clear before _scheduleNextTick
                this._skipToNextLine();
                this._scheduleNextTick();
            }
            return;
        }

        // Process pending IF branch. Loop to handle nested IF THEN IF THEN ...
        // where the inner cmdIF sets if_line again after the outer's branch runs.
        while (this.if_line !== '') {
            const _ifLine = this.if_line;
            this.if_line = '';
            const _outerIfLine = this.run_line;
            const iNewLine = this.interpret(_ifLine);
            if (iNewLine === -2) {
                if (this.running) iStopped = 1;
                this.running = 0;
                this.just_stopped = iStopped;
                break;
            } else if (iNewLine >= 0) {
                // A jump (CALL/GOTO): interpret() only ran the first statement.
                // Find and queue any remaining colon-separated statements.
                let _rest = '', _inQ = false;
                for (let _ip = 0; _ip < _ifLine.length; _ip++) {
                    if (_ifLine[_ip] === '"') { _inQ = !_inQ; continue; }
                    if (!_inQ && _ifLine[_ip] === ':') {
                        _rest = _ifLine.substring(_ip + 1).trim();
                        break;
                    }
                }
                if (_rest && this.line_remaining === '') this.line_remaining = _rest;
                // cmdCALL set returnLine = this.run_line+1 at call time.
                // Ensure it returns to _outerIfLine+1 (the line after the IF).
                if (_rest && this._sub_stack.length > 0) {
                    this._sub_stack[this._sub_stack.length - 1].returnLine = _outerIfLine + 1;
                }
                this.run_line = iNewLine;
                break;  // a jump happened; don't keep draining
            }
        }

        if (this.running) {
            this.execute_timer = 0;
            // Batch: run multiple statements per setTimeout when DELAY 0.
            // This amortises the ~1ms setTimeout overhead across many lines.
            // Time-based batch: run statements for up to 48ms per tick.
            // Chrome flags tasks >50ms as long tasks, so 48ms is a safe ceiling.
            // Check deadline every 64 iterations to minimise performance.now() overhead.
            const _batchDeadline = this.run_delay === 0 ? (performance.now() + 48) : 0;
            for (let _b = 0; _b < 100000 && this.running && !iStopped; _b++) {
                if (_batchDeadline > 0 && (_b & 63) === 0 && performance.now() > _batchDeadline) break;
                // Check yield conditions BEFORE executing each statement.
                if (this.sleepy_time > 0 || this.want_input || this.want_ai || this.want_auth || this.want_keypress || this._glLoadPending || this._resizePending) break;
                if (this.line_remaining !== '') break;
                if (this.lines[this.run_line] !== '') {
                    if (this._trace) this.appendLine('[' + this.run_line + ']', 0);
                    // SELECT CASE skipping — must check BEFORE the line cache fast path,
                    // otherwise body lines (simple assignments) bypass interpret() and execute
                    // even when they should be skipped.
                    if (this._select_stack.length > 0 && this._select_stack[this._select_stack.length-1].skipping) {
                        const _rawLine = (this.lines[this.run_line] || '').trim().toUpperCase();
                        const _pass = _rawLine.startsWith('CASE') || _rawLine.startsWith('SWITCH') ||
                                      _rawLine.startsWith('END SWITCH') || _rawLine.startsWith('ENDSWITCH') ||
                                      _rawLine.startsWith('DEFAULT');
                        if (!_pass) {
                            this.run_line++;
                            this._skipToNextLine();
                            continue;
                        }
                    }
                    // Block-IF skipping — same guard for the fast path.
                    if (this._if_stack.length > 0 && this._if_stack[this._if_stack.length-1].skipping) {
                        const _rawLine = (this.lines[this.run_line] || '').trim().toUpperCase();
                        const _pass = _rawLine.startsWith('ELSEIF') || _rawLine.startsWith('ELSE IF') ||
                                      _rawLine.startsWith('ELSE')   || _rawLine.startsWith('END IF') ||
                                      _rawLine.startsWith('ENDIF')  || _rawLine.startsWith('IF');
                        if (!_pass) {
                            this.run_line++;
                            this._skipToNextLine();
                            continue;
                        }
                    }
                    // OPT-E: use pre-compiled line cache when available
                    const cached = this._lineCache && this._lineCache[this.run_line];
                    let iNewLine;
                    if (cached && !this._trace) {
                        try {
                            if (cached.assign) {
                                // Ultra-fast path: pre-parsed numeric assignment
                                if (cached.exprNode) {
                                    const val = this._evalExprTree(cached.exprNode, ASS_NUMBER);
                                    this.variables_numbers.set(cached.varName, Number(val));
                                    iNewLine = CMD_OK;
                                } else if (cached.canCache) {
                                    // First execution — lazily parse and store the tree
                                    cached.exprNode = this._parseExprTree(cached.rhs);
                                    const val = this._evalExprTree(cached.exprNode, ASS_NUMBER);
                                    this.variables_numbers.set(cached.varName, Number(val));
                                    iNewLine = CMD_OK;
                                } else {
                                    const err = this.parseAssign(cached.raw);
                                    if (err) this.appendLine(err, 1);
                                    iNewLine = CMD_OK;
                                }
                            } else {
                                const { entry, paramStr } = cached;
                                const selfHandling = entry[3];
                                const handler      = entry[2];
                                if (selfHandling) {
                                    iNewLine = handler(paramStr);
                                } else {
                                    const numParams = entry[1];
                                    if (numParams === 0) { iNewLine = handler(); }
                                    else {
                                        const sep = entry[4] ?? ',', isRaw = entry[5] ?? 0;
                                        iNewLine = handler(this.findParameters(paramStr, isRaw, sep));
                                    }
                                }
                            }
                        } catch(e) {
                            this.appendLine('JS ERROR at line '+this.run_line+': '+e.message,1);
                            iNewLine = -2;
                        }
                    } else {
                        iNewLine = (() => { try { return this.interpret(this.lines[this.run_line]); } catch(e) { this.appendLine('JS ERROR at line '+this.run_line+': '+e.message,1); return -2; } })();
                    }
                    if      (iNewLine === -2 || iNewLine === CMD_END) { this.running = 0; iStopped = 1; this.just_stopped = 1; }
                    else if (iNewLine >= 0)   { this.run_line = iNewLine; }
                    else                      { this.run_line++; }
                    // Process IF branch immediately within batch.
                    // Save the line number of the IF statement itself (before increment)
                    // so that CALL can set the correct returnLine.
                    const _ifSourceLine = this.run_line - 1;
                    while (this.if_line !== '') {
                        const _savedIfLine = this.if_line;
                        this.if_line = '';
                        this._inBatch = true;  // prevent cmdGOTO from calling tick()
                        const _stackLenBefore = this._sub_stack.length;
                        const ifNewLine = this.interpret(_savedIfLine);
                        this._inBatch = false;
                        if      (ifNewLine === -2 || ifNewLine === CMD_END) { this.running = 0; iStopped = 1; this.just_stopped = 1; }
                        else if (ifNewLine >= 0) {
                            // Jump (CALL/GOTO): queue any remaining colon statements
                            // so they run after the jump completes.
                            let _rest = '', _inQ2 = false;
                            for (let _ip2 = 0; _ip2 < _savedIfLine.length; _ip2++) {
                                if (_savedIfLine[_ip2] === '"') { _inQ2 = !_inQ2; continue; }
                                if (!_inQ2 && _savedIfLine[_ip2] === ':') {
                                    _rest = _savedIfLine.substring(_ip2 + 1).trim();
                                    break;
                                }
                            }
                            // Override returnLine only when CALL pushed a NEW frame.
                            // For GOTO inside a SUB body, leaving the SUB's own frame
                            // alone preserves its correct return-to-caller line.
                            // The legacy `_rest && stack>0` branch is kept for
                            // backward-compat with programs that relied on the
                            // colon-tail-after-GOTO queueing (rare but existed).
                            const _callPushedFrame = this._sub_stack.length > _stackLenBefore;
                            if (_callPushedFrame) {
                                const _f = this._sub_stack[this._sub_stack.length - 1];
                                _f._afterReturn = _rest;
                                _f.returnLine = _ifSourceLine + 1;
                            } else if (_rest && this._sub_stack.length > 0) {
                                const _f = this._sub_stack[this._sub_stack.length - 1];
                                _f._afterReturn = _rest;
                                _f.returnLine = _ifSourceLine + 1;
                            }
                            this.run_line = ifNewLine;
                            break;
                        }
                        // if_line result set line_remaining - break to process it
                        else if (this.line_remaining !== '') { break; }
                    }
                }
                if (this.run_line >= MAX_LINES) { iStopped = 1; break; }
                this._skipToNextLine();
            }
            if (!iStopped && this.running) {
                this._skipToNextLine();
                this._scheduleNextTick();
            }
        } else {
            if (a === 0) this.appendLine(this.prompt, 0);
            this.blink();
        }

        if (iStopped) {
            this.running  = 0;
            this.run_line = -1;
            this._onProgramStop();
            this.appendLine(this.prompt, 0);
            this.blink();
        }
    }

    // Skip over empty program lines; never run past MAX_LINES.





} // class Interpreter


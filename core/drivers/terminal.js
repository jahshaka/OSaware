'use strict';

// ---------------------------------------------------------------------------
// TerminalDriver  (core/drivers/terminal.js)
//
// Extracted from kernel.js — Step 5 of V7 architecture refactor.
//
// Owns ALL terminal I/O: the HTML output div, canvas, cursor, keyboard
// input handling, screen-buffer mode (LOCATE), colour palette, reset,
// DOM setup, and the initialise/splash sequence.
//
// The driver receives a host reference (Interpreter) for the small set of
// cross-cutting calls: running, tick(), interpret(), _fireEventGosub() etc.
// Everything else — colours, cursor state, cols/rows, the DOM — lives here.
// ---------------------------------------------------------------------------

class TerminalDriver {

    constructor(host, id, width, height, type, initText, cols, rows, initCmd, fontSize, canvasCtx) {
        this._host = host;

        // ── Identity ───────────────────────────────────────────────────────
        this.id     = id;
        this.divId  = id + '_div';
        this.width  = width;
        this.height = height;
        this.type   = type;
        this.font_size = fontSize || 0;

        // ── DOM references (set in setup()) ───────────────────────────────
        this.o       = null;   // output div
        this.canvas  = null;
        this.context = canvasCtx || null;

        // ── Colour palette ────────────────────────────────────────────────
        this.colours = [
            'white', '#a398ff', 'red', '#00FF00', 'yellow',
            '#FF00FF', '#00FFFF', '#DDDDDD',
            '#4d45d8', '#990000', '#006600', '#FFFF99',
            '#990066', '#009999', '#FFCC00',
            'gray', 'black',
        ];
        this.colour_fg_cursor = 3;
        this.colour_bg_cursor = null;
        this.colour_bg        = 16;

        // ── Cursor & display state ────────────────────────────────────────
        this.cursor         = '_';
        this.current_cursor = '_';
        this.cursor_delay   = 250;
        this.cursor_timer   = 0;
        this.current_line   = 0;
        this.char_index     = -1;
        this.line_index     = 0;
        this.cols           = cols  || 67;
        this.rows           = rows  || 17;
        this.init_cols      = cols;
        this.init_rows      = rows;

        // ── Prompt / error strings ────────────────────────────────────────
        this.prompt                = 'OK\n';
        this.error_type            = 'TYPE MISMATCH';
        this.error_file            = 'FILE NOT FOUND';
        this.error_syntax          = 'SYNTAX ERROR';
        this.error_break           = 'BREAK';
        this.error_data            = 'OUT OF DATA';
        this.error_save            = 'SAVE FAILED';
        this.error_division_by_zero = 'DIVISION BY ZERO';
        this.at                    = 'AT';
        this.current_error         = 0;
        this.prefix                = '';

        // ── Init text (splash for c64/dos themes) ─────────────────────────
        this.init_text  = null;
        this.init       = 0;
        this.init_delay = 0;

        // ── Screen buffer (LOCATE mode) ───────────────────────────────────
        this._locateMode = false;
        this._screenBuf  = null;
        this._screenEl   = null;
        this._curRow     = 0;
        this._curCol     = 0;

        // ── Scrolling ─────────────────────────────────────────────────────
        this._scrollable    = false;
        this._scrollPending = false;
        this._measureDiv    = null;

        // ── Keyboard / input state ────────────────────────────────────────
        this.line_typed      = '';
        this.cursor_pos      = 0;
        this.quoted          = 0;
        this.want_password   = 0;
        this.want_input      = 0;
        this.input_var_type  = 0;
        this.want_keypress   = 0;
        this.input_var       = '';
        this.last_key_pressed = 0;
        this._keysHeld       = {};
        this._inputGrace     = 0;

        // Password line mode — when set, the ENTIRE current line is a
        // password (every character echoes as '*'), and on Enter the
        // captured string is passed to _passwordCallback instead of
        // being interpreted as a BASIC command. Used by LOGIN "alice"
        // and REGISTER "alice" short forms where the password is
        // requested on a dedicated prompt line.
        //
        // Distinct from want_password, which is set by SAVE WEB: to
        // obfuscate only the THIRD token of an otherwise normal command.
        // want_password_line_mode applies to the whole line.
        this.want_password_line_mode = 0;
        this._passwordCallback = null;

        // want_text_line_mode is the unmasked sibling of password line mode.
        // Used by commands that need a one-shot text prompt (e.g.
        // DELETEACCOUNT asking for username confirmation). The captured
        // line is delivered to a callback exactly like promptPassword,
        // but characters are echoed normally (no '*' masking).
        this.want_text_line_mode = 0;
        this._textCallback = null;

        // ── History ───────────────────────────────────────────────────────
        this.history      = new History();
        this.history_line = 0;

        // ── Line printer ──────────────────────────────────────────────────
        this.lprinter = new LinePrinter();

        // ── Mouse state ───────────────────────────────────────────────────
        this._mouse = {
            x: 0, y: 0, btn: 0,
            pressX: 0, pressY: 0, releaseX: 0, releaseY: 0,
            lastClickTime: 0, pending: 0,
        };
        this._mouseEnabled = 0;
        this._mouseGosub   = -1;

        // ── Graphics activation flag (shared with GFX driver) ────────────
        this._graphicsActive = false;
        // _gfx, _spr, _glCanvas are read from drivers via host getters below

        // ── AI key ───────────────────────────────────────────────────────
        this.ai_key = '';

        // ── Bound handlers ────────────────────────────────────────────────
        this._boundKeyHandler = (e) => this.keyHandler(e);
    }

    // ── Host forwarders (runtime cross-coupling) ───────────────────────────
    get running()          { return this._host.running; }
    set running(v)         { this._host.running = v; }
    get run_line()         { return this._host.run_line; }
    set run_line(v)        { this._host.run_line = v; }
    get just_stopped()     { return this._host.just_stopped; }
    set just_stopped(v)    { this._host.just_stopped = v; }
    get execute_timer()    { return this._host.execute_timer; }
    set execute_timer(v)   { this._host.execute_timer = v; }
    get _rng_seed()        { return this._host._rng_seed; }
    set _rng_seed(v)       { this._host._rng_seed = v; }
    interpret(line)        { return this._host.interpret(line); }
    tick(a)                { return this._host.tick(a); }
    assign_(t, n, v)       { return this._host.assign_(t, n, v); }
    _fireEventGosub(l)     { return this._host._fireEventGosub(l); }
    _objCleanup()          { return this._host._objCleanup(); }
    _gfxClearImages()      { return this._host._gfxClearImages(); }
    _gfxFlush()            { return this._host._gfxFlush(); }
    _gfxColour(c)          { return this._host._gfxColour(c); }

    // ── Graphics driver references — read live from drivers via host ──
    get _gfx()             { return this._host._gfxDrv._gfx; }
    get _glCanvas()        { return this._host._glDrv._glCanvas; }
    get _spr()             { return this._host.__spr; }
    set _spr(v)            { this._host.__spr = v; }

    cmdLOCATE(params) {
        if (!params) return CMD_ESYNTAX;
        const row = params[0] != null ? Math.floor(Number(params[0])) : 0;
        const col = params[1] != null ? Math.floor(Number(params[1])) : 0;

        if (!this._locateMode) this._screenActivate();

        this._curRow = Math.max(0, Math.min(row, this.rows - 1));
        this._curCol = Math.max(0, Math.min(col, this.cols - 1));
        return CMD_OK;
    }

// _screenActivate — switch to fixed screen buffer mode.
    _screenActivate() {
        if (this._locateMode) return;
        this._locateMode = true;

        // Initialise buffer: rows x cols cells, each {ch, fg, bg}.
        this._screenBuf = [];
        for (let r = 0; r < this.rows; r++) {
            this._screenBuf[r] = [];
            for (let c = 0; c < this.cols; c++) {
                this._screenBuf[r][c] = { ch: ' ', fg: this.colour_fg_cursor, bg: null };
            }
        }

        // Create a PRE overlay appended directly to the terminal div (this.o).
        // Appending to this.o means font-family/size are correctly inherited.
        // position:absolute + top/left/right/bottom:0 makes it cover the div exactly.
        if (!this._screenEl) {
            const pre = document.createElement('pre');
            pre.id = this.divId + '_screen';
            const termFont   = this.o ? this.o.style.fontFamily || 'Lucida Console, Courier New' : 'Lucida Console, Courier New';
            const termSize   = this.o ? this.o.style.fontSize   || (this.font_size + 'px') : '14px';
            pre.style.cssText = [
                'position:absolute', 'top:0', 'left:0', 'right:0', 'bottom:0',
                'margin:0', 'padding:0', 'overflow:hidden',
                `font-family:${termFont}`,
                `font-size:${termSize}`,
                'line-height:1.2em',
                'background:transparent',
                'pointer-events:none',
                'white-space:pre',
                'z-index:4',
            ].join(';');
            this._screenEl = pre;
        }
        // Update background — transparent when canvas is active so maze shows through.
        this._screenEl.style.background = this._graphicsActive ? 'transparent' : (this.colours[this.colour_bg] || '#000000');

        // Ensure the terminal div is position:relative so absolute child aligns.
        if (this.o) {
            if (getComputedStyle(this.o).position === 'static') {
                this.o.style.position = 'relative';
            }
            this.o.appendChild(this._screenEl);
            // Show the div but hide its own text content (the PRE replaces it visually).
            this.o.style.visibility = 'visible';
        }
        this._screenRender();
    }

// _screenWrite — write a string at current cursor position, advancing col.
    _screenWrite(text) {
        for (const ch of String(text)) {
            if (ch === '\n') {
                this._curRow++;
                this._curCol = 0;
            } else {
                if (this._curRow < this.rows && this._curCol < this.cols) {
                    this._screenBuf[this._curRow][this._curCol] = {
                        ch,
                        fg: this.colour_fg_cursor,
                        bg: this.colour_bg_cursor,
                    };
                }
                this._curCol++;
                if (this._curCol >= this.cols) {
                    this._curCol = 0;
                    this._curRow++;
                }
            }
        }
        this._screenRender();
    }

// _screenRender — redraw the PRE element from the buffer.
    _screenRender() {
        if (!this._screenEl || !this._screenBuf) return;
        // Build HTML: one <span> per run of same colour, rows separated by \n.
        let html = '';
        for (let r = 0; r < this.rows; r++) {
            if (r > 0) html += '\n';
            let runFg = null, runBg = null, runText = '';
            const flush = () => {
                if (!runText) return;
                const style = `color:${runFg || '#00FF00'}${runBg ? ';background:' + runBg : ''}`;
                html += `<span style="${style}">${runText.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`;
                runText = '';
            };
            const bufRow = this._screenBuf[r] || [];
            for (let c = 0; c < this.cols; c++) {
                const cell = bufRow[c];
                const fg = (cell && this.colours[cell.fg]) || '#00FF00';
                const bg = (cell && cell.bg != null) ? this.colours[cell.bg] : null;
                if (fg !== runFg || bg !== runBg) { flush(); runFg = fg; runBg = bg; }
                runText += (cell ? cell.ch : ' ');
            }
            flush();
        }
        this._screenEl.innerHTML = html;
    }

// _screenCls — clear the screen buffer (called by CLS).
    _screenCls() {
        if (!this._locateMode) return;
        // Remove the overlay and restore scroll terminal.
        if (this._screenEl && this._screenEl.parentElement) {
            this._screenEl.parentElement.removeChild(this._screenEl);
        }
        this._screenEl  = null;
        this._screenBuf = null;
        this._locateMode = false;
        if (this.o) this.o.style.visibility = 'visible';
    }
    _scrollToBottom() {
        if (!this._scrollable || !this.o) return;
        if (this._scrollPending) return;   // already queued for this frame
        this._scrollPending = true;
        requestAnimationFrame(() => {
            this._scrollPending = false;
            if (this._scrollable && this.o) {
                // Scroll the div itself (wrapper has overflow:hidden, div has overflow:auto)
                const lineH = (this.font_size || 16) * 1.3;
                const dist  = this.o.scrollHeight - this.o.scrollTop - this.o.clientHeight;
                if (dist < lineH * 2) {
                    this.o.scrollTop = this.o.scrollHeight;
                }
            }
        });
    }

// _forceScrollToBottom  –  unconditional scroll, used on Enter / program end.
    _forceScrollToBottom() {
        if (!this._scrollable || !this.o) return;
        requestAnimationFrame(() => {
            if (this.o) this.o.scrollTop = this.o.scrollHeight;
        });
    }

// appendLine  –  write text to the terminal div.
// Text is split on embedded \n so each segment gets its own span with a
// <br> between segments.  The `newline` flag adds one final <br> after all
// segments.  This avoids the double-newline bug where both the embedded \n
// scan AND the newline flag each inserted a <br> for the same line ending.
    appendLine(text, newline) {
        // In screen buffer (LOCATE) mode, write into the buffer instead of the DOM.
        if (this._locateMode) {
            this._screenWrite(String(text));
            if (newline === 1) { this._curRow++; this._curCol = 0; this._screenRender(); }
            return;
        }

        const wasRunning = this.running;

        const segments = String(text).split('\n');
        segments.forEach((seg, idx) => {
            if (seg.length > 0) {
                const span = document.createElement('span');
                span.style.color = this.colours[this.colour_fg_cursor];
                if (this.colour_bg_cursor != null) {
                    span.style.background = this.colours[this.colour_bg_cursor];
                }
                span.textContent = seg.replace(/ /g, '\u00A0');
                this.o.appendChild(span);
                this.increaseColBy(seg.length);
            }
            // Insert a <br> after every segment except the last one
            // (the last segment's line break, if any, comes from the newline flag).
            if (idx < segments.length - 1) {
                this.increaseLine();
                this.o.appendChild(document.createElement('br'));
            }
        });

        if (newline === 1) {
            this.increaseLine();
            this.o.appendChild(document.createElement('br'));
        }

        if (wasRunning && !this.running) return;
        this._scrollToBottom();
    }

    appendCharacter(ch) {
        if (this._locateMode) { this._screenWrite(ch); return; }
        if (ch === '\n') {
            this.increaseLine();
            this.o.appendChild(document.createElement('br'));
            this.char_index = -1;
            return;
        }
        const span = document.createElement('span');
        span.style.color = this.colours[this.colour_fg_cursor];
        if (this.colour_bg_cursor != null) span.style.background = this.colours[this.colour_bg_cursor];
        span.textContent = ch === ' ' ? '\u00A0' : ch;
        this.o.appendChild(span);
        this.increaseColBy(1);
        // Note: _scrollToBottom not called here — appendLine handles scrolling
        // for committed output. Calling it per-character caused bouncing.
    }

    increaseColBy(n) {
        this.char_index += n;
        if (this.char_index > this.cols + 1) {
            this.increaseLine();
            this.o.appendChild(document.createElement('br'));
        }
    }

    increaseLine() {
        if (this._scrollable) {
            // Idle / scrollable mode — let content grow freely so the user
            // can scroll up. Never strip nodes.
            this.current_line++;
            this.char_index = 0;
            return;
        }
        // Running mode — trigger scroll one row before the hard limit so the
        // incoming line always has a full visible slot.
        if (this.current_line >= this.rows - 1) {
            while (this.o.firstChild) {
                const removed = this.o.firstChild;
                this.o.removeChild(removed);
                if (removed.nodeName === 'BR') break;
            }
        } else {
            this.current_line++;
        }
        this.char_index = 0;
    }

// -----------------------------------------------------------------------
// CURSOR MANAGEMENT
// -----------------------------------------------------------------------

    appendCursor() {
        // Remove existing cursor first to avoid duplicates.
        this.removeCursor();
        const z  = document.createElement('b');
        z.style.color      = this.colours[this.colour_fg_cursor] || '#00AA00';
        z.style.background = this.colours[this.colour_bg] || '#000000';
        z.id  = this.divId + '_cursor';
        z.textContent = this.cursor || '█';  // solid block character
        this.o.appendChild(z);
        // CSS animation handles blinking — no JS timer needed per-blink.
    }

    removeCursor() {
        const z = document.getElementById(this.divId + '_cursor');
        if (z && this.o) { this.o.removeChild(z); return true; }
        return false;
    }

    blink() {
        // CSS handles the blink animation — we just need to ensure the cursor
        // element is in the DOM at the right position.  No more JS toggling
        // visibility which caused DOM reflow and grey flickering on macOS.
        clearTimeout(this.cursor_timer);
        this.cursor_timer = 0;

        if (this.want_input && this.cursor_pos < this.line_typed.length) {
            this._redrawInputLine();
        } else {
            // Only append cursor if not already present.
            if (!document.getElementById(this.divId + '_cursor')) {
                this.appendCursor();
            }
        }
        // Keep a heartbeat so blink() is re-called when state changes
        // (e.g. after input is submitted and prompt is shown again).
        if (!this.cursor_timer) {
            this.cursor_timer = setTimeout(() => this.blink(), 1000);
        }
    }

// -----------------------------------------------------------------------
// CHARACTER EDITING
// -----------------------------------------------------------------------

    removeCharacter() {
        this.char_index = Math.max(-1, this.char_index - 1);
        // Walk backwards through child nodes to remove the last SPAN or BR.
        let child = this.o.lastChild;
        while (child && child.nodeName !== 'SPAN' && child.nodeName !== 'BR') {
            this.o.removeChild(child);
            child = this.o.lastChild;
        }
        if (child) this.o.removeChild(child);
    }

    delLine() {
        while (this.o.lastChild) {
            if (this.o.lastChild.nodeName === 'BR') break;
            this.o.removeChild(this.o.lastChild);
        }
    }

// -----------------------------------------------------------------------
// CLS
// -----------------------------------------------------------------------
    cls() {
        // If in LOCATE screen mode, tear it down first.
        if (this._locateMode) this._screenCls();
        while (this.o.firstChild) this.o.removeChild(this.o.firstChild);
        this.current_line = 0;
        this.char_index   = -1;
        if (this._gfx) {
            // Remove any image quads, clear pixel buffer, hide canvas
            this._gfxClearImages();
            const bg = this._gfxColour(this.colour_bg);
            const buf = this._gfx.buf;
            for (let i = 0; i < buf.length; i += 4) {
                buf[i] = bg[0]; buf[i+1] = bg[1]; buf[i+2] = bg[2]; buf[i+3] = 255;
            }
            this._gfx.dirty = true;
            this._gfxFlush();
            this._gfx.canvas.style.display = 'none';
        } else if (this.context) {
            this.context.fillStyle = this.colours[this.colour_bg] || '#000000';
            this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
        // Remove graphics-active so terminal background is opaque
        if (this.o) this.o.classList.remove('graphics-active');
        this._graphicsActive = false;
    }

// -----------------------------------------------------------------------
// _onProgramStop  –  called whenever a running program ends (naturally,
// via END, or via Ctrl+C).  Resets foreground colour to the theme default
// so the cursor is always visible regardless of what COLOUR the program
// last set.
// Also sets a short input grace period so the keypress that triggered RUN
// (e.g. pressing Enter on "RUN MENU") is not consumed by the first INPUT
// in the newly-started program.
// -----------------------------------------------------------------------
    _onProgramStop() {
        this.colour_fg_cursor = 3;
        this.colour_bg_cursor = null;
        this._inputGrace = Date.now() + 120;
        if (this._locateMode) this._screenCls();
        this._objCleanup();  // stop animation, erase all objects

        // Hide all WebGL overlay canvases when program ends
        if (this._glCanvas) this._glCanvas.style.display = 'none';

        // Hide GL.FPS / GL.RFPS overlays — no floating counter at the OK prompt
        if (this._host && this._host._glDrv && this._host._glDrv._hideFpsOverlays) {
            this._host._glDrv._hideFpsOverlays();
        }

        // Hide and clear the 2D gfx canvas so terminal text is visible again
        if (this._gfx) {
            this._gfxClearImages();
            // Clear CPU buffer to fully transparent first
            this._gfx.buf.fill(0);
            this._gfx.dirty = true;
            // Upload transparent pixels to GPU BEFORE hiding — otherwise stale
            // opaque pixels remain on the WebGL canvas and bleed into the next program
            this._gfxFlush();
            this._gfx.canvas.style.display = 'none';
        }

        // Hide the sprite canvas too
        if (this._spr) this._spr.canvas.style.display = 'none';

        // Remove graphics-active class so terminal background is opaque again
        if (this.o) this.o.classList.remove('graphics-active');
        this._graphicsActive = false;

        // Always restore terminal visibility — UI OFF may have hidden it,
        // and a crash/force-exit must never leave the terminal invisible.
        if (this.o) { this.o.style.opacity = '1'; this.o.style.pointerEvents = ''; }

        // Reset mouse trapping state
        this._mouseEnabled = 0;
        this._mouseGosub   = -1;
        if (this._mouse) { this._mouse.btn = 0; this._mouse.pending = 0; }
    }

// -----------------------------------------------------------------------
// KEY HANDLERS
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// _redrawInputLine  –  wipe the current input line from the DOM and
// redraw it with the cursor at cursor_pos.  Used by left/right arrow,
// backspace, and character insert so the terminal always reflects the
// true state of line_typed.
// -----------------------------------------------------------------------
// _markInputStart — invisible sentinel placed after INPUT prompt text.
// _redrawInputLine removes only nodes after it, keeping the prompt.
    _markInputStart() {
        const ex = document.getElementById(this.divId + '_input_start');
        if (ex && this.o.contains(ex)) this.o.removeChild(ex);
        const s = document.createElement('span');
        s.id = this.divId + '_input_start';
        s.style.display = 'none';
        this.o.appendChild(s);
    }

// _removeAfterSentinel — wipe typed text+cursor but leave prompt intact.
    _removeAfterSentinel() {
        const s = document.getElementById(this.divId + '_input_start');
        if (!s || !this.o.contains(s)) {
            this.removeCursor();
            this.delLine();
            return;
        }
        this.removeCursor();
        while (this.o.lastChild && this.o.lastChild !== s) {
            this.o.removeChild(this.o.lastChild);
        }
    }

    _redrawInputLine() {
        this._removeAfterSentinel();

        // When in password mode, draw '*' instead of the real characters.
        // line_typed still holds the real password (used by the Enter handler
        // to fire the callback), but the visible DOM only shows asterisks.
        const mask = (this.want_password || this.want_password_line_mode);
        const visible = mask
            ? '*'.repeat(this.line_typed.length)
            : this.line_typed;

        const before   = visible.substring(0, this.cursor_pos);
        const atCursor = visible.substring(this.cursor_pos, this.cursor_pos + 1);
        const after    = visible.substring(this.cursor_pos + 1);

        // Draw the part before the cursor.
        if (before.length > 0) {
            const span = document.createElement('span');
            span.style.color = this.colours[this.colour_fg_cursor];
            span.textContent = before.replace(/ /g, ' ');
            this.o.appendChild(span);
        }

        // Draw the character under the cursor with inverted colours so it
        // looks like a real block cursor sitting on that character.
        const cursorChar = atCursor || ' ';
        const cursorSpan = document.createElement('span');
        cursorSpan.id = this.divId + '_cursor';
        cursorSpan.style.color      = this.colours[this.colour_bg] || '#000';
        cursorSpan.style.background = this.colours[this.colour_fg_cursor];
        cursorSpan.textContent = cursorChar === ' ' ? ' ' : cursorChar;
        this.o.appendChild(cursorSpan);

        // Draw the part after the cursor.
        if (after.length > 0) {
            const span = document.createElement('span');
            span.style.color = this.colours[this.colour_fg_cursor];
            span.textContent = after.replace(/ /g, ' ');
            this.o.appendChild(span);
        }
        // _scrollToBottom not called here — see appendLine for scroll logic.
    }

    ignoreKeyHandler(e) {
        const kc = e.keyCode || e.which;
        // Track held keys for KEYDOWN() function (keyup clears in the onkeyup handler above)
        if (this._keysHeld) this._keysHeld[kc] = true;

        // Respect input grace period — suppress all keydown events except Ctrl+C.
        if (this._inputGrace > 0 && Date.now() < this._inputGrace) {
            if (!(e.ctrlKey && (kc === 67 || kc === 99 || kc === 90 || kc === 122))) return true;
        }

        // Ctrl+C or Ctrl+Z to break a running program.
        if (e.ctrlKey && (kc === 67 || kc === 99 || kc === 90 || kc === 122)) {
            if (this.running) {
                this.removeCursor();
                if (this._host && this._host._cancelNextTick) this._host._cancelNextTick();
                else clearTimeout(this.execute_timer);
                this.running        = 0;
                this.just_stopped   = 1;
                this.want_input     = 0;
                this._onProgramStop();
                this.tick(1);
                this.appendLine(`${this.error_break} ${this.at} ${this.run_line}\n`, 0);
                this.appendLine(this.prompt, 0);
                this.run_line = -1;
                this.removeCursor();
            }
            return false;
        }


        // Tab — insert 3 spaces at cursor position (indent).
        // Prevent default so the browser doesn't move focus off the terminal.
        if (kc === 9) {
            const spaces = '   ';
            this.line_typed = this.line_typed.slice(0, this.cursor_pos) +
                              spaces +
                              this.line_typed.slice(this.cursor_pos);
            this.cursor_pos += 3;
            this._redrawInputLine();
            return false;
        }

        // Backspace — delete char to the left of cursor_pos.
        if (kc === 8) {
            if (this.cursor_pos > 0) {
                const ch = this.line_typed[this.cursor_pos - 1];
                if (ch === '"') this.quoted = this.quoted ? 0 : 1;
                this.line_typed = this.line_typed.slice(0, this.cursor_pos - 1) +
                                  this.line_typed.slice(this.cursor_pos);
                this.cursor_pos--;
                this._redrawInputLine();
            }
            return false;
        }

        // ESC — cancel EDIT (or any input) without saving, restore prompt.
        // Also cancels password line mode (LOGIN/REGISTER short form).
        if (kc === 27) {
            if (this.want_input && this.input_var === '__EDIT__') {
                // Discard the edit — wipe the current line and show prompt.
                this.delLine();
                this.line_typed     = '';
                this.char_index     = 0;
                this.want_input     = 0;
                this.want_password  = 0;
                this.quoted         = 0;
                this.appendLine('', 1);
                this.appendLine(this.prompt, 0);
                this.blink();
            } else if (this.want_password_line_mode) {
                // Cancel password prompt, clear pending callback, restore prompt
                const cb = this._passwordCallback;
                this.want_password_line_mode = 0;
                this._passwordCallback = null;
                this.line_typed = '';
                this.char_index = 0;
                this.cursor_pos = 0;
                clearTimeout(this.cursor_timer);
                this.appendLine('', 1);
                this.appendLine('(cancelled)', 1);
                this.appendLine(this.prompt, 0);
                this.blink();
                // Call the callback with null to signal cancellation,
                // in case the shell wants to know (e.g. to print an error)
                if (typeof cb === 'function') {
                    try { cb(null); } catch (e) { /* swallow */ }
                }
            } else if (this.want_text_line_mode) {
                // Same as above but for the unmasked text line mode.
                const cb = this._textCallback;
                this.want_text_line_mode = 0;
                this._textCallback = null;
                this.line_typed = '';
                this.char_index = 0;
                this.cursor_pos = 0;
                clearTimeout(this.cursor_timer);
                this.appendLine('', 1);
                this.appendLine('(cancelled)', 1);
                this.appendLine(this.prompt, 0);
                this.blink();
                if (typeof cb === 'function') {
                    try { cb(null); } catch (e) { /* swallow */ }
                }
            }
            return false;
        }

        // Space — iOS Safari does not fire keypress for space, only keydown.
        // Only handle it here if we're likely on iOS (touch device) or if
        // the event has no keypress equivalent coming (check via e.key === ' ').
        // We detect iOS by checking if touch events are supported.
        if (kc === 32 && !e.ctrlKey && !e.metaKey) {
            const isIOS = /iP(ad|hone|od)/.test(navigator.userAgent) ||
                          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            if (isIOS) {
                this.keyHandler({ which: 32, charCode: 32, key: ' ',
                                  ctrlKey: false, metaKey: false,
                                  preventDefault: () => {}, stopPropagation: () => {} });
                return false;
            }
        }

        // For arrow keys use e.key (reliable across all browsers/servers).
        // Never use keyCode alone — on some servers Shift+9 fires keyCode=40
        // which collides with Arrow Down, wiping the input line.
        const ekey = e.key || '';

        // Arrow left — move cursor one position left within the line.
        if (ekey === 'ArrowLeft' || (kc === 37 && ekey === '')) {
            if (this.running && !this.want_input) { this.last_key_pressed = 37; return false; }
            if (this.cursor_pos > 0) {
                this.cursor_pos--;
                this._redrawInputLine();
            }
            return false;
        }

        // Arrow right — move cursor one position right within the line.
        if (ekey === 'ArrowRight' || (kc === 39 && ekey === '')) {
            if (this.running && !this.want_input) { this.last_key_pressed = 39; return false; }
            if (this.cursor_pos < this.line_typed.length) {
                this.cursor_pos++;
                this._redrawInputLine();
            }
            return false;
        }

        // Arrow up — history previous.
        if (ekey === 'ArrowUp' || (kc === 38 && ekey === '')) {
            if (this.running && !this.want_input) { this.last_key_pressed = 38; return false; }
            if (this.history_line > 0) {
                this.history_line--;
                this.delLine();
                this.line_typed = this.history.getLine(this.history_line) || '';
                this.cursor_pos = this.line_typed.length;
                this.appendLine(this.line_typed, 0);
            } else {
                this.delLine();
                this.line_typed = '';
                this.cursor_pos = 0;
            }
            return false;
        }

        // Arrow down — history next.
        if (ekey === 'ArrowDown' || (kc === 40 && ekey === '')) {
            if (this.running && !this.want_input) { this.last_key_pressed = 40; return false; }
            if (this.history_line < this.history.lines.length) {
                this.history_line++;
                this.delLine();
                this.line_typed = this.history.getLine(this.history_line) || '';
                this.cursor_pos = this.line_typed.length;
                this.appendLine(this.line_typed, 0);
            } else {
                this.delLine();
                this.line_typed = '';
                this.cursor_pos = 0;
            }
            return false;
        }

        // Block F5 (browser refresh).
        if (kc === 116) return false;
        return true;
    }

    keyHandler(e) {
        // keyHandler is registered on keypress events.
        // On keypress, e.keyCode is UNRELIABLE for printable characters — on many
        // browsers/servers it equals the charCode (e.g. keyCode=40 for '('),
        // colliding with arrow-key codes. Use e.key for non-printable identity
        // and e.which (the charCode) for printable character insertion.
        const which = e.which || e.charCode || 0;  // charCode of typed character
        const key   = e.key || '';                  // logical key name — reliable on keypress

        // Input grace period.
        if (this._inputGrace > 0 && Date.now() < this._inputGrace) {
            if (!(e.ctrlKey && (which === 99 || which === 3 || key === 'c' || key === 'C'))) return false;
        }

        if (this.running && !this.want_input && !this.want_keypress) {
            this.last_key_pressed = which || (e.keyCode || 0);
            this.line_typed = '';
            this.cursor_pos = 0;
            if (!(e.ctrlKey && (which === 99 || which === 3 || key === 'c' || key === 'C'))) return false;
        }

        if ((this.running === 0) || this.want_input) this.removeCursor();

        // GETKEY() waiting for a keypress.
        if (this.want_keypress) {
            this.want_keypress = 0;
            this.assign_(ASS_NUMBER, this.input_var, which || (e.keyCode || 0));
            this.tick(1);
            return false;
        }

        // Backspace: some browsers fire it on keypress as well as keydown.
        // Use e.key to avoid matching charCode 8 (which has no printable character
        // so this is safe, but e.key is unambiguous).
        if (key === 'Backspace') { this.ignoreKeyHandler(e); return false; }

        // Enter.
        if (key === 'Enter' || which === 13) {
            // Wipe the current input line from the DOM completely (removes all
            // spans including the inverted cursor block and any before/after spans
            // left from _redrawInputLine), then redraw the full line as plain text
            // followed by a <br>.  This prevents the character-under-cursor from
            // appearing visually deleted when Enter is pressed mid-line.
            this.removeCursor();
            const sLineTyped = this.line_typed;
            if (this.cursor_pos < sLineTyped.length) {
                this.cursor_pos = sLineTyped.length;
                this._redrawInputLine();
                this.removeCursor();
            }
            const iSentinel = document.getElementById(this.divId + '_input_start');
            if (iSentinel && this.o.contains(iSentinel)) this.o.removeChild(iSentinel);
            this.increaseLine();
            this.o.appendChild(document.createElement('br'));

            this.line_typed     = '';
            this.char_index     = 0;
            this.cursor_pos     = 0;
            this.want_password  = 0;

            // Password line mode — the whole captured line IS the password.
            // Hand it to the pending callback (set by the shell's LOGIN /
            // REGISTER short form), clear state, redraw prompt. Do NOT
            // add to history, do NOT interpret as BASIC.
            if (this.want_password_line_mode) {
                const capturedPassword = sLineTyped;
                const cb = this._passwordCallback;
                this.want_password_line_mode = 0;
                this._passwordCallback = null;
                clearTimeout(this.cursor_timer);
                if (typeof cb === 'function') {
                    try {
                        cb(capturedPassword);
                    } catch (e) {
                        this.appendLine('password handler error: ' + (e.message || e), 1);
                        this.appendLine(this.prompt, 0);
                        this.blink();
                    }
                } else {
                    // No callback registered — shouldn't happen, but don't lock up
                    this.appendLine(this.prompt, 0);
                    this.blink();
                }
                return false;
            }

            // Text line mode — same shape as password mode, but the line
            // was echoed normally (not masked). Used for DELETEACCOUNT
            // username confirmation and similar one-shot text prompts.
            if (this.want_text_line_mode) {
                const capturedText = sLineTyped;
                const cb = this._textCallback;
                this.want_text_line_mode = 0;
                this._textCallback = null;
                clearTimeout(this.cursor_timer);
                if (typeof cb === 'function') {
                    try {
                        cb(capturedText);
                    } catch (e) {
                        this.appendLine('text handler error: ' + (e.message || e), 1);
                        this.appendLine(this.prompt, 0);
                        this.blink();
                    }
                } else {
                    this.appendLine(this.prompt, 0);
                    this.blink();
                }
                return false;
            }

            if (this.want_input) {
                if (this.input_var === '__AIKEY__') {
                    this.ai_key        = sLineTyped;
                    this.want_input    = 0;
                    this.want_password = 0;
                    clearTimeout(this.cursor_timer);
                    this.appendLine('API key set.', 1);
                    this.tick(0);
                } else if (this.input_var === '__RANDOMIZE__') {
                    const seed = parseInt(sLineTyped, 10);
                    this._rng_seed = (!isNaN(seed) ? Math.abs(seed) & 0x7FFFFFFF : Date.now() & 0x7FFFFFFF) || 1;
                    this.want_input = 0;
                    clearTimeout(this.cursor_timer);
                    this.tick(0);
                } else if (this.input_var === '__EDIT__') {
                    this.want_input = 0;
                    clearTimeout(this.cursor_timer);
                    if (sLineTyped !== '') {
                        this.history_line = this.history.addLine(sLineTyped);
                        this.interpret(sLineTyped);
                    }
                    this.appendLine(this.prompt, 0);
                    this.blink();
                } else {
                    this.assign_(this.input_var_type, this.input_var, sLineTyped);
                    this.want_input = 0;
                    clearTimeout(this.cursor_timer);
                    this.tick(0);
                }
            } else if (sLineTyped !== '') {
                this.history_line = this.history.addLine(sLineTyped);
                this.interpret(sLineTyped);
            }
            return false;
        }

        // Double-quote toggle.
        if (which === 34) {
            this.quoted = this.quoted ? 0 : 1;
            this.line_typed = this.line_typed.slice(0, this.cursor_pos) +
                              '"' +
                              this.line_typed.slice(this.cursor_pos);
            this.cursor_pos++;
            this._redrawInputLine();
            return false;
        }

        // Ctrl+C or Ctrl+Z — break running program.
        if (e.ctrlKey && (which === 99 || which === 3 || which === 26 || key === 'c' || key === 'C' || key === 'z' || key === 'Z')) {
            this.ignoreKeyHandler(e);
            return false;
        }

        // Printable ASCII — insert at cursor_pos.
        if (which >= 32 && which <= 126) {
            const ch = String.fromCharCode(which);
            // Preserve case when: inside INPUT, inside quotes, editing a
            // program line (line_typed starts with a digit = line number),
            // typing the argument to DIR (folder names are case-sensitive),
            // in password line mode (passwords are case-sensitive —
            // "Hunter2" and "HUNTER2" are different passwords), OR in
            // text line mode (used by DELETEACCOUNT for username confirm,
            // which is case-sensitive).
            const lineStart = this.line_typed.trimStart();
            const isProgramLine = lineStart.length > 0 && lineStart[0] >= '0' && lineStart[0] <= '9';
            const isDirArg = this.line_typed.toUpperCase().startsWith('DIR ');
            const upper = (this.want_input || this.quoted || isProgramLine || isDirArg || this.want_password_line_mode || this.want_text_line_mode) ? ch : ch.toUpperCase();
            // Obfuscate display for either password mode:
            //   want_password           — third token of SAVE WEB:
            //   want_password_line_mode — entire line (LOGIN/REGISTER short form)
            // Text line mode is NOT masked — characters echo normally so
            // the user can see what they're typing (e.g. their username
            // when confirming an account deletion).
            const display = (this.want_password || this.want_password_line_mode) ? '*' : upper;

            this.line_typed = this.line_typed.slice(0, this.cursor_pos) +
                              upper +
                              this.line_typed.slice(this.cursor_pos);
            this.cursor_pos++;

            // Trigger password mode for SAVE WEB: command.
            if (which === 32 && this.line_typed.toUpperCase().startsWith('SAVE WEB:')) {
                const parts = this.line_typed.split(' ');
                if (parts.length === 3) this.want_password = 1;
            }

            this._redrawInputLine();
            return false;
        }

        // For any other key that didn't return early above, ensure cursor is shown.
        if (this.running === 0 || this.want_input) this.appendCursor();
        return false;
    }

// -----------------------------------------------------------------------
// DISPLAY / SETUP
// -----------------------------------------------------------------------

    initCanvas() {
        this.canvas  = document.getElementById('kanvas');
        if (this.canvas && !this.context) {
            this.context = this.canvas.getContext('2d');
        }
    }

    getTextWidth(txt) {
        if (!this._measureDiv) {
            this._measureDiv = document.createElement('div');
            this._measureDiv.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
        }
        this._measureDiv.textContent = txt === ' ' ? '\u00A0' : txt;
        document.body.appendChild(this._measureDiv);
        const w = this._measureDiv.offsetWidth;
        document.body.removeChild(this._measureDiv);
        return w;
    }

    getTextHeight(txt) {
        if (!this._measureDiv) this.getTextWidth(txt);
        this._measureDiv.textContent = txt === ' ' ? '\u00A0' : txt;
        document.body.appendChild(this._measureDiv);
        const h = this._measureDiv.offsetHeight;
        document.body.removeChild(this._measureDiv);
        return h;
    }

    reset_(rsize) {
        this.error_type   = 'TYPE MISMATCH';
        this.error_syntax = 'SYNTAX ERROR';
        this.error_break  = 'BREAK';
        this.at           = 'AT';

        const s = this.o ? this.o.style : {};

        switch (this.type) {
            case 'yo':
            case 'linux':
            case 'dos': {
                this.cursor           = '_';
                this.colour_fg_cursor = 3;
                this.colour_bg        = 16;   // 16 = black (0-indexed palette index 16)

                if (this.canvas) {
                    this.canvas.style.width  = this.width + 'px';
                    this.canvas.style.height = this.height + 'px';
                    this.canvas.width        = this.width;
                    this.canvas.height       = this.height;
                    this.canvas.style.background = 'rgb(0,0,0)';
                } else {
                    s.background = 'rgb(0,0,0)';
                }

                s.fontFamily = 'Lucida Console, Courier New';

                let size;
                if (this.font_size === 0) {
                    if (rsize) {
                        if (this._measureDiv) this._measureDiv.style.fontSize = rsize;
                        this.width  = this.cols * this.getTextWidth('M');
                        this.height = this.rows * this.getTextHeight('M');
                        if (this.canvas) {
                            this.canvas.style.width  = this.width + 'px';
                            this.canvas.style.height = this.height + 'px';
                        }
                        size = rsize;
                    } else {
                        size = Math.min(this.height / this.rows, this.width / this.cols);
                    }
                } else {
                    size = this.font_size;
                }
                s.fontSize = typeof size === 'number' ? size + 'px' : size;

                if (this.type === 'yo') {
                    this.prompt       = 'Hit me, bro!\n';
                    this.error_syntax = 'WTF?';
                    this.at           = 'on line';
                }
                break;
            }

            case 'c64': {
                this.cursor_delay     = 1000;
                this.prompt           = 'READY.\n';
                this.cursor           = '\u2588';
                this.colour_fg_cursor = 1;
                this.colour_bg        = 8;
                this.cols             = this.init_cols || 40;
                this.rows             = this.init_rows || 16;
                this.current_line     = 0;

                this.init_text = [
                    '     **** COMMODORE 64 BASIC V2 ****', 1,
                    ' 64K RAM SYSTEM  38911 BASIC BYTES FREE', 1,
                    'READY.',
                ];
                this.init_delay = 3500;

                s.width      = this.width + 'px';
                s.height     = this.height + 'px';
                s.background = '#4d45d8';
                s.color      = '#a398ff';
                s.fontFamily = 'Courier New';
                s.fontWeight = 'bold';
                s.border     = `${this.width / 10}px solid #a398ff`;

                const size = Math.min(this.height / this.rows, this.width / this.cols);
                s.fontSize  = size + 'px';
                this.cursor = '\u2588';
                break;
            }
        }
    }

    reset_colour() {
        switch (this.type) {
            case 'linux':
            case 'dos':
                this.colour_fg_cursor = 3;
                this.colour_bg_cursor = null;
                this.colour_bg        = 16;
                break;
            case 'c64':
                this.colour_fg_cursor = 1;
                this.colour_bg_cursor = null;
                this.colour_bg        = 8;
                break;
        }
        if (this.o) this.o.style.background = this.colours[this.colour_bg];
    }

    setup() {
        this.initCanvas();
        this.o = document.getElementById(this.divId);
        if (!this.o) return;

        document.onkeypress = (e) => this.keyHandler(e);
        document.onkeydown  = (e) => this.ignoreKeyHandler(e);
        document.onkeyup    = (e) => { if (this._keysHeld) delete this._keysHeld[e.keyCode || e.which]; };


        // Mouse events — registered on the terminal wrapper so coordinates
        // are relative to the canvas/terminal area.
        const mouseTarget = document.getElementById('terminal-wrapper') || document.body;
        mouseTarget.addEventListener('mousemove', (e) => {
            const rect = mouseTarget.getBoundingClientRect();
            this._mouse.x = Math.round(e.clientX - rect.left);
            this._mouse.y = Math.round(e.clientY - rect.top);
        }, { passive: true });
        mouseTarget.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // left button only
            const rect = mouseTarget.getBoundingClientRect();
            this._mouse.pressX = Math.round(e.clientX - rect.left);
            this._mouse.pressY = Math.round(e.clientY - rect.top);
            this._mouse.btn = -1; // held
            // When a program has the mouse trapped (MOUSE ON / ON MOUSE GOSUB),
            // suppress the browser's text-selection drag so click-dragging the
            // mouse-look doesn't paint a selection highlight over the terminal/HUD.
            if (this._mouseEnabled === 1) {
                e.preventDefault();
                const sel = window.getSelection && window.getSelection();
                if (sel && sel.removeAllRanges) { try { sel.removeAllRanges(); } catch (err) {} }
            }
            // Fire ON MOUSE GOSUB if enabled
            if (this._mouseEnabled === 1 && this._mouseGosub >= 0 && this.running) {
                this._fireEventGosub(this._mouseGosub);
            }
        }, { passive: false });
        mouseTarget.addEventListener('mouseup', (e) => {
            if (e.button !== 0) return;
            const rect = mouseTarget.getBoundingClientRect();
            this._mouse.releaseX = Math.round(e.clientX - rect.left);
            this._mouse.releaseY = Math.round(e.clientY - rect.top);
            // Detect single vs double click
            const now = Date.now();
            if (now - this._mouse.lastClickTime < 400) {
                this._mouse.pending = Math.min(this._mouse.pending + 1, 2);
            } else {
                this._mouse.pending = 1;
            }
            this._mouse.lastClickTime = now;
            this._mouse.btn = this._mouse.pending;
        }, { passive: true });
        mouseTarget.addEventListener('mouseleave', () => {
            if (this._mouse.btn === -1) this._mouse.btn = 0;
        }, { passive: true });

        // ── Touch → Mouse mapping (tablet & touchscreen support) ─────────
        // Converts touch events to the same _mouse state that BASIC reads,
        // so MOUSE ON / ON MOUSE GOSUB / MOUSE(n) all work on tablets.
        const _touchToMouse = (e, type) => {
            const touch = e.touches[0] || e.changedTouches[0];
            if (!touch) return;
            const rect = mouseTarget.getBoundingClientRect();
            const tx = Math.round(touch.clientX - rect.left);
            const ty = Math.round(touch.clientY - rect.top);

            if (type === 'start') {
                this._mouse.x       = tx;
                this._mouse.y       = ty;
                this._mouse.pressX  = tx;
                this._mouse.pressY  = ty;
                this._mouse.btn     = -1; // held
                if (this._mouseEnabled === 1 && this._mouseGosub >= 0 && this.running) {
                    this._fireEventGosub(this._mouseGosub);
                }
            } else if (type === 'move') {
                this._mouse.x = tx;
                this._mouse.y = ty;
            } else if (type === 'end') {
                this._mouse.releaseX = tx;
                this._mouse.releaseY = ty;
                const now = Date.now();
                if (now - this._mouse.lastClickTime < 400) {
                    this._mouse.pending = Math.min(this._mouse.pending + 1, 2);
                } else {
                    this._mouse.pending = 1;
                }
                this._mouse.lastClickTime = now;
                this._mouse.btn = this._mouse.pending;
            } else if (type === 'cancel') {
                this._mouse.btn = 0;
            }
        };

        // passive:false on touchstart/touchend so e.preventDefault() works
        // (prevents double-firing as browser also generates synthetic mouse events)
        mouseTarget.addEventListener('touchstart', (e) => {
            // Only prevent default if a BASIC program is actively using the mouse
            // — otherwise leave scroll behaviour intact for the terminal
            if (this._mouseEnabled === 1) e.preventDefault();
            _touchToMouse(e, 'start');
        }, { passive: false });

        mouseTarget.addEventListener('touchmove', (e) => {
            if (this._mouseEnabled === 1) e.preventDefault();
            _touchToMouse(e, 'move');
        }, { passive: false });

        mouseTarget.addEventListener('touchend', (e) => {
            _touchToMouse(e, 'end');
        }, { passive: true });

        mouseTarget.addEventListener('touchcancel', (e) => {
            _touchToMouse(e, 'cancel');
        }, { passive: true });

        switch (this.type) {
            case 'c64':
                this.reset_();
                {
                    const size = Math.min(this.height / this.rows, this.width / this.cols);
                    this.width = (size - 4) * this.cols;
                    this.o.style.width = this.width + 'px';
                }
                break;

            case 'dos':
                this.cursor_delay = 250;
                this.cursor       = '_';
                this.cols         = this.init_cols || 67;
                this.rows         = this.init_rows || 17;
                this.current_line = 0;
                this.prefix       = '';
                this.prompt       = 'OK\n';
                // Build number is read from the page URL's cache-busting param
                const _build = (() => {
                    try {
                        const m = document.querySelector('script[src*="kernel.js"]');
                        if (m) { const v = m.src.match(/v=(\d+)/); if (v) return v[1]; }
                    } catch(e) {}
                    return '1780435742';
                })();
                this.init_text    = [
                    'The Online Operating System', 1,
                    'Powered by OSaware v7 Alpha', 1,
                    '', 1,
                    'Geekprocessor [build ' + _build + ']', 1,
                    'Plenty bytes free', 1,
                    'OK', 1,
                ];
                this.reset_();
                this.o.style.width  = this.width + 'px';
                this.o.style.height = this.height + 'px';
                break;

            case 'linux':
                this.cursor_delay = 250;
                this.cursor       = '_';
                this.cols         = this.init_cols || 67;
                this.rows         = this.init_rows || 17;
                this.current_line = 0;
                this.init_text    = ['', 1, '', 0];
                this.o.style.width      = this.width + 'px';
                this.o.style.height     = this.height + 'px';
                this.o.style.background = 'rgb(0,0,0)';
                this.o.style.color      = 'rgb(255,255,255)';
                this.o.style.fontFamily = 'Lucida Console, Courier New';
                this.o.style.fontSize   = Math.min(this.height / this.rows, this.width / this.cols) + 'px';
                this.o.style.border     = '1px solid rgb(100,100,100)';
                break;

            default:
                this.o.style.width      = '640px';
                this.o.style.height     = '400px';
                this.o.style.background = 'rgb(0,0,0)';
                this.o.style.color      = 'rgb(255,255,255)';
                this.o.style.fontFamily = 'Lucida Console, Courier New';
                break;
        }

        this.current_cursor = this.cursor;
    }

    // promptPassword — enter password line mode with a prompt.
    // Shell calls this from cmdLOGIN/cmdREGISTER short form. The callback
    // fires when the user presses Enter (receives the password string) or
    // Escape (receives null).
    promptPassword(callback, promptText) {
        this.want_password_line_mode = 1;
        this._passwordCallback = callback;
        this.line_typed = '';
        this.char_index = 0;
        this.cursor_pos = 0;
        this.appendLine(promptText || 'Enter password: ', 0);
        // Mark where the prompt ends so _redrawInputLine (triggered on every
        // keystroke) only wipes the typed characters, not the prompt text.
        // Without this, the first keystroke's _removeAfterSentinel finds no
        // sentinel and calls delLine(), wiping "Enter password: " entirely.
        this._markInputStart();
        this.blink();
    }

    // promptText — enter text line mode with a prompt. Same as
    // promptPassword but characters are echoed normally (not masked).
    // Used for one-shot text confirmations like DELETEACCOUNT asking
    // for the username. Case is preserved, characters are visible,
    // ESC cancels (callback receives null), Enter submits (callback
    // receives the typed string).
    promptText(callback, promptText) {
        this.want_text_line_mode = 1;
        this._textCallback = callback;
        this.line_typed = '';
        this.char_index = 0;
        this.cursor_pos = 0;
        this.appendLine(promptText || 'Enter text: ', 0);
        this._markInputStart();
        this.blink();
    }

    initialize() {
        this.char_index = -1;
        if (this.init === 0 && this.init_text) {
            this.cls();
            // init_text is interleaved [string, crFlag, string, crFlag, ...]
            // Step by 2: even indices are text, odd indices are the CR flag (0 = no newline, 1 = newline).
            for (let i = 0; i < this.init_text.length; i += 2) {
                const text = this.init_text[i];
                if (typeof text === 'number') continue;
                const cr = (i + 1 < this.init_text.length)
                    ? (Number(this.init_text[i + 1]) === 0 ? 0 : 1)
                    : 1;
                this.appendLine(String(text), cr);
            }
            this.init = 1;
            this.appendCursor();
            this.blink();
            return 1;
        }
        return 0;
    }

}

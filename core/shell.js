'use strict';

import * as C from './constants.js';
import { AuthService }                              from './auth/auth_service.js';


// ---------------------------------------------------------------------------
// ShellRuntime  (core/shell.js)
//
// Extracted from kernel.js as part of the V7 architecture refactor (Step 4).
// Contains all shell/REPL commands — LIST, LOAD, SAVE, RUN, NEW, MERGE,
// RESET, FILES, DIR, MEM, LABELS, HELP, HISTORY, EDIT, CONT.
//
// The shell operates on *programs as files*. It has no knowledge of how
// BASIC lines are actually executed — that belongs to the interpreter.
//
// All state access goes through this._host (the Interpreter instance).
// ---------------------------------------------------------------------------

export class ShellRuntime {

    constructor(host) {
        this._host = host;
    }

    // ── Host state forwarders ──────────────────────────────────────────────
    get lines()              { return this._host.lines; }
    set lines(v)           { this._host.lines = v; }
    get lines_assigned()     { return this._host.lines_assigned; }
    set lines_assigned(v)           { this._host.lines_assigned = v; }
    get line_assigned()      { return this._host.line_assigned; }
    get running()            { return this._host.running; }
    set running(v)           { this._host.running = v; }
    get run_line()           { return this._host.run_line; }
    set run_line(v)          { this._host.run_line = v; }
    get execute_timer()      { return this._host.execute_timer; }
    set execute_timer(v)     { this._host.execute_timer = v; }
    get want_ai()            { return this._host.want_ai; }
    set want_ai(v)           { this._host.want_ai = v; }
    get _runAfterLoad()      { return this._host._runAfterLoad; }
    set _runAfterLoad(v)     { this._host._runAfterLoad = v; }
    get _trace()             { return this._host._trace; }
    set _trace(v)            { this._host._trace = v; }
    get _dimInfo()           { return this._host._dimInfo; }
    set _dimInfo(v)          { this._host._dimInfo = v; }
    get _dimClass()          { return this._host._dimClass; }
    set _dimClass(v)         { this._host._dimClass = v; }
    get _arrMax()            { return this._host._arrMax; }
    set _arrMax(v)           { this._host._arrMax = v; }
    get _labels()            { return this._host._labels; }
    get if_line()            { return this._host.if_line; }
    set if_line(v)           { this._host.if_line = v; }
    get line_remaining()     { return this._host.line_remaining; }
    set line_remaining(v)    { this._host.line_remaining = v; }
    get fs()                 { return this._host.fs; }
    get history()            { return this._host.history; }
    get lprinter()           { return this._host.lprinter; }
    get prompt()             { return this._host.prompt; }
    get error_file()         { return this._host.error_file; }
    get error_save()         { return this._host.error_save; }
    get error_syntax()       { return this._host.error_syntax; }
    get variables_numbers()  { return this._host.variables_numbers; }
    get variables_strings()  { return this._host.variables_strings; }
    get variables_arr_numbers() { return this._host.variables_arr_numbers; }
    get variables_arr_strings() { return this._host.variables_arr_strings; }

    // ── Host method forwarders ─────────────────────────────────────────────
    trim(s)                  { return this._host.trim(s); }
    appendLine(t, n)         { return this._host.appendLine(t, n); }
    cls()                    { return this._host.cls(); }
    blink()                  { return this._host.blink(); }
    run()                    { return this._host.run(); }
    reset_(s)                { return this._host.reset_(s); }
    assign(n, v)             { return this._host.assign(n, v); }
    getValue(t, s, e, tp)    { return this._host.getValue(t, s, e, tp); }
    _resolveStrArg(p)        { return this._host._resolveStrArg(p); }
    _splitArgs(s, n)         { return this._host._splitArgs(s, n); }
    _scanLabels()            { return this._host._scanLabels(); }
    _scheduleNextTick()      { return this._host._scheduleNextTick(); }
    _skipToNextLine()        { return this._host._skipToNextLine(); }
    _imgStore()              { return this._host._imgStore(); }
    _forceScrollToBottom()   { return this._host._forceScrollToBottom(); }

    cmdMEM() {
        // ── Process table — kernel processes + window processes ────────────
        const procs = this._host.os ? this._host.os.listProcesses() : [];

        // Add window processes from WindowDriver — only show live windows
        const winDrv = this._host._winDrv || this._host.__winDrv;
        const winProcs = [];
        if (winDrv && winDrv._windows) {
            for (const [pid, rec] of winDrv._windows) {
                // Prune closed windows from registry on the fly
                if (!rec.win || rec.win.closed) {
                    winDrv._windows.delete(pid);
                    continue;
                }
                winProcs.push({
                    pid,
                    name:  rec.name || 'window',
                    state: rec.status === 1 ? 'running' : 'starting',
                    lines: 0,
                    window: true,
                });
            }
        }

        const allProcs = [...procs, ...winProcs];
        if (allProcs.length > 0) {
            this.appendLine('Processes:', 1);
            for (const p of allProcs) {
                const nameStr  = (p.name || '?').padEnd(16);
                const stateStr = p.state.padEnd(8);
                const lineStr  = p.lines > 0 ? `${p.lines} lines` : (p.window ? '[window]' : '');
                this.appendLine(`  PID ${String(p.pid).padEnd(4)} ${nameStr} ${stateStr} ${lineStr}`, 1);
            }
            this.appendLine('', 1);
        }
        // ── Current program memory ──────────────────────────────────────────
        const used = this.lines_assigned ? this.lines_assigned.size : 0;
        const free = C.MAX_LINES - used;
        let lineCount = 0, maxLine = 0;
        if (this.lines) {
            for (let i = 0; i < this.lines.length; i++) {
                if (this.lines[i] && this.lines[i] !== '') {
                    lineCount++;
                    if (i > maxLine) maxLine = i;
                }
            }
        }
        const numVars = (this.variables_numbers ? this.variables_numbers.size : 0) +
                        (this.variables_strings  ? this.variables_strings.size  : 0);
        const arrVars = (this.variables_arr_numbers ? this.variables_arr_numbers.size : 0) +
                        (this.variables_arr_strings  ? this.variables_arr_strings.size  : 0);
        this.appendLine('Program info:', 1);
        this.appendLine(`  Lines used  : ${lineCount}`, 1);
        this.appendLine(`  Highest line: ${maxLine}`, 1);
        this.appendLine(`  Lines free  : ${free} of ${C.MAX_LINES}`, 1);
        if (numVars > 0 || arrVars > 0) {
            this.appendLine(`  Variables   : ${numVars} scalar, ${arrVars} array`, 1);
        }
        return C.CMD_OK;
    }

    cmdINFO() { return this.cmdMEM(); }

    // ── HWINFO — dump hardware / browser / runtime introspection ────────────
    cmdHWINFO() {
        const line = (s) => this.appendLine(s, 1);
        const safe = (fn, fallback) => { try { const v = fn(); return (v === undefined || v === null || v === '') ? fallback : v; } catch (e) { return fallback; } };
        const fmt  = (n) => { if (typeof n !== 'number' || !isFinite(n)) return String(n); if (n >= 1e9) return (n/1e9).toFixed(2)+' GB'; if (n >= 1e6) return (n/1e6).toFixed(1)+' MB'; if (n >= 1e3) return (n/1e3).toFixed(1)+' KB'; return n+' B'; };

        line('=== OSAWARE HWINFO ===');
        line('');

        // ── Browser & platform ──────────────────────────────────────────────
        line('-- BROWSER --');
        const ua = safe(() => navigator.userAgent, '?');
        line('userAgent  : ' + ua);
        line('platform   : ' + safe(() => navigator.platform, '?'));
        line('vendor     : ' + safe(() => navigator.vendor, '?'));
        line('language   : ' + safe(() => navigator.language, '?'));
        line('languages  : ' + safe(() => (navigator.languages || []).join(','), '?'));
        line('online     : ' + safe(() => navigator.onLine, '?'));
        line('cookieEnab : ' + safe(() => navigator.cookieEnabled, '?'));
        line('doNotTrack : ' + safe(() => navigator.doNotTrack, '?'));

        // High-entropy UA data (Chromium only)
        const uaData = safe(() => navigator.userAgentData, null);
        if (uaData) {
            line('uaData.mob : ' + safe(() => uaData.mobile, '?'));
            line('uaData.plat: ' + safe(() => uaData.platform, '?'));
            const brands = safe(() => (uaData.brands || []).map(b => b.brand+' '+b.version).join(', '), '');
            if (brands) line('uaData.brnd: ' + brands);
        }
        line('');

        // ── CPU & memory ────────────────────────────────────────────────────
        line('-- CPU & MEMORY --');
        line('cpu cores  : ' + safe(() => navigator.hardwareConcurrency, '?'));
        line('deviceMem  : ' + safe(() => navigator.deviceMemory + ' GB (approx)', 'n/a (Safari/FF)'));
        const pm = safe(() => performance.memory, null);
        if (pm) {
            line('js heap    : ' + fmt(pm.usedJSHeapSize) + ' used / ' + fmt(pm.totalJSHeapSize) + ' total');
            line('heap limit : ' + fmt(pm.jsHeapSizeLimit));
        } else {
            line('js heap    : n/a (Chromium-only API)');
        }
        line('');

        // ── Display & viewport ──────────────────────────────────────────────
        line('-- DISPLAY --');
        line('screen     : ' + safe(() => screen.width + 'x' + screen.height, '?') + ' (avail ' + safe(() => screen.availWidth + 'x' + screen.availHeight, '?') + ')');
        line('colorDepth : ' + safe(() => screen.colorDepth + ' bit', '?'));
        line('pixelRatio : ' + safe(() => window.devicePixelRatio, '?'));
        line('viewport   : ' + safe(() => window.innerWidth + 'x' + window.innerHeight, '?'));
        line('orientation: ' + safe(() => (screen.orientation && screen.orientation.type) || '?', '?'));
        line('touchPoints: ' + safe(() => navigator.maxTouchPoints, '?'));
        line('');

        // ── Connection ──────────────────────────────────────────────────────
        line('-- CONNECTION --');
        const conn = safe(() => navigator.connection || navigator.mozConnection || navigator.webkitConnection, null);
        if (conn) {
            line('type       : ' + safe(() => conn.effectiveType, '?'));
            line('downlink   : ' + safe(() => conn.downlink + ' Mbps', '?'));
            line('rtt        : ' + safe(() => conn.rtt + ' ms', '?'));
            line('saveData   : ' + safe(() => conn.saveData, '?'));
        } else {
            line('(NetworkInformation API unavailable)');
        }
        line('');

        // ── Runtime / engine ────────────────────────────────────────────────
        line('-- RUNTIME --');
        line('url        : ' + safe(() => location.href, '?'));
        line('protocol   : ' + safe(() => location.protocol, '?'));
        line('host       : ' + safe(() => location.host, '?'));
        line('referrer   : ' + safe(() => document.referrer || '(none)', '?'));
        line('readyState : ' + safe(() => document.readyState, '?'));
        line('timeOrigin : ' + safe(() => new Date(performance.timeOrigin).toISOString(), '?'));
        line('uptime ms  : ' + safe(() => Math.round(performance.now()), '?'));
        line('tz         : ' + safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, '?'));
        line('');

        // ── WebGL ───────────────────────────────────────────────────────────
        line('-- WEBGL --');
        try {
            const tc = document.createElement('canvas');
            const gl = tc.getContext('webgl2') || tc.getContext('webgl') || tc.getContext('experimental-webgl');
            if (gl) {
                line('version    : ' + (gl.getParameter(gl.VERSION) || '?'));
                line('shading    : ' + (gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '?'));
                line('vendor     : ' + (gl.getParameter(gl.VENDOR) || '?'));
                line('renderer   : ' + (gl.getParameter(gl.RENDERER) || '?'));
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                if (dbg) {
                    line('gpu vendor : ' + (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '?'));
                    line('gpu rendr  : ' + (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '?'));
                }
                line('maxTexSize : ' + (gl.getParameter(gl.MAX_TEXTURE_SIZE) || '?'));
            } else {
                line('(WebGL not available)');
            }
        } catch (e) {
            line('(WebGL probe failed: ' + e.message + ')');
        }
        line('');

        // ── Storage ─────────────────────────────────────────────────────────
        line('-- STORAGE --');
        line('localStorage : ' + safe(() => (typeof localStorage !== 'undefined' ? 'available' : 'no'), 'no'));
        line('sessionStor  : ' + safe(() => (typeof sessionStorage !== 'undefined' ? 'available' : 'no'), 'no'));
        line('indexedDB    : ' + safe(() => (typeof indexedDB !== 'undefined' ? 'available' : 'no'), 'no'));
        line('serviceWkr   : ' + safe(() => ('serviceWorker' in navigator ? 'available' : 'no'), 'no'));

        line('');
        line('=== end HWINFO ===');
        return C.CMD_OK;
    }

    cmdLABELS() {
        this._scanLabels();
        const entries = Object.entries(this._labels);
        if (entries.length === 0) {
            this.appendLine('No labels found in program.', 1);
        } else {
            this.appendLine('Labels:', 1);
            for (const [name, line] of entries.sort((a,b) => a[1]-b[1])) {
                this.appendLine(`  ${String(line).padStart(5)}  ${name}:`, 1);
            }
        }
        return C.CMD_OK;
    }

    cmdHELP(topic) {
        this.help(this.trim(String(topic || '')));
        return C.CMD_OK;
    }

    cmdVIEW(param) {
        if (!param) { this.appendLine('VIEW: specify a filename, e.g. VIEW TEXT/OSAWARE.TXT', 1); return C.CMD_OK; }
        // Strip surrounding quotes if present
        const path = this.trim(String(param)).replace(/^["']|["']$/g, '');
        // Resolve: try with TEXT/ prefix if no slash given
        let text = this.fs.getTextFile(path);
        if (text === null && !path.includes('/')) {
            text = this.fs.getTextFile('TEXT/' + path.toUpperCase());
        }
        if (text === null) {
            this.appendLine('VIEW: file not found: ' + path, 1);
            return C.CMD_OK;
        }
        // Print each line to the terminal
        const lines = text.split('\n');
        for (const line of lines) {
            this.appendLine(line, 1);
        }
        return C.CMD_OK;
    }

    cmdCLEARSCREEN() { this.cls(); return C.CMD_OK; }

    // Parse a LIST range argument into [start, end].
    // Accepts a RAW string (LIST is selfHandling=1):
    //   ""         → full program
    //   "100"      → single line 100
    //   "1-100"    → lines 1 to 100  (dash syntax)
    //   "1,100"    → lines 1 to 100  (comma syntax)
    //   "Label"    → from Label to end
    //
    // Self-handling means we bypass findParameters entirely — otherwise
    // "100-200" would be evaluated as an arithmetic expression (= -100)
    // by getRaw and the range would be lost.
    _parseListRange(rawParam) {
        const raw = String(rawParam ?? '').trim();

        // No arg at all — list everything.
        if (!raw) return [0, C.MAX_LINES - 1];

        // Label name — resolve to its line number, list from there to end
        if (/^[A-Za-z][A-Za-z0-9.]*$/.test(raw)) {
            this._scanLabels();
            const ln = this._labels[raw.toUpperCase()];
            if (ln !== undefined) return [ln, C.MAX_LINES - 1];
            return [0, C.MAX_LINES - 1];  // unknown label — list everything
        }

        // Dash range: "100-200"
        const dashMatch = raw.match(/^(\d+)\s*-\s*(\d+)$/);
        if (dashMatch) {
            return [parseInt(dashMatch[1], 10), parseInt(dashMatch[2], 10)];
        }

        // Comma range: "100,200"
        const commaMatch = raw.match(/^(\d+)\s*,\s*(\d+)$/);
        if (commaMatch) {
            return [parseInt(commaMatch[1], 10), parseInt(commaMatch[2], 10)];
        }

        // Single line number
        const single = raw.match(/^(\d+)$/);
        if (single) {
            const n = parseInt(single[1], 10);
            return [n, n];
        }

        // Fallback — unrecognised, list everything
        return [0, C.MAX_LINES - 1];
    }

    cmdLIST(param) {
        const [s, f] = this._parseListRange(param);
        for (let i = s; i <= f; i++) {
            if (this.lines_assigned.has(i)) this.appendLine(`${i} ${this.lines[i]}`, 1);
        }
        return C.CMD_OK;
    }

    cmdLLIST(param) {
        const [s, f] = this._parseListRange(param);
        for (let i = s; i <= f; i++) {
            if (this.lines_assigned.has(i)) this.lprinter.print(`${i} ${this.lines[i]}`, 1);
        }
        return C.CMD_OK;
    }

    cmdDIM(params) {
        // FIX: removed spurious `break` — all params are now processed.
        if (!params) return C.CMD_ESYNTAX;
        if (!this._dimInfo) this._dimInfo = {};
        if (!this._dimClass) this._dimClass = {};
        for (let thisDim of params) {
            thisDim = thisDim.trim();
            // OOP: support "DIM x AS ClassName" and "DIM arr(n) AS ClassName".
            // The `AS ClassName` suffix binds the variable to an object handle
            // type for later resolution. We strip it here so the legacy DIM
            // path below sees a clean name. The variable itself is created
            // as a numeric slot (handle storage). Default value 0 = NOTHING.
            const asMatch = thisDim.match(/\s+AS\s+([A-Z_][A-Z0-9_]*)\s*$/i);
            if (asMatch) {
                const className = asMatch[1].toUpperCase();
                thisDim = thisDim.substring(0, asMatch.index).trim();
                // Stash the class binding for the bare/array name so later
                // assignment / member access can resolve it.
                const op = thisDim.indexOf('(');
                const baseName = op >= 0 ? thisDim.substring(0, op).trim() : thisDim;
                this._dimClass[baseName] = className;
            }
            const p1   = thisDim.indexOf('$');
            const p2   = thisDim.indexOf('(');
            const p3   = thisDim.indexOf(')');
            const isStr = p1 > 0;
            const varName  = thisDim.substring(0, p2 > 0 ? (isStr ? p1 + 1 : p2) : thisDim.length);
            const dimStr   = p3 > p2 ? thisDim.substring(p2 + 1, p3) : '';
            const dimParts = dimStr.split(',').map(s => parseInt(s.trim(), 10) + 1);

            // Store dimension info for multi-dim arrays (cols, depth, ...)
            // Variables are case-sensitive; key by original-case varName.
            if (dimParts.length >= 2) {
                this._dimInfo[varName] = dimParts;
            }

            if (p2 > -1) {
                // P6 FIX: allocate the entire array in one Map.set instead of
                // calling assign() N+1 times (each of which trims and does a
                // Map lookup). DIM A(1000) is now O(1) not O(n).
                const total   = dimParts.reduce((a, b) => a * b, 1);
                if (!total || !Number.isFinite(total) || total < 1) continue;  // guard against bad DIM
                const fillVal = isStr ? '' : 0;
                if (isStr) {
                    this.variables_arr_strings.set(varName, new Array(total).fill(fillVal));
                } else {
                    this.variables_arr_numbers.set(varName, new Array(total).fill(fillVal));
                }
                // Track max index for UBOUND
                if (!this._arrMax) this._arrMax = {};
                const typeKey = (isStr ? C.ASS_ARRAY_STRING : C.ASS_ARRAY_NUMBER) + ':' + varName;
                this._arrMax[typeKey] = total - 1;
            } else if (thisDim[0] !== '') {
                this.assign(thisDim, isStr ? '' : '0');
            } else {
                this.appendLine(this.error_syntax, 1);
            }
        }
        return C.CMD_OK;
    }

// FIX: cmdSAVE is now implemented properly.
    cmdSAVE(param) {
        if (!param) return C.CMD_ESYNTAX;
        const name = this.trim(param);

        // SAVE DOWNLOAD [filename] — download current program as a .bas file
        if (name.toUpperCase().startsWith('DOWNLOAD')) {
            const rest     = this.trim(name.substring(8)).replace(/^["']|["']$/g, '');
            const stem     = (rest || 'program').replace(/\.bas$/i, '');
            const filename = stem + '.bas';
            // Build numbered text content from this.lines[]
            const lineNums = [];
            for (let i = 0; i < this.lines.length; i++) {
                if (this.lines_assigned && this.lines_assigned.has(i)) {
                    lineNums.push(i + ' ' + (this.lines[i] || ''));
                }
            }
            if (lineNums.length === 0) {
                this.appendLine('Nothing to save — program is empty.', 1);
                return C.CMD_OK;
            }
            const content = lineNums.join('\n') + '\n';
            // Trigger browser download
            const blob = new Blob([content], { type: 'text/plain' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.appendLine('Downloaded: ' + filename + ' (' + lineNums.length + ' lines)', 1);
            return C.CMD_OK;
        }

        const ok = this.fs.saveFile(name, this.lines, null);
        if (!ok) this.appendLine(this.error_save, 1);
        return C.CMD_OK;
    }

    cmdFILES(param) {
        const files = this.fs.listUserFiles();
        this.appendLine('', 1);
        this.appendLine(' USER SPACE', 1);
        this.appendLine(' ----------', 1);
        if (files.length === 0) {
            this.appendLine(' (empty)', 1);
            this.appendLine(' Use SAVE <name> to save a program', 1);
        } else {
            for (let i = 0; i < files.length; i += 3) {
                const row = files.slice(i, i + 3).map(n => n.padEnd(16)).join('');
                this.appendLine(' ' + row, 1);
            }
            this.appendLine('', 1);
            this.appendLine(` ${files.length} program${files.length !== 1 ? 's' : ''}`, 1);
        }
        this.appendLine('', 1);
        // Show TEXT/ folder
        const textFiles = this.fs.listTextFolder('TEXT');
        if (textFiles.length > 0) {
            this.appendLine(' TEXT FILES', 1);
            this.appendLine(' ----------', 1);
            for (let i = 0; i < textFiles.length; i += 3) {
                const row = textFiles.slice(i, i + 3).map(n => n.padEnd(20)).join('');
                this.appendLine(' ' + row, 1);
            }
            this.appendLine('', 1);
            this.appendLine(' VIEW <filename> to read', 1);
            this.appendLine('', 1);
        }
        return C.CMD_OK;
    }

    cmdDELUSER(param) {
        if (!param) { this.appendLine('Usage: DELUSER <name>', 1); return C.CMD_ESYNTAX; }
        const name = this.trim(param).toUpperCase();
        const idx  = this.fs._userFiles.findIndex(([n]) => n === name);
        if (idx < 0) {
            this.appendLine('Not found: ' + name, 1);
        } else {
            this.fs._userFiles.splice(idx, 1);
            this.fs._persistUserFiles();
            this.appendLine('Deleted: ' + name, 1);
        }
        return C.CMD_OK;
    }


// VFSPUT "path", data$ — store any string data as a VFS user asset.
// Creates the folder implicitly. Data can be any string (text, data URL, etc.)
// Usage:  VFSPUT "MYGAME/LEVEL1.DAT", levelData$
    cmdVFSPUT(param) {
        const args = this._splitArgs(param, 2);
        if (args.length < 2) return C.CMD_ESYNTAX;
        const path = args[0];
        const data = args[1];
        if (!path) return C.CMD_ESYNTAX;
        const ext = path.split('.').pop().toLowerCase();
        const mime = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
                       txt:'text/plain', json:'application/json',
                       dat:'application/octet-stream' }[ext] || 'text/plain';
        this.fs.putAsset(path, mime, data);
        return C.CMD_OK;
    }

// VFSGET$ "path" — retrieve user asset data as a string.
// Usage:  d$ = VFSGET$("MYGAME/LEVEL1.DAT")
    cmdVFSGET(param) {
        const path = this._resolveStrArg(param);
        if (!path) return '';
        const data = this.fs.getAsset(path);
        return data || '';
    }

// READTEXT "path" [, arrayName$] — load a text file into a string array.
// Default array name is TXT$ with count in TXT_COUNT.
// Lines are stored in arrayName$(1), arrayName$(2), ... arrayName$(N)
// and the count is in a matching numeric variable <arrayBase>_COUNT or TXT_COUNT.
// Usage:  READTEXT "TEXT/OSAWARE.TXT"
//         FOR I=1 TO TXT_COUNT : PRINT TXT$(I) : NEXT I
//   or:   READTEXT "TEXT/OSAWARE.TXT", "LINES$"
//         FOR I=1 TO LINES_COUNT : PRINT LINES$(I) : NEXT I
    cmdREADTEXT(param) {
        if (!param) { this.appendLine('READTEXT: specify a filename', 1); return C.CMD_OK; }

        // Resolve first arg as a string (handles quoted literals AND variables like F$)
        // Split on comma to allow optional array name: READTEXT "file", "ARR$"
        const commaIdx = String(param).indexOf(',');
        const firstArg  = commaIdx >= 0 ? String(param).substring(0, commaIdx).trim() : String(param).trim();
        const secondArg = commaIdx >= 0 ? String(param).substring(commaIdx + 1).trim() : '';

        const rawPath = this._resolveStrArg(firstArg);

        // Resolve path — try direct, then TEXT/ prefix
        let text = this.fs.getTextFile(rawPath);
        if (text === null && !rawPath.includes('/')) {
            text = this.fs.getTextFile('TEXT/' + rawPath.toUpperCase());
        }
        if (text === null) {
            this.appendLine('READTEXT: file not found: ' + rawPath, 1);
            return C.CMD_OK;
        }

        // Determine array name — strip trailing $ if given.
        // Variables are case-sensitive (Model B); preserve whatever case the user
        // supplied as the target array name.
        let arrName = 'TXT';
        if (secondArg) {
            arrName = this._resolveStrArg(secondArg).replace(/\$+$/, '');
        }
        const countVar = arrName + '_COUNT';

        // Split text into lines (strip trailing empty line if present)
        const lines = text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

        // Store lines into BASIC string array via proper assign() — arrName$(1..N)
        // First clear any existing array by setting it to a fresh empty one
        const interp = this._host;
        const arrKey = arrName + '$';
        if (interp.variables_arr_strings) {
            interp.variables_arr_strings.set(arrKey, []);
        }
        // Assign each line using the interpreter's assign() which handles memory correctly
        for (let i = 0; i < lines.length; i++) {
            interp.assign(arrKey + '(' + (i + 1) + ')', lines[i]);
        }
        // Store count as a numeric variable
        interp.assign(countVar, lines.length);

        return C.CMD_OK;
    }

// VFSIMG "path", "imgname" — save a loaded image (from LOADIMG store) into VFS.
// Usage:  LOADIMG "hero","https://..."  then  VFSIMG "MYGAME/HERO.PNG","hero"
    cmdVFSIMG(param) {
        const args = this._splitArgs(param, 2);
        if (args.length < 2) return C.CMD_ESYNTAX;
        const path    = args[0];
        const imgname = args[1];
        if (!path || !imgname) return C.CMD_ESYNTAX;
        const data = this._imgStore()[imgname];
        if (!data) {
            this.appendLine('VFSIMG: image not found in store: ' + imgname, 1);
            return C.CMD_OK;
        }
        this.fs.putAsset(path, 'image/png', data);
        this.appendLine('Saved ' + imgname + ' → ' + path, 1);
        return C.CMD_OK;
    }

// VFSDEL "path" — delete a user VFS asset.
    cmdVFSDEL(param) {
        const path = this._resolveStrArg(param);
        if (!path) return C.CMD_ESYNTAX;
        this.fs.deleteAsset(path);
        return C.CMD_OK;
    }

    // =======================================================================
    // Auth commands
    //
    // DEVLOGIN / DEVLOGOUT / DEVWHOAMI — dev sandbox against MockRemote
    // LOGIN / LOGOUT / REGISTER        — production stubs (step 4)
    // WHOAMI                           — production-auth state (always 'local' for now)
    //
    // DEV* commands trigger async storage swaps so they use the want_auth
    // yield pattern — same shape as the AI commands (_aiDispatch). Sync
    // commands (DEVWHOAMI, WHOAMI, production stubs) just print and return.
    // =======================================================================

    // Helper: yield pattern for async auth commands. Cancels the tick timer,
    // sets want_auth = 1, fires the async op, on resolve/reject prints the
    // result and resumes execution.
    //
    // IMPORTANT: When a BASIC program calls an async auth command, the tick
    // loop has ALREADY advanced run_line past the DEVLOGIN line by the time
    // cmdDEVLOGIN returns C.CMD_OK. The batch then breaks because want_auth=1.
    // So on async resume, we must NOT increment run_line again — we'd skip
    // the line immediately after DEVLOGIN. We just reschedule the tick.
    _runAuthOp(asyncOp, onSuccess) {
        const host = this._host;
        host.want_auth = 1;
        if (host.execute_timer) {
            clearTimeout(host.execute_timer);
            host.execute_timer = 0;
        }
        asyncOp.then((result) => {
            host.want_auth = 0;
            if (result && result.ok) {
                onSuccess(result);
            } else {
                const msg = (result && result.error) ? result.error : 'auth operation failed';
                this.appendLine(msg, 1);
            }
            if (host.running) {
                host._scheduleNextTick();
            } else {
                this.appendLine(host.prompt, 0);
                host.blink();
            }
        }).catch((err) => {
            host.want_auth = 0;
            this.appendLine('auth error: ' + (err.message || err), 1);
            if (host.running) {
                host._scheduleNextTick();
            } else {
                this.appendLine(host.prompt, 0);
                host.blink();
            }
        });
    }

    // DEVLOGIN "user", "pass" — dev sandbox login against MockRemoteStorageProvider
    cmdDEVLOGIN(param) {
        if (false) {
            this.appendLine('DEVLOGIN: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        const args = this._splitArgs(param, 2);
        if (args.length < 2) {
            this.appendLine('Usage: DEVLOGIN "user", "password"', 1);
            return C.CMD_OK;
        }
        const username = args[0];
        const password = args[1];

        this._runAuthOp(
            AuthService.devLogin(username, password),
            (result) => {
                this.appendLine('Logged in as ' + result.user + ' (dev)', 1);
            }
        );
        return C.CMD_OK;
    }

    // DEVLOGOUT — leave dev sandbox, swap back to local provider
    cmdDEVLOGOUT(param) {
        if (false) {
            this.appendLine('DEVLOGOUT: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        this._runAuthOp(
            AuthService.devLogout(),
            (result) => {
                this.appendLine('Logged out (dev, was ' + result.user + ')', 1);
            }
        );
        return C.CMD_OK;
    }

    // DEVWHOAMI — print the current dev-mode username (sync)
    cmdDEVWHOAMI(param) {
        if (false) {
            this.appendLine('DEVWHOAMI: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        const user = AuthService.devCurrentUser();
        this.appendLine(user ? user : '(no dev session)', 1);
        return C.CMD_OK;
    }

    // LOGIN "user", "pass" — real production auth via RemoteStorageProvider.
    // LOGIN "user"         — short form; prompts for password obfuscated.
    cmdLOGIN(param) {
        if (false) {
            this.appendLine('LOGIN: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        const args = this._splitArgs(param, 2);
        const username = args[0] || '';
        if (!username) {
            this.appendLine('Usage: LOGIN "user" [, "password"]', 1);
            return C.CMD_OK;
        }

        // Full form: password provided inline
        if (args.length >= 2 && args[1]) {
            this._runAuthOp(
                AuthService.login(username, args[1]),
                (result) => {
                    this.appendLine('Logged in as ' + result.user, 1);
                }
            );
            return C.CMD_OK;
        }

        // Short form: prompt for password
        const host = this._host;
        host.promptPassword((pw) => {
            if (pw === null) return;   // user pressed ESC — cancelled
            if (!pw) {
                this.appendLine('(no password entered)', 1);
                this.appendLine(host.prompt, 0);
                host.blink();
                return;
            }
            this._runAuthOp(
                AuthService.login(username, pw),
                (result) => {
                    this.appendLine('Logged in as ' + result.user, 1);
                }
            );
        }, 'Enter password: ');
        return C.CMD_OK;
    }

    // LOGOUT — end production auth session
    cmdLOGOUT(param) {
        if (false) {
            this.appendLine('LOGOUT: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        this._runAuthOp(
            AuthService.logout(),
            (result) => {
                this.appendLine('Logged out (was ' + result.user + ')', 1);
            }
        );
        return C.CMD_OK;
    }

    // REGISTER "user", "pass" — create account and auto-login.
    // REGISTER "user"         — short form; prompts for password obfuscated.
    cmdREGISTER(param) {
        if (false) {
            this.appendLine('REGISTER: AuthService not loaded', 1);
            return C.CMD_OK;
        }
        const args = this._splitArgs(param, 2);
        const username = args[0] || '';
        if (!username) {
            this.appendLine('Usage: REGISTER "user" [, "password"]', 1);
            return C.CMD_OK;
        }

        // Helper to run the actual register call with a given password
        const doRegister = (pw) => {
            this._runAuthOp(
                AuthService.register(username, pw),
                (result) => {
                    this.appendLine('Registered and logged in as ' + result.user, 1);
                    this.appendLine('(your LOCAL data is preserved and will return on LOGOUT)', 1);
                }
            );
        };

        // Full form
        if (args.length >= 2 && args[1]) {
            doRegister(args[1]);
            return C.CMD_OK;
        }

        // Short form: prompt for password
        const host = this._host;
        host.promptPassword((pw) => {
            if (pw === null) return;   // ESC cancelled
            if (!pw) {
                this.appendLine('(no password entered)', 1);
                this.appendLine(host.prompt, 0);
                host.blink();
                return;
            }
            doRegister(pw);
        }, 'Enter password: ');
        return C.CMD_OK;
    }

    // PASSWORD — three-step prompt to change own password.
    //
    // Prompts (all using the obfuscated '*' password line mode):
    //   1. current password
    //   2. new password
    //   3. confirm new password
    //
    // Verifies steps 2 and 3 match before submitting. Branches on dev vs
    // real auth — uses devChangePassword in dev mode, changePassword in
    // real mode. The user stays logged in on the current device after a
    // successful change (other devices get invalidated server-side).
    //
    // No inline form — passwords must always be entered via the masked
    // prompt to prevent shoulder-surfing or accidental history capture.
    cmdPASSWORD(param) {
        if (false) {
            this.appendLine('PASSWORD: AuthService not loaded', 1);
            return C.CMD_OK;
        }

        // Determine which auth mode we're in. Dev mode uses devChangePassword,
        // real mode uses changePassword. If neither, the user isn't logged
        // in at all.
        const isDev  = AuthService.devCurrentUser && AuthService.devCurrentUser();
        const isReal = AuthService.currentUser   && AuthService.currentUser();
        if (!isDev && !isReal) {
            this.appendLine('PASSWORD: not logged in (use LOGIN or DEVLOGIN first)', 1);
            return C.CMD_OK;
        }

        const host = this._host;
        const self = this;

        // Step 1 — current password
        host.promptPassword((currentPw) => {
            if (currentPw === null) return;  // ESC cancelled
            if (!currentPw) {
                self.appendLine('(no password entered)', 1);
                self.appendLine(host.prompt, 0);
                host.blink();
                return;
            }

            // Step 2 — new password
            host.promptPassword((newPw) => {
                if (newPw === null) return;
                if (!newPw) {
                    self.appendLine('(no password entered)', 1);
                    self.appendLine(host.prompt, 0);
                    host.blink();
                    return;
                }

                // Step 3 — confirm new password
                host.promptPassword((confirmPw) => {
                    if (confirmPw === null) return;
                    if (newPw !== confirmPw) {
                        self.appendLine('passwords do not match — try again', 1);
                        self.appendLine(host.prompt, 0);
                        host.blink();
                        return;
                    }

                    // All three captured; submit to auth service
                    const op = isDev
                        ? AuthService.devChangePassword(currentPw, newPw)
                        : AuthService.changePassword(currentPw, newPw);

                    self._runAuthOp(op, (result) => {
                        self.appendLine('Password changed', 1);
                        if (result && result.sessions_invalidated > 0) {
                            self.appendLine('(' + result.sessions_invalidated +
                                ' other session' + (result.sessions_invalidated === 1 ? '' : 's') +
                                ' invalidated)', 1);
                        }
                    });
                }, 'Confirm new password: ');
            }, 'New password: ');
        }, 'Current password: ');
        return C.CMD_OK;
    }

    // DELETEACCOUNT — soft-delete (archive) the current account.
    //
    // Two-step confirmation:
    //   1. Type the username (unmasked) — proves the user knows what
    //      account they're deleting and isn't a passing typo
    //   2. Enter the password (masked) — proves it's the account owner
    //
    // On success, the server archives the account, frees the username
    // for re-registration, drops all sessions, and clears the cookie.
    // Locally we swap back to the local provider and clear the auth
    // state, returning the user to the not-logged-in sandbox.
    //
    // Branches on dev vs real auth. No inline form (deletion must
    // always be interactive).
    cmdDELETEACCOUNT(param) {
        if (false) {
            this.appendLine('DELETEACCOUNT: AuthService not loaded', 1);
            return C.CMD_OK;
        }

        const isDev      = AuthService.devCurrentUser && AuthService.devCurrentUser();
        const isReal     = AuthService.currentUser   && AuthService.currentUser();
        const currentUsr = isDev || isReal;
        if (!currentUsr) {
            this.appendLine('DELETEACCOUNT: not logged in (use LOGIN or DEVLOGIN first)', 1);
            return C.CMD_OK;
        }

        const host = this._host;
        const self = this;

        // Print a warning before the prompt so the user knows what's about
        // to happen. They can ESC out of either step to cancel.
        self.appendLine('WARNING: This will archive your account.', 1);
        self.appendLine('  - You will be logged out everywhere', 1);
        self.appendLine('  - Your username will be freed for re-registration', 1);
        self.appendLine('  - Your data is preserved (admin can restore later)', 1);
        self.appendLine('Press ESC at any prompt to cancel.', 1);

        // Step 1 — username confirmation (unmasked)
        host.promptText((typedUsername) => {
            if (typedUsername === null) return;  // ESC cancelled
            if (typedUsername !== currentUsr) {
                self.appendLine('username does not match — cancelled', 1);
                self.appendLine(host.prompt, 0);
                host.blink();
                return;
            }

            // Step 2 — password (masked)
            host.promptPassword((password) => {
                if (password === null) return;
                if (!password) {
                    self.appendLine('(no password entered)', 1);
                    self.appendLine(host.prompt, 0);
                    host.blink();
                    return;
                }

                // Submit to auth service
                const op = isDev
                    ? AuthService.devArchiveSelf(password, typedUsername)
                    : AuthService.archiveSelf(password, typedUsername);

                self._runAuthOp(op, (result) => {
                    self.appendLine('Account archived: ' + result.archived_username, 1);
                    self.appendLine('You have been logged out. Your LOCAL data has returned.', 1);
                });
            }, 'Enter password to confirm: ');
        }, 'Type your username to confirm: ');
        return C.CMD_OK;
    }

    // WHOAMI — print the current production-auth username (sync).
    // Reports the real-auth user, or "local" if not logged in.
    // DEVWHOAMI reports the dev-mode username separately.
    cmdWHOAMI(param) {
        if (false) {
            this.appendLine('local', 1);
            return C.CMD_OK;
        }
        const user = AuthService.currentUser();
        this.appendLine(user ? user : 'local', 1);
        return C.CMD_OK;
    }

// DIR [folder] — list VFS contents. DIR alone = full listing, DIR MAZE3D = folder listing.
    cmdDIR(param) {
        const folder = (param || '').trim().replace(/^"|"$/g, '').replace(/\/?\*.*$/, '').trim();
        if (folder) {
            this.fs._showFolderListing(folder, this);
        } else {
            this.fs._showListing(this);
        }
        return C.CMD_OK;
    }

    cmdLOAD(param) {
        if (!param) return C.CMD_ESYNTAX;

        // Pause execution while file loads asynchronously.
        this.want_ai = 1;
        if (this.execute_timer) { clearTimeout(this.execute_timer); this.execute_timer = 0; }

        const result = this.fs.loadFile(param, this);

        // If result is a Promise (async fetch), handle it.
        if (result && typeof result.then === 'function') {
            result.then((a) => {
                this.want_ai = 0;
                if (typeof a === 'number') {
                    if (a === -1) this.appendLine(this.error_file, 1);
                } else if (a) {
                    this.lines          = a;
                    this.lines_assigned = new Set();
                    for (let i = 0; i < this.lines.length; i++) {
                        if (this.lines[i] && this.lines[i] !== '') this.line_assigned(i);
                    }
                    // If RUN <filename> triggered this load, start execution now.
                    if (this._runAfterLoad) {
                        this._runAfterLoad = false;
                        this.run();
                        return;
                    }
                }
                // Show prompt once after successful load.
                if (!this.running) {
                    this.appendLine(this.prompt, 0);
                    this.blink();
                }
            }).catch(() => {
                this.want_ai = 0;
                this._runAfterLoad = false;
                this.appendLine(this.error_file, 1);
                if (!this.running) { this.appendLine(this.prompt, 0); this.blink(); }
            });
            return C.CMD_END;
        }

        // Synchronous result (in-memory files like MENU).
        this.want_ai = 0;
        if (typeof result === 'number') {
            if (result === -1) this.appendLine(this.error_file, 1);
        } else if (result) {
            this.lines          = result;
            this.lines_assigned = new Set();
            for (let i = 0; i < this.lines.length; i++) {
                if (this.lines[i] && this.lines[i] !== '') this.line_assigned(i);
            }
            // Don't print OK prompt if we're about to RUN the file immediately.
            if (!this._runAfterLoad) {
                this.appendLine(this.prompt, 0);
                this.blink();
            }
        }
        return C.CMD_OK;
    }

    cmdRESET() { this.reset_(); this.cls(); return C.CMD_OK; }

    cmdRESIZE(fontSize) { this.reset_(fontSize); this.cls(); return C.CMD_OK; }

    cmdNEW() {
        // Clear program lines
        this.lines_assigned = new Set();
        this.lines          = new Array(C.MAX_LINES).fill('');
        // Clear all variables and flow state — same as a fresh start
        this._host.zapVariables();
        this._host.data          = null;
        this._host.data_count    = -1;
        this._host.data_position = 0;
        this._host.for_level     = -1;
        this._host.fors          = new Array(32).fill(null).map(() => [-1, '']);
        this._host.for_var       = '';
        this._host.gosub_level   = -1;
        this._host.gosubs        = [];
        this._host._if_stack     = [];
        this._host._select_stack = [];
        this._host._while_stack  = [];
        this._host._sub_stack    = [];
        this._host._in_sub       = false;
        this._host._shared_vars  = new Set();
        this._host._static_vars  = {};
        this._host.line_remaining = '';
        this._host.if_line        = '';
        this._host._labels        = {};
        this._host._subs          = {};
        this._host._lineCache     = null;
        this._host._exprCache     = new Map();
        this._host._on_goto_table = null;
        return C.CMD_OK;
    }

// MERGE <filename>  –  load a file and merge its lines into the current program.
// Unlike LOAD, existing lines are NOT cleared first; loaded lines overwrite
// only the line numbers present in the file.
    cmdMERGE(param) {
        if (!param) return C.CMD_ESYNTAX;

        this.want_ai = 1;
        if (this.execute_timer) { clearTimeout(this.execute_timer); this.execute_timer = 0; }

        const result = this.fs.loadFile(param, this);

        const _mergeLines = (loaded) => {
            if (!loaded || typeof loaded === 'number') {
                if (loaded === -1) this.appendLine(this.error_file, 1);
                return;
            }
            for (let i = 0; i < loaded.length; i++) {
                if (loaded[i] && loaded[i] !== '') {
                    this.lines[i] = loaded[i];
                    this.line_assigned(i);
                }
            }
            this.appendLine('Merged.', 1);
        };

        if (result && typeof result.then === 'function') {
            result.then((a) => {
                this.want_ai = 0;
                _mergeLines(a);
                if (!this.running) { this.appendLine(this.prompt, 0); this.blink(); }
            }).catch(() => {
                this.want_ai = 0;
                this.appendLine(this.error_file, 1);
                if (!this.running) { this.appendLine(this.prompt, 0); this.blink(); }
            });
            return C.CMD_END;
        }

        this.want_ai = 0;
        _mergeLines(result);
        return C.CMD_OK;
    }

    cmdRUN(param) {
        // RUN PROGNAME -w  — open program in a new browser window (windowed mode)
        if (param && param !== '') {
            const rawParam = String(param).trim();
            const parts    = rawParam.split(/\s+/);
            const winFlag  = parts.includes('-w') || parts.includes('-W');
            const namePart = parts.filter(p => p !== '-w' && p !== '-W').join(' ');

            if (winFlag && namePart) {
                const progName = namePart.endsWith('$')
                    ? String(this.getValue(namePart, 0, namePart.length, 1 /* C.ASS_STRING */))
                    : namePart.toUpperCase();

                // Validate existence BEFORE opening the window
                const fs      = this.fs;
                const stripped = progName.toUpperCase();
                const inSystem = fs._files && fs._files.some(([k, v]) => k === stripped && Array.isArray(v));
                const inUser   = fs._userFiles && fs._userFiles.some(([n]) => n === stripped);

                let exists = inSystem || inUser;

                // If not in memory stores, try a synchronous XHR to ./files/PROGNAME.bas
                if (!exists) {
                    try {
                        const xhr = new XMLHttpRequest();
                        xhr.open('HEAD', './files/' + stripped + '.bas', false); // sync
                        xhr.send();
                        exists = (xhr.status === 200);
                    } catch(e) { exists = false; }
                }

                if (!exists) {
                    this.appendLine(this.error_file, 1);
                    this.appendLine(this.prompt, 0);
                    this.blink();
                    return 1;
                }

                // Program exists — open child window via WindowDriver
                const pid = this._host.kernel.call({syscall:'window.launch', param: '"' + progName + '"'});
                if (pid && pid > 0) {
                    this.appendLine('Launched ' + progName + ' (PID ' + pid + ')', 1);
                } else {
                    this.appendLine('Popup blocked — allow popups for this site.', 1);
                }
                this.appendLine(this.prompt, 0);
                this.blink();
                return 1;
            }
        }

        this.run_line       = 0;
        this.running        = 0;
        this.if_line        = '';
        this.line_remaining = '';

        if (this.execute_timer !== 0) {
            clearTimeout(this.execute_timer);
            this.execute_timer = 0;
        }

        if (param && param !== '') {
            const sName = param.endsWith('$')
                ? String(this.getValue(param, 0, param.length, 1 /* C.ASS_STRING */))
                : param;
            // cmdLOAD may be async (returns C.CMD_END for disk files).
            // Set flag so the async handler calls run() when file is ready.
            this._host._lastLoadedName = sName.replace(/^WEB:/i,'').toUpperCase();
            this._runAfterLoad = true;
            const loadResult = this.cmdLOAD(sName);
            if (loadResult === C.CMD_OK) {
                // Synchronous load (in-memory file) — run immediately.
                this._runAfterLoad = false;
                this.run();
            }
            // If async (C.CMD_END), cmdLOAD's Promise handler will call run().
            return 1;
        }
        this.run();
        return C.CMD_OK;
    }

    cmdCONT() {
        if (this.run_line >= 0) {
            this.running = 1;
            this._skipToNextLine();
            this._scheduleNextTick();
        } else {
            this.appendLine('CANNOT CONTINUE', 1);
        }
        return C.CMD_OK;
    }

    cmdTRON()  { this._trace = true;  return C.CMD_OK; }
    cmdTROFF() { this._trace = false; return C.CMD_OK; }

    // -----------------------------------------------------------------------
    cmdHISTORY() {
        const lines = this.history.lines;
        if (lines.length === 0) {
            this.appendLine('No history yet.', 1);
            return C.CMD_OK;
        }
        this.appendLine('', 1);
        this.appendLine(' Command History', 1);
        this.appendLine(' ---------------', 1);
        const start = Math.max(0, lines.length - 50);  // show last 50
        for (let i = start; i < lines.length; i++) {
            const num = String(i + 1).padStart(4, ' ');
            this.appendLine(num + '  ' + lines[i], 1);
        }
        this.appendLine('', 1);
        return C.CMD_OK;
    }
    help(topic) {
        // Clear the screen when HELP is called with no topic, as the original did.
        if (!topic || topic === '') this.cls();

        let lines = [];

        if (topic === 'FILES' || topic === 'VFS' || topic === 'DIR') {
            lines = [
                'VIRTUAL FILE SYSTEM  (HELP FILES)',
                '==================================',
                '',
                'LISTING',
                '  LOAD *              Full VFS listing (programs + folders)',
                '  LOAD "folder/*"     List contents of a specific folder',
                '  DIR                 Same as LOAD * — full listing',
                '  DIR folder          List a specific folder',
                '',
                'LOADING PROGRAMS',
                '  LOAD name           Load a BASIC program by name',
                '  LOAD WEB:name       Load from the ./files/ directory on disk',
                '  MERGE name          Merge into current program',
                '  RUN name            Load and run immediately',
                '',
                'SAVING PROGRAMS',
                '  SAVE name           Save to user space (localStorage)',
                '  SAVE DOWNLOAD       Download current program as .bas file',
                '  SAVE DOWNLOAD n$    Download with custom filename',
                '',
                'VFS ASSETS (images and data files in folders)',
                '  Assets live in named folders e.g. MAZE3D/',
                '  DIR MAZE3D          List the MAZE3D folder',
                '  LOAD "MAZE3D/*"     Same thing',
                '',
                '  Loading an asset into the image store:',
                '    LOADIMG "name","folder/file.png"',
                '  Then use as:',
                '    DISPLAY "name",x,y,w,h     draw to 2D canvas',
                '    GL.TEXTURE meshId,"name",n  apply to 3D mesh',
                '',
                '  Built-in VFS folders:',
                '    MAZE3D/  — STONE.PNG  FLOOR.PNG  CEIL.PNG',
                '',
                'EXAMPLE',
                '  DIR                                \'  see all',
                '  DIR MAZE3D                         \'  see folder',
                '  LOADIMG "wall","MAZE3D/STONE.PNG"  \'  load asset',
                '  GL.TEXTURE wallId,"wall",2         \'  use in 3D',
                '',
                'DISPLAYING IMAGES',
                '  IMAGE "path"              Show image centred, auto-fit',
                '  IMAGE x,y,"path"[,w,h]   Positioned with optional size',
                '  CORS-safe on file:// â resolves VFS paths automatically',
                '',
                'TEXT FILES  (TEXT/ folder)',
                '  VIEW file.txt           Print file to terminal',
                '  READTEXT file.txt       Load into TXT$(1..N), TXT_COUNT',
                '    FOR I=1 TO TXT_COUNT : PRINT TXT$(I) : NEXT I',
                '  READTEXT f, "ARR$"      Load into custom array ARR$(1..N)',
                '  VFSGET$("TEXT/file")    Read whole file as one string',
                '  RUN VIEWER              Interactive viewer',
                '',
                '  Built-in: TEXT/OSAWARE.TXT â system overview',
                '',
                'CREATING YOUR OWN FOLDERS & ASSETS',
                '  VFSPUT "folder/file.ext", data$    Store any string as an asset',
                '  VFSGET$("folder/file.ext")         Read asset back as a string',
                '  VFSIMG "folder/file.png", "name"   Save a loaded image into VFS',
                '  VFSDEL "folder/file.ext"           Delete a user asset',
                '',
                '  Folders are created automatically — just use a path with /.',
                '  User assets persist across sessions (saved to browser storage).',
                '',
                '  Example — save a loaded image into your own folder:',
                '    LOADIMG "hero","https://example.com/hero.png"',
                '    VFSIMG "MYGAME/HERO.PNG","hero"',
                '    DIR MYGAME                       \'  confirms it is stored',
                '',
                '  Example — store level data as text:',
                '    VFSPUT "MYGAME/LEVEL1.DAT", levelString$',
                '    d$ = VFSGET$("MYGAME/LEVEL1.DAT")',
            ];
        } else if (topic === 'LIST') {
            lines = [
                'LIST [start[-end]]',
                '  List the program in memory.',
                '  LIST        - list entire program',
                '  LIST 100    - list line 100 only',
                '  LIST 1-100  - list lines 1 to 100',
            ];
        } else if (topic === 'DELAY') {
            lines = [
                'DELAY <ms>',
                '  Set execution delay between lines in milliseconds.',
                '  Lower = faster. Default is 5.',
            ];
        } else if (topic === 'IF') {
            lines = [
                'IF condition THEN statement [ELSE statement]',
                '  Single-line IF:',
                '    IF x>10 THEN PRINT "big" ELSE PRINT "small"',
                '',
                '  Block IF (nothing after THEN):',
                '    IF x > 10 THEN',
                '      PRINT "big"',
                '    ELSEIF x > 5 THEN',
                '      PRINT "medium"',
                '    ELSE',
                '      PRINT "small"',
                '    END IF',
            ];
        } else if (topic === 'FOR') {
            lines = [
                'FOR var=start TO end [STEP n]',
                '  NEXT [var]',
                '',
                '  Example:',
                '    FOR I=1 TO 10 STEP 2',
                '      PRINT I',
                '    NEXT I',
            ];
        } else if (topic === 'WHILE') {
            lines = [
                'WHILE condition',
                '  ...statements...',
                'WEND',
                '',
                '  Repeats while condition is true.',
                '  Example:',
                '    WHILE X < 10 : X=X+1 : WEND',
            ];
        } else if (topic === 'SWITCH' || topic === 'CASE') {
            lines = [
                'SWITCH / CASE  (HELP SWITCH)',
                '==============================',
                '',
                'SWITCH(expression)',
                '  CASE value:',
                '    ...statements...',
                '    BREAK',
                '  CASE value1, value2:      \'  comma list',
                '    BREAK',
                '  CASE start TO end:        \'  range',
                '    BREAK',
                '  CASE IS > value:          \'  comparison: IS >, IS <, IS >=, IS <=, IS =, IS <>',
                '    BREAK',
                '  DEFAULT:',
                '    ...fallback...',
                '    BREAK',
                'END SWITCH',
                '',
                '  SWITCH is C-style. BREAK exits the current block.',
                '  Omit BREAK to fall through to the next CASE.',
                '  CASE values can be numbers or strings.',
                '',
                '  Example — game key dispatch:',
                '    SWITCH(INKEY)',
                '      CASE 119:   \'  W',
                '      CASE 38:    \'  up arrow  (fall-through)',
                '        Y = Y - 1 : BREAK',
                '      CASE 115:   \'  S',
                '      CASE 40:    \'  down arrow',
                '        Y = Y + 1 : BREAK',
                '      DEFAULT:',
                '        BREAK',
                '    END SWITCH',
                '',
                '  Example — string matching:',
                '    SWITCH(CMD$)',
                '      CASE "QUIT":  GOTO Done',
                '      CASE "HELP":  GOSUB ShowHelp : BREAK',
                '      DEFAULT:      PRINT "Unknown: "; CMD$',
                '    END SWITCH',
                '',
            ];
        } else if (topic === 'ON') {
            lines = [
                'ON n GOTO line1, line2, ...',
                'ON n GOSUB line1, line2, ...',
                '',
                '  Branches to the nth line in the list.',
                '  If n < 1 or n > list length, falls through.',
                '',
                'ON ERROR GOTO line',
                '  Trap runtime errors. Use ERR and ERL to',
                '  identify error. RESUME or RESUME NEXT to continue.',
                'ON ERROR GOTO 0  - disable error trapping.',
            ];
        } else if (topic === 'SOUND' || topic === 'AUDIO' || topic === 'WAVE') {
            lines = [
                'AUDIO REFERENCE  (HELP AUDIO)',
                '==============================',
                '',
                'SOUND  frequency, duration [, volume [, voice]]',
                '  Play a tone through the speaker.',
                '  frequency  — 20 to 15000 Hz',
                '  duration   — in jiffies (1/60 sec).  60 = 1 second.',
                '  volume     — 0 (silent) to 255 (full).  Default 127.',
                '  voice      — 0..3.  0,3 = left channel.  1,2 = right.  Default 0.',
                '',
                '  SOUND 440, 60           \'  A4 for 1 second',
                '  SOUND 261, 30, 200, 0   \'  middle C, half second, loud, left',
                '',
                'SOUND WAIT',
                '  Queue subsequent SOUND statements instead of playing immediately.',
                '',
                'SOUND RESUME',
                '  Play all queued sounds simultaneously (sync multiple voices).',
                '',
                '  Example — C major chord:',
                '    SOUND WAIT',
                '    SOUND 261, 60, 160, 0   \'  C — left',
                '    SOUND 329, 60, 140, 1   \'  E — right',
                '    SOUND 392, 60, 140, 2   \'  G — right',
                '    SOUND RESUME',
                '',
                'WAVE  voice, SIN | arrayName',
                '  Set the waveform for a voice (0-3).',
                '  WAVE 0, SIN        — reset to sine (default)',
                '  WAVE 0, MyArr      — use 256-element integer array as waveform.',
                '                       Values must be in range -128 to 127.',
                '',
                '  Built-in waveforms:',
                '    WAVE 0, SIN                   \'  clean sine',
                '',
                '  Custom sawtooth:',
                '    DIM W(255)',
                '    FOR I=0 TO 255 : W(I)=I-128 : NEXT I',
                '    WAVE 0, W',
                '',
                '  Custom organ (additive harmonics):',
                '    DIM W(255)',
                '    FOR I=0 TO 255',
                '      A = I*6.2832/256',
                '      W(I) = INT(60*SIN(A)+30*SIN(2*A)+20*SIN(3*A))',
                '    NEXT I',
                '    WAVE 0, W',
                '',
                'BEEP',
                '  Short alert tone.',
                '',
                'Demo: RUN AUDIOTEST',
            ];
        } else if (topic === 'WINDOW' || topic === 'WINDOW.SEND' || topic === 'IPC') {
            lines = [
                'WINDOW IPC  (HELP WINDOW)',
                '===========================',
                '',
                'Open and communicate with child OSAWARE windows.',
                'Each child is a full independent OS instance with its own PID.',
                '',
                'LAUNCHING',
                '  pid = LAUNCH("PROGNAME")     Open child, returns PID',
                '  RUN PROGNAME -w              Same from the prompt',
                '',
                'SENDING MESSAGES',
                '  WINDOW.SEND pid, msg$         Send string to child',
                '',
                '  From child back to parent:',
                '  WINDOW.REPLY msg$             Send string to parent',
                '',
                'RECEIVING MESSAGES',
                '  ON WINDOW GOSUB lbl           Fire handler when message arrives',
                '  WINDOW.MSG$                   String: last received message',
                '  WINDOW.PID                    Numeric: PID of last sender',
                '',
                'STATUS & CONTROL',
                '  WINDOW.STATUS(pid)            0=closed  1=running',
                '  WINDOW.CLOSE pid              Terminate child window',
                '  WINDOW.ISCHILD$               "1" if this is a child window',
                '',
                'EXAMPLE — parent spawns child and sends a level number:',
                '  10 pid = LAUNCH("MYGAME")',
                '  20 SLEEP 120',
                '  30 WINDOW.SEND pid, "LEVEL:5"',
                '  40 ON WINDOW GOSUB Reply',
                '  50 GOTO 50',
                '  60 Reply:',
                '  70 PRINT "Child says: "; WINDOW.MSG$',
                '  80 RETURN',
                '',
                'EXAMPLE — child program receives and replies:',
                '  10 ON WINDOW GOSUB Handler : GOTO 10',
                '  20 Handler:',
                '  30 PRINT "Got: "; WINDOW.MSG$',
                '  40 WINDOW.REPLY "ACK:" + WINDOW.MSG$',
                '  50 RETURN',
                '',
                '  Note: ON WINDOW GOSUB fires asynchronously when a message',
                '  arrives, even while the program is running a loop.',
                '  Browser popup blocker must allow popups for this site.',
            ];
        } else if (topic === 'LAUNCH' || topic === 'WINDOWED') {
            lines = [
                'LAUNCH / RUN -w  (HELP LAUNCH)',
                '================================',
                '',
                'Open a BASIC program in a new browser window.',
                '',
                'From the prompt:',
                '  RUN MAZE3D -w     Open MAZE3D in a new window',
                '  RUN MENU -w         Open MENU in a new window',
                '',
                'From inside a BASIC program:',
                '  LAUNCH "MAZE3D"   Same as RUN -w but callable from code',
                '',
                '  10 PRINT "Launching demo..."',
                '  20 LAUNCH "MAZE3D"',
                '',
                'URL syntax (for bookmarks or links):',
                '  index.html?run=MAZE3D',
                '  index.html?run=PBRCUBE',
                '',
                'Notes:',
                '  - Each window is a fully independent OSAWARE instance.',
                '  - Browser popup blocker must allow popups for this site.',
                '  - The new window hides the toolbar for a cleaner app feel.',
                '  - Window title is set to OSAWARE — PROGRAMNAME.',
            ];
        } else if (topic === 'AI' || topic === 'AINUM' || topic === 'AISYSTEM' || topic === 'AIMODEL' ||
                   topic === 'AITEMP' || topic === 'AITOKENS' || topic === 'AIWEB' || topic === 'AIKEY' || topic === 'AICLEAR') {
            lines = [
                'AI <prompt> [, RESULT$]',
                '  Send a prompt to Claude and stream the reply into the',
                '  terminal. If RESULT$ is given, the reply is stored',
                '  silently in that string variable instead.',
                '  <prompt> is a quoted string or a string variable name',
                '  (build longer prompts with + first).',
                '',
                'AINUM <prompt>, VAR',
                '  Like AI but stores a numeric answer in VAR. The model',
                '  is told to reply with only a number; if it does not,',
                '  VAR gets 0.  Pair with AITEMP 0 for stable results.',
                '',
                'AISYSTEM "text" / AISYSTEM VAR$ / AISYSTEM @"file" / AISYSTEM',
                '  Set the system prompt — your persona / raw context /',
                '  data the model should always know. Replaces the',
                '  built-in default. AISYSTEM @"file" loads it from a saved',
                '  VFS file (do SAVE "file" first). AISYSTEM "" resets it;',
                '  AISYSTEM with no argument prints the current one.',
                '',
                'AIMODEL name      (or just AIMODEL to see it)',
                '  FAST/HAIKU (default), SMART/SONNET, BEST/OPUS, DEFAULT,',
                '  or a literal Anthropic model id.',
                '',
                'AITEMP n          0..1  (0 = deterministic, best for data)',
                'AITOKENS n        1..8192  (default 1024)',
                'AIWEB ON | OFF    let Claude search the web itself (default OFF)',
                'AIKEY             enter your Anthropic key (masked, session only)',
                'AICLEAR           wipe the conversation history',
                'AICLEAR ALL       also reset AISYSTEM/AIMODEL/AITEMP/AITOKENS/AIWEB',
                '',
                'After every AI / AINUM call, AIERR$ is "" on success or',
                'holds the error text — test it in programs.',
                '',
                'AIWEB vs WEBGET:  AIWEB lets Claude decide what to search/read',
                '  and gives you a synthesised answer; WEBGET (HELP WEB) fetches',
                '  one URL you name and gives you the raw bytes.',
                '',
                '  Chat, streamed to the terminal:',
                '    10 INPUT "You: ";Q$',
                '    20 IF UPPER$(Q$)="QUIT" THEN END',
                '    30 AI Q$',
                '    40 GOTO 10',
                '',
                '  Pull data into a program:',
                '    10 AISYSTEM "You are OSAWARE data: capital of France is Paris."',
                '    20 AITEMP 0',
                '    30 AI "What is the capital of France?", C$',
                '    40 IF AIERR$<>"" THEN PRINT "AI down: ";AIERR$ : END',
                '    50 PRINT "Capital: "; C$',
                '',
                '  Numeric answer:',
                '    10 AINUM "Rate this idea 1-10: robots", N',
                '    20 PRINT "Score: "; N',
                '',
                '  Let Claude fetch live data for you:',
                '    10 AIWEB ON',
                '    20 AI "What is the price of bitcoin right now?", P$',
                '    30 PRINT P$',
                '    40 AINUM "Bitcoin price in USD right now - just the number", N',
                '    50 PRINT "BTC = $"; N',
                '',
                '  Big context from a saved file:  SAVE "OSDATA"  then  AISYSTEM @"OSDATA"',
                '',
                '  Web data + AI (see HELP WEB):',
                '    10 WEBGET "api.github.com/repos/jahshaka/OSaware", J$',
                '    20 P$ = "In one line, what is this repo? " + J$',
                '    30 AI P$, S$ : PRINT S$',
            ];
        } else if (topic === 'WEB' || topic === 'WEBGET') {
            lines = [
                'WEBGET url$, RESULT$',
                '  HTTP GET from the open web. The response body text is',
                '  stored in RESULT$ (capped at 1 MB). After the call:',
                '    WEBSTATUS  = HTTP status code (0 on a network error)',
                '    WEBERR$    = "" on success, or the error message',
                '  url$ may be a quoted string or a string variable. "https://"',
                '  is assumed if you leave off the scheme. Execution pauses',
                '  until the response arrives (20-second timeout).',
                '',
                'Cross-origin (CORS) limit:',
                '  The browser only allows requests to sites that send the',
                '  Access-Control-Allow-Origin header. Most public JSON APIs',
                '  do (api.github.com, wttr.in, api.coingecko.com, the',
                '  Wikipedia API, jsonplaceholder.typicode.com, ...). Many',
                '  ordinary web pages do NOT — those will fail with',
                '  "Failed to fetch". GET only for now.',
                '',
                '  Example — live weather:',
                '    10 WEBGET "wttr.in/Berlin?format=3", W$',
                '    20 IF WEBERR$<>"" THEN PRINT "weather down: ";WEBERR$ : END',
                '    30 PRINT W$',
                '',
                '  Example — pull JSON and pick a value out by hand:',
                '    10 WEBGET "api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", J$',
                '    20 P = INSTR(J$, "usd") : PRINT MID$(J$, P, 30)',
            ];
        } else if (topic === 'AUTH' || topic === 'LOGIN' || topic === 'REGISTER' ||
                   topic === 'LOGOUT' || topic === 'WHOAMI' || topic === 'ACCOUNT' ||
                   topic === 'ACCOUNTS' || topic === 'PASSWORD' || topic === 'DELETEACCOUNT') {
            lines = [
                'ACCOUNTS & MULTI-DEVICE SYNC  (HELP AUTH)',
                '==========================================',
                '',
                'OSAWARE has three independent storage modes that never mix:',
                '',
                '  LOCAL  — default. Programs and files live in your browser',
                '           (localStorage). No account needed. Data does NOT',
                '           follow you to other devices or browsers.',
                '',
                '  REAL   — production account. Programs and files sync to',
                '           the OSAWARE backend. Log in from any device and',
                '           your work is there. Use REGISTER / LOGIN / LOGOUT.',
                '',
                '  DEV    — in-memory sandbox for testing multi-tenancy.',
                '           DEVLOGIN / DEVLOGOUT. State vanishes on refresh.',
                '',
                'CREATING AN ACCOUNT',
                '  REGISTER "alice"              Create account, prompt for',
                '                                password (obfuscated *****)',
                '  REGISTER "alice","hunter2"    Create account inline',
                '',
                '  After REGISTER you are automatically logged in.',
                '  Username must be 3-32 chars, letters/digits/underscore only.',
                '  Password must be 6-128 chars.',
                '',
                'LOGGING IN / OUT',
                '  LOGIN "alice"                 Log in, prompt for password',
                '  LOGIN "alice","hunter2"       Log in inline',
                '  LOGOUT                        End session, return to LOCAL',
                '  WHOAMI                        Print current account or "local"',
                '',
                'CHANGING YOUR PASSWORD',
                '  PASSWORD                      Three masked prompts:',
                '                                  Current password: ****',
                '                                  New password:     ****',
                '                                  Confirm new:      ****',
                '  Other devices logged into the same account are signed out.',
                '  This device stays signed in. New password takes effect',
                '  immediately. Press ESC at any prompt to cancel.',
                '',
                'DELETING YOUR ACCOUNT',
                '  DELETEACCOUNT                 Two-step confirmation:',
                '                                  Type your username to confirm',
                '                                  Enter password to confirm: ****',
                '  Your account is archived (soft-deleted):',
                '    - You are logged out everywhere',
                '    - Your username is freed for re-registration',
                '    - Your data is preserved (admin can restore)',
                '  Your LOCAL data returns when archive completes.',
                '  Press ESC at any prompt to cancel.',
                '',
                'WHAT HAPPENS TO LOCAL DATA WHEN YOU LOG IN',
                '  Your LOCAL programs and files are preserved in the browser.',
                '  They become invisible during the REAL session — you see',
                '  only the account\'s data. On LOGOUT your LOCAL work returns.',
                '  Accounts are fully isolated: one user cannot see another.',
                '',
                'EXAMPLES',
                '  ] REGISTER "alice"',
                '  Enter password: ******',
                '  Registered and logged in as alice',
                '  (your LOCAL data is preserved and will return on LOGOUT)',
                '',
                '  ] WHOAMI',
                '  alice',
                '',
                '  ] PASSWORD',
                '  Current password: ******',
                '  New password: *********',
                '  Confirm new password: *********',
                '  Password changed',
                '',
                '  ] LOGOUT',
                '  Logged out (was alice)',
                '',
                '  ] WHOAMI',
                '  local',
                '',
                'DEV SANDBOX (for testing)',
                '  DEVLOGIN "alice","pass1"      Mock login (in-memory only)',
                '  DEVLOGOUT                     Exit dev sandbox',
                '  DEVWHOAMI                     Current dev user',
                '  Hardcoded test users: alice/pass1  bob/pass2  test/test',
                '  PASSWORD and DELETEACCOUNT also work in DEV mode',
                '  (state persists for the page lifetime, lost on refresh).',
                '  DEV and REAL cannot mix — you must log out of one',
                '  before using the other.',
                '',
                'REGRESSION TESTS',
                '  RUN VFSAUTHTEST       Tests DEV mode multi-tenancy',
                '  RUN VFSREALTEST       Tests REAL mode end-to-end',
                '                        (uses fixed test account)',
            ];
        } else if (topic === 'GRAPHICS' || topic === 'SPRITES' || topic === 'GL' || topic === 'SUB' || topic === 'FUNCTION' || topic === 'SUBS' || topic === 'PBR' || topic === 'TEXTURES') {
            lines = [
                'GRAPHICS, SPRITES & SUBPROGRAMS REFERENCE (HELP GRAPHICS)',
                '===========================================================',
                '',
                '2D CANVAS',
                '  CLS               COLOUR n          DELAY/SLEEP',
                '  PSET x,y[,col]    PRESET x,y        POINT(x,y)',
                '  FILLCIRCLE x,y,r[,col]              Solid filled circle',
                '  LINE x1,y1,x2,y2  CIRCLE x,y,r      RECT x1,y1,x2,y2',
                '  FILLRECT x1,y1,x2,y2[,col]          PAINT x,y[,col]',
                '  WIDTH / HEIGHT    (canvas size in pixels)',
                '',
                'IMAGES',
                '  LOADIMG name$,src$   Load image into store.',
                '    src$ can be a URL, data-URL, or VFS path (e.g. "MAZE3D/STONE.PNG")',
                '  DISPLAY name$[,x,y[,w,h]]   Draw stored image to 2D canvas',
                '  IMGLIST              List all images in the store',
                '  IMGFREE name$        Remove image from store',
                '  VFS demos: LOADIMG "cb","DEMO/CHECKERBOARD.PNG"  etc.',
                '  GL.TEXTURE also accepts image store names — see TEXTURES below',
                '',
                'KEYBOARD',
                '  INKEY              Read last keypress (clears after read)',
                '  GETKEY()           Wait for a keypress, return keycode',
                '  KEYDOWN(n)         1 if keycode n is currently held, 0 if not',
                '    Common keycodes: 37=Left 38=Up 39=Right 40=Down',
                '                     87=W 65=A 83=S 68=D  27=ESC 32=Space',
                '    Usage:  IF KEYDOWN(87) OR KEYDOWN(38) THEN ...',
                '',
                'MOUSE',
                '  MOUSE ON/OFF/STOP   ON MOUSE GOSUB lbl',
                '  MOUSE(0) 0=up 1=click 2=dblclick -1=held',
                '  MOUSE(1)/MOUSE(2)   current X/Y cursor position',
                '  MOUSE(3)/MOUSE(4)   X/Y at last press',
                '  MOUSE(5)/MOUSE(6)   X/Y at last release',
                '',
                'SPRITES (OBJECT system)',
                '  OBJECT.SHAPE id,def$   OBJECT.ON/OFF [id]',
                '  OBJECT.X/Y id,val      OBJECT.VX/VY id,val',
                '  OBJECT.AX/AY id,val    OBJECT.PRIORITY id,n',
                '  OBJECT.START/STOP      OBJECT.CLOSE [id]',
                '  OBJECT.HIT id,x1,y1,x2,y2   Test if obj overlaps rectangle',
                '  OBJECT.CLIP x1,y1,x2,y2     Set clipping region for all objects',
                '  OBJECT.PLANES n              Set number of draw planes',
                '  COLLISION ON/OFF/STOP',
                '  COLLISION(id)                1 if object id has collided',
                '  ON COLLISION GOSUB lbl       Fire handler on any collision',
                '  ON MOUSE GOSUB lbl           Fire handler on mouse click',
                '  Shape def: "w,h,RRGGBBRRGGBB..." (000000=transparent)',
                '  Also: OBJECT.SHAPE id,"imagename"  (from image store)',
                '',
                '3D GL SYSTEM (Three.js WebGL)',
                '------------------------------',
                '',
                'SCENE SETUP',
                '  GL.INIT              Initialise WebGL renderer, scene and camera',
                '  GL.CLS [r,g,b]       Clear canvas (r,g,b 0-255, default black)',
                '  GL.PERSPECTIVE fov   Field of view in degrees (e.g. 55)',
                '  GL.CAMERA x,y,z      Camera position in world space',
                '  GL.LOOKAT x,y,z      Point camera looks at (default 0,0,0)',
                '',
                'RENDER MODES',
                '  GL.WIRE              Wireframe edges only',
                '  GL.SOLID             Solid Phong shading',
                '  GL.SOLIDWIRE         Solid Phong + edge outlines',
                '  GL.WIREALL flag      1: every mesh -> unlit wireframe   0: restore',
                '',
                'LIGHTING',
                '  GL.LIGHT lx,ly,lz               Directional light',
                '  GL.LIGHTOFF                     Turn the directional light off',
                '  GL.AMBIENT a                    Ambient level 0.0-1.0',
                '  GL.BLOOM s[,radius,threshold]   Post-process bloom glow (s=0 off)',
                '  GL.AA flag                      Anti-aliasing (FXAA post-pass); 0 = off/aliased',
                '  GL.FPS flag                     1: show "Frames per second" overlay (top-left)',
                '  GL.POINTLIGHT x,y,z[,r,g,b[,intensity,distance]]',
                '  GL.RECTLIGHT x,y,z,w,h[,r,g,b[,intensity]]   Area light, faces down (PBR mats only)',
                '  GL.LIGHTSOFF                    Remove all point + rect lights',
                '',
                'MATERIAL PROPERTIES',
                '  GL.COLOUR r,g,b      Base colour for next mesh (0-255 each)',
                '  GL.COLOR r,g,b       Alias for GL.COLOUR',
                '  GL.SHINE n           Specular shininess 0-200 (default 30)',
                '  GL.ALPHA n           Opacity 0.0-1.0 (default 1.0)',
                '  GL.EMISSIVE r,g,b    Self-glow colour (0-255 each)',
                '  GL.WIRECOLOR r,g,b   Edge colour for SOLIDWIRE mode',
                '',
                'ATMOSPHERE',
                '  GL.FOG r,g,b,near,far    Linear depth fog',
                '  GL.FOGOFF                Disable fog',
                '',
                'BUILDING MESHES',
                '  GL.BEGIN             Start a new mesh definition',
                '  GL.VERTEX x,y,z      Add a vertex (1-indexed)',
                '  GL.FACE i,j,k[,l]    Add tri or quad face (1-based indices)',
                '  GL.END               Finalise mesh — assigns ID',
                '  GL.MESHID            Numeric var: ID of last GL.END mesh',
                '  GL.SPHERE r[,w,h]    Add a sphere mesh (w,h = segments)',
                '  GL.BOX    w,h,d       Add a box mesh (width, height, depth)',
                '  GL.MESHID             Numeric: ID assigned by last GL.END/GL.SPHERE/GL.BOX',
                '',
                'VISIBILITY',
                '  GL.HIDE id            Remove mesh from scene (retains definition)',
                '  GL.SHOW id            Re-add a hidden mesh',
                '  GL.DISPOSE id         Free a mesh + its GPU resources (permanent)',
                '',
                'TEXTURES & PBR MATERIALS',
                '  GL.TEXTURE id,name$[,repeat]',
                '    Apply an image-store texture to a mesh.',
                '    LOADIMG "stone","MAZE3D/STONE.PNG"',
                '    GL.TEXTURE meshId,"stone",2',
                '  GL.CHROME  id[,roughness]   Real-time reflective chrome',
                '',
                'PBR MAPS  (physically-based rendering)',
                '  GL.NORMALMAP    id,name$      Surface normal detail',
                '  GL.ROUGHMAP     id,name$      Roughness (grey: 0=mirror 1=matte)',
                '  GL.AOMAP        id,name$      Ambient occlusion',
                '  GL.HEIGHTMAP    id,name$      Displacement',
                '  GL.METALMAP     id,name$      Metalness mask',
                '  GL.EMISSIVEMAP  id,name$      Emissive mask',
                '  GL.ROUGHNESS    id,value      Scalar roughness 0.0-1.0',
                '  GL.METALNESS    id,value      Scalar metalness 0.0-1.0',
                '  GL.EMISSIVEINTENSITY id,v     Emissive glow intensity',
                '  GL.ENVMAP       id,name$[,n]  Environment/reflection map',
                '',
                '  Demo: RUN PBRCUBE',
                '',
                'TRANSFORMING MESHES',
                '  GL.TRANSLATE id,x,y,z    GL.ROTATE id,rx,ry,rz',
                '  GL.SCALE id,sx,sy,sz     (transforms set per frame, not cumulative)',
                '  GL.INSTANCE id,x,y,z,dirX,dirY,dirZ',
                '    Add one GPU instance of mesh id at (x,y,z) with its local +X',
                '    axis mapped onto (dirX,dirY,dirZ) and local +Y kept vertical.',
                '    First call turns id into the shared template; thousands of',
                '    instances render in one draw call. Great for trails/grass/etc.',
                '',
                'RENDERING',
                '  GL.DRAW id / GL.DRAWALL',
                '',
                'DEMOS',
                '  RUN GLDEMO      Wireframe cube',
                '  RUN GL3D        Solid objects',
                '  RUN GLSHADE     Phong shading + lights',
                '  RUN SGIDEMO     SGI Necker cube',
                '  RUN GLDEMOMAX   Advanced: fog, chrome, mouse orbit, point lights',
                '  RUN PBRCUBE     PBR materials — roughness, metalness, env maps',
                '  RUN MAZE3D      First-person 3D dungeon',
                '  RUN MAZE3D    3D dungeon with head bob, prizes, SWITCH/CASE',
                '',
                'SUBPROGRAMS (SUB / FUNCTION)',
                '-----------------------------',
                '',
                'DECLARATION',
                '  SUB name[(param1, param2, ...)] STATIC',
                '    ...body...',
                '  END SUB',
                '',
                '  FUNCTION name[(params)] STATIC',
                '    name = returnValue',
                '  END FUNCTION',
                '',
                '  STATIC is required on the declaration line.',
                '  All local variables retain their values between calls.',
                '',
                'CALLING',
                '  CALL name(arg1, arg2)   \'  explicit',
                '  name arg1, arg2         \'  implicit',
                '  Each CALL must be on its own line.',
                '',
                'PARAMETERS',
                '  Pass by reference (default) — changes affect caller.',
                '  Pass by value — wrap in extra parens: CALL Sub((X))',
                '',
                'SHARED — share main-program variables inside a SUB',
                '  SHARED var1, var2      scalars',
                '  SHARED arr1, arr2      arrays (1D and 2D) also supported',
                '',
                'EXIT SUB / EXIT FUNCTION — return early.',
                '',
                'SCOPE: all SUB variables are LOCAL by default.',
                '',
                'AUDIO — type HELP AUDIO',
                '  SOUND, WAVE, SOUND WAIT/RESUME',
                '  Demo: RUN AUDIOTEST',
            ];
        } else {
            lines = [
                'The Online Operating System',
                'Powered by OSaware v7 Alpha',
                '',
                '----------------------------------------------------------------',
                '',
                'GENERAL COMMANDS',
                '  Program:  NEW, LIST, LLIST, RUN [name|-w], LOAD, SAVE, MERGE',
                '  Windows:  RUN name -w    LAUNCH name$      (HELP LAUNCH)',
                '  Edit:     EDIT <line|label>, DELETE <line[-line]>',
                '  Display:  CLS, RESET, LOCATE, COLOUR/COLOR, PRINT USING',
                '            LSET, RSET, LPRINT, WIDTH, RESIZE',
                '  Flow:     GOTO, GOSUB..RETURN, IF..THEN..ELSE..END IF',
                '            FOR..NEXT, WHILE..WEND, ON n GOTO/GOSUB',
                '            SWITCH/CASE/DEFAULT/BREAK/END SWITCH  (HELP SWITCH)',
                '            END, STOP, CONT, BREAK',
                '  Data:     DIM, ERASE, CLEAR, DATA, READ, RESTORE',
                '            LET, SWAP, INPUT, LINE INPUT, WRITE',
                '            OPTION BASE n    POKE/POKEW/POKEL addr,val',
                '  Error:    ON ERROR GOTO, RESUME, RESUME NEXT',
                '  Debug:    TRON, TROFF, MEM, INFO, HWINFO, HISTORY, GLDEBUG',
                '  System:   SLEEP, DELAY, BEEP, RANDOMIZE, DECLARE',
                '  Labels:   75 MainLoop:   GOTO MainLoop   LABELS',
                '  SUBs:     SUB name(p) STATIC .. END SUB',
                '            CALL name(args)   SHARED/STATIC vars  (HELP GRAPHICS)',
                '  View:     FULLSCREEN [ON|OFF]   OVERSCAN [ON|OFF]',
                '  AI:       AI, AINUM, AISYSTEM, AIMODEL, AITEMP, AIWEB, AIKEY, AICLEAR  (HELP AI)',
                '  WEB:      WEBGET url$, R$  -> R$, WEBSTATUS, WEBERR$   (HELP WEB)',
                '',
                'VIRTUAL FILE SYSTEM',
                '  LOAD *              List all programs and folders',
                '  LOAD "folder/*"     List contents of a folder',
                '  DIR                 Same as LOAD * (full listing)',
                '  DIR folder          List a specific folder',
                '  LOAD name           Load a BASIC program',
                '  SAVE name           Save program to user space',
                '  SAVE DOWNLOAD [n$]  Download .bas file to your computer',
                '  LOAD WEB:name       Load from ./files/ directory',
                '',
                '  VFS ASSETS (images, data files stored in folders)',
                '    LOADIMG n$,"folder/file.png"   Load from VFS into image store',
                '    VFSPUT "folder/file.ext",d$    Create/store a user asset',
                '    VFSGET$("folder/file.ext")     Read a user asset as string',
                '    VFSIMG "folder/file.png","n$"  Save image store entry to VFS',
                '    VFSDEL "folder/file.ext"       Delete a user asset',
                '    Built-in folders: MAZE3D/  DEMO/  TEXT/',
                '    User assets persist in browser storage — HELP FILES for details',
                '',
                '  DISPLAYING IMAGES',
                '    IMAGE "path"            Show image centred, auto-fit to canvas',
                '    IMAGE x,y,"path"[,w,h]  Positioned with optional size',
                '',
                '  TEXT FILES  (TEXT/ folder)',
                '    VIEW file.txt           Print file to terminal, line by line',
                '    READTEXT file.txt       Load into TXT$(1..N), TXT_COUNT',
                '    VFSGET$("TEXT/file")    Read whole file as one string',
                '    RUN VIEWER              Interactive text file browser',
                '',
                'KEYBOARD INPUT',
                '  INKEY              Last keypress (0 if none, clears on read)',
                '  GETKEY()           Wait and return keycode',
                '  KEYDOWN(n)         1 if keycode n held, 0 if not — for games',
                '    Codes: 37=← 38=↑ 39=→ 40=↓  87=W 65=A 83=S 68=D  27=ESC',
                '',
                'ACCOUNTS & MULTI-DEVICE SYNC  (HELP AUTH)',
                '  REGISTER "user"            Create account (prompts for password)',
                '  REGISTER "user","pass"     Create account (password inline)',
                '  LOGIN "user"               Log in (prompts for password)',
                '  LOGIN "user","pass"        Log in (password inline)',
                '  LOGOUT                     End session, return to LOCAL mode',
                '  PASSWORD                   Change own password (3 prompts)',
                '  DELETEACCOUNT              Archive own account & log out',
                '  WHOAMI                     Print current account, or "local"',
                '  Your programs and files sync across devices when logged in.',
                '  LOCAL work is preserved and returns when you LOGOUT.',
                '',
                'NETWORKING',
                '  WS.OPEN url$   WS.SEND msg$   WS.CLOSE',
                '  WS.ONMSG lbl   WS.RECV$   WS.STATUS (0-3)',
                '  Demo: RUN SSH',
                '',
                'WINDOW IPC  (inter-process, cross-window messaging)',
                '  pid = LAUNCH("prog")    Open child window, get PID',
                '  WINDOW.SEND pid, msg$   Send to child',
                '  WINDOW.REPLY msg$       Reply from child to parent',
                '  WINDOW.MSG$  WINDOW.PID WINDOW.STATUS(pid)',
                '  ON WINDOW GOSUB lbl     Fire on incoming message',
                '  HELP WINDOW for full reference',
                '',
                'GRAPHICS, SPRITES & 3D — HELP GRAPHICS',
                '  2D canvas, images (incl. VFS paths), KEYDOWN, mouse,',
                '  sprites, 3D GL/WebGL, SUBs',
                '',
                'AUDIO — HELP AUDIO',
                '  SOUND freq, dur [, vol [, voice]]',
                '  WAVE voice, SIN | arrayName',
                '  SOUND WAIT / SOUND RESUME',
                '  Demo: RUN AUDIOTEST',
                '',
                'NUMERIC FUNCTIONS',
                '  ABS(x)   SGN(x)   INT(x)   FIX(x)   SQR(x)',
                '  SIN(x)   COS(x)   TAN(x)   ATN(x)   EXP(x)',
                '  LOG(x)   RND(n)   VAL(s)   LEN(s)   CLNG(x)',
                '  CSNG(x)  LBOUND(a) UBOUND(a)  NOT x  INSTR(s,t)',
                '  PEEK(n)  CSRLIN   ERL   ERR   POINT(x,y)',
                '  KEYDOWN(n)   MOUSE(n)   UPTIME   SECONDS',
                '',
                'STRING FUNCTIONS',
                '  MID$(s,n,l)    LEFT$(s,n)    RIGHT$(s,n)',
                '  UPPER$(s)      LOWER$(s)     UCASE$(s)',
                '  STR$(n)        CHR$(n)       ASC(s)',
                '  INSTR(s,t)     SPACE$(n)     STRING$(n,c)',
                '  HEX$(n)        OCT$(n)       CENTER$(s)',
                '  TAB$(n)        LINES$(n)',
                '',
                'BUILT-IN VARIABLES',
                '  DATE$   TIME$   UPTIME   SECONDS',
                '  COLS    ROWS    WIDTH    HEIGHT',
                '  INKEY   CSRLIN  ERL      ERR',
                '',
                'Type HELP <topic> for detail on:',
                '  LIST  IF  FOR  WHILE  ON  SWITCH  WINDOW  AI  GRAPHICS  AUDIO  FILES',
                '  SUB   LAUNCH  AUTH',
                '',
                '----------------------------------------------------------------',
                '',
            ];
        }
        for (const line of lines) this.appendLine(line, 1);
        // Force scroll to bottom after all help text is appended.
        // setTimeout (not rAF) gives Firefox time to finish DOM layout
        // before measuring scrollHeight — fixes Firefox not scrolling on HELP.
        setTimeout(() => this._forceScrollToBottom(), 50);
    }

    // LAUNCH progname  —  open a BASIC program in a managed child window.
    // Routes through WindowDriver for full IPC support.
    // Returns PID of the child window (stored in last numeric result).
    cmdLAUNCH(param) {
        if (!param) { this.appendLine('Usage: LAUNCH <program>', 1); return 1; }
        const progName = this._resolveStrArg(param).toUpperCase().trim();

        // Validate existence before opening the window
        const fs = this.fs;
        const inSystem = fs._files && fs._files.some(([k, v]) => k === progName && Array.isArray(v));
        const inUser   = fs._userFiles && fs._userFiles.some(([n]) => n === progName);
        let exists = inSystem || inUser;
        if (!exists) {
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('HEAD', './files/' + progName + '.bas', false);
                xhr.send();
                exists = (xhr.status === 200);
            } catch(e) { exists = false; }
        }
        if (!exists) {
            this.appendLine(this.error_file, 1);
            this.appendLine(this.prompt, 0);
            this.blink();
            return 1;
        }

        // Route through kernel bus → WindowDriver
        const pid = this._host.kernel.call({syscall: 'window.launch', param: '"' + progName + '"'});
        if (pid && pid > 0) {
            this.appendLine('Launched ' + progName + ' (PID ' + pid + ')', 1);
        }
        this.appendLine(this.prompt, 0);
        this.blink();
        return 1;
    }


}

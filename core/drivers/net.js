'use strict';
import * as C from '../constants.js';


// ---------------------------------------------------------------------------
// NetDriver  (drivers/net.js)
//
// Extracted from kernel.js as part of the V7 architecture refactor (Step 2).
// Wraps WebSocket: WS.OPEN, WS.SEND, WS.CLOSE, WS.ONMSG, WS.CLEAR, WS.STATUS.
// ---------------------------------------------------------------------------

export class NetDriver {

    constructor(host) {
        this._host     = host;
        this._ws       = null;
        this._wsStatus = 0;
        this._wsQueue  = [];
        this._wsOnMsg  = -1;
    }

    // ── Host forwarders ────────────────────────────────────────────────────
    get running()    { return this._host.running; }
    get run_line()   { return this._host.run_line; }
    set run_line(v)  { this._host.run_line = v; }
    trim(s)          { return this._host.trim(s); }
    appendLine(t,n)  { return this._host.appendLine(t,n); }
    evalCalc(a,b,c)  { return this._host.evalCalc(a,b,c); }
    _resolveLabel(l)      { return this._host._resolveLabel(l); }
    _resolveStrArg(p)     { return this._host._resolveStrArg(p); }
    _scheduleNextTick()   { return this._host._scheduleNextTick(); }
    _skipToNextLine()     { return this._host._skipToNextLine(); }
    blink()               { return this._host.blink(); }
    get prompt()          { return this._host.prompt; }
    get execute_timer()   { return this._host.execute_timer; }
    set execute_timer(v)  { this._host.execute_timer = v; }
    get gosub_level()     { return this._host.gosub_level; }
    set gosub_level(v)    { this._host.gosub_level = v; }
    get gosubs()          { return this._host.gosubs; }
    get want_ai()         { return this._host.want_ai; }
    set want_ai(v)        { this._host.want_ai = v; }

    _wsInit() {
        if (!this._ws) {
            this._ws       = null;
            this._wsStatus = 0;
            this._wsQueue  = [];
            this._wsOnMsg  = -1;
        }
    }

    _wsResume() {
        if (this.running) { this.run_line++; this._skipToNextLine(); this._scheduleNextTick(); }
        else { this.appendLine(this.prompt, 0); this.blink(); }
    }

    cmdWS_OPEN(param) {
        const url = this._resolveStrArg(param);
        if (!url) return C.CMD_ESYNTAX;
        // Close existing connection
        if (this._ws) { try { this._ws.close(); } catch(e) {} this._ws = null; }
        this._wsStatus = 1;  // connecting
        this._wsQueue  = [];
        this.want_ai   = 1;
        if (this.execute_timer) { clearTimeout(this.execute_timer); this.execute_timer = 0; }
        try {
            const ws = new WebSocket(url);
            this._ws = ws;
            ws.onopen = () => {
                this._wsStatus = 2;
                this.want_ai = 0;
                this._wsResume();
            };
            ws.onmessage = (e) => {
                this._wsQueue.push(String(e.data));
                // Fire WS.ONMSG callback if set
                if (this._wsOnMsg >= 0 && this.running) {
                    this.gosub_level++;
                    this.gosubs[this.gosub_level] = this.run_line;
                    this.run_line = this._wsOnMsg;
                }
            };
            ws.onerror = () => {
                this._wsStatus = 3;
                this.want_ai = 0;
                this.appendLine('WS ERROR: connection failed', 1);
                this._wsResume();
            };
            ws.onclose = () => {
                this._wsStatus = 0;
                this._ws = null;
            };
        } catch(e) {
            this._wsStatus = 3;
            this.want_ai = 0;
            this.appendLine('WS ERROR: ' + e.message, 1);
            this._wsResume();
        }
        return C.CMD_OK;
    }

    cmdWS_SEND(param) {
        const msg = this._resolveStrArg(param);
        if (!this._ws || this._wsStatus !== 2) {
            this.appendLine('WS ERROR: not connected', 1);
            return C.CMD_OK;
        }
        try { this._ws.send(msg); } catch(e) { this.appendLine('WS SEND ERROR: ' + e.message, 1); }
        return C.CMD_OK;
    }

    cmdWS_CLOSE() {
        if (this._ws) { try { this._ws.close(); } catch(e) {} this._ws = null; }
        this._wsStatus = 0;
        return C.CMD_OK;
    }

    cmdWS_CLEAR() {
        this._wsQueue = [];
        return C.CMD_OK;
    }

    cmdWS_ONMSG(param) {
        const lbl = Number(this.evalCalc(this.trim(String(param || '-1')), C.ASS_NUMBER));
        this._wsOnMsg = lbl;
        return C.CMD_OK;
    }

// WS.RECV$ — used as a string function in lookup_, see compiler.js
// Returns next queued message or "" if queue is empty
    _wsRecv() {
        if (!this._wsQueue || this._wsQueue.length === 0) return '';
        return this._wsQueue.shift();
    }


}

'use strict';

// ---------------------------------------------------------------------------
// WindowDriver  (core/drivers/window.js)
//
// Manages child OSAWARE windows as kernel processes.
// Uses BroadcastChannel + postMessage for cross-window IPC.
//
// BASIC surface:
//   pid = LAUNCH("PROGNAME")      open child window, returns PID
//   WINDOW.SEND pid, msg$         send message to child
//   WINDOW.CLOSE pid              close/terminate child window
//   WINDOW.STATUS(pid)            0=closed 1=running 2=waiting
//   WINDOW.REPLY msg$             (child → parent) send reply
//   ON WINDOW GOSUB lbl           fire handler when any msg arrives
//   WINDOW.MSG$                   string var: last received message
//   WINDOW.PID                    numeric var: PID of last sender
//
// Architecture:
//   Each child window gets a numeric PID (continuing from the kernel's table).
//   The driver maintains a registry: pid → {win, channel, status}
//   All messages use the shape: {osaware:true, type, pid, parentPid, msg}
//   The BroadcastChannel 'osaware-ipc' is used for child → parent replies.
//   Direct postMessage on the window reference is used for parent → child.
// ---------------------------------------------------------------------------

class WindowDriver {

    constructor(host) {
        this._host       = host;
        this._windows    = new Map();  // pid → {win, status, name}
        this._nextPid    = 100;        // window PIDs start at 100 to avoid collision
        this._onMsgLine  = -1;         // GOSUB line for ON WINDOW
        this._lastMsg    = '';         // WINDOW.MSG$
        this._lastPid    = 0;          // WINDOW.PID (sender)
        this._parentPid  = null;       // set if we ARE a child window
        this._channel    = null;       // BroadcastChannel — lazy init
        this._parentRef  = null;       // opener window ref (if child)
        this._seen       = new Set();  // deduplication: msgId → handled

        // Boot: register as child if launched via URL param
        const params = typeof URLSearchParams !== 'undefined'
            ? new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
            : null;
        if (params && params.get('run')) {
            this._initAsChild(params);
        }
    }

    // ── Host forwarders ────────────────────────────────────────────────────
    get running()          { return this._host.running; }
    get run_line()         { return this._host.run_line; }
    set run_line(v)        { this._host.run_line = v; }
    appendLine(t, n)       { return this._host.appendLine(t, n); }
    blink()                { return this._host.blink(); }
    get prompt()           { return this._host.prompt; }
    _resolveStrArg(p)      { return this._host._resolveStrArg(p); }
    evalCalc(a, b, c)      { return this._host.evalCalc(a, b, c); }
    trim(s)                { return this._host.trim(s); }
    _scheduleNextTick()    { return this._host._scheduleNextTick(); }
    _skipToNextLine()      { return this._host._skipToNextLine(); }
    _fireEventGosub(l)     { return this._host._fireEventGosub(l); }

    // ── BroadcastChannel (lazy init, shared across all windows) ───────────
    _getChannel() {
        if (!this._channel && typeof BroadcastChannel !== 'undefined') {
            this._channel = new BroadcastChannel('osaware-ipc');
            this._channel.onmessage = (e) => this._onBroadcast(e.data);
        }
        return this._channel;
    }

    // ── Child initialisation ───────────────────────────────────────────────
    _initAsChild(params) {
        const ppid = parseInt(params.get('ppid') || '1', 10);
        const cpid = parseInt(params.get('cpid') || '100', 10);
        this._parentPid = ppid;
        this._nextPid   = cpid;
        this._parentRef = window.opener || null;

        // Listen for messages from parent
        window.addEventListener('message', (e) => {
            if (!e.data || !e.data.osaware) return;
            this._handleIncoming(e.data);
        });

        // Also listen on broadcast channel
        this._getChannel();

        // Defer 'ready' notification until after DOM/setup completes
        setTimeout(() => {
            this._sendToParent({ type: 'ready', pid: cpid, ppid });
        }, 300);

        // When we close, notify parent
        window.addEventListener('beforeunload', () => {
            this._sendToParent({ type: 'closed', pid: cpid, ppid });
        });
    }

    // ── Message routing ────────────────────────────────────────────────────

    // Send a message from parent → child (via direct postMessage)
    _sendToChild(pid, data) {
        const rec = this._windows.get(pid);
        if (!rec || !rec.win || rec.win.closed) return false;
        try {
            rec.win.postMessage({ osaware: true, ts: Date.now(), ...data }, '*');
            return true;
        } catch(e) { return false; }
    }

    // Send from child → parent (via BroadcastChannel + opener postMessage)
    _sendToParent(data) {
        const msg = { osaware: true, ts: Date.now(), ...data };
        // Try direct postMessage to opener first (fastest)
        if (this._parentRef && !this._parentRef.closed) {
            try { this._parentRef.postMessage(msg, '*'); } catch(e) {}
        }
        // Also broadcast so any listener catches it
        const ch = this._getChannel();
        if (ch) { try { ch.postMessage(msg); } catch(e) {} }
    }

    // Broadcast received (child → parent direction)
    _onBroadcast(data) {
        if (!data || !data.osaware) return;
        this._handleIncoming(data);
    }

    // Central incoming message handler (works for both parent and child)
    _handleIncoming(data) {
        if (!data || !data.osaware) return;
        // Deduplicate: same message may arrive via postMessage AND BroadcastChannel
        const msgId = (data.type || '') + ':' + (data.pid || '') + ':' + (data.msg || '') + ':' + (data.ts || '');
        if (this._seen.has(msgId)) return;
        this._seen.add(msgId);
        // Expire old IDs after 2s to prevent memory growth
        setTimeout(() => this._seen.delete(msgId), 2000);

        const { type, pid, ppid, msg } = data;

        // Parent receives: 'ready', 'closed', 'reply', 'output'
        if (type === 'ready') {
            const rec = this._windows.get(pid);
            if (rec) {
                rec.status = 1;
                // Brief terminal notification (only when at the prompt, not interrupting)
                if (!this.running) {
                    const name = rec.name || String(pid);
                    this.appendLine('', 1);
                    this.appendLine('[OSAWARE] ' + name + ' (PID ' + pid + ') running.', 1);
                    this.appendLine(this.prompt, 0);
                    this.blink();
                }
            }
            return;
        }

        if (type === 'closed') {
            const rec = this._windows.get(pid);
            if (rec) rec.status = 0;
            this._lastMsg = '[CLOSED]';
            this._lastPid = pid;
            const progName = rec ? rec.name : String(pid);
            if (this._onMsgLine >= 0 && this.running) {
                // Running a BASIC program — fire GOSUB handler
                this._fireEventGosub(this._onMsgLine);
            } else {
                // At the terminal prompt — print notification directly
                this.appendLine('', 1);
                this.appendLine('[OSAWARE] ' + progName + ' (PID ' + pid + ') closed.', 1);
                this.appendLine(this.prompt, 0);
                this.blink();
            }
            return;
        }

        if (type === 'reply' || type === 'send') {
            this._lastMsg = String(msg || '');
            this._lastPid = Number(pid || ppid || 0);
            const rec = this._windows.get(this._lastPid);
            if (rec) rec.status = 1;
            if (this._onMsgLine >= 0 && this.running) {
                // Running a BASIC program — fire GOSUB handler
                this._fireEventGosub(this._onMsgLine);
            } else {
                // At the terminal prompt — print message inline
                this.appendLine('', 1);
                this.appendLine('[PID ' + this._lastPid + '] ' + this._lastMsg, 1);
                this.appendLine(this.prompt, 0);
                this.blink();
            }
            return;
        }

        // Child receives: 'send' from parent
        if (type === 'send' && this._parentPid !== null) {
            this._lastMsg = String(msg || '');
            this._lastPid = Number(ppid || 1);
            if (this._onMsgLine >= 0 && this.running) {
                this._fireEventGosub(this._onMsgLine);
            }
            return;
        }

        // Child receives: 'kill' from parent
        if (type === 'kill') {
            if (typeof window !== 'undefined') window.close();
        }
    }

    // ── BASIC command implementations ──────────────────────────────────────

    // LAUNCH("PROGNAME") or LAUNCH "PROGNAME"
    // Returns the PID assigned to the child window
    cmdLAUNCH(param) {
        if (!param) { this.appendLine('Usage: LAUNCH program$', 1); return -1; }
        const progName = this._resolveStrArg(param).toUpperCase().trim();
        const pid      = this._nextPid++;
        const base     = window.location.href.split('?')[0];
        const url      = `${base}?run=${encodeURIComponent(progName)}&ppid=1&cpid=${pid}`;
        const win      = window.open(url, `osaware-${pid}`,
            'width=900,height=700,menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes');

        if (!win) {
            this.appendLine('LAUNCH: popup blocked — allow popups for this site.', 1);
            return -1;
        }

        // Register the child
        this._windows.set(pid, { win, status: 0, name: progName });

        // Listen for messages from this child via window.addEventListener
        window.addEventListener('message', (e) => {
            if (!e.data || !e.data.osaware) return;
            if (e.data.pid === pid || e.data.ppid === 1) {
                this._handleIncoming(e.data);
            }
        }, { capture: false });

        // Poll for window close (fallback for browsers that don't fire beforeunload cross-window)
        const closePoller = setInterval(() => {
            if (win.closed) {
                clearInterval(closePoller);
                const rec = this._windows.get(pid);
                if (rec && rec.status !== 0) {
                    rec.status = 0;
                    // Use _handleIncoming directly (already deduped by _seen)
                    this._handleIncoming({ osaware: true, ts: Date.now(), type: 'closed', pid });
                }
            }
        }, 500);

        // Also init broadcast channel to catch child replies
        this._getChannel();

        return pid;  // returned to BASIC as numeric value
    }

    // WINDOW.SEND pid, msg$
    cmdWINDOW_SEND(param) {
        if (!param) return -1;
        const parts = String(param).split(',');
        if (parts.length < 2) { this.appendLine('Usage: WINDOW.SEND pid, msg$', 1); return -1; }
        const pid = Number(this.evalCalc(parts[0].trim(), 0, parts[0].trim().length));
        const msg = this._resolveStrArg(parts.slice(1).join(',').trim());
        const sent = this._sendToChild(pid, { type: 'send', pid, ppid: 1, msg });
        if (!sent) this.appendLine(`WINDOW.SEND: PID ${pid} not found or closed.`, 1);
        return -1;
    }

    // WINDOW.CLOSE pid
    cmdWINDOW_CLOSE(param) {
        if (!param) return -1;
        const pid = Number(this.evalCalc(String(param).trim(), 0, String(param).trim().length));
        const sent = this._sendToChild(pid, { type: 'kill', pid });
        const rec = this._windows.get(pid);
        if (rec) {
            try { if (rec.win && !rec.win.closed) rec.win.close(); } catch(e) {}
            rec.status = 0;
        }
        return -1;
    }

    // WINDOW.REPLY msg$  (called from child program to reply to parent)
    cmdWINDOW_REPLY(param) {
        if (this._parentPid === null) {
            this.appendLine('WINDOW.REPLY: not running as a child window.', 1);
            return -1;
        }
        const msg = this._resolveStrArg(param || '""');
        this._sendToParent({ type: 'reply', pid: this._nextPid, ppid: this._parentPid, msg });
        return -1;
    }

    // ON WINDOW GOSUB lbl
    cmdON_WINDOW(param) {
        if (!param) return -1;
        const t = this.trim(String(param)).toUpperCase();
        if (t === '0' || t === 'OFF') { this._onMsgLine = -1; return -1; }
        const lbl = this._host._resolveLabel ? this._host._resolveLabel(param)
                  : Number(param);
        this._onMsgLine = lbl >= 0 ? lbl : Number(param);
        return -1;
    }

    // WINDOW.STATUS(pid) → 0=closed, 1=running, 2=waiting
    windowStatus(pid) {
        const rec = this._windows.get(Number(pid));
        if (!rec) return 0;
        if (rec.win && rec.win.closed) { rec.status = 0; }
        return rec.status;
    }

    // Accessors for WINDOW.MSG$ and WINDOW.PID
    get lastMsg()  { return this._lastMsg; }
    get lastPid()  { return this._lastPid; }
    get isChild()  { return this._parentPid !== null; }
}

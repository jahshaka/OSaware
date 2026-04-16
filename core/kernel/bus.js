'use strict';

// ---------------------------------------------------------------------------
// KernelBus  (core/kernel/bus.js)
//
// The IPC syscall bus — Step 3 of the V7 architecture refactor.
//
// This is the wall between the BASIC runtime (Layer 4) and the drivers
// (Layer 2). Runtimes post syscall messages; drivers register handlers.
// No runtime ever calls a driver method directly.
//
// API:
//   bus.on(syscall, handler)       — driver registers a handler at boot
//   bus.post(msg)                  — runtime fires a one-way syscall
//   bus.call(msg) → value          — runtime makes a synchronous syscall
//                                    (used for INKEY, MOUSE, WS.STATUS etc)
//   bus.emit(event, ...args)       — kernel emits events (program stop etc)
//   bus.listen(event, handler)     — services subscribe to kernel events
//
// Message shape:
//   { syscall: 'print', text: 'hello', newline: 1 }
//   { syscall: 'gl.camera', x: 1, y: 0, z: 5 }
//   { syscall: 'sound.play', freq: 440, dur: 0.5, vol: 127, voice: 0 }
//
// The syscall string is the routing key. Convention:
//   'print'          terminal commands (no prefix — terminal is primary I/O)
//   'gl.*'           3D rendering
//   'gfx.*'          2D pixel drawing
//   'sound.*'        audio synthesis
//   'net.*'          network / WebSocket
//   'input.*'        keyboard / mouse queries
//   'vfs.*'          virtual filesystem
// ---------------------------------------------------------------------------

class KernelBus {

    constructor() {
        // syscall → handler function
        this._handlers = new Map();
        // event name → [handler, ...] (for kernel lifecycle events)
        this._listeners = new Map();
        // Optional debug mode — logs every post/call
        this._debug = false;
    }

    // ── Driver registration ────────────────────────────────────────────────

    // Register a handler for a syscall.
    // handler(msg, pid) → void   (for post)
    // handler(msg, pid) → value  (for call)
    on(syscall, handler) {
        if (this._handlers.has(syscall)) {
            console.warn(`KernelBus: overwriting handler for '${syscall}'`);
        }
        this._handlers.set(syscall, handler);
        return this; // chainable
    }

    // ── Runtime interface ──────────────────────────────────────────────────

    // Fire-and-forget syscall. Returns CMD_OK (-1) for use as a return value
    // in cmd* methods.
    post(msg, pid = 0) {
        if (this._debug) console.log('[bus.post]', msg.syscall, msg);
        const handler = this._handlers.get(msg.syscall);
        if (!handler) {
            if (this._debug) console.warn(`KernelBus: no handler for '${msg.syscall}'`);
            return -1; // CMD_OK
        }
        handler(msg, pid);
        return -1; // CMD_OK
    }

    // Synchronous syscall — handler must return a value.
    // Used for INKEY, MOUSE(n), WS.STATUS, POINT(x,y) etc.
    call(msg, pid = 0) {
        if (this._debug) console.log('[bus.call]', msg.syscall, msg);
        const handler = this._handlers.get(msg.syscall);
        if (!handler) {
            if (this._debug) console.warn(`KernelBus: no handler for '${msg.syscall}'`);
            return null;
        }
        return handler(msg, pid);
    }

    // ── Kernel lifecycle events ────────────────────────────────────────────

    // Kernel emits events (program stop, resize, etc.)
    emit(event, ...args) {
        const listeners = this._listeners.get(event);
        if (listeners) listeners.forEach(fn => fn(...args));
    }

    // Services subscribe to kernel events
    listen(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
        return this;
    }

    // ── Diagnostics ───────────────────────────────────────────────────────

    // List all registered syscalls (for MEM / INFO display)
    registeredSyscalls() {
        return [...this._handlers.keys()].sort();
    }

    enableDebug() { this._debug = true; }
    disableDebug() { this._debug = false; }
}

'use strict';

import { ProcessMemory } from './process_memory.js';

// ---------------------------------------------------------------------------
// Kernel  (core/kernel/kernel.js)
//
// Step 5 of the V7 architecture refactor.
//
// The Kernel is the true OS kernel — it owns:
//   - The process table (registered processes with PIDs, state, priority)
//   - The cooperative scheduler (execute/tick loop via setTimeout)
//   - Process lifecycle: start, kill, pause, resume
//   - The KernelBus reference (IPC between processes and drivers)
//
// Processes register with kernel.registerProcess(process).
// The kernel calls process.tick() on each active process in priority order.
// process.execute() bootstraps a process (setup + initialize).
//
// The Interpreter (BASIC runtime) is the first process registered.
// Future processes: LuaRuntime, ShellRuntime, WASMModule, etc.
//
// Design principle: the Kernel knows NOTHING about BASIC syntax, line numbers,
// variables, or drivers. It only knows about processes, timers, and the bus.
// ---------------------------------------------------------------------------

export class Kernel {

    constructor(bus) {
        // The IPC syscall bus
        this.bus = bus;

        // Process table: pid → process record
        // Each record: { pid, process, state, priority }
        // state: 'running' | 'sleeping' | 'waiting' | 'stopped'
        this._processes  = new Map();
        this._nextPid    = 1;

        // The currently active (focused) process PID
        this._activePid  = null;

        // Global timer handle — only one tick loop runs at a time
        this._tickTimer  = null;
    }

    // ── Process registration ───────────────────────────────────────────────

    // Register a process with the kernel. Returns its PID.
    // process must implement: execute(), tick(a), start(), kill()
    // Allocates an isolated ProcessMemory for the process.
    registerProcess(process, priority = 0) {
        const pid = this._nextPid++;
        const mem = new ProcessMemory();
        this._processes.set(pid, {
            pid,
            process,
            memory:   mem,
            state:    'stopped',
            priority,
        });
        // Hand the memory context to the process
        if (typeof process.attachMemory === 'function') {
            process.attachMemory(mem);
        }
        // First registered process is the active one
        if (this._activePid === null) this._activePid = pid;
        return pid;
    }

    // Spawn a new process of the same type as an existing one.
    // Returns the new PID. Future use for multitasking.
    spawnProcess(process, priority = 0) {
        return this.registerProcess(process, priority);
    }

    // Get the ProcessMemory for a given PID
    getMemory(pid) {
        const rec = this._processes.get(pid ?? this._activePid);
        return rec ? rec.memory : null;
    }

    // Get the active (focused) process record
    activeProcess() {
        return this._processes.get(this._activePid);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    // Boot the kernel — start the active process
    start() {
        const rec = this.activeProcess();
        if (rec) {
            rec.state = 'running';
            rec.process.execute();
        }
    }

    // Terminate a process
    kill(pid) {
        const rec = this._processes.get(pid ?? this._activePid);
        if (!rec) return;
        rec.state = 'stopped';
        rec.process.kill();
    }

    // Pause a process (keeps it registered, suspends scheduling)
    pause(pid) {
        const rec = this._processes.get(pid ?? this._activePid);
        if (!rec) return;
        rec.state = 'sleeping';
        rec.process.pause?.();
    }

    // Resume a paused process
    resume(pid) {
        const rec = this._processes.get(pid ?? this._activePid);
        if (!rec) return;
        rec.state = 'running';
        rec.process.resume?.();
    }

    // ── Diagnostics ───────────────────────────────────────────────────────

    // List all registered processes (for MEM/PS command)
    listProcesses() {
        return [...this._processes.values()].map(r => ({
            pid:      r.pid,
            state:    r.state,
            priority: r.priority,
            lines:    r.memory ? r.memory.lines_assigned.size : 0,
            name:     r.name || (r.pid === 1 ? 'shell' : 'program'),
        }));
    }
}

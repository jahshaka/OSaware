'use strict';

// ---------------------------------------------------------------------------
// ProcessMemory  (core/kernel/process_memory.js)
//
// Step 6 of the V7 architecture refactor — process isolation.
//
// Every BASIC process gets its own isolated memory context. No process can
// read or corrupt another process's variables, program, or flow control state.
//
// The Kernel allocates a ProcessMemory for each registered process.
// When a second BASIC program runs, it gets a fresh ProcessMemory while
// the first program's state is preserved — enabling true multitasking.
//
// Memory categories:
//   program    — lines[], lines_assigned, _lineCache, _exprCache
//   variables  — numbers, strings, arrays, functions
//   flow       — gosubs, for/next, if/switch/while stacks, sub stack
//   execution  — run_line, running, if_line, data, error trapping
//   heap       — _memory (64K byte array), optionBase, dimInfo, arrMax
// ---------------------------------------------------------------------------

class ProcessMemory {

    constructor() {
        this.reset();
    }

    // Allocate a completely fresh memory context.
    // Called at construction and by the kernel when a process is spawned.
    reset() {

        // ── Program store ──────────────────────────────────────────────────
        this.lines          = new Array(MAX_LINES).fill('');
        this.lines_assigned = new Set();
        this._lineCache     = null;   // built at RUN time
        this._exprCache     = new Map();
        this._labels        = {};
        this._subs          = {};
        this._dimInfo       = {};
        this._arrMax        = {};

        // ── Variable heap ──────────────────────────────────────────────────
        this.variables_numbers     = new Map();
        this.variables_strings     = new Map();
        this.variables_arr_numbers = new Map();
        this.variables_arr_strings = new Map();
        this.variables_func        = [];

        // ── Flow control stacks ────────────────────────────────────────────
        this.gosub_level    = -1;
        this.gosubs         = [];
        this.for_level      = -1;
        this.fors           = new Array(32).fill(null).map(() => [-1, '']);
        this.for_var        = '';
        this._if_stack      = [];
        this._select_stack  = [];
        this._while_stack   = [];
        this._sub_stack     = [];
        this._in_sub        = false;
        this._shared_vars   = new Set();
        this._static_vars   = {};
        this._on_goto_table = null;
        this._func_result   = null;

        // ── Execution state ────────────────────────────────────────────────
        this.run_line       = 0;
        this.running        = 0;
        this.if_line        = '';
        this.line_remaining = '';
        this.just_stopped   = 0;
        this.want_input     = 0;
        this.want_ai        = 0;
        this.sleepy_time    = 0;
        this.run_delay      = 5;

        // DATA/READ state
        this.data           = null;
        this.data_count     = -1;
        this.data_position  = 0;

        // Error trapping
        this._error_trap_line    = -1;
        this._error_resume_line  = -1;
        this._last_err           = 0;
        this._last_erl           = 0;
        this._in_error           = false;

        // ── BASIC heap ─────────────────────────────────────────────────────
        this._memory        = new Uint8Array(65536);
        this._optionBase    = 0;

        // ── Misc runtime state ─────────────────────────────────────────────
        this._trace         = false;
        this._rng_seed      = null;
    }

    // Snapshot the variable heap (used by CALL to save/restore SUB scope)
    snapshotVars() {
        return {
            numbers:    new Map(this.variables_numbers),
            strings:    new Map(this.variables_strings),
            arrNumbers: new Map([...this.variables_arr_numbers].map(([k,v])=>[k,[...v]])),
            arrStrings: new Map([...this.variables_arr_strings].map(([k,v])=>[k,[...v]])),
        };
    }

    // Restore a variable heap snapshot
    restoreVars(snap) {
        this.variables_numbers     = snap.numbers;
        this.variables_strings     = snap.strings;
        this.variables_arr_numbers = snap.arrNumbers;
        this.variables_arr_strings = snap.arrStrings;
    }

    // Reset just the variable heap (zapVariables equivalent)
    zapVariables() {
        this.variables_numbers     = new Map();
        this.variables_strings     = new Map();
        this.variables_arr_numbers = new Map();
        this.variables_arr_strings = new Map();
        // variables_func intentionally kept (DEF FN persists across RUN)
    }
}

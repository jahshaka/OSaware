'use strict';

// Module-level cache for volatile built-in set (shared across all instances)
let _VOLATILE_SET = null;
let _BUILTIN_NUM_NAMES_SET = null;

// Module-level Sets for function type detection — created once, reused on every call.
const _STR_FUNCS = new Set(['TAB$', 'LINES$', 'LEFT$', 'RIGHT$', 'MID$',
                             'CENTER$', 'CHR$', 'UPPER$', 'LOWER$', 'STR$', 'VFSGET$', 'FOLDEREXISTS$', 'WINDOW.MSG$', 'DEVICE$', 'SCREENW$', 'SCREENH$', 'WHOAMI$', 'DEVWHOAMI$',
                             'WALLET.TOKENSYMBOL$']);
const _NUM_FUNCS = new Set(['LEN', 'INT', 'RND', 'ABS', 'SQR', 'VAL',
                             'SGN', 'FIX', 'EXP', 'LOG', 'SIN', 'COS',
                             'TAN', 'ATN', 'CLNG', 'CSNG', 'CVI', 'CVL',
                             'CVS', 'CVD', 'PEEK', 'PEEKW', 'PEEKL',
                             'ASC', 'INSTR', 'LBOUND', 'UBOUND', 'POINT',
                             'OBJECT.X', 'OBJECT.Y', 'OBJECT.VX', 'OBJECT.VY',
                             'OBJECT.AX', 'OBJECT.AY', 'OBJECT.PRIORITY',
                             'COLLISION', 'WS.STATUS', 'MOUSE', 'KEYDOWN', 'WINDOW.STATUS', 'WINDOW.PID', 'LAUNCH',
                             'WALLET.TOKEN', 'WALLET.TOKENAT']);


// ---------------------------------------------------------------------------
// OSAWARE Compiler  (compiler.js)
//
// Loaded AFTER kernel.js. Mixed into Interpreter.prototype so the kernel
// gains language processing capabilities — like a compiler service loading
// on top of a running OS kernel.
//
// Provides:
//   Variable storage  : zapVariables, getAssignType, getElement
//   Assign / lookup   : assign_, assign, lookup_, lookup
//   Expression eval   : findFirstOperator, getValue, evalCalc
//   Parsing           : parseAssign, getRaw, findParameters
//   Condition check   : checkCondition
// ---------------------------------------------------------------------------

class Compiler {

    zapVariables() {
        // Use Maps for O(1) variable lookup instead of O(n) array scan.
        this.variables_numbers     = new Map();
        this.variables_strings     = new Map();
        this.variables_arr_numbers = new Map();  // Map<name, Array>
        this.variables_arr_strings = new Map();  // Map<name, Array>
        this._arrMax               = {};  // tracks max index per array
        this._lineCache            = null; // rebuilt at next RUN
        this._static_vars          = {};  // clear SUB static locals between runs
        this._sub_stack            = [];  // clear any dangling sub frames
        this._in_sub               = false;
        this._shared_vars          = new Set();
        this._soundWait            = false;
        this._soundQueue           = [];
        this._dimInfo              = {};  // clear 2D array dimension info
        this._dimClass             = {};  // clear DIM..AS Class bindings
        this._oopObjects           = new Map(); // clear OOP instance store
        this._oopObjectsNext       = 1;
        this._exprCache            = new Map(); // expression parse tree cache
        this._assignTypeCache      = new Map(); // OPT-AT: getAssignType memo
        // Note: variables_func is intentionally kept (DEF FN persists across RUN).
    }

    // -----------------------------------------------------------------------
    // trim  –  native String.prototype.trim().
    // -----------------------------------------------------------------------
    trim(s) {
        if (s == null) return '';
        return String(s).trim();
    }

    // _splitTopLevelCommas — split on commas at paren-depth 0 so nested array
    // calls like TARGETID(P) inside TANK(TARGETID(P), 1) survive as one arg.
    _splitTopLevelCommas(s) {
        const parts = [];
        let depth = 0, start = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === ',' && depth === 0) {
                parts.push(s.substring(start, i));
                start = i + 1;
            }
        }
        parts.push(s.substring(start));
        return parts;
    }

    // _evalArrayIndex — compute flat array index from a possibly multi-dimensional
    // index expression like "r,c" or "i" or "x*2+1".
    // For 2D: uses _dimCols[name] stored by DIM to compute r*cols+c.
    _evalArrayIndex(inner, baseName) {
        // Use paren-aware split so nested array calls (e.g. TARGETID(P) inside
        // TANK(TARGETID(P), 1)) don't get torn apart at their inner comma.
        const parts = this._splitTopLevelCommas(inner);
        if (parts.length === 1) {
            const single = parts[0];
            const n = Number(single);
            if (!Number.isNaN(n) && single.trim() !== '') return n;
            return this.evalCalc(single, ASS_NUMBER, 0) || 0;
        }
        const indices = parts.map(p => {
            const n = Number(p.trim());
            return (!Number.isNaN(n) && p.trim() !== '') ? n : (this.evalCalc(p.trim(), ASS_NUMBER, 0) || 0);
        });
        // Get column count from _dimInfo if available, else use a safe large number.
        // Variables are case-sensitive — use baseName as-is (matches DIM storage in shell.js).
        const name = baseName || '';
        const cols = (this._dimInfo && this._dimInfo[name]) ? this._dimInfo[name][1] : 1024;
        // For 2D: index = row * cols + col; for 3D would extend similarly
        if (indices.length === 2) return indices[0] * cols + indices[1];
        // 3D fallback: row*dim1*dim2 + col*dim2 + depth
        if (indices.length === 3) {
            const cols2 = (this._dimInfo && this._dimInfo[name]) ? (this._dimInfo[name][2] || 1024) : 1024;
            return indices[0] * cols * cols2 + indices[1] * cols2 + indices[2];
        }
        return indices[0];
    }

    // -----------------------------------------------------------------------
    // getAssignType  –  determine the storage type from the variable name.
    //
    // OPT-AT: memoise per name. Called from lookup_/assign_/parseAssign — for
    // a hot loop reading the same identifier each tick the inputs are stable
    // and the result never changes, so a Map gives O(1) instead of four
    // string searches + two Set lookups + a substring + toUpperCase.
    // Process-local: lives on the Interpreter instance, reset across loaders.
    // -----------------------------------------------------------------------
    getAssignType(variableName) {
        let cache = this._assignTypeCache;
        if (cache) {
            const hit = cache.get(variableName);
            if (hit !== undefined) return hit;
        }
        const dollarPos  = variableName.indexOf('$');
        const parenOpen  = variableName.indexOf('(');
        const parenClose = variableName.lastIndexOf(')');

        // Built-in function names are language keywords — match case-insensitively.
        const funcName  = parenOpen > 0 ? variableName.substring(0, parenOpen).toUpperCase() : '';
        const isStrFunc = _STR_FUNCS.has(funcName);
        const isNumFunc = _NUM_FUNCS.has(funcName);

        let result;
        // String variable or string-returning function
        if (variableName.endsWith('$') || isStrFunc) result = ASS_STRING;
        // Array of strings: name$(index)
        else if (dollarPos > 0 && parenOpen > dollarPos) result = ASS_ARRAY_STRING;
        // Array of numbers: name(index)   (but not a known numeric function)
        else if (parenClose > parenOpen && !isNumFunc) result = ASS_ARRAY_NUMBER;
        else result = ASS_NUMBER;

        if (!cache) {
            cache = new Map();
            this._assignTypeCache = cache;
        }
        // Cap cache size to keep memory bounded; arrays like SHAPES(0)..(N)
        // are different keys and could blow it up in tight loops.
        if (cache.size < 4096) cache.set(variableName, result);
        return result;
    }

    // -----------------------------------------------------------------------
    // getElement  –  extract the array index from a variable name like A(3).
    // -----------------------------------------------------------------------
    // _matchingClose — find the close-paren matching an open-paren at `openIdx`,
    // respecting nested parens. Returns -1 if unmatched. Critical for nested
    // array calls: TANK(TARGETID(P), 1) — the matching close is the LAST `)`,
    // not the first one (which closes TARGETID(P) instead of TANK).
    _matchingClose(s, openIdx) {
        let depth = 0;
        for (let i = openIdx; i < s.length; i++) {
            const c = s[i];
            if (c === '(') depth++;
            else if (c === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    // -----------------------------------------------------------------------
    // OOP helpers — paren+quote-aware scanners for the new operators.
    // -----------------------------------------------------------------------

    // _findToplevelIS — index of the top-level " IS " operator (case-insensitive)
    // or -1. Skipped inside parens and quoted strings. Returns the index of the
    // first space (i.e. of the leading ' ' before "IS"). The caller adds 4 to
    // skip past " IS ".
    _findToplevelIS(s) {
        let depth = 0, inQ = false;
        const up = s.toUpperCase();
        for (let i = 0; i < s.length - 3; i++) {
            const c = s[i];
            if (c === '"') { inQ = !inQ; continue; }
            if (inQ) continue;
            if (c === '(') { depth++; continue; }
            if (c === ')') { depth--; continue; }
            if (depth !== 0) continue;
            // Match " IS " surrounded by whitespace (or start/end-of-string).
            if (c === ' ' && up[i+1] === 'I' && up[i+2] === 'S' && up[i+3] === ' ') {
                // Reject identifiers like "ISP" or "VARS" containing IS.
                return i;
            }
        }
        return -1;
    }

    // _findToplevelMemberDot — index of a dot that is a member-access dot
    // (i.e. one that follows an identifier or a closing paren), at depth 0,
    // outside quotes, AND where the resulting member access pattern consumes
    // the rest of the expression. Returns -1 if the expression isn't a pure
    // member access, so the caller can fall through to the standard operator
    // scan (e.g. for "ME.V + amt" where `+` should win).
    _findToplevelMemberDot(s) {
        // The expression must be entirely a pure member access of the form:
        //   identifier[$] [ '(' args ')' ] . identifier[$] [ '(' args ')' ]
        // Anything else (e.g. "ME.A + ME.B") returns -1, so the standard
        // operator scan in evalCalc handles the binary operators first.
        let j = 0;
        // Skip leading whitespace.
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        // Receiver must start with [A-Za-z_].
        if (j >= s.length || !/[A-Za-z_]/.test(s[j])) return -1;
        j++;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        if (j < s.length && s[j] === '$') j++;
        // Optional (args) for array receivers / function-call results.
        if (j < s.length && s[j] === '(') {
            const cp = this._matchingClose(s, j);
            if (cp < 0) return -1;
            j = cp + 1;
        }
        // Skip whitespace between receiver and dot.
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        // Must be at the dot.
        if (j >= s.length || s[j] !== '.') return -1;
        const dotIdx = j;
        j++;
        // Member name starts with [A-Za-z_].
        if (j >= s.length || !/[A-Za-z_]/.test(s[j])) return -1;
        j++;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        if (j < s.length && s[j] === '$') j++;
        // Optional (args) for method calls.
        if (j < s.length && s[j] === '(') {
            const cp = this._matchingClose(s, j);
            if (cp < 0) return -1;
            j = cp + 1;
        }
        // Trailing whitespace, then must be end-of-string.
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        if (j < s.length) return -1;
        return dotIdx;
    }

    // _evalNewExpr — handle the body of "NEW " (everything after the keyword).
    //   Form:    ClassName(arg1, arg2, ...)
    //   Returns: integer handle (or 0 if class unknown).
    _evalNewExpr(rest) {
        const op = rest.indexOf('(');
        let className, argStr = '';
        if (op >= 0) {
            const cp = this._matchingClose(rest, op);
            className = rest.substring(0, op).trim();
            argStr    = (cp > op) ? rest.substring(op + 1, cp) : '';
        } else {
            className = rest.trim();
        }
        if (!this._objectAlloc) return 0;
        const handle = this._objectAlloc(className);
        if (!handle) return 0;
        // If the class declares an Init method, call it with the args.
        const cls = this._classes[className.toUpperCase()];
        const initEntry = cls && cls.methodVtable ? cls.methodVtable['INIT'] : null;
        if (initEntry) {
            const args = argStr.trim() ? this._splitTopLevelCommas(argStr).map(a => this._evalArg(a)) : [];
            this._dispatchMethod(handle, cls, initEntry.method, args, false);
        }
        return handle;
    }

    // _evalArg — evaluate one argument expression with type detection
    // (string if ends with $, else numeric).
    _evalArg(expr) {
        const t = expr.trim();
        // Detect string by literal or var name
        if (t.startsWith('"')) {
            const end = t.lastIndexOf('"');
            if (end > 0) return t.substring(1, end);
        }
        // Heuristic: if first identifier ends with $ -> string
        const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*\$)\b/);
        if (m) return this.evalCalc(t, ASS_STRING, 0);
        // Otherwise number
        return this.evalCalc(t, ASS_NUMBER, 0);
    }

    // _evalMemberExpr — handles  obj.field  /  obj.method(args)  expressions.
    //   s        : the full expression text
    //   dotIdx   : index of the top-level member-access dot in s
    //   assignType: caller's expected type (used to pick numeric vs string read)
    //
    // The LEFT side of the dot resolves to an object handle (a variable or a
    // function call returning a handle, or the MYBASE/ME keywords). The RIGHT
    // side is either a bare identifier (field read) or an identifier followed
    // by parens (method call).
    _evalMemberExpr(s, dotIdx, assignType, level) {
        const leftRaw  = s.substring(0, dotIdx).trim();
        const rightRaw = s.substring(dotIdx + 1).trim();
        const leftUpper = leftRaw.toUpperCase();
        const isMybase  = (leftUpper === 'MYBASE');
        const isMe      = (leftUpper === 'ME');
        // Resolve receiver handle and dispatching class.
        let selfHandle = 0;
        let dispatchCls = null;
        if (isMe || isMybase) {
            const frame = this._meFrame();
            if (!frame) return undefined;     // fall through — not in a method
            selfHandle = frame.selfHandle;
            dispatchCls = isMybase ? frame.classDef : frame.classDef;
            if (isMybase) {
                // For MYBASE we use mybaseVtable instead of methodVtable.
                dispatchCls = { ...frame.classDef, methodVtable: frame.classDef.mybaseVtable };
            }
        } else {
            // The receiver must be a known object handle. If the variable
            // isn't tied to a class via DIM ... AS, and doesn't resolve to
            // a live OOP object, this dot isn't an OOP member access at all
            // — it's a built-in like GL.MESHID or a namespaced identifier.
            // Return undefined so the caller falls back to standard eval.
            const simpleVar = /^[A-Za-z_][A-Za-z0-9_]*(\$)?$/.test(leftRaw);
            const declaredClass = simpleVar && this._dimClass ? this._dimClass[leftRaw] : null;
            if (!declaredClass) {
                // Try treating it as an arbitrary expression that might evaluate
                // to a handle. But to avoid touching non-OOP built-ins, only do
                // this when we have an _oopObjects map AND the value is a
                // live handle key.
                if (!this._oopObjects) return undefined;
                const tryHandle = Number(this.evalCalc(leftRaw, ASS_NUMBER, level + 1)) || 0;
                if (!tryHandle || !this._oopObjects.has(tryHandle)) return undefined;
                selfHandle = tryHandle;
            } else {
                selfHandle = Number(this.evalCalc(leftRaw, ASS_NUMBER, level + 1)) || 0;
                if (!selfHandle) return undefined;
            }
            const inst = this._objectGet(selfHandle);
            if (!inst) return undefined;
            dispatchCls = inst.classDef;
        }
        // Parse the right side: identifier [(args)].
        const op = rightRaw.indexOf('(');
        let memberName, argStr = null;
        if (op >= 0) {
            const cp = this._matchingClose(rightRaw, op);
            memberName = rightRaw.substring(0, op).trim();
            argStr     = (cp > op) ? rightRaw.substring(op + 1, cp) : '';
        } else {
            memberName = rightRaw.trim();
        }
        // Field read?  No parens AND name is a known field in the class.
        if (argStr === null) {
            const inst = this._objectGet(selfHandle);
            if (!inst) return 0;
            const upper = memberName.toUpperCase();
            if (inst.fields.has(upper)) {
                const v = inst.fields.get(upper);
                // Field-name sigil ($) tells us the storage type. ASS_ANY
                // (called from PRINT etc.) must preserve the actual type so
                // a hex-looking string like a wallet address isn't coerced
                // back to a number via Number("0xabc...").
                const isStrField = memberName.endsWith('$');
                if (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING ||
                    (assignType === ASS_ANY && isStrField)) {
                    return String(v == null ? '' : v);
                }
                if (assignType === ASS_ANY) return v;
                return Number(v) || 0;
            }
            return 0;
        }
        // Method call.
        const methodEntry = dispatchCls.methodVtable[memberName.toUpperCase()];
        if (!methodEntry) return 0;
        const args = argStr.trim() ? this._splitTopLevelCommas(argStr).map(a => this._evalArg(a)) : [];
        // The dispatched method runs in the context of its DEFINING class —
        // so MYBASE inside the body correctly walks the parent chain of the
        // method's owner, not the original receiver's class. This is what
        // makes 2-level inheritance (Cat → Mammal → Animal) work without
        // infinite recursion when MYBASE.Init is called from each level.
        const ownerCls = methodEntry.ownerClass || dispatchCls;
        const result = this._dispatchMethod(selfHandle, ownerCls, methodEntry.method, args, isMybase);
        // Method-name sigil ($) determines the return type. Under ASS_ANY
        // (PRINT context), we MUST trust the sigil — otherwise a string
        // result like "0xabc..." gets Number()'d to scientific notation.
        const isStrReturn = methodEntry.method.name.endsWith('$');
        if (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING ||
            (assignType === ASS_ANY && isStrReturn)) {
            return String(result == null ? '' : result);
        }
        if (assignType === ASS_ANY) return result;
        return Number(result) || 0;
    }

    // _meFrame — return the nearest enclosing method frame (or null).
    _meFrame() {
        const stack = this._sub_stack;
        if (!stack) return null;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].isMethod) return stack[i];
        }
        return null;
    }

    // _dispatchMethod — synchronously invoke a class method. Saves+restores
    // the interpreter's run_line / line_remaining around the inline execution
    // so the caller's flow is undisturbed. Returns the function's return
    // value (or undefined for SUBs).
    _dispatchMethod(handle, cls, method, args, isMybase) {
        const k = this;
        const savedRunLine      = k.run_line;
        const savedLineRemaining = k.line_remaining;
        const savedIfLine        = k.if_line;
        k.line_remaining = '';
        k.if_line        = '';
        const entryLine = k._enterMethodFrame(handle, cls, method, args, isMybase);
        if (entryLine < 0) {
            // Failed to enter — restore and return.
            k.run_line       = savedRunLine;
            k.line_remaining = savedLineRemaining;
            k.if_line        = savedIfLine;
            return undefined;
        }
        // Inline-body form: the SUB/FUNCTION declaration, body, and END SUB
        // are all on the same physical line ("SUB N(x) : body : END SUB").
        // _scanClasses extracted the body text — interpret it as a single
        // multi-statement line.
        if (method.inlineBody !== null && method.inlineBody !== undefined) {
            let body = method.inlineBody;
            // Walk colon-separated statements, paren-aware, quote-aware.
            const stmts = [];
            let depth = 0, inQ = false, start = 0;
            for (let i = 0; i < body.length; i++) {
                const c = body[i];
                if (c === '"') { inQ = !inQ; continue; }
                if (inQ) continue;
                if (c === '(') { depth++; continue; }
                if (c === ')') { depth--; continue; }
                if (c === ':' && depth === 0) {
                    stmts.push(body.substring(start, i).trim());
                    start = i + 1;
                }
            }
            stmts.push(body.substring(start).trim());
            for (const stmt of stmts) {
                if (!stmt) continue;
                k.run_line = method.startLine;
                k.interpret(stmt);
            }
            const popped = k._exitMethodFrame();
            const result = popped ? popped.funcResult : undefined;
            k.run_line       = savedRunLine;
            k.line_remaining = savedLineRemaining;
            k.if_line        = savedIfLine;
            return result;
        }
        // Step from entryLine+1 until we hit END SUB / END FUNCTION,
        // pop the frame, and return the result.
        const sortedLines = [...k.lines_assigned].sort((a, b) => a - b);
        // Find the first line index AFTER method.startLine.
        let pc = -1;
        for (let i = 0; i < sortedLines.length; i++) {
            if (sortedLines[i] > method.startLine) { pc = i; break; }
        }
        if (pc < 0) {
            k._exitMethodFrame();
            k.run_line       = savedRunLine;
            k.line_remaining = savedLineRemaining;
            k.if_line        = savedIfLine;
            return undefined;
        }
        // Execute lines until END SUB/FUNCTION reached. We re-enter interpret()
        // line-by-line. This is a synchronous mini-runner that piggybacks on
        // the existing interpret() machinery without entangling tick().
        const endLineNo = method.endLine;
        const guard = 100000;  // runaway-loop sentinel
        let steps  = 0;
        let curIdx = pc;
        while (steps++ < guard && curIdx < sortedLines.length) {
            const ln = sortedLines[curIdx];
            if (ln >= endLineNo) break;
            k.run_line = ln;
            const txt = k.lines[ln] || '';
            const newLn = k.interpret(txt);
            // Drain any if_line pending from the just-run statement.
            while (k.if_line !== '') {
                const _if = k.if_line; k.if_line = '';
                const r = k.interpret(_if);
                if (r >= 0) { k.run_line = r; }
            }
            if (newLn === -2 || newLn === CMD_END) break;
            if (newLn === -3 /* EXIT SUB sentinel? */ ) break;
            if (newLn !== undefined && newLn !== null && newLn >= 0) {
                // jump — find the new line index
                let nidx = -1;
                for (let i = 0; i < sortedLines.length; i++) {
                    if (sortedLines[i] === newLn) { nidx = i; break; }
                }
                if (nidx < 0) break;
                curIdx = nidx;
            } else {
                curIdx++;
            }
        }
        const popped = k._exitMethodFrame();
        const result = popped ? popped.funcResult : undefined;
        k.run_line       = savedRunLine;
        k.line_remaining = savedLineRemaining;
        k.if_line        = savedIfLine;
        return result;
    }

    getElement(variableName) {
        const parenOpen  = variableName.indexOf('(');
        if (parenOpen < 0) return 0;
        const parenClose = this._matchingClose(variableName, parenOpen);
        if (parenClose < 0) return 0;

        const inner = variableName.substring(parenOpen + 1, parenClose);
        const baseName = variableName.substring(0, parenOpen);
        return this._evalArrayIndex(inner, baseName);
    }

    // -----------------------------------------------------------------------
    // assign_  –  low-level store. Uses Maps for O(1) lookup.
    // -----------------------------------------------------------------------
    assign_(varType, variableName, variableValue) {
        // Variable names are case-sensitive (Model B). Trim only.
        variableName = variableName.trim();

        // For arrays, extract base name and element index. Use _matchingClose
        // so nested calls like TANK(TARGETID(P), 1) resolve to the OUTER `)`.
        let element = 0;
        if (varType === ASS_ARRAY_NUMBER || varType === ASS_ARRAY_STRING) {
            const parenOpen  = variableName.indexOf('(');
            const parenClose = parenOpen >= 0 ? this._matchingClose(variableName, parenOpen) : -1;
            if (parenClose > parenOpen) {
                const inner = variableName.substring(parenOpen + 1, parenClose);
                element = this._evalArrayIndex(inner, variableName.substring(0, parenOpen));
            }
            variableName = variableName.substring(0, parenOpen < 0 ? variableName.length : parenOpen);
            if (!this._arrMax) this._arrMax = {};
            const key = varType + ':' + variableName;
            if (element > (this._arrMax[key] || 0)) this._arrMax[key] = element;
        }

        switch (varType) {
            case ASS_NUMBER:
                this.variables_numbers.set(variableName, variableValue);
                break;
            case ASS_STRING:
                this.variables_strings.set(variableName, variableValue);
                break;
            case ASS_ARRAY_NUMBER: {
                let arr = this.variables_arr_numbers.get(variableName);
                if (!arr) { arr = []; this.variables_arr_numbers.set(variableName, arr); }
                arr[element] = variableValue;
                break;
            }
            case ASS_ARRAY_STRING: {
                let arr = this.variables_arr_strings.get(variableName);
                if (!arr) { arr = []; this.variables_arr_strings.set(variableName, arr); }
                arr[element] = variableValue;
                break;
            }
            case ASS_FUNCTION:
                // Functions still use the legacy array (rarely written)
                for (const entry of this.variables_func) {
                    if (entry[0] === variableName) { entry[1] = variableValue; return; }
                }
                this.variables_func.push([variableName, variableValue]);
                break;
            default:
                this.variables_numbers.set(variableName, variableValue);
        }
    }

    // -----------------------------------------------------------------------
    // assign  –  high-level store; infers type from the variable name.
    // -----------------------------------------------------------------------
    assign(variableName, rightSide) {
        const iAssType = this.getAssignType(variableName);
        this.assign_(iAssType, variableName, rightSide);
    }

    // -----------------------------------------------------------------------
    // lookup_  –  low-level variable / function lookup.
    // -----------------------------------------------------------------------
    lookup_(type, variableName, element) {
        // Variable names are case-sensitive (Model B). Keep `variableName` in
        // its original case for storage Map lookups and string-content
        // extraction. Use `nameU` separately for matching built-in keywords
        // (function names, numeric/string special variables) — those remain
        // case-insensitive because they're language keywords, not identifiers.

        // OPT-H: fast path for hot-loop variables like I, X, SUM, COUNT.
        // Skip String/trim/Number checks when we know it's a user variable
        // (not a built-in name like TIMER, INKEY, WIDTH, etc.)
        if (typeof variableName === 'string' && variableName.length > 0 &&
            type === ASS_NUMBER && element === undefined &&
            !Compiler._BUILTIN_NUM_NAMES.has(variableName)) {
            // Only take the shortcut for simple identifier chars (no trim needed).
            let allValid = true;
            const len = variableName.length;
            const fc0 = variableName.charCodeAt(0);
            if ((fc0 >= 65 && fc0 <= 90) || (fc0 >= 97 && fc0 <= 122) || fc0 === 95) {
                for (let i = 1; i < len; i++) {
                    const cc = variableName.charCodeAt(i);
                    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
                          (cc >= 48 && cc <= 57) || cc === 95 || cc === 46)) {
                        allValid = false; break;
                    }
                }
                if (allValid) {
                    const val = this.variables_numbers.get(variableName);
                    if (val !== undefined) return val;
                    // Not set: returns 0 per BASIC semantics for numeric vars
                    return 0;
                }
            }
        }

        variableName = String(variableName).trim();
        const nameU = variableName.toUpperCase();

        // Immediately return plain numbers.
        const asNum = Number(variableName);
        if (!Number.isNaN(asNum) && variableName !== '') return asNum;

        switch (type) {
            case ASS_NUMBER: {
                // Built-in numeric variables — keyword match, case-insensitive.
                switch (nameU) {
                    case 'UPTIME':    return (Date.now() - this.dStartTime) / 1000;
                    case 'SECONDS':   return Date.now() / 1000;
                    case 'TIMER':     return Math.round(performance.now());
                    case 'WS.STATUS': return this._wsStatus || 0;
                    case 'WINDOW.PID': return this._winDrv ? this._winDrv.lastPid : 0;
                    case 'DEVICE':    { const ua=navigator.userAgent||''; const t=navigator.maxTouchPoints>0; const w=window.innerWidth; if(/Mobi|Android|iPhone/i.test(ua)||(t&&w<768)) return 1; if(t&&w<1200) return 2; return 0; }
                    case 'SCREENW':   return window.innerWidth;
                    case 'SCREENH':   return window.innerHeight;
                    case 'COLS':      return Number(this.cols);
                    case 'ROWS':      return Number(this.rows);
                    case 'WIDTH':     return this.canvas ? Number(this.canvas.width)  : 0;
                    case 'HEIGHT':    return this.canvas ? Number(this.canvas.height) : 0;
                    // LINES — count of non-empty lines in the current program
                    case 'LINES': {
                        if (!this.lines) return 0;
                        let n = 0;
                        for (let i = 0; i < this.lines.length; i++) {
                            if (this.lines[i] && this.lines[i] !== '') n++;
                        }
                        return n;
                    }
                    // MAXLINE — highest line number in the current program
                    case 'MAXLINE': {
                        if (!this.lines) return 0;
                        for (let i = this.lines.length - 1; i >= 0; i--) {
                            if (this.lines[i] && this.lines[i] !== '') return i;
                        }
                        return 0;
                    }
                    case 'CSRLIN': return Number(this.current_line);
                    case 'ERL':    return Number(this._last_erl || 0);
                    case 'ERR':    return Number(this._last_err || 0);
                    case 'INKEY': {
                        const k = this.last_key_pressed;
                        this.last_key_pressed = 0;
                        return k;
                    }
                    case 'KEYDOWN': {
                        // KEYDOWN — returns 1 if any key is currently held, 0 otherwise.
                        // Use as a variable (no args) to check any key, or KEYDOWN(n) for specific keycode.
                        return (Object.keys(this._keysHeld || {}).length > 0) ? 1 : 0;
                    }
                    case 'GL.MESHID': return this._gl ? (this._gl.lastId || 0) : 0;
                    case 'GL.PROBEY': return this._gl ? (this._gl._probeY || 0) : 0;
                    case 'GL.SCANY':  return this._gl ? (this._gl._scanY || 0) : 0;
                    case 'GL.SCAND':  return this._gl ? (this._gl._scanD || 0) : 0;
                    case 'GL.SCANS':  return this._gl ? (this._gl._scanS || 0) : 0;
                    case 'GL.HITID':  return this._gl ? (this._gl._obstHitID !== undefined ? this._gl._obstHitID : -1) : -1;
                    case 'GL.HITDIST': return this._gl ? (this._gl._obstHitDist || 0) : 0;
                    case 'GL.OBSTID': return this._gl ? (this._gl._lastObstId !== undefined ? this._gl._lastObstId : -1) : -1;
                    case 'AIG_YAW':   return this._gl ? (this._gl._navYaw   || 0) : 0;
                    case 'AIG_PITCH': return this._gl ? (this._gl._navPitch || 0) : 0;
                    case 'AIG_BOOST': return this._gl ? (this._gl._navBoost || 0) : 0;
                    case 'AIG_SEV':   return this._gl ? (this._gl._navSev   || 0) : 0;
                    // Wallet (Stage 1) — see docs/OSaware Wallet.pdf.
                    case 'WALLET.CHAINID':    return this._walletDrv ? this._walletDrv.walletChainId()   : 0;
                    case 'WALLET.BALANCE':    return this._walletDrv ? this._walletDrv.walletBalance()   : 0;
                    case 'WALLET.CONNECTED':  return this._walletDrv ? this._walletDrv.walletConnected() : 0;
                    case 'WALLET.TOKENCOUNT': return this._walletDrv ? this._walletDrv.walletTokenCount(): 0;
                }

                // Numeric built-in functions  e.g. ABS(…), RND(…) …
                if (variableName.includes('(')) {
                    const upper = variableName.toUpperCase();
                    // rawArg preserves original case so identifiers like RND(maxN) and
                    // ASC(name$) resolve to case-sensitive variables correctly.
                    // numArg is computed from rawArg and only matters when the arg is
                    // a plain number literal — case is irrelevant in that case.
                    const rawArg  = this.extractValue(variableName, 1);
                    let   numArg  = this.extractValue(variableName, 0);
                    const numVal  = Number(rawArg);
                    if (!Number.isNaN(numVal) && rawArg !== '') numArg = numVal;

                    // OBJECT property read functions: OBJECT.X(id), OBJECT.Y(id), etc.
                    const objFuncs = {
                        'OBJECT.X(': 'x', 'OBJECT.Y(': 'y',
                        'OBJECT.VX(': 'vx', 'OBJECT.VY(': 'vy',
                        'OBJECT.AX(': 'ax', 'OBJECT.AY(': 'ay',
                        'OBJECT.PRIORITY(': 'priority',
                    };
                    for (const [prefix, prop] of Object.entries(objFuncs)) {
                        if (upper.startsWith(prefix)) {
                            const id = Math.floor(Number(this.evalCalc(rawArg, ASS_NUMBER)));
                            const obj = this._objects && this._objects[id];
                            return obj ? Number(obj[prop]) : 0;
                        }
                    }

                    // WALLET.TOKEN(symbol$) — ERC-20 balance from the registry.
                    // symbol can be a string literal "USDC" or a string var X$.
                    if (upper.startsWith('WALLET.TOKEN(')) {
                        if (!this._walletDrv) return 0;
                        const symRaw = this.extractValue(variableName, 1);
                        let sym = '';
                        if (symRaw.startsWith('"')) {
                            const end = symRaw.lastIndexOf('"');
                            if (end > 0) sym = symRaw.slice(1, end);
                        } else {
                            sym = String(this.evalCalc(symRaw, ASS_STRING) || '');
                        }
                        return this._walletDrv.walletToken(sym);
                    }
                    // WALLET.TOKENAT(i) — value of the i-th non-zero token.
                    if (upper.startsWith('WALLET.TOKENAT(')) {
                        if (!this._walletDrv) return 0;
                        const arg = this.extractValue(variableName, 1);
                        const idx = Math.floor(Number(this.evalCalc(arg, ASS_NUMBER)));
                        return this._walletDrv.walletTokenValueAt(idx);
                    }

                    // COLLISION(id) — poll collision queue for a specific object id.
                    if (upper.startsWith('COLLISION(')) {
                        const id = Math.floor(Number(this.evalCalc(rawArg, ASS_NUMBER)));
                        if (!this._collisionQueue) return 0;
                        if (id === 0) {
                            // COLLISION(0) — return id of any object that collided
                            const entry = this._collisionQueue.find(e => true);
                            return entry ? entry.id : 0;
                        }
                        if (id === -1) {
                            // COLLISION(-1) — return window id of last COLLISION(0)
                            return 0;
                        }
                        // COLLISION(id) — return what object id collided with
                        const idx = this._collisionQueue.findIndex(e => e.id === id);
                        if (idx < 0) return 0;
                        const other = this._collisionQueue[idx].other;
                        this._collisionQueue.splice(idx, 1);
                        return other;
                    }

                    if (upper.startsWith('PEEK('))  { const a=Number(numArg)&0xFFFF; return this._memory[a]||0; }
                    if (upper.startsWith('WINDOW.STATUS(')) {
                        return this._winDrv ? this._winDrv.windowStatus(numArg) : 0;
                    }
                    if (upper.startsWith('LAUNCH(')) {
                        // LAUNCH("PROGNAME") — open child window, return PID
                        const rawArg = variableName.slice(7, -1).trim();
                        const progArg = rawArg.startsWith('"') ? rawArg : ('"' + rawArg + '"');
                        return this._winDrv ? this._winDrv.cmdLAUNCH(progArg) : 0;
                    }
                    if (upper.startsWith('PEEKW(')) { const a=Number(numArg)&0xFFFF; return (this._memory[a]||0)|((this._memory[(a+1)&0xFFFF]||0)<<8); }
                    if (upper.startsWith('PEEKL(')) { const a=Number(numArg)&0xFFFF; return ((this._memory[a]||0)|((this._memory[(a+1)&0xFFFF]||0)<<8)|((this._memory[(a+2)&0xFFFF]||0)<<16)|((this._memory[(a+3)&0xFFFF]||0)<<24))>>>0; }
                    if (upper.startsWith('CVI('))   return Number(numArg)&0xFFFF;
                    if (upper.startsWith('CVL('))   return Number(numArg)>>>0;
                    if (upper.startsWith('CVS('))   return Number(numArg);
                    if (upper.startsWith('KEYDOWN(')) {
                        // KEYDOWN(n) — returns 1 if key with keycode n is currently held
                        const kc = Math.round(Number(numArg));
                        return (this._keysHeld && this._keysHeld[kc]) ? 1 : 0;
                    }
                    if (upper.startsWith('CVD('))   return Number(numArg);
                    if (upper.startsWith('ABS('))  return Math.abs(Number(numArg));
                    if (upper.startsWith('SGN('))  return Math.sign(Number(numArg));
                    if (upper.startsWith('ASC(')) {
                        // ASC takes a string arg — use raw string not numArg
                        const s = rawArg.startsWith('"') ? rawArg.slice(1, rawArg.lastIndexOf('"')) : String(this.lookup_(ASS_STRING, rawArg));
                        return s.length > 0 ? s.charCodeAt(0) : 0;
                    }
                    if (upper.startsWith('VAL(')) {
                        const s = (rawArg.startsWith('"') ? rawArg.slice(1, rawArg.lastIndexOf('"')) : String(this.lookup_(ASS_STRING, rawArg))).trimStart();
                        const m = s.match(/^-?[\d.]+/);
                        return m ? Number(m[0]) : 0;
                    }
                    if (upper.startsWith('FIX('))  return Math.trunc(Number(numArg));
                    if (upper.startsWith('CLNG(')) return Math.round(Number(numArg));
                    if (upper.startsWith('CSNG(')) return Number(numArg);
                    if (upper.startsWith('EXP('))  return Math.exp(Number(numArg));
                    if (upper.startsWith('LOG('))  return numArg > 0 ? Math.log(Number(numArg)) : 0;
                    if (upper.startsWith('SIN('))  return Math.sin(Number(numArg));
                    if (upper.startsWith('COS('))  return Math.cos(Number(numArg));
                    if (upper.startsWith('TAN('))  return Math.tan(Number(numArg));
                    if (upper.startsWith('ATN('))  return Math.atan(Number(numArg));
                    if (upper.startsWith('INSTR(')) {
                        // INSTR(haystack$, needle$)  or  INSTR(start, haystack$, needle$)
                        const raw   = this.extractValue(variableName, 1);
                        const parts = raw.split(',');
                        let start = 0, hay, needle;
                        if (parts.length >= 3) {
                            start  = Math.max(0, Number(this.evalCalc(parts[0].trim(), ASS_NUMBER, 0)) - 1);
                            hay    = String(this.getValue(parts[1].trim(), 0, parts[1].trim().length, ASS_STRING));
                            needle = String(this.getValue(parts[2].trim(), 0, parts[2].trim().length, ASS_STRING));
                        } else {
                            hay    = String(this.getValue(parts[0].trim(), 0, parts[0].trim().length, ASS_STRING));
                            needle = String(this.getValue(parts[1].trim(), 0, parts[1].trim().length, ASS_STRING));
                        }
                        const idx = hay.indexOf(needle, start);
                        return idx < 0 ? 0 : idx + 1;  // BASIC is 1-based
                    }
                    if (upper.startsWith('POINT(')) {
                        // POINT(x, y) — return colour index of pixel
                        const raw   = this.extractValue(variableName, 1);
                        const parts = raw.split(',');
                        const px    = Number(this.evalCalc(parts[0].trim(), ASS_NUMBER, 0));
                        const py    = parts.length > 1 ? Number(this.evalCalc(parts[1].trim(), ASS_NUMBER, 0)) : 0;
                        // Read from Three.js pixel buffer if active, else fall back to canvas
                        let d;
                        if (this._gfx) {
                            d = this._gfxRead(px, py);
                        } else if (this.context && this.canvas) {
                            d = this.context.getImageData(px, py, 1, 1).data;
                        } else {
                            return -1;
                        }
                        // Match against colour table; return index or -1 if no match
                        const hex = `#${d[0].toString(16).padStart(2,'0')}${d[1].toString(16).padStart(2,'0')}${d[2].toString(16).padStart(2,'0')}`.toUpperCase();
                        const idx = this.colours.findIndex(c => c.toUpperCase() === hex);
                        return idx >= 0 ? idx : -1;
                    }
                    // MOUSE(n) — Amiga BASIC compatible mouse function
                    if (upper.startsWith('MOUSE(')) {
                        const n = Math.round(Number(numArg));
                        const m = this._mouse || {};
                        switch (n) {
                            case 0: {
                                // Return button status.
                                // -1 (held) persists until mouseup — don't clear it.
                                // Click counts (1, 2) are cleared after reading.
                                const s = m.btn || 0;
                                if (s !== -1) { m.btn = 0; m.pending = 0; }
                                return s;
                            }
                            case 1: return m.x || 0;       // current X
                            case 2: return m.y || 0;       // current Y
                            case 3: return m.pressX || 0;  // press start X
                            case 4: return m.pressY || 0;  // press start Y
                            case 5: return m.releaseX || 0; // release/current X
                            case 6: return m.releaseY || 0; // release/current Y
                            default: return 0;
                        }
                    }

                    if (upper.startsWith('LBOUND(')) return 1;
                    if (upper.startsWith('UBOUND(')) {
                        const uname = rawArg.split(',')[0].trim();
                        if (!this._arrMax) return 0;
                        return this._arrMax[ASS_ARRAY_NUMBER + ':' + uname] ||
                               this._arrMax[ASS_ARRAY_STRING  + ':' + uname] || 0;
                    }
                    if (upper.startsWith('SQR('))  return numArg >= 0 ? Math.sqrt(Number(numArg)) : Math.sqrt(this.lookup_(ASS_NUMBER, String(numArg)));
                    if (upper.startsWith('INT('))  return Math.floor(Number(numArg));  // BASIC INT() floors toward -infinity
                    if (upper.startsWith('LEN(')) {
                        // rawArg preserves original case and quotes; evaluate as string.
                        const lenStr = rawArg.startsWith('"')
                            ? rawArg.slice(1, rawArg.lastIndexOf('"'))
                            : String(this.getValue(rawArg, 0, rawArg.length, ASS_STRING));
                        return lenStr.length;
                    }
                    if (upper.startsWith('RND(')) {
                        // OSAWARE BASIC convention (matches Amiga/C64/home computer BASICs):
                        //   RND(1)  → float 0 <= x < 1
                        //   RND(n)  → integer 0 <= x < n   (n > 1)
                        // This matches all existing programs which use RND(WIDTH), RND(15) etc.
                        const rndN = Math.abs(Number(numArg));
                        return rndN <= 1
                            ? this._seededRandom()
                            : Math.floor(this._seededRandom() * rndN);
                    }
                    // VAL handled above with raw string arg
                    // Unknown function with parens — evaluate the expression inside.
                    return Number(numArg);
                }

                // Fall through to Map lookup below.
                break;
            }

            case ASS_STRING: {
                // Built-in string variables — keyword match, case-insensitive.
                if (nameU === 'TIME$') {
                    const d = new Date();
                    const pad = (n) => String(n).padStart(2, '0');
                    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                }
                if (nameU === 'DATE$') {
                    const d = new Date();
                    const pad = (n) => String(n).padStart(2, '0');
                    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                }
                if (nameU === 'WS.RECV$') return this._wsRecv ? this._wsRecv() : '';
                if (nameU === 'DEVICE$') {
                    const ua = navigator.userAgent || '';
                    const touch = navigator.maxTouchPoints > 0;
                    const w = window.innerWidth;
                    if (/Mobi|Android|iPhone/i.test(ua) || (touch && w < 768)) return 'mobile';
                    if (touch && w < 1200) return 'tablet';
                    return 'desktop';
                }
                if (nameU === 'SCREENW$') return String(window.innerWidth);
                if (nameU === 'SCREENH$') return String(window.innerHeight);
                if (nameU === 'WINDOW.MSG$') return this._winDrv ? this._winDrv.lastMsg : '';
                if (nameU === 'WINDOW.ISCHILD$') return (this._winDrv && this._winDrv.isChild) ? '1' : '0';
                if (nameU === 'WHOAMI$') {
                    if (typeof window === 'undefined' || !window.AuthService) return 'local';
                    const u = window.AuthService.currentUser();
                    return u ? u : 'local';
                }
                if (nameU === 'DEVWHOAMI$') {
                    if (typeof window === 'undefined' || !window.AuthService) return '(no dev session)';
                    const u = window.AuthService.devCurrentUser();
                    return u ? u : '(no dev session)';
                }
                // Wallet (Stage 1) — see docs/OSaware Wallet.pdf.
                if (nameU === 'WALLET$')         return this._walletDrv ? this._walletDrv.walletAddress()       : '';
                if (nameU === 'WALLET.NETWORK$') return this._walletDrv ? this._walletDrv.walletNetworkName()   : '';
                if (nameU === 'WALLET.SYMBOL$')  return this._walletDrv ? this._walletDrv.walletSymbol()        : '';
                if (nameU === 'WALLET.TOKENS$')  return this._walletDrv ? this._walletDrv.walletTokensJoined()  : '';

                // String built-in functions.
                if (variableName.includes('(')) {
                    const upper = variableName.toUpperCase();

                    // WALLET.TOKENSYMBOL$(i) — symbol of the i-th non-zero token.
                    if (upper.startsWith('WALLET.TOKENSYMBOL$(')) {
                        if (!this._walletDrv) return '';
                        const arg = this.extractValue(variableName, 1);
                        const idx = Math.floor(Number(this.evalCalc(arg, ASS_NUMBER)));
                        return this._walletDrv.walletTokenSymbol(idx);
                    }

                    if (upper.startsWith('ENVIRON$(')) {
                    const key = this.extractValue(variableName, 1).replace(/^"|"$/g,'');
                    return ({'BROWSER':navigator.userAgent,'PLATFORM':navigator.platform,'LANGUAGE':navigator.language,'URL':location.href}[key.toUpperCase()]||'');
                }
                if (upper.startsWith('SPC(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                    return ' '.repeat(Math.max(0, n));
                }
                if (upper.startsWith('MKI$(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0)) & 0xFFFF;
                    return String.fromCharCode(n & 0xFF, (n >> 8) & 0xFF);
                }
                if (upper.startsWith('MKL$(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0)) >>> 0;
                    return String.fromCharCode(n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF);
                }
                if (upper.startsWith('MKS$(') || upper.startsWith('MKD$(')) {
                    return String(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                }
                if (upper.startsWith('UCASE$(')) {
                    const r = this.extractValue(variableName, 1);
                    return String(this.getValue(r, 0, r.length, ASS_STRING)).toUpperCase();
                }
                if (upper.startsWith('LCASE$(')) {
                    const r = this.extractValue(variableName, 1);
                    return String(this.getValue(r, 0, r.length, ASS_STRING)).toLowerCase();
                }
                if (upper.startsWith('SPACE$(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                    return ' '.repeat(Math.max(0, n));
                }
                if (upper.startsWith('STRING$(')) {
                    const raw   = this.extractValue(variableName, 1);
                    const parts = raw.split(',');
                    const n     = Number(this.getValue(parts[0], 0, parts[0].length, ASS_NUMBER));
                    const chVal = parts.length > 1
                        ? (Number(parts[1]) > 0
                            ? String.fromCharCode(Number(parts[1]))
                            : String(this.getValue(parts[1], 0, parts[1].length, ASS_STRING))[0] || ' ')
                        : ' ';
                    return chVal.repeat(Math.max(0, n));
                }
                if (upper.startsWith('HEX$(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                    return Math.trunc(Math.abs(n)).toString(16).toUpperCase();
                }
                if (upper.startsWith('OCT$(')) {
                    const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                    return Math.trunc(Math.abs(n)).toString(8);
                }
                if (upper.startsWith('CENTER$(')) {
                        const raw   = this.extractValue(variableName, 1);
                        const parts = raw.split(',');
                        let text    = parts[0];
                        let cols    = this.cols;
                        if (parts.length > 1) {
                            const n = Number(parts[1]);
                            cols = (!Number.isNaN(n) && n > 0) ? n : this.lookup_(ASS_NUMBER, parts[1]);
                        }
                        text = text.startsWith('"')
                            ? text.slice(1, text.lastIndexOf('"'))
                            : String(this.lookup_(ASS_STRING, text));
                        const padLen = Math.floor((cols - text.length) / 2);
                        return ' '.repeat(Math.max(0, padLen)) + text +
                               ' '.repeat(Math.max(0, cols - padLen - text.length));
                    }
                    if (upper.startsWith('UPPER$(')) {
                        const raw = this.extractValue(variableName, 1);
                        return String(this.getValue(raw, 0, raw.length, ASS_STRING)).toUpperCase();
                    }
                    if (upper.startsWith('LOWER$(')) {
                        const raw = this.extractValue(variableName, 1);
                        return String(this.getValue(raw, 0, raw.length, ASS_STRING)).toLowerCase();
                    }
                    if (upper.startsWith('MID$(')) {
                        // Quote-aware comma split so MID$(A$+",",2,1) works correctly.
                        // Pull from variableName (original case) so string literal contents
                        // and variable names like a$ vs A$ survive.
                        const raw = this.extractValue(variableName, 1);
                        const parts = [];
                        let inQ = false, start = 0;
                        for (let ci = 0; ci <= raw.length; ci++) {
                            if (raw[ci] === '"') { inQ = !inQ; continue; }
                            if (!inQ && (raw[ci] === ',' || ci === raw.length)) {
                                parts.push(raw.substring(start, ci).trim());
                                start = ci + 1;
                            }
                        }
                        const str = String(this.evalCalc(parts[0] || '', ASS_STRING));
                        let startIdx = 0, length = str.length;
                        if (parts.length > 1) startIdx = Math.floor(Number(this.evalCalc(parts[1], ASS_NUMBER))) - 1;
                        if (parts.length > 2) length   = Math.floor(Number(this.evalCalc(parts[2], ASS_NUMBER)));
                        return str.substr(Math.max(0, startIdx), Math.max(0, length));
                    }
                    if (upper.startsWith('STR$(')) {
                        const raw = this.extractValue(upper, 1);
                        return String(this.getValue(raw, 0, raw.length, ASS_NUMBER));
                    }
                    if (upper.startsWith('VFSGET$(')) {
                        // VFSGET$("path") — retrieve a VFS text file or asset as a string.
                        // Pull from variableName (original case), not upper — VFS paths
                        // are case-sensitive and must reach the lookup verbatim.
                        const raw = this.extractValue(variableName, 1);
                        const pathArg = String(this.evalCalc(raw, ASS_STRING)).replace(/^"|"$/g, '');
                        // Check text files first, then assets
                        const _txt = this.fs ? this.fs.getTextFile(pathArg) : null;
                        if (_txt !== null) return _txt;
                        if (this.fs && !pathArg.includes('/')) {
                            const _txt2 = this.fs.getTextFile('TEXT/' + pathArg.toUpperCase());
                            if (_txt2 !== null) return _txt2;
                        }
                        return (this.fs && this.fs.getAsset(pathArg)) || '';
                    }
                    if (upper.startsWith('FOLDEREXISTS$(')) {
                        // FOLDEREXISTS$("path") — case-SENSITIVE folder existence check.
                        // Returns "1" if any VFS entry lives under the prefix, else "0".
                        // String return so it composes inside IF: IF FOLDEREXISTS$("test")="1" THEN ...
                        // Pull from variableName (original case) — see VFSGET$ note above.
                        const raw = this.extractValue(variableName, 1);
                        const pathArg = String(this.evalCalc(raw, ASS_STRING)).replace(/^"|"$/g, '');
                        return (this.fs && this.fs.folderExists(pathArg)) ? '1' : '0';
                    }
                    if (upper.startsWith('CHR$(')) {
                        const code = Number(this.extractValue(upper, 0));
                        return String.fromCharCode(code);
                    }
                    if (upper.startsWith('RIGHT$(')) {
                        // Pull from variableName (original case) — see MID$ note.
                        const raw   = this.extractValue(variableName, 1);
                        const ci    = raw.indexOf(',');
                        const str   = ci >= 0 ? String(this.evalCalc(raw.substring(0, ci).trim(), ASS_STRING)) : String(this.lookup(raw));
                        const len   = ci >= 0 ? Math.floor(Number(this.evalCalc(raw.substring(ci+1).trim(), ASS_NUMBER))) : str.length;
                        return str.slice(-Math.max(0, len));
                    }
                    if (upper.startsWith('LEFT$(')) {
                        // Pull from variableName (original case) — see MID$ note.
                        const raw   = this.extractValue(variableName, 1);
                        const ci    = raw.indexOf(',');
                        const str   = ci >= 0 ? String(this.evalCalc(raw.substring(0, ci).trim(), ASS_STRING)) : String(this.lookup(raw));
                        const len   = ci >= 0 ? Math.floor(Number(this.evalCalc(raw.substring(ci+1).trim(), ASS_NUMBER))) : str.length;
                        return str.substring(0, Math.max(0, len));
                    }
                    if (upper.startsWith('TAB$(')) {
                        const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                        return ' '.repeat(Math.max(0, n));
                    }
                    if (upper.startsWith('LINES$(')) {
                        const n = Number(this.evalCalc(this.extractValue(upper, 1), ASS_NUMBER, 0));
                        return '\n'.repeat(Math.max(0, n));
                    }
                }

                // Fall through to Map lookup below.
                break;
            }

            case ASS_ARRAY_NUMBER:
            case ASS_ARRAY_STRING:
            case ASS_FUNCTION:
                break;  // handled by Map lookup below

            default:
                return 0;
        }

        // Search the variable store (O(1) Map lookup).
        const elem = element ?? 0;
        switch (type) {
            case ASS_NUMBER: {
                const v = this.variables_numbers.get(variableName);
                return v !== undefined ? Number(v) : 0;
            }
            case ASS_STRING: {
                const v = this.variables_strings.get(variableName);
                return v !== undefined ? String(v) : '';
            }
            case ASS_ARRAY_NUMBER: {
                const arr = this.variables_arr_numbers.get(variableName);
                if (arr) return Number(arr[elem] ?? 0);
                // Check DEF FN table
                for (const entry of this.variables_func) {
                    if (entry[0] === variableName) {
                        const expr = String(entry[1]).replace(/\btoken\b/g, String(elem));
                        this.parseAssign(`func_result=${expr}`);
                        return Number(this.lookup('func_result'));
                    }
                }
                return 0;
            }
            case ASS_ARRAY_STRING: {
                const arr = this.variables_arr_strings.get(variableName);
                return arr ? String(arr[elem] ?? '') : '';
            }
        }
    }

    // -----------------------------------------------------------------------
    // lookup  –  high-level variable lookup; infers type from the name.
    // -----------------------------------------------------------------------
    lookup(variableName) {
        const varType = this.getAssignType(variableName);
        const element = this.getElement(variableName);
        const parenOpen = variableName.indexOf('(');

        if (varType !== ASS_ARRAY_NUMBER && varType !== ASS_ARRAY_STRING) {
            return this.lookup_(varType, variableName);
        }
        return this.lookup_(varType, parenOpen > 0 ? variableName.substring(0, parenOpen) : variableName, element);
    }

    // -----------------------------------------------------------------------
    // findFirstOperator  –  locate the leftmost top-level operator.
    // FIX: parenthesis depth is now a counter (was a 0/1 toggle, broke
    //      on nested parens like ((1+2)*3)).
    // -----------------------------------------------------------------------
    findFirstOperator(expr) {
        // Find the LOWEST priority top-level operator (rightmost in precedence).
        // This is the outermost split point for correct recursive evaluation.
        // e.g. "ZR*ZR-ZI*ZI+CR" → finds + (lowest), splits into "ZR*ZR-ZI*ZI" and "CR".
        // Scan right-to-left so the leftmost lowest-priority operator is found
        // (for left-to-right evaluation of equal-priority operators).
        let operPos  = -1;
        let operType = OPER_NONE;
        let depth    = 0;
        let inQuotes = false;

        // First pass: find minimum (lowest) priority among all top-level operators
        let minPriority = OPER_POW + 1;
        for (let i = 0; i < expr.length; i++) {
            const ch = expr[i];
            if (ch === '"') { inQuotes = !inQuotes; continue; }
            if (inQuotes) continue;
            if (ch === '(') { depth++; continue; }
            if (ch === ')') { depth--; continue; }
            if (depth !== 0) continue;
            let p = 0;
            if (ch === '+') p = OPER_PLUS;
            else if (ch === '-') p = OPER_MINUS;
            else if (ch === '%') p = OPER_MODULO;
            else if (ch === '/') p = OPER_DIV;
            else if (ch === '*') p = OPER_MUL;
            else if (ch === '^') p = OPER_POW;
            if (p > 0 && p < minPriority) minPriority = p;
        }
        if (minPriority > OPER_POW) return null;

        // Second pass: find the LAST occurrence of that lowest-priority operator
        // (gives left-to-right evaluation for equal-priority ops like a-b-c).
        inQuotes = false; depth = 0;
        for (let i = 0; i < expr.length; i++) {
            const ch = expr[i];
            if (ch === '"') { inQuotes = !inQuotes; continue; }
            if (inQuotes) continue;
            if (ch === '(') { depth++; continue; }
            if (ch === ')') { depth--; continue; }
            if (depth !== 0) continue;
            let p = 0;
            if (ch === '+') p = OPER_PLUS;
            else if (ch === '-') p = OPER_MINUS;
            else if (ch === '%') p = OPER_MODULO;
            else if (ch === '/') p = OPER_DIV;
            else if (ch === '*') p = OPER_MUL;
            else if (ch === '^') p = OPER_POW;
            if (p === minPriority) { operPos = i; operType = p; }
        }

        if (operType === OPER_NONE) return null;
        return [operPos, operType];
    }

    // -----------------------------------------------------------------------
    // getValue  –  extract a single value (literal, variable, or sub-expr).
    // FIX: the old `if (!Number(sNumber))` coerced "0" to falsy, treating the
    //      literal zero as an unresolved variable name.  Now uses isNaN check.
    // -----------------------------------------------------------------------
    getValue(str, start, length, valType) {
        const s = str.substr(start, length).trim();
        const isStrType = valType === ASS_STRING || valType === ASS_ARRAY_STRING;
        if (!s) return isStrType ? '' : 0;

        // NOT prefix operator
        const s0 = s.charCodeAt(0);

        // Fast numeric literal check — most loop variables are numbers.
        if ((s0 >= 48 && s0 <= 57) || (s0 === 45 && s.length > 1)) {
            const asNum = Number(s);
            if (!Number.isNaN(asNum)) return isStrType ? String(asNum) : asNum;
        }

        // String literal.
        if (s0 === 34) { // '"'
            if (isStrType || valType === ASS_ANY)
                return s.slice(1, s.lastIndexOf('"'));
        }

        // NOT prefix operator
        if (s0 === 78 && s.substring(0,4).toUpperCase() === 'NOT ') {
            return ~Math.trunc(Number(this.evalCalc(s.substring(4).trim(), ASS_NUMBER, 0)));
        }

        // Parenthesised sub-expression.
        if (s0 === 40 && (valType === ASS_NUMBER || valType === ASS_ANY)) { // '('
            const inner = s.slice(1, s.lastIndexOf(')'));
            const result = this.evalCalc(inner, ASS_NUMBER, 0);
            if (result != null) return Number(result);
        }

        // Numeric literal fallback.
        if (s0 !== 34 && s0 !== 40) {
            const asNum = Number(s);
            if (!Number.isNaN(asNum) && s !== '') return isStrType ? String(asNum) : asNum;
        }

        // OOP: handle obj.field / obj.method() BEFORE the flat lookup, so
        // that PRINT'ing a method result (e.g. PRINT wallet.Address$())
        // dispatches via the vtable instead of being misread as a string
        // array variable named "wallet.Address$".
        if (this._findToplevelMemberDot) {
            const dotIdx = this._findToplevelMemberDot(s);
            if (dotIdx >= 0 && typeof this._evalMemberExpr === 'function') {
                const oopResult = this._evalMemberExpr(s, dotIdx, valType, 0);
                if (oopResult !== undefined) return oopResult;
            }
        }

        // Variable or function call.
        // If ASS_ANY and the identifier ends with $ or is a known string function,
        // delegate to ASS_STRING so STR$(), LEFT$() etc. work correctly.
        if (valType === ASS_ANY) {
            const sU = s.toUpperCase();
            const isStrFn = sU.startsWith('STR$(') || sU.startsWith('LEFT$(') ||
                            sU.startsWith('RIGHT$(') || sU.startsWith('MID$(') ||
                            sU.startsWith('CHR$(') || sU.startsWith('HEX$(') ||
                            sU.startsWith('UPPER$(') || sU.startsWith('LOWER$(') ||
                            sU.startsWith('SPACE$(') || sU.startsWith('TAB$(') ||
                            (s.includes('$') && s.includes('('));
            if (isStrFn) return this.getValue(s, 0, s.length, ASS_STRING);
        }
        return this.lookup(s);
    }

    // -----------------------------------------------------------------------
    // Expression parse tree cache — parse once, evaluate many times.
    //
    // _parseExprTree(s) → AST node:
    //   {t:'n', v:number}          — numeric literal
    //   {t:'s', v:string}          — string literal
    //   {t:'v', v:'VARNAME'}       — numeric variable
    //   {t:'vs', v:'VARNAME$'}     — string variable
    //   {t:'op', op:prec, l, r}    — binary operator
    //   {t:'neg', c}               — unary minus
    //   {t:'raw', v:string}        — fallback: evaluate with getValue
    //
    // _evalExprTree(node) → value
    // -----------------------------------------------------------------------
    _parseExprTree(s) {
        s = s.trim();
        if (!s) return {t:'n', v:0};

        // Numeric literal
        const fc = s.charCodeAt(0);
        if (fc >= 48 && fc <= 57) {
            const n = Number(s);
            if (!Number.isNaN(n)) return {t:'n', v:n};
        }

        // Negative numeric literal
        if (fc === 45 && s.length > 1) {
            const n = Number(s);
            if (!Number.isNaN(n)) return {t:'n', v:n};
        }

        // String literal
        if (fc === 34 && s[s.length-1] === '"' && s.indexOf('"',1) === s.length-1) {
            return {t:'s', v:s.slice(1,-1)};
        }

        // Strip outer parens
        if (fc === 40 && s[s.length-1] === ')') {
            let d = 0, allWrapped = true;
            for (let i = 0; i < s.length-1; i++) {
                if (s[i] === '(') d++;
                else if (s[i] === ')') d--;
                if (d === 0) { allWrapped = false; break; }
            }
            if (allWrapped) return this._parseExprTree(s.slice(1,-1));
        }

        // Unary minus
        if (fc === 45 && s.length > 1) {
            return {t:'neg', c: this._parseExprTree(s.slice(1).trim())};
        }

        // Find lowest-priority top-level operator
        let bestPos = -1, bestPrec = 999, depth = 0, inQuote = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '"') { inQuote = !inQuote; continue; }
            if (inQuote) continue;
            if (ch === '(') { depth++; continue; }
            if (ch === ')') { depth--; continue; }
            if (depth !== 0) continue;
            let prec = 0;
            if      (ch === '+') prec = OPER_PLUS;
            else if (ch === '-' && i > 0) prec = OPER_MINUS;
            else if (ch === '%') prec = OPER_MODULO;
            else if (ch === '/') prec = OPER_DIV;
            else if (ch === '*') prec = OPER_MUL;
            else if (ch === '^') prec = OPER_POW;
            if (prec > 0 && prec <= bestPrec) { bestPrec = prec; bestPos = i; }
        }

        if (bestPos >= 0) {
            const left  = s.substring(0, bestPos).trim();
            const right = s.substring(bestPos + 1).trim();
            return {t:'op', op:bestPrec,
                    l: this._parseExprTree(left),
                    r: this._parseExprTree(right)};
        }

        // Simple variable name (all alpha/digit/$)
        if (s.length <= 16) {
            let simple = true;
            for (let ci = 0; ci < s.length; ci++) {
                const cc = s.charCodeAt(ci);
                if (!((cc>=65&&cc<=90)||(cc>=97&&cc<=122)||cc===36||cc===95||
                      (ci>0&&cc>=48&&cc<=57))) { simple=false; break; }
            }
            if (simple) {
                // Variable names are case-sensitive; preserve original case in the AST.
                return s[s.length-1]==='$' ? {t:'vs',v:s} : {t:'v',v:s};
            }
        }

        // Fallback: use getValue for functions, arrays, etc.
        return {t:'raw', v:s};
    }

    _evalExprTree(node, assignType) {
        switch (node.t) {
            case 'n':  return node.v;
            case 's':  return node.v;
            case 'v':  return (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING) ? this.lookup_(ASS_STRING, node.v) : this.lookup_(ASS_NUMBER, node.v);
            case 'vs': return this.lookup_(ASS_STRING, node.v);
            case 'neg': return -Number(this._evalExprTree(node.c, ASS_NUMBER));
            case 'raw': return this.getValue(node.v, 0, node.v.length, assignType);
            case 'op': {
                const l = this._evalExprTree(node.l, assignType);
                const r = this._evalExprTree(node.r, assignType);
                switch (node.op) {
                    case OPER_PLUS:
                        if (assignType===ASS_STRING||assignType===ASS_ARRAY_STRING)
                            return String(l)+String(r);
                        if (assignType===ASS_ANY &&
                            (typeof l==='string'||typeof r==='string'||
                             Number.isNaN(Number(l))||Number.isNaN(Number(r))))
                            return String(l)+String(r);
                        return Number(l)+Number(r);
                    case OPER_MINUS:  return Number(l)-Number(r);
                    case OPER_MUL:    return Number(l)*Number(r);
                    case OPER_DIV:    return Number(r)!==0 ? Number(l)/Number(r) : 0;
                    case OPER_MODULO: return Number(r)!==0 ? Number(l)%Number(r) : 0;
                    case OPER_POW:    return Math.pow(Number(l),Number(r));
                    default:          return l;
                }
            }
        }
        return 0;
    }

    // -----------------------------------------------------------------------
    // evalCalc  –  recursive expression evaluator respecting operator precedence.
    // -----------------------------------------------------------------------

    // Volatile built-ins that must never be cached (their value changes each call)
    static get _VOLATILE() {
        return _VOLATILE_SET || (_VOLATILE_SET = new Set([
            'TIMER','INKEY','SECONDS','RND','MOUSE','KEYDOWN',
            'COLLISION','WS.STATUS','CSRLIN','ERL','ERR',
            'GL.MESHID','GL.PROBEY','GL.SCANY','GL.SCAND','GL.SCANS','GL.HITID','GL.HITDIST','GL.OBSTID',
            'AIG_YAW','AIG_PITCH','AIG_BOOST','AIG_SEV','LINES','MAXLINE',
            'WALLET','WALLET$','WALLET.CHAINID','WALLET.BALANCE','WALLET.CONNECTED','WALLET.NETWORK$','WALLET.SYMBOL$','WALLET.TOKENS$','WALLET.TOKENCOUNT'
        ]));
    }

    // OPT-H: set of all-uppercase built-in numeric identifier names.
    // Used by lookup_ to gate the fast path: if a name is in this set,
    // we must go through the switch (not direct Map lookup) because the
    // value is computed dynamically, not stored as a user variable.
    static get _BUILTIN_NUM_NAMES() {
        return _BUILTIN_NUM_NAMES_SET || (_BUILTIN_NUM_NAMES_SET = new Set([
            'UPTIME','SECONDS','TIMER','WS.STATUS','WINDOW.PID','DEVICE',
            'SCREENW','SCREENH','COLS','ROWS','WIDTH','HEIGHT',
            'LINES','MAXLINE','INKEY','RND','MOUSE','KEYDOWN','COLLISION',
            'CSRLIN','ERL','ERR','GL.MESHID','GL.PROBEY','GL.SCANY','GL.SCAND','GL.SCANS','GL.HITID','GL.HITDIST','GL.OBSTID',
            'AIG_YAW','AIG_PITCH','AIG_BOOST','AIG_SEV','PI','TRUE','FALSE',
            'WALLET.CHAINID','WALLET.BALANCE','WALLET.CONNECTED','WALLET.TOKENCOUNT'
        ]));
    }

    evalCalc(calculation, assignType, level = 0) {
        const s = calculation.trim();
        if (!s) return (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING) ? '' : 0;

        // ── OOP pre-checks (must run BEFORE the expression cache because
        //     they introduce side effects — NEW allocates, method calls run
        //     user code, etc.). The patterns we recognise are:
        //
        //       NOTHING                       — the null-handle literal
        //       NEW ClassName(args)           — instantiate, returns handle
        //       expr1 IS expr2                — reference equality
        //       obj.field                     — member read
        //       obj.method(args)              — method-call expression
        //
        //   _findToplevelIS / _findToplevelDot / _findMatchingClose are
        //   paren-aware so nested calls don't trip them.
        // ───────────────────────────────────────────────────────────────────
        const sUpper = s.toUpperCase();
        if (sUpper === 'NOTHING') return 0;
        if (sUpper.startsWith('NEW ') || sUpper.startsWith('NEW\t')) {
            return this._evalNewExpr(s.substring(4).trim());
        }
        const isIdx = this._findToplevelIS(s);
        if (isIdx >= 0) {
            const left  = s.substring(0, isIdx).trim();
            const right = s.substring(isIdx + 4).trim();
            const a = Number(this.evalCalc(left,  ASS_NUMBER, level + 1)) || 0;
            const b = Number(this.evalCalc(right, ASS_NUMBER, level + 1)) || 0;
            return (a === b) ? 1 : 0;
        }
        const dotIdx = this._findToplevelMemberDot(s);
        if (dotIdx >= 0) {
            const oopResult = this._evalMemberExpr(s, dotIdx, assignType, level);
            // undefined = "not OOP after all" (e.g. GL.MESHID, namespaced
            // built-in). Fall through to normal expression handling.
            if (oopResult !== undefined) return oopResult;
        }
        // ───────────────────────────────────────────────────────────────────

        // ── OPT-CACHE: Use pre-parsed expression tree for hot expressions ──
        // Only cache at the top level (level===0) and for non-string types.
        // Never cache volatile built-ins or expressions containing them.
        if (level === 0 && this._exprCache && assignType !== ASS_STRING && assignType !== ASS_ARRAY_STRING) {
            // Quick volatile check — skip cache for known dynamic identifiers
            const su = s.toUpperCase();
            const isVolatile = Compiler._VOLATILE.has(su) ||
                               su.includes('TIMER') || su.includes('INKEY') ||
                               su.includes('SECONDS') || su.includes('RND') ||
                               su.includes('MOUSE') || su.includes('KEYDOWN') ||
                               // OOP — bypass cache, evalCalc has its own paths
                               s.includes('.') ||
                               su === 'NOTHING' || su.startsWith('NEW ') ||
                               / IS /i.test(' ' + s + ' ');
            if (!isVolatile) {
                let node = this._exprCache.get(s);
                if (!node) {
                    const hasFunc = /[A-Z]\w*\s*\(/i.test(s);
                    if (!hasFunc) {
                        node = this._parseExprTree(s);
                        if (this._exprCache.size < 2000) this._exprCache.set(s, node);
                    }
                }
                if (node) {
                    const result = this._evalExprTree(node, assignType);
                    if (assignType === ASS_ANY) {
                        // Preserve strings — don't coerce "10" back to number 10
                        // as that would break string concatenation like STR$(X)+"pts"
                        return result;
                    }
                    return Number(result);
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── OPT-F: Fast paths for the most common cases ──────────────────────
        // 1. Plain positive number literal — no scanning needed at all.
        const fc = s.charCodeAt(0);
        if (fc >= 48 && fc <= 57) {  // starts with digit
            const n = Number(s);
            if (!Number.isNaN(n)) return n;
        }
        // 2. Plain quoted string literal — single call, no operator scan.
        if (fc === 34 && s[s.length-1] === '"') {  // starts and ends with "
            // Make sure it's a simple literal (no interior quotes)
            if (s.indexOf('"', 1) === s.length - 1) return s.slice(1, -1);
        }
        // 3. Simple variable name — all alpha/$ chars, no operators.
        // Covers the extremely common "A=A+1" inner recursion: evalCalc("A").
        if (s.length <= 12) {
            let simple = true;
            for (let ci = 0; ci < s.length; ci++) {
                const cc = s.charCodeAt(ci);
                if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) ||
                       cc === 36 || cc === 95 ||
                       (ci > 0 && cc >= 48 && cc <= 57))) {
                    simple = false; break;
                }
            }
            if (simple) {
                // Variables are case-sensitive — pass original case to lookup_.
                if (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING) {
                    return this.lookup_(ASS_STRING, s);
                } else {
                    return this.lookup_(ASS_NUMBER, s);
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // Unary minus: if expression starts with '-' treat as 0 - rest.
        if (s[0] === '-' && s.length > 1) {
            const rest = s.substring(1).trim();
            if (isNaN(Number(s))) {
                return -Number(this.evalCalc(rest, ASS_NUMBER, level + 1));
            }
        }

        // Pass 1: find lowest-priority top-level operator (left-to-right).
        // Lower OPER_* constant = lower precedence = split here first.
        let bestPos = -1, bestPrec = 999, depth = 0, inQuote = false;

        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '"') { inQuote = !inQuote; continue; }
            if (inQuote) continue;
            if (ch === '(') { depth++; continue; }
            if (ch === ')') { depth--; continue; }
            if (depth !== 0) continue;

            let prec = 0;
            if (ch === '+') prec = OPER_PLUS;
            else if (ch === '-' && i > 0) prec = OPER_MINUS;
            else if (ch === '%') prec = OPER_MODULO;
            else if (ch === '/') prec = OPER_DIV;
            else if (ch === '*') prec = OPER_MUL;
            else if (ch === '^') prec = OPER_POW;

            if (prec > 0 && prec <= bestPrec) {
                bestPrec = prec;
                bestPos  = i;
            }
        }

        // No operator at top level.
        if (bestPos < 0) {
            // If the entire expression is wrapped in parentheses, strip and recurse.
            // e.g. "(TS-16)" has no top-level operator — strip parens → "TS-16" ✓
            if (s[0] === '(' && s[s.length-1] === ')') {
                let d = 0, allWrapped = true;
                for (let i = 0; i < s.length - 1; i++) {
                    if (s[i] === '(') d++;
                    else if (s[i] === ')') d--;
                    if (d === 0) { allWrapped = false; break; }
                }
                if (allWrapped) return this.evalCalc(s.slice(1, -1), assignType, level + 1);
            }
            const val = this.getValue(s, 0, s.length, assignType);
            if (assignType === ASS_ANY) {
                // Preserve the value as-is — strings stay strings so concat works.
                return val;
            }
            return (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING)
                ? String(val) : Number(val);
        }

        // Split on the lowest-priority operator and recurse both sides.
        const left  = s.substring(0, bestPos).trim();
        const right = s.substring(bestPos + 1).trim();

        const lVal = this.evalCalc(left,  assignType, level + 1);
        const rVal = this.evalCalc(right, assignType, level + 1);

        let result;
        switch (bestPrec) {
            case OPER_PLUS:
                if (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING) {
                    result = String(lVal) + String(rVal);
                } else if (assignType === ASS_ANY &&
                           (typeof lVal === 'string' || typeof rVal === 'string' ||
                            Number.isNaN(Number(lVal)) || Number.isNaN(Number(rVal)))) {
                    // ASS_ANY: if either side is a string, concatenate
                    result = String(lVal) + String(rVal);
                } else {
                    result = Number(lVal) + Number(rVal);
                }
                break;
            case OPER_MINUS:  result = Number(lVal) - Number(rVal); break;
            case OPER_MUL:    result = Number(lVal) * Number(rVal); break;
            case OPER_DIV:
                if (Number(rVal) !== 0) { result = Number(lVal) / Number(rVal); }
                else { this.current_error = -1; result = 0; }
                break;
            case OPER_MODULO: result = Number(rVal) !== 0 ? Number(lVal) % Number(rVal) : 0; break;
            case OPER_POW:    result = Math.pow(Number(lVal), Number(rVal)); break;
            default:          result = lVal; break;
        }

        if (assignType === ASS_ANY) {
            // Preserve value — strings stay strings so concat works correctly.
            return result;
        }
        return (assignType === ASS_STRING || assignType === ASS_ARRAY_STRING)
            ? String(result) : Number(result);
    }

    // -----------------------------------------------------------------------
    // parseAssign  –  evaluate and store a LET-style assignment.
    // -----------------------------------------------------------------------
    parseAssign(lineToParse) {
        // Compound assignment: +=, -=, *=, /= at top level (outside parens/quotes).
        // Scans left-to-right; first match wins. Allows whitespace between op and '='.
        // Rewrites "LHS op= RHS" as "LHS = (LHS) op (RHS)" and recurses through normal path.
        {
            let depth = 0, inQ = false;
            for (let i = 0; i < lineToParse.length - 1; i++) {
                const c = lineToParse[i];
                if (c === '"') { inQ = !inQ; continue; }
                if (inQ) continue;
                if (c === '(') { depth++; continue; }
                if (c === ')') { depth--; continue; }
                if (depth !== 0) continue;
                if (c === '=') break; // plain '=' encountered first, not compound
                if (c === '+' || c === '-' || c === '*' || c === '/') {
                    let j = i + 1;
                    while (j < lineToParse.length && lineToParse[j] === ' ') j++;
                    if (j < lineToParse.length && lineToParse[j] === '=') {
                        const lhs = lineToParse.substring(0, i).trim();
                        const rhs = lineToParse.substring(j + 1).trim();
                        if (lhs.length > 0 && rhs.length > 0) {
                            return this.parseAssign(lhs + '=(' + lhs + ')' + c + '(' + rhs + ')');
                        }
                    }
                }
            }
        }

        const eqPos = lineToParse.indexOf('=');
        if (eqPos <= 0) return null;

        const varName    = lineToParse.substring(0, eqPos).trim();  // trim spaces around =
        const assignment = lineToParse.substring(eqPos + 1).trim();

        // OOP: "obj.field = expr" — write to the receiver's field rather than
        // a regular variable. The LHS contains a dot at top level.
        {
            const dotIdx = this._findToplevelMemberDot(varName);
            if (dotIdx >= 0) {
                const recvRaw   = varName.substring(0, dotIdx).trim();
                const fieldName = varName.substring(dotIdx + 1).trim();
                const recvUpper = recvRaw.toUpperCase();
                let selfHandle = 0;
                let isOopWrite = false;
                if (recvUpper === 'ME' || recvUpper === 'MYBASE') {
                    const frame = this._meFrame();
                    if (frame) { selfHandle = frame.selfHandle; isOopWrite = true; }
                } else {
                    const simpleVar = /^[A-Za-z_][A-Za-z0-9_]*(\$)?$/.test(recvRaw);
                    const declaredClass = simpleVar && this._dimClass ? this._dimClass[recvRaw] : null;
                    if (declaredClass) {
                        selfHandle = Number(this.evalCalc(recvRaw, ASS_NUMBER, 0)) || 0;
                        if (selfHandle) isOopWrite = true;
                    } else if (this._oopObjects) {
                        const tryHandle = Number(this.evalCalc(recvRaw, ASS_NUMBER, 0)) || 0;
                        if (tryHandle && this._oopObjects.has(tryHandle)) {
                            selfHandle = tryHandle;
                            isOopWrite = true;
                        }
                    }
                }
                if (!isOopWrite) {
                    // Not an OOP write — fall through to standard variable
                    // assignment (so things like GL.X = expr aren't hijacked).
                } else {
                const inst = this._objectGet(selfHandle);
                if (!inst) return null;
                const upper = fieldName.toUpperCase();
                // Evaluate RHS in correct type (string if field-name ends with $).
                const isStr = fieldName.endsWith('$');
                const val   = this.evalCalc(assignment, isStr ? ASS_STRING : ASS_NUMBER, 0);
                inst.fields.set(upper, isStr ? String(val == null ? '' : val) : Number(val) || 0);
                // Also reflect into the current method's bare-name scope so
                // subsequent reads in the same method see the new value
                // without a fresh field-snapshot.
                if (isStr) this.variables_strings.set(fieldName, String(val == null ? '' : val));
                else       this.variables_numbers.set(fieldName, Number(val) || 0);
                return false;
                }   // end isOopWrite
            }
        }

        if (assignment === 'GETKEY()') {
            this.want_keypress = 1;
            this.input_var     = varName;
            if (this.running) this.tick(1);
            return false;
        }

        const assType = this.getAssignType(varName);

        // ── OPT-ASSIGN: fast path for simple numeric variable assignments ──
        // e.g. ZR=TMP, IT=IT+1, ZR=ZR*ZR-ZI*ZI+CR — use expression cache
        if (assType === ASS_NUMBER && this._exprCache !== undefined) {
            const au = assignment.toUpperCase();
            const isVolatile = au.includes('TIMER') || au.includes('INKEY') ||
                               au.includes('SECONDS') || au.includes('RND') ||
                               au.includes('MOUSE') || au.includes('KEYDOWN') ||
                               // OOP forms — _parseExprTree can't reduce these;
                               // route to evalCalc which has OOP fast paths.
                               assignment.includes('.') ||
                               au === 'NOTHING' || au.startsWith('NEW ') ||
                               / IS /i.test(' ' + assignment + ' ');
            if (!isVolatile) {
                let node = this._exprCache.get(assignment);
                if (!node) {
                    const hasFunc = /[A-Z]\w*\s*\(/i.test(assignment);
                    if (!hasFunc) {
                        node = this._parseExprTree(assignment);
                        if (this._exprCache.size < 2000) this._exprCache.set(assignment, node);
                    }
                }
                if (node) {
                    const calc = this._evalExprTree(node, ASS_NUMBER);
                    // Variables are case-sensitive — store under original-case varName.
                    this.variables_numbers.set(varName, Number(calc));
                    return null;
                }
            }
        }
        // ──────────────────────────────────────────────────────────────────

        const calc = this.evalCalc(assignment, assType);

        if (calc === null) {
            if (this.current_error === -1) return this.error_division_by_zero;
            return this.error_syntax;
        }

        this.assign_(assType, varName, (assType === ASS_NUMBER || assType === ASS_ARRAY_NUMBER)
            ? Number(calc)
            : calc);
        return null;
    }

    // -----------------------------------------------------------------------
    // extractValue  –  pull the content between the first ( ) pair.
    // -----------------------------------------------------------------------
    extractValue(expr, wantRaw) {
        const p1 = expr.indexOf('(');
        const p2 = expr.lastIndexOf(')');
        if (p2 <= p1 + 1) return '';

        const inner = expr.substring(p1 + 1, p2);
        if (wantRaw) return inner;

        // If it contains operators, evaluate it.
        if (/[-+*/^%]/.test(inner)) {
            return this.evalCalc(inner, ASS_NUMBER, 0);
        }
        return this.lookup(inner);
    }

    // -----------------------------------------------------------------------
    // getRaw  –  coerce a token string to its value (number, string, or variable).
    // -----------------------------------------------------------------------
    getRaw(s, isRaw) {
        s = String(s);
        const n = Number(s);
        if (!Number.isNaN(n) && s.trim() !== '') return n;
        if (s.startsWith('"') || isRaw) {
            if (!isRaw) {
                const end = s.lastIndexOf('"');
                return end < 1 ? null : s.slice(1, end);
            }
            return s;
        }
        if (s.length > 0) return this.evalCalc(s, ASS_ANY, 0);
        return null;
    }

    // -----------------------------------------------------------------------
    // findParameters  –  split a parameter string by a separator, evaluating each.
    // Quote-aware: separators inside double-quoted strings are ignored.
    // -----------------------------------------------------------------------
    findParameters(sWork, isRaw, separator) {
        const localWork = this.trim(sWork);
        if (!localWork) return null;

        const result  = [];
        const sepLen  = separator.length;
        let   start   = 0;
        let   inQuote = false;

        for (let i = 0; i <= localWork.length - sepLen; i++) {
            if (localWork[i] === '"') { inQuote = !inQuote; continue; }
            if (inQuote) continue;
            if (localWork.substring(i, i + sepLen) === separator) {
                const token = this.trim(localWork.substring(start, i));
                result.push(token.length > 0 ? this.getRaw(token, isRaw) : null);
                start = i + sepLen;
                i = start - 1;   // loop will i++ to start
            }
        }
        // Push the final token.
        const last = this.trim(localWork.substring(start));
        result.push(last.length > 0 ? this.getRaw(last, isRaw) : null);
        return result;
    }


    // -----------------------------------------------------------------------
    // checkCondition  –  evaluate a boolean condition (supports AND / OR / NOT).
    // Quote-aware: operators inside string literals are ignored.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Condition parse tree cache — parse once, evaluate many times.
    // Used by WHILE/IF conditions in tight loops.
    // -----------------------------------------------------------------------
    _parseCondTree(expr) {
        expr = expr.trim();

        // Strip outer matching parentheses: "(A OR B)" -> "A OR B".
        // Repeat for nested wraps like "((A))" -> "A".
        while (expr.length >= 2 && expr[0] === '(' && expr[expr.length-1] === ')') {
            let depth = 0, outerMatched = true;
            for (let i = 0; i < expr.length; i++) {
                if (expr[i] === '(') depth++;
                else if (expr[i] === ')') depth--;
                if (depth === 0 && i < expr.length - 1) {
                    outerMatched = false; break;  // closing came before end
                }
            }
            if (!outerMatched || depth !== 0) break;
            expr = expr.substring(1, expr.length - 1).trim();
        }
        const upper = expr.toUpperCase();

        // Find AND/OR at word boundaries (OR has lower precedence) at paren depth 0.
        // Without depth tracking, "A AND (B OR C)" would split at the inner OR,
        // producing left="A AND (B" with unmatched parens — silently wrong.
        const findKw = (s, kw) => {
            const u = s.toUpperCase();
            let inQ = false, depth = 0;
            for (let i = 0; i <= u.length - kw.length; i++) {
                if (u[i] === '"') { inQ = !inQ; continue; }
                if (inQ) continue;
                if (u[i] === '(') { depth++; continue; }
                if (u[i] === ')') { depth--; continue; }
                if (depth > 0) continue;
                if (u.substring(i, i+kw.length) === kw) {
                    const before = i===0 || /\W/.test(u[i-1]);
                    const after  = (i+kw.length>=u.length) || /\W/.test(u[i+kw.length]);
                    if (before && after) return i;
                }
            }
            return -1;
        };

        const orIdx  = findKw(expr, 'OR');
        const andIdx = findKw(expr, 'AND');

        if (orIdx >= 0 && (andIdx < 0 || orIdx < andIdx)) {
            return {t:'or', l:this._parseCondTree(expr.substring(0,orIdx).trim()),
                           r:this._parseCondTree(expr.substring(orIdx+2).trim())};
        }
        if (andIdx >= 0) {
            return {t:'and', l:this._parseCondTree(expr.substring(0,andIdx).trim()),
                            r:this._parseCondTree(expr.substring(andIdx+3).trim())};
        }
        if (upper.startsWith('NOT ')) {
            return {t:'not', c:this._parseCondTree(expr.substring(4).trim())};
        }

        // Find comparison operator at paren depth 0 (avoid matching < / > inside
        // function-call arg lists like MIN(A, B>C) if such usage ever appears).
        const findOp = (s, op) => {
            let inQ=false, depth=0;
            for (let i=0; i<=s.length-op.length; i++) {
                if (s[i]==='"'){inQ=!inQ;continue;} if(inQ)continue;
                if (s[i]==='(') { depth++; continue; }
                if (s[i]===')') { depth--; continue; }
                if (depth > 0) continue;
                if (s.substring(i,i+op.length)===op) return i;
            }
            return -1;
        };

        let opPos=-1, op='', cond='';
        // OOP: `IS` is a word-bounded reference-equality comparison. Treat as
        // numeric `=` since handles are integers. Detected BEFORE the symbol
        // comparison ops so `x IS NOTHING` parses as a cmp node, not a
        // truthy expression on `x IS NOTHING` (which _parseExprTree can't
        // make sense of).
        const isKwIdx = findKw(expr, 'IS');
        if (isKwIdx >= 0) { opPos = isKwIdx; op = 'IS'; cond = 'eq'; }
        else if ((opPos=findOp(expr,'>='))>=0){op='>=';cond='ge';}
        else if ((opPos=findOp(expr,'<='))>=0){op='<=';cond='le';}
        else if ((opPos=findOp(expr,'<>'))>=0){op='<>';cond='ne';}
        else if ((opPos=findOp(expr,'<')) >=0){op='<'; cond='lt';}
        else if ((opPos=findOp(expr,'>')) >=0){op='>';cond='gt';}
        else if ((opPos=findOp(expr,'=')) >=0){op='=';cond='eq';}

        if (cond !== '') {
            const left  = expr.substring(0, opPos).trim();
            const right = expr.substring(opPos+op.length).trim();
            const isStr = left.startsWith('"')||right.startsWith('"')||
                          left.endsWith('$')||right.endsWith('$');
            // OOP: expressions with `.` (member access), `NEW`, or the
            // NOTHING literal can't be reduced by _parseExprTree — leave
            // their nodes null so the cmp evaluator falls back to evalCalc
            // (which has the OOP fast paths).
            const isOOP = (e) => {
                if (!e) return false;
                const u = e.toUpperCase();
                return e.includes('.') || u === 'NOTHING' || u.startsWith('NEW ');
            };
            const lNode = (isStr || isOOP(left))  ? null : this._parseExprTree(left);
            const rNode = (isStr || isOOP(right)) ? null : this._parseExprTree(right);
            return {t:'cmp', cond, isStr,
                    lNode, rNode,
                    lRaw:left, rRaw:right};
        }

        // Truthy number (e.g. WHILE FLAG)
        const node = this._parseExprTree(expr);
        return {t:'truthy', node, raw:expr};
    }

    _evalCondTree(ct) {
        switch (ct.t) {
            case 'or':     return this._evalCondTree(ct.l) || this._evalCondTree(ct.r);
            case 'and':    return this._evalCondTree(ct.l) && this._evalCondTree(ct.r);
            case 'not':    return !this._evalCondTree(ct.c);
            case 'truthy':
                return ct.node ? Number(this._evalExprTree(ct.node, ASS_NUMBER)) !== 0
                               : Number(this.evalCalc(ct.raw, ASS_NUMBER)) !== 0;
            case 'cmp': {
                let l, r;
                if (ct.isStr) {
                    l = String(this.evalCalc(ct.lRaw, ASS_STRING));
                    r = String(this.evalCalc(ct.rRaw, ASS_STRING));
                } else {
                    l = ct.lNode ? Number(this._evalExprTree(ct.lNode, ASS_NUMBER))
                                 : Number(this.evalCalc(ct.lRaw, ASS_NUMBER));
                    r = ct.rNode ? Number(this._evalExprTree(ct.rNode, ASS_NUMBER))
                                 : Number(this.evalCalc(ct.rRaw, ASS_NUMBER));
                }
                switch (ct.cond) {
                    case 'eq': return l===r;
                    case 'ne': return l!==r;
                    case 'lt': return l<r;
                    case 'gt': return l>r;
                    case 'le': return l<=r;
                    case 'ge': return l>=r;
                }
            }
        }
        return false;
    }

    checkCondition(expr) {
        expr = expr.trim();

        // ── OPT-COND: Cache parsed condition trees ──
        // For tight loops like WHILE IT<MAXI AND ZR*ZR+ZI*ZI<4, the condition
        // string is identical every iteration — cache the parsed structure.
        if (this._exprCache) {
            const condKey = '\x00' + expr; // prefix to avoid collision with expr keys
            let ct = this._exprCache.get(condKey);
            if (!ct) {
                ct = this._parseCondTree(expr);
                if (this._exprCache.size < 2000) this._exprCache.set(condKey, ct);
            }
            if (ct) return this._evalCondTree(ct);
        }
        // ──────────────────────────────────────────────────────────────────────

        // Helper: find the position of a keyword (AND/OR) at word boundaries,
        // skipping content inside double-quoted strings.
        const findKeyword = (s, kw) => {
            const upper = s.toUpperCase();
            let inQuote = false;
            for (let i = 0; i <= upper.length - kw.length; i++) {
                if (upper[i] === '"') { inQuote = !inQuote; continue; }
                if (inQuote) continue;
                if (upper.substring(i, i + kw.length) === kw) {
                    const before = i === 0 ? true : /\W/.test(upper[i - 1]);
                    const after  = (i + kw.length >= upper.length) ? true : /\W/.test(upper[i + kw.length]);
                    if (before && after) return i;
                }
            }
            return -1;
        };

        // Helper: find first occurrence of an operator outside quoted strings.
        const findOp = (s, op) => {
            let inQuote = false;
            for (let i = 0; i <= s.length - op.length; i++) {
                if (s[i] === '"') { inQuote = !inQuote; continue; }
                if (inQuote) continue;
                if (s.substring(i, i + op.length) === op) return i;
            }
            return -1;
        };

        // Split on the lowest-priority logical operator (OR before AND for precedence).
        const orIdx  = findKeyword(expr, 'OR');
        const andIdx = findKeyword(expr, 'AND');

        let curArg, nextArg, isOr;

        if (orIdx >= 0 || andIdx >= 0) {
            let splitAt, skipLen;
            if (orIdx >= 0 && (andIdx < 0 || orIdx < andIdx)) {
                splitAt = orIdx; skipLen = 2; isOr = true;
            } else {
                splitAt = andIdx; skipLen = 3; isOr = false;
            }
            curArg  = expr.substring(0, splitAt).trim();
            nextArg = expr.substring(splitAt + skipLen).trim();
        } else {
            curArg = expr;
        }

        // Handle NOT prefix: NOT condition
        const curUpper = curArg.toUpperCase();
        if (curUpper.startsWith('NOT ')) {
            const inner = curArg.substring(4).trim();
            const result = !this.checkCondition(inner);
            if (nextArg) {
                return isOr ? (result || this.checkCondition(nextArg))
                            : (result && this.checkCondition(nextArg));
            }
            return result;
        }

        // Evaluate curArg — find the comparison operator (longest first to avoid ≥ vs >).
        let bReturn = false;
        let opPos = -1, op = '', cond = '';

        if ((opPos = findOp(curArg, '>=')) >= 0) { op = '>='; cond = 'ge'; }
        else if ((opPos = findOp(curArg, '<=')) >= 0) { op = '<='; cond = 'le'; }
        else if ((opPos = findOp(curArg, '<>')) >= 0) { op = '<>'; cond = 'ne'; }
        else if ((opPos = findOp(curArg, '<'))  >= 0) { op = '<';  cond = 'lt'; }
        else if ((opPos = findOp(curArg, '>'))  >= 0) { op = '>';  cond = 'gt'; }
        else if ((opPos = findOp(curArg, '='))  >= 0) { op = '=';  cond = 'eq'; }

        if (cond !== '') {
            const left  = curArg.substring(0, opPos).trim();
            const right = curArg.substring(opPos + op.length).trim();

            const isStringCmp = left.startsWith('"')  || right.startsWith('"') ||
                                 left.endsWith('$')    || right.endsWith('$')   ||
                                 left.includes('$(')   || right.includes('$(');

            if (isStringCmp) {
                const sLeft  = String(this.evalCalc(left,  ASS_STRING) ?? '');
                const sRight = String(this.evalCalc(right, ASS_STRING) ?? '');
                switch (cond) {
                    case 'eq': bReturn = sLeft === sRight; break;
                    case 'ne': bReturn = sLeft !== sRight; break;
                    case 'gt': bReturn = sLeft >   sRight; break;
                    case 'lt': bReturn = sLeft <   sRight; break;
                    case 'ge': bReturn = sLeft >=  sRight; break;
                    case 'le': bReturn = sLeft <=  sRight; break;
                }
            } else {
                const iLeft  = Number(this.evalCalc(left,  ASS_NUMBER));
                const iRight = Number(this.evalCalc(right, ASS_NUMBER));
                switch (cond) {
                    case 'eq': bReturn = iLeft === iRight; break;
                    case 'ne': bReturn = iLeft !== iRight; break;
                    case 'gt': bReturn = iLeft >   iRight; break;
                    case 'lt': bReturn = iLeft <   iRight; break;
                    case 'ge': bReturn = iLeft >=  iRight; break;
                    case 'le': bReturn = iLeft <=  iRight; break;
                }
            }
        }

        // If no comparison operator found, evaluate curArg as a truthy number.
        // Handles: IF KEYDOWN(87) THEN, IF FLAG THEN, IF RUNNING THEN etc.
        if (cond === '') {
            const val = Number(this.evalCalc(curArg, ASS_NUMBER));
            bReturn = val !== 0;
        }

        // Recurse for AND / OR.
        if (nextArg) {
            return isOr
                ? (bReturn || this.checkCondition(nextArg))
                : (bReturn && this.checkCondition(nextArg));
        }

        return bReturn;
    }

}

// ---------------------------------------------------------------------------
// Mixin: inject all Compiler methods into Interpreter.prototype.
// Runs once after both files are parsed, before boot.js calls new Interpreter().
// ---------------------------------------------------------------------------
Object.getOwnPropertyNames(Compiler.prototype).forEach(name => {
    if (name !== 'constructor') {
        Interpreter.prototype[name] = Compiler.prototype[name];
    }
});

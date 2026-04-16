'use strict';

// ---------------------------------------------------------------------------
// OSAWARE libraries  (modernised from ngbasic-0.2-libraries.js)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Array.prototype.indexOf polyfill is no longer needed (ES5+).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// linePrinter  –  opens a popup window that emulates a line-printer output.
// ---------------------------------------------------------------------------
class LinePrinter {
    constructor() {
        this.version  = '0.2';
        this.lpWindow = null;
        this.addDiv   = null;
    }

    initialize() {
        if (!this.lpWindow || this.lpWindow.closed) {
            this.lpWindow = window.open(
                '', '',
                'width=640,height=800,status=no,navigation=no,scrollbars=yes'
            );
            this.lpWindow.document.write(
                `<html><head><title>OSAWARE Line Printer v${this.version}</title></head>` +
                `<body><div id="lprint" style="font-family:'Courier New';font-size:11px;"></div></body></html>`
            );
            this.addDiv = null;
        }
        if (!this.addDiv) {
            this.addDiv = this.lpWindow.document.getElementById('lprint');
        }
    }

    print(line, cr) {
        if (!this.lpWindow || this.lpWindow.closed) this.initialize();
        if (!this.addDiv) this.addDiv = this.lpWindow.document.getElementById('lprint');

        for (const ch of line) {
            const node = this.lpWindow.document.createTextNode(ch === ' ' ? '\u00A0' : ch);
            this.addDiv.appendChild(node);
        }
        if (cr === 1) this.addDiv.appendChild(this.lpWindow.document.createElement('br'));
    }
}

// ---------------------------------------------------------------------------
// History  –  stores previously-typed command lines with de-duplication.
// ---------------------------------------------------------------------------
class History {
    constructor() {
        this.version = '0.1';
        this.lines   = [];
    }

    getLines() {
        return this.lines.length;
    }

    getLine(index) {
        return this.lines[index] ?? '';
    }

    // Add a line; if it already exists move it to the end (most-recent).
    addLine(line) {
        // Remove any existing occurrence of the same line.
        const existing = this.lines.indexOf(line);
        if (existing !== -1) {
            this.lines.splice(existing, 1);
        }
        this.lines.push(line);
        return this.lines.length;
    }
}

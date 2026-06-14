'use strict';
import * as C from '../constants.js';


// ---------------------------------------------------------------------------
// AudioDriver  (drivers/audio.js)
//
// Extracted from kernel.js as part of the V7 architecture refactor (Step 2).
// Wraps all audio synthesis: SOUND, WAVE, BEEP and the Web Audio context.
// ---------------------------------------------------------------------------

export class AudioDriver {

    constructor(host) {
        this._host       = host;
        this._audioCtx   = null;
        this._soundWait  = false;
        this._soundQueue = [];
        this._waveTables = {};
    }

    // ── Host forwarders ────────────────────────────────────────────────────
    get o()         { return this._host.o; }
    trim(s)         { return this._host.trim(s); }
    appendLine(t,n) { return this._host.appendLine(t,n); }
    evalCalc(a,b,c) { return this._host.evalCalc(a,b,c); }
    findParameters(a,b,c) { return this._host.findParameters(a,b,c); }
    get variables_arr_numbers() { return this._host.variables_arr_numbers; }

// -----------------------------------------------------------------------
// SOUND frequency, duration [, volume [, voice]]
// SOUND WAIT / SOUND RESUME
// Amiga BASIC compatible: frequency 20-15000 Hz, duration in jiffies (1/60s),
// volume 0-255, voice 0-3 (0,3=left  1,2=right)
// -----------------------------------------------------------------------
    cmdSOUND(param) {
        if (!param) return C.CMD_ESYNTAX;
        // Parse raw param string into array, handling WAIT/RESUME first
        const rawTrim = this.trim(String(param)).toUpperCase();

        // SOUND WAIT / SOUND RESUME
        const p0 = rawTrim.split(',')[0].trim();
        if (p0 === 'WAIT')   { this._soundWait = true;  return C.CMD_OK; }
        if (p0 === 'RESUME') { this._soundWait = false; this._flushSoundQueue(); return C.CMD_OK; }

        // Parse comma-separated numeric params
        const parts = this.findParameters(String(param), 0, ',');
        if (!parts || parts.length < 2) return C.CMD_ESYNTAX;

        const freq   = Math.max(20, Math.min(15000, Number(parts[0])));
        const dur    = Math.max(0, Number(parts[1])) / 60;  // jiffies → seconds
        const vol    = parts[2] != null ? Math.max(0, Math.min(255, Number(parts[2]))) : 127;
        const voice  = parts[3] != null ? Math.max(0, Math.min(3,   Number(parts[3]))) : 0;
        const gainVal = (vol / 255) * 0.7;

        const entry = { freq, dur, gainVal, voice };
        if (this._soundWait) {
            if (!this._soundQueue) this._soundQueue = [];
            this._soundQueue.push(entry);
        } else {
            this._playSoundEntry(entry);
        }
        return C.CMD_OK;
    }

    _getAudioCtx() {
        if (!this._audioCtx) {
            try {
                this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch(e) { return null; }
        }
        // Resume if suspended (browser autoplay policy)
        if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
        return this._audioCtx;
    }

    _playSoundEntry(entry) {
        const ctx = this._getAudioCtx();
        if (!ctx) return;
        const { freq, dur, gainVal, voice } = entry;
        if (dur <= 0) return;

        // Pan: voice 0,3 → left (-1),  voice 1,2 → right (+1)
        const pan = (voice === 0 || voice === 3) ? -0.8 : 0.8;

        try {
            const osc    = ctx.createOscillator();
            const gain   = ctx.createGain();
            const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

            // Use custom PeriodicWave if defined for this voice, else sine
            const waveTable = this._waveTables && this._waveTables[voice];
            if (waveTable) {
                osc.setPeriodicWave(waveTable);
            } else {
                osc.type = 'sine';
            }

            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(gainVal, ctx.currentTime);
            // Short fade-out to avoid clicks
            gain.gain.setValueAtTime(gainVal, ctx.currentTime + dur - 0.01);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);

            if (panner) {
                panner.pan.setValueAtTime(pan, ctx.currentTime);
                osc.connect(gain);
                gain.connect(panner);
                panner.connect(ctx.destination);
            } else {
                osc.connect(gain);
                gain.connect(ctx.destination);
            }

            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + dur);
        } catch(e) {}
    }

    _flushSoundQueue() {
        if (!this._soundQueue || !this._soundQueue.length) return;
        const queue = this._soundQueue;
        this._soundQueue = [];
        for (const entry of queue) this._playSoundEntry(entry);
    }

// -----------------------------------------------------------------------
// WAVE voice, SIN | arrayName
// Defines the waveform for a voice channel (0-3).
// WAVE voice, SIN       → reset to sine wave
// WAVE voice, arrayName → use 256-element array as waveform (-128 to 127)
// -----------------------------------------------------------------------
    cmdWAVE(param) {
        if (!param) return C.CMD_ESYNTAX;
        const ctx = this._getAudioCtx();
        if (!ctx) return C.CMD_OK;

        const comma = String(param).indexOf(',');
        if (comma < 0) return C.CMD_ESYNTAX;

        const voiceStr = this.trim(String(param).substring(0, comma));
        const waveStr  = this.trim(String(param).substring(comma + 1));
        const voice    = Math.max(0, Math.min(3, Math.floor(Number(this.evalCalc(voiceStr, 0)))));

        if (!this._waveTables) this._waveTables = {};

        // WAVE v, SIN → clear custom wave (back to sine)
        if (waveStr.toUpperCase() === 'SIN') {
            delete this._waveTables[voice];
            return C.CMD_OK;
        }

        // WAVE v, ArrayName → build PeriodicWave from array
        // Look up the array — it should have 256 elements, values -128 to 127
        const arrName = waveStr.toUpperCase();
        const arr = this.variables_arr_numbers.get(arrName);
        if (!arr || arr.length < 256) {
            this.appendLine('WAVE: array must have at least 256 elements', 1);
            return C.CMD_OK;
        }

        // Convert the waveform samples to a PeriodicWave via FFT
        // Build real/imag coefficients from the 256-sample waveform
        const N = 256;
        const samples = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            samples[i] = Math.max(-1, Math.min(1, (arr[i] || 0) / 128));
        }

        // DFT to get frequency components
        const real = new Float32Array(N / 2 + 1);
        const imag = new Float32Array(N / 2 + 1);
        for (let k = 0; k <= N / 2; k++) {
            let re = 0, im = 0;
            for (let n = 0; n < N; n++) {
                const angle = (2 * Math.PI * k * n) / N;
                re += samples[n] * Math.cos(angle);
                im -= samples[n] * Math.sin(angle);
            }
            real[k] = re / N * 2;
            imag[k] = im / N * 2;
        }

        try {
            this._waveTables[voice] = ctx.createPeriodicWave(real, imag,
                { disableNormalization: false });
        } catch(e) {
            this.appendLine('WAVE: ' + e.message, 1);
        }
        return C.CMD_OK;
    }

    cmdBEEP() {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'square';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.15);
            if (this.o) {
                const prev = this.o.style.filter;
                this.o.style.filter = 'invert(1)';
                setTimeout(() => { this.o.style.filter = prev; }, 80);
            }
        } catch(e) { }
        return C.CMD_OK;
    }


}

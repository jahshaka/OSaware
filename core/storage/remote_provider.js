'use strict';

// ---------------------------------------------------------------------------
// RemoteStorageProvider
//
// Real-backend storage provider for OSAWARE. Implements the same async
// interface as LocalStorageProvider and MockRemoteStorageProvider, but
// talks HTTP to the production backend at /api/*.
//
// Called from AuthService after a successful LOGIN or REGISTER — the
// AuthService constructs a RemoteStorageProvider and hands it to
// vfs.setStorageProvider(), which loads the user's data via loadAll()
// and swaps the in-memory cache.
//
// Design notes:
//
// 1. SAME-ORIGIN URLS
//    All endpoints are accessed via relative URLs ('/api/...'). Because
//    the OSAWARE frontend and backend are hosted on the same origin
//    (Pattern A deployment), the browser automatically sends session
//    cookies on every request. No CORS config, no API base URL. If we
//    ever need to run the frontend against a different-origin backend
//    (e.g. for local dev), we add a config knob then.
//
// 2. SAME ENVELOPE + CRC AS OTHER PROVIDERS
//    The backend stores envelopes verbatim as opaque strings. The
//    browser computes CRC32 before upload and verifies after download,
//    exactly like LocalStorageProvider does. Envelope format is
//    {v, crc, ts, data} — unchanged.
//
// 3. EAGER BINARY PRELOAD AT LOGIN
//    loadAll() fetches the envelopes + binary manifest in one call, then
//    iterates the manifest and fetches each binary blob individually.
//    This means login time scales with binary data size — a user with a
//    few MB of images logs in fast, a user with 100MB takes a while.
//    Acceptable for v1; upgrade to lazy loading later if it becomes a
//    problem. Eager loading lets existing BASIC programs treat binary
//    reads as synchronous, just like LOCAL and DEV modes.
//
// 4. FIRE-AND-FORGET WRITES
//    Same pattern as LocalStorageProvider: saveFiles/saveAssets return
//    promises but the VFS calls them without awaiting. The in-memory
//    cache updates synchronously; the network persist happens in the
//    background. If the tab closes before a write completes, orphan
//    recovery on next login handles it (the server's pending slot is
//    CRC-validated just like localStorage's).
//
// 5. BINARY WRITES ARE SEPARATE
//    saveBinary(path, bytes, mime) is a distinct method that uploads
//    raw bytes via PUT /api/blob/:path. This avoids putting megabyte-sized
//    base64 blobs into the envelope. deleteBinary(path) removes them.
//    The VFS calls saveBinary when it notices a putAsset() with a
//    binary mime type (image/*, audio/*, etc.).
//
// 6. ERROR PHILOSOPHY
//    Network failures and HTTP errors are logged but don't throw to the
//    caller on fire-and-forget writes. loadAll() throws on hard failure
//    because the caller (VFS swap) needs to know whether to abort the
//    swap. Individual binary fetches inside loadAll() that fail are
//    logged and skipped — the user loses access to that one file but
//    the rest of the session works.
// ---------------------------------------------------------------------------

class RemoteStorageProvider {

    // No constructor args — the backend knows who you are from the
    // session cookie that the browser sends automatically. If the
    // session is invalid, every request will return 401.
    constructor() {
        this.name = 'remote';
        // Track commit timestamps for diagnostics
        this._lastCommitFiles  = 0;
        this._lastCommitAssets = 0;
    }

    // =======================================================================
    // Storage provider interface (matches LocalStorageProvider/MockRemote)
    // =======================================================================

    // loadAll — fetch the user's full state from the backend.
    // Returns { files, assets, diagnostics }.
    //
    // Does THREE things:
    //   1. GET /api/storage → envelopes + binary_manifest
    //   2. Parse/verify envelopes (CRC check), populate files and text assets
    //   3. For each entry in binary_manifest, GET /api/blob/:path, decode
    //      bytes into a base64 data: URL, and inject into the assets map
    //
    // Throws on hard failure (network down, 401, server error). The
    // AuthService catches the throw and reports a login error to the user.
    async loadAll() {
        const diagnostics = {
            provider:       this.name,
            orphansSwept:   0,
            legacyMigrated: false,
            warnings:       [],
            binariesLoaded: 0,
            binariesFailed: 0,
        };

        // Step 1: fetch envelopes and manifest
        let storage;
        try {
            const res = await fetch('/api/storage', {
                method:      'GET',
                credentials: 'include',
            });
            if (!res.ok) {
                throw new Error('GET /api/storage returned ' + res.status);
            }
            storage = await res.json();
        } catch (e) {
            throw new Error('RemoteStorageProvider.loadAll: failed to fetch storage: ' + (e.message || e));
        }

        // Step 2: parse envelopes and extract files + text assets
        // The server returns pending and committed slots for both files and
        // assets. We resolve pending-first (server side orphan recovery)
        // and fall back to committed.
        const files  = this._resolveSlot(
            storage.files_envelope_committed,
            storage.files_envelope_pending,
            [], 'files', diagnostics
        );
        const assets = this._resolveSlot(
            storage.assets_envelope_committed,
            storage.assets_envelope_pending,
            {}, 'assets', diagnostics
        );

        // Step 3: download each binary in the manifest
        const manifest = Array.isArray(storage.binary_manifest) ? storage.binary_manifest : [];
        for (const entry of manifest) {
            try {
                const bytes = await this._fetchBlob(entry.path);
                // Convert raw bytes to a data: URL so VFS can treat it
                // like other assets (which store data: URLs as strings).
                const base64 = this._bytesToBase64(bytes);
                const dataUrl = 'data:' + (entry.mime || 'application/octet-stream') +
                                ';base64,' + base64;
                assets[entry.path] = { mime: entry.mime, data: dataUrl };
                diagnostics.binariesLoaded++;
            } catch (e) {
                console.warn('RemoteStorageProvider: failed to load binary ' + entry.path + ':', e.message || e);
                diagnostics.binariesFailed++;
                diagnostics.warnings.push('binary ' + entry.path + ' failed to load');
            }
        }

        return { files, assets, diagnostics };
    }

    // saveFiles — persist the programs envelope to the backend.
    // Fire-and-forget from the VFS's perspective; returns a promise
    // but the VFS doesn't await it.
    async saveFiles(files) {
        return this._persistBlob('files_committed', files, 'files');
    }

    // saveAssets — persist the text-assets envelope to the backend.
    // Note: only text/non-binary assets go through this path. Binary
    // assets (images, audio, etc.) are handled via saveBinary below.
    // The VFS is responsible for filtering; see vfs.js putAsset().
    async saveAssets(assets) {
        // Filter out binary entries before envelope persistence.
        // Binary assets have data: URLs starting with "data:image/",
        // "data:audio/", etc. and are stored via saveBinary().
        // Text and small/raw-string assets stay in the envelope.
        const textOnly = {};
        for (const [key, val] of Object.entries(assets || {})) {
            if (this._isBinaryAsset(val)) continue;
            textOnly[key] = val;
        }
        return this._persistBlob('assets_committed', textOnly, 'assets');
    }

    // saveBinary — upload raw binary bytes for a single asset.
    // Called by the VFS's putAsset() when the incoming data is binary.
    // Uses PUT /api/blob/:path which handles the filesystem layer.
    async saveBinary(path, bytesOrDataUrl, mime) {
        // Accept either raw Uint8Array/ArrayBuffer or a data: URL string.
        // Most VFS call sites pass a data: URL because that's what the
        // existing code stores.
        let bytes;
        try {
            bytes = this._normaliseBytes(bytesOrDataUrl);
        } catch (e) {
            console.warn('RemoteStorageProvider.saveBinary: invalid bytes for ' + path + ':', e.message);
            return false;
        }

        const url = '/api/blob/' + this._encodePath(path);
        try {
            const res = await fetch(url, {
                method:      'PUT',
                credentials: 'include',
                headers:     { 'Content-Type': mime || 'application/octet-stream' },
                body:        bytes,
            });
            if (!res.ok) {
                console.warn('RemoteStorageProvider.saveBinary: PUT ' + path + ' returned ' + res.status);
                return false;
            }
            return true;
        } catch (e) {
            console.warn('RemoteStorageProvider.saveBinary: network error for ' + path + ':', e.message || e);
            return false;
        }
    }

    // deleteBinary — remove a binary asset from the backend.
    async deleteBinary(path) {
        const url = '/api/blob/' + this._encodePath(path);
        try {
            const res = await fetch(url, {
                method:      'DELETE',
                credentials: 'include',
            });
            // 404 is OK here — the file was already gone
            if (!res.ok && res.status !== 404) {
                console.warn('RemoteStorageProvider.deleteBinary: DELETE ' + path + ' returned ' + res.status);
                return false;
            }
            return true;
        } catch (e) {
            console.warn('RemoteStorageProvider.deleteBinary: network error for ' + path + ':', e.message || e);
            return false;
        }
    }

    // =======================================================================
    // INTERNAL: envelope persistence
    // =======================================================================

    async _persistBlob(slotName, payload, label) {
        const crc32 = (typeof window !== 'undefined' && window.OSAWARE_crc32)
            ? window.OSAWARE_crc32
            : null;
        if (!crc32) {
            console.warn('RemoteStorageProvider: OSAWARE_crc32 not available — local_provider.js must load first');
            return false;
        }

        let serialised, crc;
        try {
            serialised = JSON.stringify(payload);
            crc = crc32(serialised);
        } catch (e) {
            console.warn('RemoteStorageProvider: failed to serialise ' + label + ':', e);
            return false;
        }

        const envelope = {
            v:    1,
            crc:  crc,
            ts:   Date.now(),
            data: payload,
        };
        const envelopeJson = JSON.stringify(envelope);

        try {
            const res = await fetch('/api/storage', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    slot_name:     slotName,
                    envelope_json: envelopeJson,
                }),
            });
            if (!res.ok) {
                console.warn('RemoteStorageProvider: POST /api/storage (' + slotName + ') returned ' + res.status);
                return false;
            }
            if (label === 'files')  this._lastCommitFiles  = envelope.ts;
            if (label === 'assets') this._lastCommitAssets = envelope.ts;
            return true;
        } catch (e) {
            console.warn('RemoteStorageProvider: network error persisting ' + label + ':', e.message || e);
            return false;
        }
    }

    // =======================================================================
    // INTERNAL: slot resolution with CRC validation
    // =======================================================================
    //
    // The server returns both committed and pending slots. We prefer
    // pending if it has a valid CRC (means a previous write was in
    // flight but the committed-flip got cut off) — the backend already
    // does its own orphan recovery on the server side, but this is a
    // second line of defence for the wire transfer.
    _resolveSlot(committedJson, pendingJson, emptyValue, label, diagnostics) {
        const crc32 = (typeof window !== 'undefined' && window.OSAWARE_crc32)
            ? window.OSAWARE_crc32
            : null;

        // Try pending first
        if (pendingJson) {
            const parsed = this._parseEnvelope(pendingJson);
            if (parsed && crc32) {
                const expected = crc32(JSON.stringify(parsed.data));
                if (expected === parsed.crc) {
                    diagnostics.orphansSwept++;
                    return parsed.data;
                }
                diagnostics.warnings.push(label + ': pending envelope CRC mismatch, ignoring');
            } else if (parsed && !crc32) {
                // No CRC helper available — trust the pending
                return parsed.data;
            }
        }

        // Fall back to committed
        if (committedJson) {
            const parsed = this._parseEnvelope(committedJson);
            if (!parsed) {
                diagnostics.warnings.push(label + ': committed envelope failed to parse, returning empty');
                return emptyValue;
            }
            if (crc32) {
                const expected = crc32(JSON.stringify(parsed.data));
                if (expected !== parsed.crc) {
                    diagnostics.warnings.push(label + ': committed envelope CRC mismatch (wire corruption?), returning empty');
                    return emptyValue;
                }
            }
            if (label === 'files')  this._lastCommitFiles  = parsed.ts || 0;
            if (label === 'assets') this._lastCommitAssets = parsed.ts || 0;
            return parsed.data;
        }

        // Neither slot present — empty state
        return emptyValue;
    }

    _parseEnvelope(raw) {
        try {
            const env = JSON.parse(raw);
            if (env && typeof env === 'object'
                && typeof env.crc === 'string'
                && env.data !== undefined) {
                return env;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // =======================================================================
    // INTERNAL: binary fetch + encoding helpers
    // =======================================================================

    async _fetchBlob(path) {
        const url = '/api/blob/' + this._encodePath(path);
        const res = await fetch(url, {
            method:      'GET',
            credentials: 'include',
        });
        if (!res.ok) {
            throw new Error('GET ' + url + ' returned ' + res.status);
        }
        return res.arrayBuffer();
    }

    // URL-encode a VFS path for use in /api/blob/:path.
    // Slashes are preserved (they're legal in the URL), but every
    // other non-alphanumeric character gets percent-encoded. This
    // matches how the backend expects paths on the wire.
    _encodePath(path) {
        return String(path).split('/').map(encodeURIComponent).join('/');
    }

    // Convert an ArrayBuffer or Uint8Array to base64.
    _bytesToBase64(buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        // Chunked conversion to avoid call-stack overflow on large buffers.
        // btoa() takes a string, and String.fromCharCode(...huge_array)
        // crashes around 100K chars on most browsers. 8K chunks are safe.
        const CHUNK = 0x2000;
        let str = '';
        for (let i = 0; i < u8.length; i += CHUNK) {
            str += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return btoa(str);
    }

    // Convert a data: URL string back to raw bytes for upload.
    // Returns a Uint8Array.
    _dataUrlToBytes(dataUrl) {
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) throw new Error('not a data: URL');
        const header = dataUrl.substring(0, commaIdx);
        const payload = dataUrl.substring(commaIdx + 1);
        if (header.includes(';base64')) {
            // base64-encoded payload
            const raw = atob(payload);
            const u8 = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
            return u8;
        }
        // URL-encoded payload (rare but legal per RFC 2397)
        const decoded = decodeURIComponent(payload);
        const u8 = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) u8[i] = decoded.charCodeAt(i);
        return u8;
    }

    // Accept raw bytes OR a data: URL and return raw bytes.
    _normaliseBytes(input) {
        if (input instanceof Uint8Array) return input;
        if (input instanceof ArrayBuffer) return new Uint8Array(input);
        if (typeof input === 'string') {
            if (input.startsWith('data:')) return this._dataUrlToBytes(input);
            // Plain string — treat as UTF-8 text
            return new TextEncoder().encode(input);
        }
        throw new Error('unsupported input type');
    }

    // Heuristic: is this asset binary (should go via saveBinary) or text
    // (should stay in the envelope)?
    //
    // Binary if:
    //   - mime starts with image/, audio/, video/, application/octet-stream
    //   - mime is application/zip, application/pdf
    //   - data is a data: URL with a binary mime header
    //
    // Text otherwise (text/*, application/json, application/xml, plain
    // strings under 4KB).
    //
    // This heuristic is duplicated in vfs.js putAsset for routing.
    // Keep them in sync.
    _isBinaryAsset(val) {
        if (!val || typeof val !== 'object') return false;
        const mime = val.mime || '';
        if (mime.startsWith('image/'))  return true;
        if (mime.startsWith('audio/'))  return true;
        if (mime.startsWith('video/'))  return true;
        if (mime === 'application/octet-stream') return true;
        if (mime === 'application/zip') return true;
        if (mime === 'application/pdf') return true;
        // Check data URL header
        const data = val.data || '';
        if (typeof data === 'string' && data.startsWith('data:')) {
            const header = data.substring(5, data.indexOf(','));
            if (header.startsWith('image/') || header.startsWith('audio/') ||
                header.startsWith('video/') || header === 'application/octet-stream') {
                return true;
            }
        }
        return false;
    }
}

// Expose as a global for the non-module script-tag load order.
if (typeof window !== 'undefined') {
    window.RemoteStorageProvider = RemoteStorageProvider;
}

// CommonJS export for Node-based smoke tests. Safe in the browser
// because `module` is undefined there and the typeof guard skips this.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RemoteStorageProvider };
}

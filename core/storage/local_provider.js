'use strict';

// ---------------------------------------------------------------------------
// LocalStorageProvider
//
// Single-tenant storage backend for the OSAWARE VirtualFs. Persists user
// programs and user-created assets to the browser's localStorage.
//
// Storage layout (Layout 2 — separate pending/committed keys):
//   osaware_user_files_committed   — last durable snapshot of user programs
//   osaware_user_files_pending     — in-flight snapshot, present only briefly
//                                    while a save is being verified
//   osaware_user_assets_committed  — last durable snapshot of user assets
//   osaware_user_assets_pending    — in-flight snapshot of user assets
//
// Each value is an envelope:
//   { v: 1, crc: <crc32-hex>, ts: <epoch-ms>, data: <payload> }
//
// Persist sequence (Option D + Approach 1 + Option α):
//   1. Serialise the new payload, compute CRC32
//   2. Write the envelope to the *_pending key (committed key untouched)
//   3. Read it back, verify byte-for-byte match
//   4. On match: copy to *_committed key, then remove *_pending key
//   5. On mismatch: leave *_pending in place; orphan cleanup at next loadAll
//      will validate via CRC and either promote it or delete it
//
// On loadAll() at startup or provider swap:
//   - For each blob (files/assets), check the *_pending key
//   - If pending CRC validates → promote to committed (the verify-then-flip
//     step got cut off, but the data is intact)
//   - If pending CRC is invalid or pending key is malformed → delete it
//     and fall back to whatever is in *_committed
//   - The *_committed key from the previous successful save is never
//     touched until a new committed value is written, so the user's
//     last-known-good state is always preserved.
//
// The interface is async (returns Promises) so the same shape works for
// future remote providers. Reads happen against the cache populated by
// loadAll(); writes are fire-and-forget from the VFS's perspective but
// commit-and-verify under the hood.
// ---------------------------------------------------------------------------

// CRC32 — table-driven, IEEE 802.3 polynomial (0xEDB88320). Pure JS, no deps.
// Returns an unsigned 32-bit integer formatted as 8-char lowercase hex.
const _CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c >>> 0;
    }
    return t;
})();

function crc32(str) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        crc = _CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF] ^ (crc >>> 8);
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// Storage key constants — single source of truth, used for grep + future migration.
const KEY_FILES_COMMITTED  = 'osaware_user_files_committed';
const KEY_FILES_PENDING    = 'osaware_user_files_pending';
const KEY_ASSETS_COMMITTED = 'osaware_user_assets_committed';
const KEY_ASSETS_PENDING   = 'osaware_user_assets_pending';

// Legacy keys (pre-multi-tenant). On first loadAll() we migrate any data
// found under the old names into the new committed slots, then delete the
// old keys. One-shot migration; subsequent boots find nothing.
const LEGACY_KEY_FILES  = 'osaware_user_files';
const LEGACY_KEY_ASSETS = 'osaware_user_assets';

class LocalStorageProvider {

    constructor() {
        this.name = 'local';
        // Track most recent commit time for each blob, useful for diagnostics.
        this._lastCommitFiles  = 0;
        this._lastCommitAssets = 0;
    }

    // -----------------------------------------------------------------------
    // loadAll — async one-shot called at startup or on provider swap.
    // Returns { files, assets, diagnostics }.
    // diagnostics.orphansSwept counts pending envelopes promoted-or-deleted.
    // -----------------------------------------------------------------------
    async loadAll() {
        const diagnostics = {
            provider:       this.name,
            orphansSwept:   0,
            legacyMigrated: false,
            warnings:       [],
        };

        // One-shot migration from legacy single-key layout.
        this._migrateLegacy(diagnostics);

        const files  = this._loadBlob(KEY_FILES_COMMITTED,  KEY_FILES_PENDING,  [], 'files',  diagnostics);
        const assets = this._loadBlob(KEY_ASSETS_COMMITTED, KEY_ASSETS_PENDING, {}, 'assets', diagnostics);

        return { files, assets, diagnostics };
    }

    // -----------------------------------------------------------------------
    // saveFiles — fire-and-forget persist of the user-files array.
    // Returns Promise<boolean> — resolves true on commit, false on failure.
    // VFS callers can ignore the promise (current behaviour) and rely on
    // orphan cleanup to recover from interrupted writes on next boot.
    // -----------------------------------------------------------------------
    async saveFiles(files) {
        return this._persistBlob(KEY_FILES_COMMITTED, KEY_FILES_PENDING, files, 'files');
    }

    // -----------------------------------------------------------------------
    // saveAssets — fire-and-forget persist of the user-assets object.
    // -----------------------------------------------------------------------
    async saveAssets(assets) {
        return this._persistBlob(KEY_ASSETS_COMMITTED, KEY_ASSETS_PENDING, assets, 'assets');
    }

    // -----------------------------------------------------------------------
    // saveBinary / deleteBinary — present for interface symmetry with
    // RemoteStorageProvider. In LOCAL mode, binary assets live inside the
    // same envelope as text assets (because localStorage doesn't care about
    // size up to its ~5MB budget, and base64 inline is how the browser
    // already stores them). The VFS calls saveBinary when a binary write
    // happens, but for the local provider the real persistence is already
    // handled by saveAssets — so saveBinary is a no-op that returns success.
    //
    // These methods exist so the VFS can call provider.saveBinary(...)
    // unconditionally without having to check which provider is active.
    // The remote provider's saveBinary does the real PUT /api/blob/ work.
    // -----------------------------------------------------------------------
    async saveBinary(path, bytesOrDataUrl, mime) {
        // no-op — saveAssets handles the persistence
        return true;
    }

    async deleteBinary(path) {
        // no-op — the deletion is handled by the VFS removing the entry
        // from _userAssets and then calling saveAssets to persist the map
        return true;
    }

    // =======================================================================
    // INTERNAL: blob persistence with envelope + CRC + verify-and-flip
    // =======================================================================

    _persistBlob(committedKey, pendingKey, payload, label) {
        let serialised, crc;
        try {
            serialised = JSON.stringify(payload);
            crc = crc32(serialised);
        } catch (e) {
            console.warn('LocalStorageProvider: failed to serialise ' + label + ' for persist:', e);
            return false;
        }

        const envelope = {
            v:    1,
            crc:  crc,
            ts:   Date.now(),
            data: payload,
        };
        let envelopeStr;
        try {
            envelopeStr = JSON.stringify(envelope);
        } catch (e) {
            console.warn('LocalStorageProvider: failed to wrap envelope for ' + label + ':', e);
            return false;
        }

        // Step 1: write to the pending slot. The committed slot is untouched.
        try {
            localStorage.setItem(pendingKey, envelopeStr);
        } catch (e) {
            console.warn('LocalStorageProvider: localStorage write failed for ' + label + ' (pending):', e);
            return false;
        }

        // Step 2: read back from pending and verify byte-for-byte.
        let readBack;
        try {
            readBack = localStorage.getItem(pendingKey);
        } catch (e) {
            console.warn('LocalStorageProvider: localStorage readback failed for ' + label + ':', e);
            return false;
        }
        if (readBack !== envelopeStr) {
            console.warn('LocalStorageProvider: pending readback mismatch for ' + label + ' — leaving pending in place for orphan cleanup');
            return false;
        }

        // Step 3: pending verified. Promote to committed.
        try {
            localStorage.setItem(committedKey, envelopeStr);
        } catch (e) {
            console.warn('LocalStorageProvider: localStorage write failed for ' + label + ' (committed):', e);
            return false;
        }

        // Step 4: clear the pending slot — write is now durable.
        try {
            localStorage.removeItem(pendingKey);
        } catch (e) {
            // Non-fatal: orphan cleanup at next boot will resolve.
            console.warn('LocalStorageProvider: failed to clear pending slot for ' + label + ':', e);
        }

        if (label === 'files')  this._lastCommitFiles  = envelope.ts;
        if (label === 'assets') this._lastCommitAssets = envelope.ts;
        return true;
    }

    // =======================================================================
    // INTERNAL: blob loading with orphan cleanup (Option α — boot scan)
    // =======================================================================

    _loadBlob(committedKey, pendingKey, emptyValue, label, diagnostics) {
        // First, check the pending slot. If it exists, attempt to validate
        // and either promote or discard it.
        let pendingRaw = null;
        try {
            pendingRaw = localStorage.getItem(pendingKey);
        } catch (e) {
            // localStorage unavailable entirely; nothing to do.
        }

        if (pendingRaw !== null) {
            const result = this._validateAndPromotePending(committedKey, pendingKey, pendingRaw, label, diagnostics);
            if (result !== null) {
                // Pending was valid and promoted — return its data directly.
                return result;
            }
            // Pending was invalid; fall through to load committed.
        }

        // Load the committed slot.
        let committedRaw = null;
        try {
            committedRaw = localStorage.getItem(committedKey);
        } catch (e) {
            return emptyValue;
        }
        if (committedRaw === null) return emptyValue;

        const parsed = this._parseEnvelope(committedRaw, label, diagnostics);
        if (parsed === null) {
            diagnostics.warnings.push(label + ': committed envelope failed to parse, falling back to empty');
            return emptyValue;
        }

        // Verify the committed envelope's CRC too — defends against external
        // corruption (browser extensions, manual editing, storage bit-rot).
        const expectedCrc = crc32(JSON.stringify(parsed.data));
        if (expectedCrc !== parsed.crc) {
            diagnostics.warnings.push(label + ': committed envelope CRC mismatch (expected ' + expectedCrc + ', got ' + parsed.crc + '), falling back to empty');
            return emptyValue;
        }

        if (label === 'files')  this._lastCommitFiles  = parsed.ts || 0;
        if (label === 'assets') this._lastCommitAssets = parsed.ts || 0;
        return parsed.data;
    }

    // Validate a pending envelope. If the CRC checks out, promote it to the
    // committed slot, clear the pending slot, and return the data. If the
    // pending envelope is invalid, delete it and return null (caller will
    // fall back to the committed slot).
    _validateAndPromotePending(committedKey, pendingKey, pendingRaw, label, diagnostics) {
        const parsed = this._parseEnvelope(pendingRaw, label, diagnostics);
        if (parsed === null) {
            // Malformed pending — delete it.
            diagnostics.orphansSwept++;
            diagnostics.warnings.push(label + ': pending envelope malformed, discarding orphan');
            try { localStorage.removeItem(pendingKey); } catch (e) {}
            return null;
        }

        const expectedCrc = crc32(JSON.stringify(parsed.data));
        if (expectedCrc !== parsed.crc) {
            // CRC mismatch — pending was likely truncated mid-write.
            diagnostics.orphansSwept++;
            diagnostics.warnings.push(label + ': pending envelope CRC mismatch, discarding orphan');
            try { localStorage.removeItem(pendingKey); } catch (e) {}
            return null;
        }

        // Pending is valid — promote it. The verify-and-flip in the original
        // write sequence got cut off, but the data is intact.
        diagnostics.orphansSwept++;
        try {
            localStorage.setItem(committedKey, pendingRaw);
            localStorage.removeItem(pendingKey);
        } catch (e) {
            diagnostics.warnings.push(label + ': failed to promote pending orphan — will retry next boot');
            // Even if the promote write failed, the data we already parsed
            // is valid and we can hand it back to the caller for this session.
        }

        if (label === 'files')  this._lastCommitFiles  = parsed.ts || 0;
        if (label === 'assets') this._lastCommitAssets = parsed.ts || 0;
        return parsed.data;
    }

    _parseEnvelope(raw, label, diagnostics) {
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
    // INTERNAL: one-shot migration from legacy single-key layout
    // =======================================================================
    _migrateLegacy(diagnostics) {
        let migrated = false;

        // Files — legacy key was 'osaware_user_files', value was raw JSON array.
        try {
            const legacyFiles = localStorage.getItem(LEGACY_KEY_FILES);
            const newFilesExists = localStorage.getItem(KEY_FILES_COMMITTED) !== null;
            if (legacyFiles !== null && !newFilesExists) {
                let parsed = null;
                try { parsed = JSON.parse(legacyFiles); } catch (e) {}
                if (Array.isArray(parsed)) {
                    this._persistBlob(KEY_FILES_COMMITTED, KEY_FILES_PENDING, parsed, 'files');
                    migrated = true;
                }
                localStorage.removeItem(LEGACY_KEY_FILES);
            } else if (legacyFiles !== null && newFilesExists) {
                // New key already populated — discard legacy without migration.
                localStorage.removeItem(LEGACY_KEY_FILES);
            }
        } catch (e) {
            diagnostics.warnings.push('legacy files migration failed: ' + (e.message || e));
        }

        // Assets — legacy key was 'osaware_user_assets', value was raw JSON object.
        try {
            const legacyAssets = localStorage.getItem(LEGACY_KEY_ASSETS);
            const newAssetsExists = localStorage.getItem(KEY_ASSETS_COMMITTED) !== null;
            if (legacyAssets !== null && !newAssetsExists) {
                let parsed = null;
                try { parsed = JSON.parse(legacyAssets); } catch (e) {}
                if (parsed && typeof parsed === 'object') {
                    this._persistBlob(KEY_ASSETS_COMMITTED, KEY_ASSETS_PENDING, parsed, 'assets');
                    migrated = true;
                }
                localStorage.removeItem(LEGACY_KEY_ASSETS);
            } else if (legacyAssets !== null && newAssetsExists) {
                localStorage.removeItem(LEGACY_KEY_ASSETS);
            }
        } catch (e) {
            diagnostics.warnings.push('legacy assets migration failed: ' + (e.message || e));
        }

        diagnostics.legacyMigrated = migrated;
    }
}

// Make available as a global for the non-module script-tag load order.
if (typeof window !== 'undefined') {
    window.LocalStorageProvider = LocalStorageProvider;
    window.OSAWARE_crc32 = crc32;
}

// CommonJS export for Node-based smoke tests. Guarded so the browser
// path (where `module` is undefined) is unaffected.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LocalStorageProvider, crc32 };
}

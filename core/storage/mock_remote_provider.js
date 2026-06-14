'use strict';

// ---------------------------------------------------------------------------
// MockRemoteStorageProvider
//
// In-memory multi-user storage backend that pretends to be a remote server.
// Used exclusively by the DEV* BASIC commands (DEVLOGIN / DEVLOGOUT / etc.)
// for testing the multi-tenant plumbing without requiring a real backend.
// The real RemoteStorageProvider (step 4) will speak the same interface but
// swap the in-memory table for HTTP calls.
//
// Design notes:
//
// 1. SINGLETON USER STORE
//    The per-user data lives in a module-level Map that all instances of
//    this class share. This is deliberate: it simulates a real remote where
//    any client pointing at the same user sees the same data. Two VFS
//    instances (or two provider swaps) for alice both read/write alice's
//    namespace. This is what makes VFSAUTHTEST's "logout alice, login alice
//    again, data still there" assertion meaningful.
//
// 2. HARDCODED USERS
//    For testing only. The user table is baked into the source:
//      alice / pass1
//      bob   / pass2
//      test  / test
//    This is fine because the mock never leaves the browser and the
//    passwords are visible in the JS source anyway. The real provider will
//    do proper hashed-password auth against a backend.
//
// 3. CONFIGURABLE LATENCY
//    Each async method sleeps for `this._latency` ms (default 50) before
//    resolving. This forces calling code to handle real async timing from
//    day one, rather than silently relying on synchronous behaviour that
//    would break against a real network.
//
// 4. SAME ENVELOPE + CRC AS LOCAL PROVIDER
//    Reuses the envelope format {v, crc, ts, data} and OSAWARE_crc32 from
//    local_provider.js. This means loadAll() diagnostics, orphan cleanup,
//    and corruption detection all work identically across providers — no
//    special cases in the VFS swap code.
//
// 5. PER-USER PENDING/COMMITTED SLOTS
//    Each user has their own pending and committed slots for files and
//    assets, just like the local provider but keyed by username inside
//    the singleton store rather than by localStorage key. Same Layout 2
//    semantics: committed is never touched during a pending write.
//
// 6. ORPHAN CLEANUP
//    loadAll() runs the same boot-scan orphan recovery as the local
//    provider. For the mock this is mostly ornamental (nothing truly
//    interrupts a synchronous in-memory write), but it's important that
//    the interface is identical to the local provider so tests written
//    against one work against the other.
//
// 7. NOT PERSISTENT ACROSS RELOADS
//    All data lives in the module-level Map, which is wiped when the tab
//    closes. This is intentional — the mock is for testing the swap
//    plumbing, not for actual data storage.
// ---------------------------------------------------------------------------

// Module-level singleton user store. Key: username. Value: per-user slots.
// Shape:
//   {
//     alice: {
//       files_committed: <envelope-string or null>,
//       files_pending:   <envelope-string or null>,
//       assets_committed: <envelope-string or null>,
//       assets_pending:   <envelope-string or null>,
//     },
//     bob: { ... },
//   }
const _MOCK_USER_STORE = new Map();

// Hardcoded credentials table. Plaintext is fine — this is a test fake.
// Mutable so DEV-mode password changes (V7B24+) actually persist for the
// page lifetime. Reset on page reload.
const _MOCK_CREDENTIALS = {
    'alice': 'pass1',
    'bob':   'pass2',
    'test':  'test',
};

// Archived users set (V7B24+). Once a user is archived in DEV mode, their
// credentials remain in _MOCK_CREDENTIALS but DEVLOGIN against them will
// fail because validateCredentials checks this set first. The username is
// considered "archived" until page reload (the mock has no persistence).
const _MOCK_ARCHIVED = new Set();

// Short sleep helper — simulates network round-trip latency.
function _mockDelay(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ensure a user has slot entries in the store (lazy init).
function _ensureUserSlots(username) {
    if (!_MOCK_USER_STORE.has(username)) {
        _MOCK_USER_STORE.set(username, {
            files_committed:  null,
            files_pending:    null,
            assets_committed: null,
            assets_pending:   null,
        });
    }
    return _MOCK_USER_STORE.get(username);
}

export class MockRemoteStorageProvider {

    // Construct a provider bound to a specific user.
    // opts.latency: ms to delay each async call (default 50, or
    //               window.OSAWARE_MOCK_LATENCY if set for global override)
    // opts.username: required — which user's namespace this provider serves
    constructor(opts = {}) {
        if (!opts.username) {
            throw new Error('MockRemoteStorageProvider requires opts.username');
        }
        this.name     = 'mock:' + opts.username;
        this.username = opts.username;
        // Precedence: explicit opts.latency > global env var > default 50
        if (typeof opts.latency === 'number') {
            this._latency = opts.latency;
        } else if (typeof window !== 'undefined' && typeof window.OSAWARE_MOCK_LATENCY === 'number') {
            this._latency = window.OSAWARE_MOCK_LATENCY;
        } else {
            this._latency = 50;
        }
    }

    // -----------------------------------------------------------------------
    // validateCredentials — static-ish helper used by AuthService to check
    // a username+password pair before constructing a provider instance.
    // Returns true if the credentials are valid, false otherwise.
    // NOT part of the storage interface — this is a mock-specific method.
    // -----------------------------------------------------------------------
    static validateCredentials(username, password) {
        if (!username || typeof username !== 'string') return false;
        if (typeof password !== 'string') return false;
        // Archived users can't log in (V7B24+)
        if (_MOCK_ARCHIVED.has(username)) return false;
        const expected = _MOCK_CREDENTIALS[username];
        return expected !== undefined && expected === password;
    }

    // -----------------------------------------------------------------------
    // listUsers — return the list of valid usernames. Used by tests and
    // diagnostics. Doesn't expose passwords.
    // -----------------------------------------------------------------------
    static listUsers() {
        return Object.keys(_MOCK_CREDENTIALS);
    }

    // -----------------------------------------------------------------------
    // _resetStore — WIPE the entire mock store. Used only by tests and the
    // DEV shell commands if we ever need a clean slate. Not reachable from
    // BASIC programs.
    // -----------------------------------------------------------------------
    static _resetStore() {
        _MOCK_USER_STORE.clear();
        _MOCK_ARCHIVED.clear();
        // Restore default credentials in case tests mutated them
        _MOCK_CREDENTIALS['alice'] = 'pass1';
        _MOCK_CREDENTIALS['bob']   = 'pass2';
        _MOCK_CREDENTIALS['test']  = 'test';
    }

    // -----------------------------------------------------------------------
    // changePassword — DEV-mode self-service password change (V7B24+).
    //
    // Verifies the current password, updates _MOCK_CREDENTIALS in place.
    // The change persists until page reload. Returns {ok, error?}.
    // Called by AuthService.devChangePassword, never by user code.
    // -----------------------------------------------------------------------
    async changePassword(username, currentPassword, newPassword) {
        await _mockDelay(this._latency);
        if (typeof username !== 'string' || !username) {
            return { ok: false, error: 'username required' };
        }
        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
            return { ok: false, error: 'password required' };
        }
        if (_MOCK_ARCHIVED.has(username)) {
            return { ok: false, error: 'account is archived' };
        }
        const expected = _MOCK_CREDENTIALS[username];
        if (expected === undefined) {
            return { ok: false, error: 'no such user' };
        }
        if (expected !== currentPassword) {
            return { ok: false, error: 'invalid credentials' };
        }
        if (newPassword.length < 4) {
            return { ok: false, error: 'new password too short (min 4 chars in DEV mode)' };
        }
        _MOCK_CREDENTIALS[username] = newPassword;
        return { ok: true };
    }

    // -----------------------------------------------------------------------
    // archiveUser — DEV-mode self-service account archive (V7B24+).
    //
    // Verifies the password, marks the user as archived in _MOCK_ARCHIVED.
    // Subsequent DEVLOGIN attempts against the username will fail. The
    // user's data remains in _MOCK_USER_STORE so it could in principle
    // be restored (no UI for that). Returns {ok, error?}.
    // -----------------------------------------------------------------------
    async archiveUser(username, password) {
        await _mockDelay(this._latency);
        if (typeof username !== 'string' || !username) {
            return { ok: false, error: 'username required' };
        }
        if (typeof password !== 'string') {
            return { ok: false, error: 'password required' };
        }
        if (_MOCK_ARCHIVED.has(username)) {
            return { ok: false, error: 'already archived' };
        }
        const expected = _MOCK_CREDENTIALS[username];
        if (expected === undefined) {
            return { ok: false, error: 'no such user' };
        }
        if (expected !== password) {
            return { ok: false, error: 'invalid credentials' };
        }
        _MOCK_ARCHIVED.add(username);
        return { ok: true };
    }

    // =======================================================================
    // Storage provider interface (matches LocalStorageProvider)
    // =======================================================================

    async loadAll() {
        await _mockDelay(this._latency);

        const diagnostics = {
            provider:       this.name,
            orphansSwept:   0,
            legacyMigrated: false,
            warnings:       [],
        };

        const slots = _ensureUserSlots(this.username);

        const files  = this._loadBlob(slots, 'files_committed',  'files_pending',  [], 'files',  diagnostics);
        const assets = this._loadBlob(slots, 'assets_committed', 'assets_pending', {}, 'assets', diagnostics);

        return { files, assets, diagnostics };
    }

    async saveFiles(files) {
        await _mockDelay(this._latency);
        const slots = _ensureUserSlots(this.username);
        return this._persistBlob(slots, 'files_committed', 'files_pending', files, 'files');
    }

    async saveAssets(assets) {
        await _mockDelay(this._latency);
        const slots = _ensureUserSlots(this.username);
        return this._persistBlob(slots, 'assets_committed', 'assets_pending', assets, 'assets');
    }

    // -----------------------------------------------------------------------
    // saveBinary / deleteBinary — interface symmetry with RemoteStorageProvider.
    // In DEV mode (mock) the assets Map holds binaries inline just like
    // LocalStorageProvider, so these are no-ops that return success. The
    // real persistence happens via saveAssets.
    // -----------------------------------------------------------------------
    async saveBinary(path, bytesOrDataUrl, mime) {
        return true;   // no-op
    }

    async deleteBinary(path) {
        return true;   // no-op
    }

    // =======================================================================
    // INTERNAL: blob persistence with envelope + CRC + verify-and-flip
    // (Same semantics as LocalStorageProvider, but operates on the
    // singleton store instead of localStorage.)
    // =======================================================================

    _persistBlob(slots, committedKey, pendingKey, payload, label) {
        const crc32 = (typeof window !== 'undefined' && window.OSAWARE_crc32)
            ? window.OSAWARE_crc32
            : global.OSAWARE_crc32;
        if (!crc32) {
            console.warn('MockRemoteStorageProvider: OSAWARE_crc32 not available — local_provider.js must load first');
            return false;
        }

        let serialised, crc;
        try {
            serialised = JSON.stringify(payload);
            crc = crc32(serialised);
        } catch (e) {
            console.warn('MockRemoteStorageProvider: failed to serialise ' + label + ':', e);
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
            console.warn('MockRemoteStorageProvider: failed to wrap envelope for ' + label + ':', e);
            return false;
        }

        // Layout 2: write to pending first, committed untouched.
        slots[pendingKey] = envelopeStr;

        // Verify the write by reading back. In the in-memory case this is
        // always a trivial identity check, but the discipline matches the
        // local provider so tests behave the same way.
        if (slots[pendingKey] !== envelopeStr) {
            console.warn('MockRemoteStorageProvider: pending readback mismatch for ' + label);
            return false;
        }

        // Promote to committed, then clear pending.
        slots[committedKey] = envelopeStr;
        slots[pendingKey]   = null;

        return true;
    }

    // =======================================================================
    // INTERNAL: blob loading with orphan cleanup (Option α — boot scan)
    // =======================================================================

    _loadBlob(slots, committedKey, pendingKey, emptyValue, label, diagnostics) {
        const pendingRaw = slots[pendingKey];
        if (pendingRaw !== null && pendingRaw !== undefined) {
            const result = this._validateAndPromotePending(slots, committedKey, pendingKey, pendingRaw, label, diagnostics);
            if (result !== null) return result;
        }

        const committedRaw = slots[committedKey];
        if (committedRaw === null || committedRaw === undefined) return emptyValue;

        const parsed = this._parseEnvelope(committedRaw);
        if (parsed === null) {
            diagnostics.warnings.push(label + ': committed envelope failed to parse, falling back to empty');
            return emptyValue;
        }

        // Verify committed CRC — defends against any in-memory corruption
        // (which shouldn't happen, but the test suite can plant bad data).
        const crc32 = (typeof window !== 'undefined' && window.OSAWARE_crc32)
            ? window.OSAWARE_crc32
            : global.OSAWARE_crc32;
        if (!crc32) return parsed.data;  // can't verify, trust the store

        const expectedCrc = crc32(JSON.stringify(parsed.data));
        if (expectedCrc !== parsed.crc) {
            diagnostics.warnings.push(label + ': committed envelope CRC mismatch, falling back to empty');
            return emptyValue;
        }

        return parsed.data;
    }

    _validateAndPromotePending(slots, committedKey, pendingKey, pendingRaw, label, diagnostics) {
        const parsed = this._parseEnvelope(pendingRaw);
        if (parsed === null) {
            diagnostics.orphansSwept++;
            diagnostics.warnings.push(label + ': pending envelope malformed, discarding orphan');
            slots[pendingKey] = null;
            return null;
        }

        const crc32 = (typeof window !== 'undefined' && window.OSAWARE_crc32)
            ? window.OSAWARE_crc32
            : global.OSAWARE_crc32;
        if (!crc32) return null;

        const expectedCrc = crc32(JSON.stringify(parsed.data));
        if (expectedCrc !== parsed.crc) {
            diagnostics.orphansSwept++;
            diagnostics.warnings.push(label + ': pending envelope CRC mismatch, discarding orphan');
            slots[pendingKey] = null;
            return null;
        }

        // Pending is valid — promote it.
        diagnostics.orphansSwept++;
        slots[committedKey] = pendingRaw;
        slots[pendingKey]   = null;
        return parsed.data;
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
}

// Expose as globals for the non-module script-tag load order.
if (typeof window !== 'undefined') {
    window.MockRemoteStorageProvider = MockRemoteStorageProvider;
}

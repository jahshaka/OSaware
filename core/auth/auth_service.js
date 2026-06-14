'use strict';

import { LocalStorageProvider }      from '../storage/local_provider.js';
import { MockRemoteStorageProvider } from '../storage/mock_remote_provider.js';
import { RemoteStorageProvider }     from '../storage/remote_provider.js';

// ---------------------------------------------------------------------------
// AuthService
//
// Single point of truth for auth state in OSAWARE. Owned by the boot
// sequence (init(vfs) is called once at startup), called into by the
// DEV* and LOGIN/LOGOUT/REGISTER shell commands.
//
// STATE MODEL
// ===========
//
// OSAWARE supports three distinct auth modes that share the same VFS
// storage slot but never mix:
//
//   LOCAL         — single-tenant browser mode. VFS uses LocalStorageProvider.
//                   No auth. This is the default and most common state.
//                   `_devUser` and `_realUser` are both null.
//
//   DEV(alice)    — dev sandbox. VFS uses MockRemoteStorageProvider namespaced
//                   to alice. Entered via devLogin(), exited via devLogout().
//                   `_devUser = 'alice'`, `_realUser = null`.
//
//   REAL(alice)   — (future, step 4) real authenticated session. VFS uses the
//                   real RemoteStorageProvider. `_realUser = 'alice'`,
//                   `_devUser = null`.
//
// CROSSED TRANSITIONS (Option 1 — errors, no auto-swap)
// ======================================================
//
// You cannot go directly from DEV to REAL or vice versa. The user must
// explicitly devLogout() or logout() to return to LOCAL first, then log
// into the other mode. Crossed transitions return an error object:
//
//   { ok: false, error: 'in dev sandbox — DEVLOGOUT first' }
//
// Rationale: each mode owns the VFS storage slot, and silent swaps would
// let users lose track of which namespace they're writing to. Explicit
// transitions are the clearest mental model.
//
// VFS COUPLING
// ============
//
// AuthService holds a reference to the VFS instance and calls
// vfs.setStorageProvider() to swap backends on login/logout. It does NOT
// know about BASIC commands, terminal output, or any shell specifics —
// the shell layer (shell.js cmdDEVLOGIN etc.) calls AuthService and
// translates the result into user-facing messages.
//
// SINGLETON PATTERN
// =================
//
// There is exactly one AuthService per OSAWARE session. State is held in
// module-private variables (not on `this`) so it's genuinely global and
// can't be accidentally forked by misuse. The class is exported as a
// namespace of static methods that operate on the shared state.
// ---------------------------------------------------------------------------

// Module-private state. Not on the class.
let _vfs           = null;     // VirtualFs reference, set by init()
let _devUser       = null;     // username or null
let _realUser      = null;     // username or null
let _devProvider   = null;     // cached MockRemoteStorageProvider instance for current dev user
let _realProvider  = null;     // cached RemoteStorageProvider instance for current real user
let _localProvider = null;     // cached LocalStorageProvider to restore on logout

export class AuthService {

    // -----------------------------------------------------------------------
    // init — wire up the VFS reference. Called once at boot time by boot.js
    // after `new Interpreter(...)`. Must happen before any devLogin() call.
    //
    // Idempotent: calling init() a second time re-binds the vfs reference
    // but does not reset auth state. (State can only be reset by an
    // explicit logout.)
    // -----------------------------------------------------------------------
    static init(vfs) {
        if (!vfs) {
            console.warn('AuthService.init: called with null/undefined vfs');
            return;
        }
        _vfs = vfs;
        // Remember the initial local provider so we can swap back to the
        // same instance on logout — keeping its in-memory cache warm.
        if (!_localProvider && _vfs._storage && _vfs._storage.name === 'local') {
            _localProvider = _vfs._storage;
        }
    }

    // =======================================================================
    // DEV auth family (DEVLOGIN / DEVLOGOUT / DEVWHOAMI)
    // =======================================================================

    // devLogin — validate credentials, swap VFS to mock provider for the
    // given user. Returns { ok, error?, user? }.
    //
    // Error cases:
    //   - already logged in via DEVLOGIN (including same user)
    //   - already logged in via LOGIN (crossed transition)
    //   - invalid credentials
    //   - vfs not initialised
    //   - storage swap failed
    static async devLogin(username, password) {
        if (!_vfs) {
            return { ok: false, error: 'auth service not initialised (vfs missing)' };
        }
        if (_devUser) {
            return { ok: false, error: 'already logged in as ' + _devUser + ' (dev) — DEVLOGOUT first' };
        }
        if (_realUser) {
            return { ok: false, error: 'logged in via real provider — LOGOUT first' };
        }
        if (false) {
            return { ok: false, error: 'mock provider unavailable' };
        }
        if (!MockRemoteStorageProvider.validateCredentials(username, password)) {
            return { ok: false, error: 'invalid credentials' };
        }

        // Remember the outgoing local provider so logout can restore to
        // the same instance (and its warm cache).
        if (!_localProvider) _localProvider = _vfs._storage;

        // Construct a new mock provider bound to this user and swap to it.
        // Note: save-before-swap is on by default, so any in-memory work
        // in the local provider gets persisted before we leave it.
        const mock = new MockRemoteStorageProvider({ username });
        try {
            await _vfs.setStorageProvider(mock, { skipSave: false });
        } catch (e) {
            return { ok: false, error: 'storage swap failed: ' + (e.message || e) };
        }

        _devUser     = username;
        _devProvider = mock;
        return { ok: true, user: username };
    }

    // devLogout — swap VFS back to the local provider. Default behaviour
    // saves the dev user's in-memory data to their namespace before the
    // swap (skipSave: false).
    //
    // Error cases:
    //   - not currently logged in via DEVLOGIN
    //   - in real mode (crossed transition)
    //   - storage swap failed
    static async devLogout() {
        if (!_vfs) {
            return { ok: false, error: 'auth service not initialised (vfs missing)' };
        }
        if (_realUser) {
            return { ok: false, error: 'logged in via real provider — use LOGOUT instead' };
        }
        if (!_devUser) {
            return { ok: false, error: 'not logged in' };
        }

        const outgoingUser = _devUser;

        // Swap back to the local provider. If the initial local provider
        // was cached, reuse it (keeping its warm cache); otherwise create
        // a fresh one.
        const target = _localProvider || (
            true
                ? new LocalStorageProvider()
                : null
        );
        if (!target) {
            return { ok: false, error: 'local provider unavailable' };
        }

        try {
            await _vfs.setStorageProvider(target, { skipSave: false });
        } catch (e) {
            return { ok: false, error: 'storage swap failed: ' + (e.message || e) };
        }

        _devUser     = null;
        _devProvider = null;
        return { ok: true, user: outgoingUser };
    }

    // devCurrentUser — return the current dev username, or null if not in
    // dev mode. Does NOT report real-auth state — use currentUser() for that.
    static devCurrentUser() {
        return _devUser;
    }

    // devIsAuthenticated — true if currently in DEV mode.
    static devIsAuthenticated() {
        return _devUser !== null;
    }

    // =======================================================================
    // REAL auth family (LOGIN / LOGOUT / REGISTER)
    //
    // These call the real backend via RemoteStorageProvider's fetch-based
    // API. Same state machine as the DEV family, but talks HTTP and uses
    // production cookie-based sessions.
    //
    // The pattern is:
    //   1. Validate crossed transitions (must be in LOCAL mode)
    //   2. POST /api/login or /api/register — this sets the session cookie
    //   3. Construct a new RemoteStorageProvider
    //   4. Call vfs.setStorageProvider(remote, {skipSave: false}) — this
    //      saves the outgoing local provider's in-memory cache and loads
    //      the remote user's data via provider.loadAll()
    //   5. Cache the provider and username; return { ok: true, user }
    //
    // Logout is the mirror: swap back to local, DELETE the session cookie
    // on the server.
    // =======================================================================

    static async login(username, password) {
        if (!_vfs) {
            return { ok: false, error: 'auth service not initialised (vfs missing)' };
        }
        if (_devUser) {
            return { ok: false, error: 'in dev sandbox — DEVLOGOUT first' };
        }
        if (_realUser) {
            return { ok: false, error: 'already logged in as ' + _realUser + ' — LOGOUT first' };
        }
        if (false) {
            return { ok: false, error: 'remote provider unavailable' };
        }

        // Step 1: POST /api/login to get a session cookie set on the browser.
        let response;
        try {
            response = await fetch('/api/login', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ username, password }),
            });
        } catch (e) {
            return { ok: false, error: 'network error: ' + (e.message || e) };
        }

        if (response.status === 401) {
            return { ok: false, error: 'invalid credentials' };
        }
        if (!response.ok) {
            let errMsg = 'login failed (' + response.status + ')';
            try {
                const body = await response.json();
                if (body && body.error) errMsg = body.error;
            } catch (e) { /* ignore */ }
            return { ok: false, error: errMsg };
        }

        // Session cookie is now set on the browser (HttpOnly, we can't see it).
        // Step 2: cache the local provider so logout can restore it
        if (!_localProvider) _localProvider = _vfs._storage;

        // Step 3: construct a RemoteStorageProvider and swap
        const remote = new RemoteStorageProvider();
        try {
            await _vfs.setStorageProvider(remote, { skipSave: false });
        } catch (e) {
            // The cookie is set but the swap failed — try to clean up
            // by calling /api/logout. We don't await it because there's
            // nothing meaningful to do if it also fails.
            try { fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
            return { ok: false, error: 'storage swap failed: ' + (e.message || e) };
        }

        _realUser     = username;
        _realProvider = remote;
        return { ok: true, user: username };
    }

    static async logout() {
        if (!_vfs) {
            return { ok: false, error: 'auth service not initialised (vfs missing)' };
        }
        if (_devUser) {
            return { ok: false, error: 'in dev sandbox — use DEVLOGOUT instead' };
        }
        if (!_realUser) {
            return { ok: false, error: 'not logged in' };
        }

        const outgoingUser = _realUser;

        // Step 1: swap back to local provider. This persists the real
        // user's in-memory state to the backend (via saveFiles/saveAssets)
        // before swapping because skipSave is false by default.
        const target = _localProvider || (
            true
                ? new LocalStorageProvider()
                : null
        );
        if (!target) {
            return { ok: false, error: 'local provider unavailable' };
        }

        try {
            await _vfs.setStorageProvider(target, { skipSave: false });
        } catch (e) {
            return { ok: false, error: 'storage swap failed: ' + (e.message || e) };
        }

        // Step 2: tell the server to drop the session cookie.
        // Fire-and-forget — if it fails the local state is already swapped
        // out, and the server-side session will expire naturally.
        try {
            await fetch('/api/logout', {
                method:      'POST',
                credentials: 'include',
            });
        } catch (e) {
            console.warn('AuthService.logout: /api/logout failed:', e.message || e);
        }

        _realUser     = null;
        _realProvider = null;
        return { ok: true, user: outgoingUser };
    }

    static async register(username, password) {
        if (!_vfs) {
            return { ok: false, error: 'auth service not initialised (vfs missing)' };
        }
        if (_devUser) {
            return { ok: false, error: 'in dev sandbox — DEVLOGOUT first' };
        }
        if (_realUser) {
            return { ok: false, error: 'already logged in as ' + _realUser + ' — LOGOUT first' };
        }
        if (false) {
            return { ok: false, error: 'remote provider unavailable' };
        }

        // POST /api/register — on success the backend auto-creates a session
        // and sets the cookie, so we're effectively auto-logged-in.
        let response;
        try {
            response = await fetch('/api/register', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({ username, password }),
            });
        } catch (e) {
            return { ok: false, error: 'network error: ' + (e.message || e) };
        }

        if (response.status === 409) {
            return { ok: false, error: 'username already taken' };
        }
        if (response.status === 400) {
            let errMsg = 'invalid username or password';
            try {
                const body = await response.json();
                if (body && body.error) errMsg = body.error;
            } catch (e) { /* ignore */ }
            return { ok: false, error: errMsg };
        }
        if (!response.ok) {
            let errMsg = 'registration failed (' + response.status + ')';
            try {
                const body = await response.json();
                if (body && body.error) errMsg = body.error;
            } catch (e) { /* ignore */ }
            return { ok: false, error: errMsg };
        }

        // Same as login: cache local provider, swap to remote, remember user
        if (!_localProvider) _localProvider = _vfs._storage;

        const remote = new RemoteStorageProvider();
        try {
            await _vfs.setStorageProvider(remote, { skipSave: false });
        } catch (e) {
            try { fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
            return { ok: false, error: 'storage swap failed: ' + (e.message || e) };
        }

        _realUser     = username;
        _realProvider = remote;
        return { ok: true, user: username, firstTime: true };
    }

    // currentUser — real-auth current user, or null if not in real mode.
    static currentUser() {
        return _realUser;
    }

    // isAuthenticated — real-auth session active?
    static isAuthenticated() {
        return _realUser !== null;
    }

    // =======================================================================
    // Self-service password change and account archival (V7B24+)
    // =======================================================================

    // changePassword(currentPw, newPw) — change own password.
    //
    // Calls POST /api/password. Backend verifies the current password,
    // hashes and saves the new one, and invalidates all OTHER sessions
    // (other devices). The current device's session stays valid because
    // the user just authenticated to perform the change.
    //
    // No local storage changes, no provider swap — the user stays in the
    // same auth state. Just an API call.
    //
    // Returns: {ok: true, sessions_invalidated: N} or {ok: false, error: '...'}
    static async changePassword(currentPassword, newPassword) {
        if (!_realUser) {
            return { ok: false, error: 'not logged in (use LOGIN first)' };
        }
        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
            return { ok: false, error: 'current and new password required' };
        }
        if (currentPassword === newPassword) {
            return { ok: false, error: 'new password must differ from current password' };
        }

        let response;
        try {
            response = await fetch('/api/password', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    current_password: currentPassword,
                    new_password:     newPassword,
                }),
            });
        } catch (e) {
            return { ok: false, error: 'network error: ' + (e.message || e) };
        }

        let body = null;
        try { body = await response.json(); } catch (e) { /* ignore */ }

        if (!response.ok) {
            const msg = (body && body.error) || ('HTTP ' + response.status);
            return { ok: false, error: msg };
        }

        return {
            ok: true,
            user: _realUser,
            sessions_invalidated: (body && body.sessions_invalidated) || 0,
        };
    }

    // archiveSelf(password, usernameConfirm) — soft-delete own account.
    //
    // Calls POST /api/archive-self. Backend verifies the password and
    // username confirmation, then archives the account (sets archived_at,
    // moves the username to a tombstone, frees the original username for
    // re-registration), deletes ALL sessions for this user (including the
    // current one), and clears the session cookie.
    //
    // On success, this is essentially a forced logout: we swap back to
    // the local provider so the user's LOCAL data returns, and clear
    // _realUser so currentUser() reports null. From the user's perspective
    // they've been kicked back to the not-logged-in state with their
    // local sandbox restored.
    //
    // Returns: {ok: true, archived_username: '...'} or {ok: false, error: '...'}
    static async archiveSelf(password, usernameConfirm) {
        if (!_realUser) {
            return { ok: false, error: 'not logged in (use LOGIN first)' };
        }
        if (typeof password !== 'string' || typeof usernameConfirm !== 'string') {
            return { ok: false, error: 'password and username confirmation required' };
        }

        let response;
        try {
            response = await fetch('/api/archive-self', {
                method:      'POST',
                credentials: 'include',
                headers:     { 'Content-Type': 'application/json' },
                body:        JSON.stringify({
                    password:         password,
                    username_confirm: usernameConfirm,
                }),
            });
        } catch (e) {
            return { ok: false, error: 'network error: ' + (e.message || e) };
        }

        let body = null;
        try { body = await response.json(); } catch (e) { /* ignore */ }

        if (!response.ok) {
            const msg = (body && body.error) || ('HTTP ' + response.status);
            return { ok: false, error: msg };
        }

        // Server has archived the account and dropped the cookie. Mirror
        // the logout flow locally: swap back to the local provider with
        // skipSave=true (we don't want to push state back to the just-
        // archived account!), then clear _realUser.
        const archivedUser = _realUser;
        const target = _localProvider || (
            true
                ? new LocalStorageProvider()
                : null
        );
        if (target) {
            try {
                // skipSave=true is critical here. If we let the swap
                // try to save the current state to the remote provider,
                // it would fail (no session) AND would overwrite the
                // local sandbox we're about to restore.
                await _vfs.setStorageProvider(target, { skipSave: true });
            } catch (e) {
                console.warn('AuthService.archiveSelf: storage swap failed:', e.message || e);
                // Continue anyway — clear state below so the user is
                // at least logged out of the in-memory _realUser
            }
        }

        _realUser     = null;
        _realProvider = null;
        return { ok: true, archived_username: archivedUser };
    }

    // devChangePassword(currentPw, newPw) — DEV-mode password change.
    //
    // Updates the password for the current dev user in the in-memory mock
    // provider. Persists for the lifetime of the page (no localStorage
    // for the mock — it's deliberately ephemeral). Mirrors the real
    // changePassword flow but talks to the mock instead of the API.
    static async devChangePassword(currentPassword, newPassword) {
        if (!_devUser) {
            return { ok: false, error: 'not in dev sandbox (use DEVLOGIN first)' };
        }
        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
            return { ok: false, error: 'current and new password required' };
        }
        if (currentPassword === newPassword) {
            return { ok: false, error: 'new password must differ from current password' };
        }

        const mock = _devProvider;
        if (!mock || typeof mock.changePassword !== 'function') {
            return { ok: false, error: 'mock provider does not support password change' };
        }

        const result = await mock.changePassword(_devUser, currentPassword, newPassword);
        if (!result || !result.ok) {
            return { ok: false, error: (result && result.error) || 'change failed' };
        }

        return { ok: true, user: _devUser };
    }

    // devArchiveSelf(password, usernameConfirm) — DEV-mode account archive.
    //
    // Archives the current dev user in the mock provider. The mock keeps
    // the archived flag in memory so subsequent DEVLOGIN attempts against
    // that username fail. The current dev session is cleared, and the VFS
    // swaps back to the local provider — same shape as the real
    // archiveSelf flow.
    static async devArchiveSelf(password, usernameConfirm) {
        if (!_devUser) {
            return { ok: false, error: 'not in dev sandbox (use DEVLOGIN first)' };
        }
        if (typeof password !== 'string' || typeof usernameConfirm !== 'string') {
            return { ok: false, error: 'password and username confirmation required' };
        }
        if (usernameConfirm !== _devUser) {
            return { ok: false, error: 'username confirmation does not match' };
        }

        const mock = _devProvider;
        if (!mock || typeof mock.archiveUser !== 'function') {
            return { ok: false, error: 'mock provider does not support archive' };
        }

        const result = await mock.archiveUser(_devUser, password);
        if (!result || !result.ok) {
            return { ok: false, error: (result && result.error) || 'archive failed' };
        }

        // Mirror the real flow: swap back to local provider, clear dev state
        const archivedUser = _devUser;
        const target = _localProvider || (
            true
                ? new LocalStorageProvider()
                : null
        );
        if (target) {
            try {
                await _vfs.setStorageProvider(target, { skipSave: true });
            } catch (e) {
                console.warn('AuthService.devArchiveSelf: storage swap failed:', e.message || e);
            }
        }

        _devUser     = null;
        _devProvider = null;
        return { ok: true, archived_username: archivedUser };
    }

    // =======================================================================
    // Test-only helpers — not used by the shell.
    // =======================================================================

    // _reset — WIPE all auth state. Used only by tests.
    static _reset() {
        _vfs           = null;
        _devUser       = null;
        _realUser      = null;
        _devProvider   = null;
        _realProvider  = null;
        _localProvider = null;
    }

    // _setRealUser — set the _realUser module var directly. Used only by
    // tests to simulate being in REAL mode for crossed-transition checks,
    // since real login isn't implemented yet.
    static _setRealUser(user) {
        _realUser = user;
    }
}

// Expose as a global for the non-module script-tag load order.
if (typeof window !== 'undefined') {
    window.AuthService = AuthService;
}

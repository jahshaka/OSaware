// ui.js — page-level UI interactions (fullscreen + overscan toggle)
// Loaded as an external script to comply with strict Content Security Policy.

(function() {

    // Persisted UI state — fullscreen and overscan are mutually exclusive,
    // so a single key holds whichever is active ('fullscreen', 'overscan',
    // or '' for neither). Stored in localStorage so the choice survives
    // across reloads and tabs on the same origin.
    const UI_STATE_KEY = 'osaware_ui_mode';

    function saveUiState() {
        try {
            const body = document.body;
            let mode = '';
            if (body.classList.contains('fullscreen'))    mode = 'fullscreen';
            else if (body.classList.contains('overscan')) mode = 'overscan';
            localStorage.setItem(UI_STATE_KEY, mode);
        } catch (e) { /* localStorage may be disabled — ignore */ }
    }

    function loadUiState() {
        try {
            return localStorage.getItem(UI_STATE_KEY) || '';
        } catch (e) { return ''; }
    }

    function toggleFullscreen() {
        const body = document.body;
        const btn  = document.getElementById('fs-toggle');
        // Overscan takes priority — exit it first if active
        if (body.classList.contains('overscan')) {
            body.classList.remove('overscan');
        }
        const isFs = body.classList.toggle('fullscreen');
        if (btn) btn.textContent = isFs ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
        // Mobile button mirrors the desktop one
        const btnM = document.getElementById('fs-toggle-mobile');
        if (btnM) btnM.textContent = isFs ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
        // Overscan button label is canonical too in case we just cleared it
        const osBtn = document.getElementById('os-toggle');
        if (osBtn) osBtn.textContent = 'OVERSCAN';
        saveUiState();
        if (window._osaware_resize) window._osaware_resize(true);
    }

    function toggleOverscan() {
        const body = document.body;
        const btn  = document.getElementById('os-toggle');
        // Fullscreen takes priority — exit it first if active
        if (body.classList.contains('fullscreen')) {
            body.classList.remove('fullscreen');
            const fsBtn = document.getElementById('fs-toggle');
            if (fsBtn) fsBtn.textContent = 'FULLSCREEN';
            const fsBtnM = document.getElementById('fs-toggle-mobile');
            if (fsBtnM) fsBtnM.textContent = 'FULLSCREEN';
        }
        const isOs = body.classList.toggle('overscan');
        if (btn) btn.textContent = isOs ? 'EXIT OVERSCAN' : 'OVERSCAN';
        saveUiState();
        if (window._osaware_resize) window._osaware_resize(true);
    }

    // Expose for BASIC commands
    window._toggleFullscreen = toggleFullscreen;
    window._toggleOverscan   = toggleOverscan;

    // Attach click handlers once DOM is ready
    document.addEventListener('DOMContentLoaded', function() {
        // Restore previously-saved UI mode. We add the class directly
        // (not via toggle*) because the state is already correct in
        // storage — calling the toggle would flip it the wrong way.
        // The resize callback will fire when boot.js initialises the
        // emulator, so the canvas will get sized correctly for whatever
        // mode we restore here.
        const savedMode = loadUiState();
        if (savedMode === 'fullscreen') {
            document.body.classList.add('fullscreen');
        } else if (savedMode === 'overscan') {
            document.body.classList.add('overscan');
        }

        const fsBtn = document.getElementById('fs-toggle');
        if (fsBtn) {
            // Reflect restored state in the button label immediately
            if (savedMode === 'fullscreen') fsBtn.textContent = 'EXIT FULLSCREEN';
            fsBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            fsBtn.addEventListener('click', function(e) {
                e.preventDefault();
                toggleFullscreen();
            });
        }
        // Mobile fullscreen button (same behaviour)
        const fsBtnM = document.getElementById('fs-toggle-mobile');
        if (fsBtnM) {
            if (savedMode === 'fullscreen') fsBtnM.textContent = 'EXIT FULLSCREEN';
            fsBtnM.addEventListener('mousedown', function(e) { e.preventDefault(); });
            fsBtnM.addEventListener('click', function(e) {
                e.preventDefault();
                toggleFullscreen();
            });
        }
        const osBtn = document.getElementById('os-toggle');
        if (osBtn) {
            if (savedMode === 'overscan') osBtn.textContent = 'EXIT OVERSCAN';
            osBtn.addEventListener('mousedown', function(e) { e.preventDefault(); });
            osBtn.addEventListener('click', function(e) {
                e.preventDefault();
                toggleOverscan();
            });
        }
    });

})();

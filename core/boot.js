'use strict';

    // -----------------------------------------------------------------------
    // Calculate terminal dimensions from available viewport space.
    // On mobile the terminal fills the whole screen; on desktop it sits inside
    // a fixed-aspect container leaving room for the header and footer.
    // -----------------------------------------------------------------------
    function calcDimensions() {
      const isMobile     = window.innerWidth <= 600;
      const isFullscreen = document.body.classList.contains('fullscreen');
      const isOverscan   = document.body.classList.contains('overscan');

      let termW, termH, fixedTop, fixedLeft;

      if (isOverscan) {
        // True full bleed — entire viewport
        termW     = window.innerWidth;
        termH     = window.innerHeight;
        fixedTop  = 0;
        fixedLeft = 0;
      } else if (isFullscreen) {
        // Fullscreen with frame: 12px padding on all sides,
        // terminal sits below header with 8px gap above and below.
        const PAD = 12, GAP = 8;
        const header  = document.getElementById('header');
        const footer  = document.getElementById('footer');
        const headerH = header ? header.getBoundingClientRect().height : 28;
        const footerH = footer ? footer.getBoundingClientRect().height : 24;
        termW     = window.innerWidth  - PAD * 2;
        termH     = window.innerHeight - PAD * 2 - headerH - footerH - GAP * 2;
        fixedTop  = PAD + headerH + GAP;
        fixedLeft = PAD;
      } else if (isMobile) {
        // Fill the full width; subtract the actual header + footer heights so
        // the terminal sits precisely between them edge to edge.
        const header = document.getElementById('header');
        const footer = document.getElementById('footer');
        const headerH = header ? header.getBoundingClientRect().height : 28;
        const footerH = footer ? footer.getBoundingClientRect().height : 24;
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        termW = window.innerWidth;
        termH = Math.floor(vh - headerH - footerH);
      } else {
        // Desktop: leave ~60px for header + footer, cap at 784×554.
        termW = Math.min(784, window.innerWidth  - 40);
        termH = Math.min(554, window.innerHeight - 80);
      }

      // Always resolve to a concrete pixel size — never store 0 in the
      // emulator because reset_() treats 0 as "auto-calculate", which
      // produces tiny fonts when called after a resize back to desktop.
      // Lucida Console / Courier New character aspect ratio: ~0.60w × 1.20h.
      const DESKTOP_FONT = 16;
      const fontPx = isMobile
        ? Math.floor(Math.min(termH / 12, termW / 25))  // 1.5× larger for readability
        : DESKTOP_FONT;

      const charW = fontPx * 0.60;
      const charH = fontPx * 1.20;
      const cols  = Math.max(20, Math.floor(termW / charW));
      const rows  = Math.max(10, Math.floor(termH / charH));

      return { termW, termH, cols, rows, fontSize: fontPx, fixedTop, fixedLeft };
    }

    // -----------------------------------------------------------------------
    // Resize the terminal wrapper and canvas to match calculated dimensions.
    // -----------------------------------------------------------------------
    function applyDimensions(dims) {
      const wrapper = document.getElementById('terminal-wrapper');
      const canvas  = document.getElementById('kanvas');
      const div     = document.getElementById('oEmulator_div');

      wrapper.style.width  = dims.termW + 'px';
      wrapper.style.height = dims.termH + 'px';

      // In fullscreen/overscan, position the wrapper with fixed insets so it
      // sits precisely within the padded area regardless of body layout.
      if (dims.fixedTop !== undefined) {
        wrapper.style.position = 'fixed';
        wrapper.style.top      = dims.fixedTop  + 'px';
        wrapper.style.left     = dims.fixedLeft + 'px';
        wrapper.style.zIndex   = '9999';
      } else {
        wrapper.style.position = '';
        wrapper.style.top      = '';
        wrapper.style.left     = '';
        wrapper.style.zIndex   = '';
      }

      canvas.width        = dims.termW;
      canvas.height       = dims.termH;
      canvas.style.width  = dims.termW + 'px';
      canvas.style.height = dims.termH + 'px';

      div.style.width  = dims.termW + 'px';
      div.style.height = dims.termH + 'px';
    }

    // -----------------------------------------------------------------------
    // Mobile keyboard bridge.
    // The hidden <input> captures keypresses from the touch keyboard and
    // forwards them as synthetic keyboard events to the interpreter.
    // -----------------------------------------------------------------------
    function setupMobileKeyboard(emulator) {
      const mobileInput = document.getElementById('mobile-input');
      const wrapper     = document.getElementById('terminal-wrapper');

      // Tap on the terminal → focus the hidden input (raises soft keyboard).
      wrapper.addEventListener('touchend', (e) => {
        e.preventDefault();
        mobileInput.value = '';
        mobileInput.focus();
      });

      // Forward input events to the interpreter's key handler.
      mobileInput.addEventListener('input', (e) => {
        const val = mobileInput.value;
        if (!val) return;

        for (const ch of val) {
          const synth = new KeyboardEvent('keypress', {
            which:    ch.charCodeAt(0),
            keyCode:  ch.charCodeAt(0),
            bubbles:  true,
          });
          emulator.keyHandler(synth);
        }
        mobileInput.value = '';
      });

      // Forward Enter, Backspace, arrow keys.
      mobileInput.addEventListener('keydown', (e) => {
        if ([13, 8, 38, 40].includes(e.keyCode)) {
          emulator.ignoreKeyHandler(e);
          if (e.keyCode === 13) {
            const enter = new KeyboardEvent('keypress', {
              which: 13, keyCode: 13, bubbles: true,
            });
            emulator.keyHandler(enter);
          }
        }
      });
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------
    window.addEventListener('load', () => {
      const dims  = calcDimensions();
      applyDimensions(dims);

      const canvas = document.getElementById('kanvas');
      const ctx    = canvas.getContext('2d');
      // Fill black immediately so there's no grey flash before initialize() runs.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      //   Interpreter(id, width, height, type, initText, cols, rows, initCmd, fontSize, ctx)
      // Support ?run=PROGNAME and ?cmd=COMMAND URL params for windowed app launch
      const _urlParams  = new URLSearchParams(window.location.search);
      const _runParam   = _urlParams.get('run');
      const _cmdParam   = _urlParams.get('cmd');
      const _initCmd    = _runParam ? ('RUN ' + _runParam.toUpperCase())
                        : _cmdParam ? _cmdParam
                        : null;
      const _windowMode = _runParam !== null || _cmdParam !== null;

      const oEmulator = new Interpreter(
        'oEmulator',
        dims.termW,
        dims.termH,
        'dos',
        null,
        dims.cols,
        dims.rows,
        _initCmd,        // auto-run from URL param if provided
        dims.fontSize,
        ctx
      );

      // In windowed app mode: hide toolbar chrome, make window feel like an app
      if (_windowMode) {
        const toolbar = document.getElementById('toolbar');
        if (toolbar) toolbar.style.display = 'none';
        document.title = _runParam ? ('OSAWARE — ' + _runParam.toUpperCase()) : 'OSAWARE';
      }

      // Wire AuthService to the VFS so DEVLOGIN/LOGIN can swap storage.
      if (window.AuthService) {
        window.AuthService.init(oEmulator.fs);
      }

      // VFS init is async (loads user files/assets via the storage provider,
      // runs orphan cleanup on any pending writes from a previous tab close).
      // Defer start() until init() resolves so the BASIC interpreter doesn't
      // try to read user data before it's loaded. The page stays interactive
      // throughout — all event listeners below are registered synchronously
      // and don't depend on storage being ready.
      oEmulator.fs.init().then(() => {
        oEmulator.start();
      }).catch(err => {
        console.warn('VFS init failed, starting interpreter with empty user storage:', err);
        oEmulator.start();
      });
      setupMobileKeyboard(oEmulator);

      // -----------------------------------------------------------------------
      // Clipboard paste support.
      // Intercepts Ctrl+V / Cmd+V and the native 'paste' event, then feeds
      // the clipboard text into the emulator character by character — exactly
      // as if the user had typed each character.  Newlines become Enter events
      // so pasted multi-line BASIC code is entered line by line.
      // -----------------------------------------------------------------------
      function pasteText(text) {
        if (!text) return;
        for (const ch of text) {
          if (ch === '\n' || ch === '\r') {
            // Newline → synthesise an Enter keypress so each line is submitted.
            const enterPress = new KeyboardEvent('keypress', {
              which: 13, keyCode: 13, bubbles: true,
            });
            oEmulator.keyHandler(enterPress);
          } else {
            const code = ch.charCodeAt(0);
            if (code >= 32 && code <= 126) {
              const synth = new KeyboardEvent('keypress', {
                which: code, keyCode: code, bubbles: true,
              });
              oEmulator.keyHandler(synth);
            }
          }
        }
      }

      // Listen for the native paste event.
      // This fires reliably for Edit → Paste menu and right-click paste.
      // It MAY also fire for Ctrl+V / Cmd+V when the focus is on an input
      // element, but on Mac+Chrome the terminal's custom div is not a
      // focusable input target so Cmd+V often does not fire this event.
      // The keydown handler below picks up that case via the async
      // Clipboard API.
      let _pasteJustFiredFromAsync = false;
      document.addEventListener('paste', (e) => {
        // If the keydown handler already injected the clipboard via the
        // async API moments ago, ignore this event so we don't paste twice.
        if (_pasteJustFiredFromAsync) return;
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        pasteText(text);
      });

      // Also handle Ctrl+V / Cmd+V in keydown.
      //
      // Two reasons we need this in addition to the paste listener above:
      //   1. Prevent the browser default action (which on a focused input
      //      would paste into that input instead of the terminal).
      //   2. On Mac+Chrome, the native `paste` event does not fire when
      //      Cmd+V is pressed and no input element has focus. The terminal
      //      div is not focusable, so we never get a paste event for the
      //      keyboard shortcut — only for the menu. As a fallback, we use
      //      the async Clipboard API to read the clipboard ourselves.
      //      This requires a user gesture (we have one — the keydown is
      //      the gesture) and works in modern Chrome, Safari, and Firefox.
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.keyCode === 86 || e.key === 'v')) {
          e.preventDefault();
          // Try the async Clipboard API. If it resolves with text, we
          // inject it via pasteText and set a short-lived flag so the
          // native paste event listener (if it ALSO fires moments later)
          // skips its own injection. The flag clears after a tick.
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then((text) => {
              if (!text) return;
              _pasteJustFiredFromAsync = true;
              pasteText(text);
              setTimeout(() => { _pasteJustFiredFromAsync = false; }, 100);
            }).catch(() => {
              // Permission denied or no clipboard support — silently
              // give up. The user can still paste via Edit → Paste menu.
            });
          }
        }
      });


      // -----------------------------------------------------------------------
      // Scroll mode:  'running' = overflow:hidden  (JS controls scrolling)
      //               'idle'    = overflow-y:auto  (user can scroll freely)
      // -----------------------------------------------------------------------
      // Guard: suppresses onResize re-init when the resize is caused by our own
      // layout changes (setScrollMode, fullscreen toggle) not a real window resize.
      let _suppressResize = false;

      function setScrollMode(mode) {
        const wrapper = document.getElementById('terminal-wrapper');
        const div     = document.getElementById('oEmulator_div');
        _suppressResize = true;   // layout change coming — don't re-init
        if (mode === 'running') {
          // Running: fixed height, no scrolling needed.
          // Keep overflow:hidden on wrapper AND div — do NOT use overflow:scroll
          // as that creates a stacking context breaking GL canvas z-index.
          wrapper.style.overflowY = 'hidden';
          div.style.height        = oEmulator.height + 'px';
          div.style.overflow      = 'hidden';
          oEmulator._scrollable   = false;
        } else {
          // Idle: div fills wrapper exactly, scrolls internally via overflow:auto.
          // Wrapper keeps overflow:hidden (clean stacking context for GL).
          const wrapperH = wrapper.clientHeight || oEmulator.height;
          div.style.height        = wrapperH + 'px';
          div.style.overflow      = 'auto';
          wrapper.style.overflowX = 'hidden';
          wrapper.style.overflowY = 'hidden';
          oEmulator._scrollable  = true;
          // Snap to bottom so the prompt is visible.
          requestAnimationFrame(() => {
            div.scrollTop = div.scrollHeight;
          });
        }
        // _suppressResize is cleared inside onResize's setTimeout, not here,
        // so it stays set long enough to survive the 250ms debounce.
      }

      // Always force-scroll to bottom on Enter so the prompt/response is visible.
      // Uses _forceScrollToBottom which ignores the proximity check.
      document.addEventListener('keydown', (e) => {
        if (e.keyCode === 13 && oEmulator._scrollable) {
          oEmulator._forceScrollToBottom();
        }
      }, { passive: true });

      // Patch _onProgramStop and run() on the live instance to toggle scroll mode.
      const _origOnProgramStop = oEmulator._onProgramStop.bind(oEmulator);
      oEmulator._onProgramStop = function() {
        _origOnProgramStop();
        setScrollMode('idle');
      };

      const _origRun = oEmulator.run.bind(oEmulator);
      oEmulator.run = function() {
        // Set running=1 BEFORE setScrollMode so any resize triggered by the
        // layout change sees oEmulator.running=true and bails out immediately.
        oEmulator.running = 1;
        setScrollMode('running');
        _origRun();
      };

      // Also switch to idle after the startup text has rendered.
      setTimeout(() => setScrollMode('idle'), 500);

      // -----------------------------------------------------------------------
      // Handle window resize — recalculate dimensions and re-initialise.
      // Debounced to avoid thrashing during drag-resize.
      // -----------------------------------------------------------------------
      let resizeTimer;
      // Callbacks queued by callers that want to be notified once the
      // (debounced) resize has actually applied new dimensions. Used by
      // cmdFULLSCREEN / cmdOVERSCAN to pause BASIC until WIDTH/HEIGHT update.
      let resizeDoneCallbacks = [];
      function onResize(fromFullscreen, done) {
        if (typeof done === 'function') resizeDoneCallbacks.push(done);
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          // Clear the suppress flag now — if we were suppressed we still want
          // to apply dimensions, just not the full re-init below.
          const wasSuppressed = _suppressResize;
          _suppressResize = false;

          const d = calcDimensions();
          applyDimensions(d);

          oEmulator.width  = d.termW;
          oEmulator.height = d.termH;
          oEmulator.cols   = d.cols;
          oEmulator.rows   = d.rows;
          oEmulator.font_size = d.fontSize;

          // Always sync the canvas pixel dimensions to the new wrapper size.
          const cnv = document.getElementById('kanvas');
          if (cnv) {
            const wr = cnv.parentElement;
            const cw = wr.clientWidth, ch = wr.clientHeight;
            if (cw > 0 && ch > 0) {
              cnv.width = cw; cnv.height = ch;
              cnv.style.width = cw + 'px'; cnv.style.height = ch + 'px';
            }
          }

          // Update canvas context reference after resize.
          oEmulator.context = canvas.getContext('2d');

          // Sync the Three.js 2D and sprite canvases to the new size
          if (oEmulator._gfxSyncSize) oEmulator._gfxSyncSize();
          if (oEmulator._sprSyncSize) oEmulator._sprSyncSize();

          // Fire any queued done callbacks now that dimensions have settled.
          // Drain even when we bail out of the re-init below.
          const _doneCbs = resizeDoneCallbacks;
          resizeDoneCallbacks = [];
          for (const cb of _doneCbs) { try { cb(); } catch (e) {} }

          // Never re-init if:
          // 1. A program is running
          // 2. Resize was caused by our own layout change (setScrollMode)
          // 3. Resize was triggered by the fullscreen toggle itself
          if (oEmulator.running) return;
          if (wasSuppressed)     return;
          if (fromFullscreen)    return;

          oEmulator.reset_();
          oEmulator.cls();
          oEmulator.init = 0;
          oEmulator.initialize();
        }, fromFullscreen ? 60 : 250);
      }

      window.addEventListener('resize', onResize);

      // Expose resize function so the fullscreen toggle can call it
      window._osaware_resize = onResize;

      // On mobile, the visual viewport shrinks when the keyboard appears.
      // Use visualViewport API to handle this gracefully if available.
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          if (window.innerWidth <= 600) {
            const h = window.visualViewport.height;
            document.getElementById('terminal-wrapper').style.height = h + 'px';
            document.getElementById('oEmulator_div').style.height    = h + 'px';
            document.getElementById('kanvas').style.height           = h + 'px';
          }
        });
      }
    });

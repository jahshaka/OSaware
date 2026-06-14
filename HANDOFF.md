# OSAWARE — Session Handoff

**Last updated:** 2026-06-14 (post-ESM-conversion + Path B) · **Last commit:** see `git log -1` (most recent push is the three.js ESM conversion + namespace constants). Earlier handoff section preserved below; **Session 2 (three.js upgrade + ESM)** is new — read it first.

---

## 🆕 Session 2 (2026-06-13/14) — three.js upgrade + full ESM conversion

This is the largest single change since the original handoff. Read carefully if you're picking up here.

### Stages completed (each one commit)

| Stage | Commit | Goal | Result |
|---|---|---|---|
| 0 | (no commit — pre-flight) | `test/three_compat.html` harness with 71 assertions covering every `THREE.*` symbol + addon the engine uses | r128 baseline locked at 71/71 |
| 1 | `b5a0f9e` | r128 → **r137** drop-in (same UMD pattern) | 71/71 + engine smoke test green |
| 2 | `f69c1c1` | r137 → **r147** drop-in (last revision with `examples/js/` UMD addons) | 74/74 (3 new tests added) + engine smoke green |
| 3 | *(this commit)* | r147 UMD → **r151 ESM** + full ESM conversion of every engine file + Path B namespace constants | Apps boot, MAZE3D pearl hide + wall clip fixed via `GL.PERSPECTIVE near` arg; some key-press regressions still open |

### r151 ESM is vendored locally

```
core/vendor/three/
  build/three.module.js
  addons/
    loaders/GLTFLoader.js
    objects/Sky.js              ← OSaware-custom (cloudCoverage + r128-era gamma); converted IIFE→ESM
    postprocessing/{EffectComposer,RenderPass,ShaderPass,UnrealBloomPass,MaskPass,Pass}.js
    shaders/{CopyShader,LuminosityHighPassShader,FXAAShader}.js
    lights/RectAreaLightUniformsLib.js
    utils/BufferGeometryUtils.js
```

The old `core/three.min.js` and `core/loaders/*.js` are **deleted**. Do not re-add them. `core/loaders/` directory is gone.

**Sky.js gotcha (carried forward from the prior handoff):** Don't refresh from upstream Sky.js when the engine bumps. Our copy at `core/vendor/three/addons/objects/Sky.js` has the `cloudCoverage` uniform + a self-contained ACES tone-map + `pow(1/2.2)` gamma that the unmodified upstream version lacks. The GL.SKY command writes to `cloudCoverage` directly, and removing it crashes SKYFOX at boot.

### ESM conversion mechanics (all 22 engine files)

- `index.html` was 22 `<script src>` tags → now **1 importmap + 1 `<script type="module" src="core/boot.js">`**.
- Every engine file got `'use strict';` followed by explicit `import { … } from '…';` and `export class …`.
- The classic-script-globals pattern (`window.AuthService`, `typeof MockRemoteStorageProvider !== 'undefined'`, etc.) was rewritten everywhere — files now import what they need directly.
- The `compiler.js` prototype-mixin pattern (`Interpreter.prototype[name] = Compiler.prototype[name]`) survived intact — `compiler.js` now imports `Interpreter` from `./kernel.js`; the mixin runs at module-load time before `boot.js` instantiates anything.
- `boot.js` is the single entry. It imports `Interpreter`, `AuthService`, and side-effect-imports `./compiler.js` (to fire the mixin) + `./ui.js` (to wire page-level event listeners).

### Path B — namespace constants (the future-proofing layer)

Per session-end refactor: every consumer file does
```js
import * as C from '../constants.js';
// … then C.CMD_OK, C.ASS_NUMBER, etc.
```
instead of named imports. **879 usage sites** rewritten. Adding a new constant now requires only:

1. Add `const NEW_CONST = …;` to `core/constants.js`
2. Add `NEW_CONST,` to the export block at bottom
3. Use as `C.NEW_CONST` in any consumer — no import lists to update

Confirmed no constant-name collisions with embedded BASIC strings in `vfs.js` before the rewrite, so the global word-boundary replace was safe.

### Engine changes added this session

- **`GL.PERSPECTIVE fov [, far [, near]]`** — third arg is now optional near plane (default 1.0). MAZE3D opted into `near=0.1` to restore close-wall rendering. See `cmdGL_PERSPECTIVE` in `gl3d.js`.

### Known bugs still open

| Bug | Severity | Notes |
|---|---|---|
| **C-key toggle in TRON only fires while bike is moving** | High | Suspect: block `IF … THEN … ELSE … END IF` at lines 1200–1205 may not be popping `_if_stack` properly. Need to add debug logging in `cmdENDIF` to confirm. SKYFOX C-key also reported broken but might be by-design (`IF (K=67 OR K=99) AND MODE=2 …` only works in mode 2). |
| **TRON close-camera position changed** | Medium | Likely same root cause as the MAZE3D wall fix — the near-plane bump from 0.1 → 1.0 (commit `b139824`) affects how close objects appear. Try `GL.PERSPECTIVE … , 0.1` in TRON's init. |
| **Color management defaults to sRGB in r151** | Medium | I never explicitly set `renderer.outputColorSpace = NoColorSpace`. r151 default flipped `outputColorSpace = SRGBColorSpace` — colors may look subtly different. Consider adding `r.outputColorSpace = THREE.NoColorSpace` (or `LinearSRGBColorSpace`) in `_glSetupThree` to restore r128-era behavior. |
| **Cosmetic / not-yet-investigated** | Low | User reported "lots of little issues" after the ESM conversion — please test thoroughly and report regressions. |

### Files in working tree NOT in commits yet

(at time of handoff, all under one big atomic commit being pushed)

### Stage-2 test harness — still useful

`test/three_compat.html` exercises the vendored r151 bundle. **Run after any future three.js update** to make sure nothing regresses. It uses a writable-clone shim (`const THREE = { ...THREE_NS, …addons }`) so existing test code can stay untouched even though `import * as` returns a frozen namespace in r151.

The harness should pass 74/74 in its current form. If you reduce vendor scope (e.g., drop bloom), you may need to remove the corresponding tests.

### How the engine is wired now (cheat sheet)

1. Browser loads `index.html` → sees importmap + `<script type="module" src="core/boot.js">`.
2. `boot.js` imports trigger dependency resolution — every engine file loads exactly once, depth-first.
3. `kernel.js` defines `class Interpreter { … }` and exports it.
4. `compiler.js` imports `Interpreter`, defines `class Compiler { … }`, runs the prototype mixin (every `Compiler.prototype.foo` → `Interpreter.prototype.foo`).
5. `boot.js` body fires after DOM ready, instantiates `new Interpreter(…)`, calls `AuthService.init(…)`, starts the interpreter.
6. Engine runs identically to before — same BASIC kernel, same drivers, same shell.

### Migration roadmap status

| Step | Status |
|---|---|
| Vendor r151 ESM locally | ✅ Done |
| Convert all engine files to ES modules | ✅ Done |
| Replace per-file constant imports with namespace import (`import * as C`) | ✅ Done |
| Set `renderer.outputColorSpace` for color-management parity | ❌ Open |
| Investigate TRON/SKYFOX C-key bug | ❌ Open |
| Audit broader keypress regressions | ❌ Open |
| Retire `test/three_compat.html` (post-migration cleanup) | Defer — still useful |
| Update `CLAUDE.md` (it still says "r128 do not modify") | ❌ Open |

---

## 📜 Original handoff (Session 1, 2026-06-08)

**Generated:** 2026-06-08 · **Last commit:** `1681bb8` (MADMAX car gameplay) · **Latest cachebuster:** see `VERSION`

This document catches a new Claude session up on how Karsten and I work, what's been built recently, the shape of the platform, and the open roadmap. It's expected to be the first thing read at session start.

---

## 1. How we work

### Roles (from `CLAUDE.md`)
- **Karsten (`jahshaka`)** — Product Owner. Decides what gets built, accepts/rejects.
- **Claude (this session)** — Lead Dev / Project Manager in claude.ai; also the developer in claude-code terminal sessions. Same person across roles.
- One repo, one main branch, no PRs needed for solo dev.

### Defaults (from memory)
- **Edit freely in the repo.** Karsten gave a blanket OK for non-critical changes. `git commit`, `git push`, destructive operations, or anything visible outside the repo (publishing, etc.) — those still need an explicit ask.
- **Bump cachebuster every code change.** `./bump.sh` updates `VERSION`, all 22 `?v=` refs in `index.html`, and the fallback in `core/drivers/terminal.js`. Karsten wants this run after *any* browser-served file change. Supersedes `CLAUDE.md`'s "ask first" line.
- **No `Co-Authored-By` trailer in commits.** Plain commit messages only.
- **Free-text Q&A during spec/design.** Karsten explicitly rejected `AskUserQuestion` multi-select forms during iteration. Ask 1–2 short questions in plain text instead. AskUserQuestion is fine once we're past spec and need a closed yes/no.

### BASIC gotchas that have bitten us (one memory each)
- `[[basic_if_colon_tails]]` — `IF c THEN a:b:c` gates ALL of a, b, c on c (CLAUDE.md says otherwise; it's wrong).
- `[[basic_nested_if_limit]]` — single-line IF parser tops out at 2 nested IFs.
- `[[basic_duplicate_line_silent_overwrite]]` — two tuples with the same line number → second silently replaces the first. No warning. The Python edit scripts in this repo will silently lose code if you're not careful.
- `[[basic_global_name_collision_in_gosub]]` — GOSUB has no scope. Loop counters and temps clobber each other. Prefix function-local temps.
- `[[basic_gl_2d_array_comma_arg_bug]]` — `GL.X ARR(I,J), ...` is silently broken (the inner comma is parsed as arg separator). Always copy to a 1-D scalar temp first.
- `[[basic_nested_array_parser_fix]]` — compiler fix landed 2026-06-01: `ARR(IDX(I), J)` now parses (was using first `)`). The GL.* arg parser still needs the scalar-capture workaround above.
- `[[basic_single_line_for_resets_init]]` — `INIT : FOR : body : NEXT` on one line re-runs INIT every iteration. Always split.
- `[[basic_angle_chase_wrap]]` — angle smoothing must wrap the diff to [-π, π] FIRST or chase snaps wrong at ±π.
- `[[basic_asymmetric_clamp_trap]]` — clamp BOTH signs of a signed value.
- `[[opt_e_line_cache_bypasses_parseassign]]` — `_buildLineCache` pre-compiles simple `var = expr` lines, skipping `parseAssign`. Any new parseAssign branch must be gated out of `canCache`.
- `[[kernel_if_then_gosub_for_loop_fix]]` — kernel-level fix landed 2026-06-02 for `IF cond THEN GOSUB` inside `FOR`.

### Engine gotchas
- `[[logdepthbuf_custom_shadermaterial_rule]]` — renderer runs `logarithmicDepthBuffer: true`. Every custom `THREE.ShaderMaterial` must include the four `<logdepthbuf_*>` chunks (`pars_vertex` + `vertex` + `pars_fragment` + `fragment`), otherwise it writes linear depth while everything else writes log depth and z-testing breaks in distance-dependent ways. Terrain, particle, and cloud shaders are all patched; new custom shaders are not.
- `[[glcmd_parsefloat_breaks_variables]]` — GL.* command handlers must call `this.evalCalc(token, ASS_NUMBER)`, not `parseFloat`. Raw `parseFloat` on a BASIC variable name yields `NaN` and silently no-ops.
- `[[glparsefloats_zero_fill_quirk]]` — `_glParseFloats` returns `[0, 0, ...]` for empty input, not `[]`. Never use it for "did caller pass arg?" presence checks.
- `[[gl_loop_audit_2026_05_18]]` — 3D core-loop audit; recommendations all done (rAF loop, GL.HEADLIGHT, hoisted allocs, split FPS, DT-scaled MAZE3D).

### Workflow
- **TaskCreate / TaskUpdate** for non-trivial multi-step work.
- **Cachebuster bump** after every code change (see above).
- **Don't commit/push without an ask.** The session is mid-work most of the time; ask before checkpointing.
- **Read CLAUDE.md** for architecture invariants (Embedded programs win over `files/`, etc.). Some of its rules have been superseded by memory entries — when conflict, memory wins for *that specific rule*.
- **Style:** 3-space indent per nesting level, `var` never (always `const`/`let`), no transpilation, raw ES6+. BASIC line numbers in 10s within a SUB; 1000s for SUB boundaries.

---

## 2. Platform shape (orientation)

```
core/
├── kernel.js (4500+ loc)      — Interpreter runtime, command table, syscall bus
├── compiler.js (1500+ loc)    — Expression eval, variable lookup, condition parser, expr-tree cache, OPT-H/OPT-E
├── shell.js (2000+ loc)       — Command dispatch, DIM, PRINT, I/O, HELP, DIR
├── vfs.js (5800+ loc, ~17k BASIC lines) — Virtual FS; ALL embedded programs live here, DIR categories, storage providers
├── constants.js               — MAX_LINES = 100000
├── boot.js, ui.js, libraries.js
├── three.min.js               — Three.js r128 (vendored — see roadmap)
├── style.css
├── drivers/
│   ├── gfx.js                 — 2D sprite engine (Three.js orthographic camera)
│   ├── gl3d.js (~4300 loc)    — 3D engine: GL.*, terrain, splines, particles, materials
│   ├── terminal.js            — Terminal emulator + cachebuster fallback
│   ├── audio.js, net.js, window.js
├── storage/
│   ├── local_provider.js      — Default (browser localStorage)
│   ├── remote_provider.js     — Server-backed (activated on login)
│   ├── mock_remote_provider.js
├── auth/auth_service.js       — Login flow
├── loaders/                   — Three.js addons (GLTFLoader, EffectComposer, Sky, FXAA, Bloom, etc.)
```

**Critical invariant** (from CLAUDE.md): Embedded programs in `core/vfs.js` ALWAYS WIN over the `files/*.bas` mirrors. Edit `vfs.js` for real changes; `files/` is documentation only.

**Cachebuster = build number.** `bump.sh` updates `VERSION`, the 22 `?v=` refs in `index.html`, and a fallback in `terminal.js`. The startup banner reads it from the kernel.js URL: `Geekprocessor [build NNNNNNNNNN]`.

---

## 3. Recent major work (chronological — most recent first)

### 2026-06-07 · MADMAX: plane → car-on-halfpipe (`1681bb8`)
Full rewrite of MADMAX's gameplay from SKYFOX-style flight into a car-on-track racer on the existing halfpipe track. **See `[[madmax_car_gameplay_2026_06_07]]` for details and gotchas.**

Highlights:
- Cars parameterised by `(s, u)` on the track — `s` = arclength, `u` ∈ [−0.9, +0.9] across the cross-section.
- New BASIC SUBs only (Karsten explicitly rejected adding engine-side track queries):
  - `TrkSample` — builds a dense sample buffer (`TPX/TPY/TPZ/TPDX/TPDZ/TPDY/TPS`) via Catmull-Rom from `RPX/RPY/RPZ` control points; same uniform parameterisation the engine extruder uses.
  - `TrkAt` — s → centerline pos + tangent, with `TLAST(P)` cache hint + WHILE/WEND fallback scan.
  - `TrkNormal` — (s, u, R) → halfpipe surface pos + up vector.
- `DoPhysicsStep` rewritten to drive `TS`/`TU`, gravity restoring force, `WALLHIT` counter when `TU` saturates.
- `DoHumanInput` recast as car controls (mouse horizontal + ←/→ → `TUACC`, shift → throttle, space → fire, vertical drag and ↑/↓ ignored).
- `DoAIControl` is now centerline-hold steering + gradual throttle (same accel rules as the human).
- Three obstacle pools, all spawned along the track via `TrkNormal`:
  - 18 **purple** shoot-targets (`OBSR`) — bullet hits: +1 shooter + silent removal. Drive-into: −1 driver + small red blast.
  - 24 **yellow** drive-pickups (`OBSY`) — +1 driver, vanish silently.
  - 12 **green** boost-cubes (`OBSG`) — `EBOOST *= 1.5` for 120 ticks.
- Bullet-vs-other-car: shooter +1, victim −1 + `SLOWHIT` for 60 ticks (time-scoped via `LASTSLOWED` so consecutive hits don't extend) + 20-tick visual shake on victim's roll.
- Camera ground-probe clamp dropped; bullet-vs-terrain hit dropped — bullets only expire on lifetime or red/car hit.
- HUD shows per-player score, current speed, boost multiplier (`x1.0`/`x1.5`), and current lap.
- Flight Recorder rewritten for car telemetry (toggle with `R`, dumps on `GameOver`). Logs `X/Y/Z`, `RX/RY/RZ`, `TU`, `SPD`, `EB`, `LAP`, `SCO`, `WH`, `KSR`, `HRD`, `GRY`, `GRG`, `BST`, `SHK`.

**Critical math fixes burned in (do NOT regress):**
- `CUBEYAW = atan2(-TDZ, -TDX)` (SKYFOX nose-forward convention). NOT `atan2(TDZ, TDX)`. I had this wrong twice.
- `TrkAt` lerps the unit tangent between adjacent samples weighted by `TF`. Without this the heading snaps at every segment boundary and looks like a "jerk" every ~10 units of arclength.
- `PITCH` clamped to ±20° (`CAR_PITCHMAX`) to stop the rigid ship model from dunking through the track on steep slopes.
- All hit checks are 2D XZ (matches SKYFOX's tank check) — otherwise `CAR_LIFT = 10` vertical gap eats the whole hit-radius budget.

### 2026-06-06 · `GL.TERRAIN_CARVE` + log-depth shader fix (`ecb46b0`)
**See `[[gl_terrain_carve_command]]` and `[[logdepthbuf_custom_shadermaterial_rule]]`.**

- New engine command `GL.TERRAIN_CARVE lineMeshId, halfWidth, yOffset [, falloff]` — lowers terrain Y near a spline's xz footprint so race tracks don't intersect noise hills. Cosmetic only — `GL.PROBE` and the `_terrainH` query still read procedural noise (would need a height-grid sync to make ship collision carve-aware).
- Fixed the log-depth bug that was making P=0's plasma exhaust invisible in front of terrain: fire/plasma/smoke/cloud shaders were writing linear depth while the patched terrain wrote log depth. Added the four `<logdepthbuf_*>` chunks to all custom `ShaderMaterial` instances. This is now a permanent rule for any future custom shaders.

### 2026-05–06 · TRACKBUILDER spline track viewer + MADMAX track infrastructure
A series of commits (`b139824` through `5964210`) built up the spline-track creator that MADMAX now uses:
- Multiple shape modes (bracket / horseshoe / halfpipe) + path topologies (loop / fig8 / fig8-grounded).
- `GL.SMOOTH` three-state (flat / smooth / inner-with-auto-corners).
- `GL.PATHBEZPT` (explicit Bezier handles) and `GL.PATHLINPT` (linear corners) for per-control-point path shaping.
- `GL.REMATERIAL`, `GL.PIXELRATIO`, `GL.PROFILE` (flight recorder).
- Catmull-Rom uniform / centripetal selection via path style argument.
- Auto-smooth via 30° angle threshold (duplicates ring vertices at sharp corners).

### Earlier 2026-06 · OOP for OSAWARE BASIC (`344f6a5`, `aa86536`)
Visual-Basic-style OOP added to the BASIC kernel:
- `CLASS ... END CLASS` declarations with `PRIVATE` fields and `PUBLIC` methods.
- `ME` (self-reference) inside methods.
- `NEW ClassName(args)` to instantiate.
- `obj.method(args)` member calls.
- Method dispatch on array-element receivers (the fix in `aa86536`).
- Demos: `OOPTANK`, `OOPSTARS`.

### Earlier 2026 · SKYFOX progression
SKYFOX went through V1/V2/V3 then was renamed back to SKYFOX. Major milestones (most relevant for current work):
- Per-player state-array architecture (P=0 human, P=1 AI) — this is the foundation MADMAX inherited.
- Terrain-aware AI with `GL.PROBE` + `GL.SCANFWD` lookahead.
- Particle plasma exhaust (yomotsu sprite-atlas fire shader + tinted plasma/sparks/smoke variants).
- Tank pool (`GL.LOAD` + `GL.INSTANCE`) with per-tank hit count + bullet collision.
- Per-frame minimap with PSET pixels.
- Flight Recorder pattern (toggle key, ring buffer, dump on GameOver).
- `GL.HEADLIGHT`, hoisted allocations, split FPS, DT-scaled main loops.

---

## 4. The 3D engine surface (gl3d.js commands worth knowing)

Roughly in scope-order. All registered in `core/kernel.js` in three places: `bus.on('gl.xxx', ...)`, `cmdGL_XXX(p) { return this.kernel.post(...); }`, and `['GL.XXX', 0, (p) => this.cmdGL_XXX(p), 1]` in the command table.

**Setup / world**
- `GL.INIT`, `GL.PERSPECTIVE fov, far`, `GL.AMBIENT`, `GL.LIGHT dx, dy, dz, intensity`
- `GL.FOG r, g, b, near, far` / `GL.FOGOFF`
- `GL.SKY flag [, elevation, azimuth, turbidity, cloudCoverage]` — Preetham sky + sun via vendored `Sky.js`
- `GL.CLOUDS flag [, coverage, altitude, thickness]` — volumetric clouds (custom ShaderMaterial)
- `GL.HEADLIGHT flag` — light follows camera

**Terrain**
- `GL.TERRAIN flag, size, height, hills, segs, cx, cz [, grid]` — value-noise FBM heightmap, custom ShaderMaterial (height-gradient + screen-space wire)
- `GL.PROBE x, z` → `GL.PROBEY` — terrain height at world (x, z). Reads procedural noise; **not** carve-aware.
- `GL.SCANFWD x, z, yaw, fromDist, toDist` → `GL.SCANY/D/S` — terrain sampling along a ray
- `GL.TERRAIN_CARVE lineMeshId, halfWidth, yOffset [, falloff]` — lower terrain Y near a spline's footprint (cosmetic only — see memory)

**Geometry primitives**
- `GL.BOX w, h, d`, `GL.SPHERE r, segs, rings`, `GL.CYLINDER r, h, segs`, `GL.PLANE w, d`
- `GL.SHAPEBEGIN` + `GL.SHAPEPT x, y` (cross-section)
- `GL.PATHBEGIN` + `GL.PATHPT x, z, y` / `GL.PATHBEZPT x, z, y, hix, hiz, hiy, hox, hoz, hoy` / `GL.PATHLINPT x, z, y`
- `GL.EXTRUDE shapeStyle, pathStyle [, segs, hollowInset]` — extrude SHAPE along PATH; produces the track mesh
- `GL.SPLINE pathStyle, samplesPer` — render the path as a 3D LINE primitive
- `GL.SMOOTH mode` — 0=flat, 1=smooth, 2=auto-corners (duplicates ring verts at >30° corners)

**Loading + materials**
- `GL.LOAD url$ [, rotX, rotY, rotZ]` — async GLTF/GLB load; pauses interpreter via `host._glLoadPending` until ready, then `GL.MESHID` is set
- `GL.COLOUR r, g, b`, `GL.SHINE s`, `GL.EMISSIVE r, g, b`, `GL.EMISSIVEINTENSITY id, mult`, `GL.ALPHA a`
- `GL.SOLID`, `GL.WIRE`, `GL.UNLIT`
- `GL.PBR id, metalness, roughness`
- `GL.REMATERIAL id` — rebuild material from current GL.* state (used after texture changes)

**Transform + scene graph**
- `GL.TRANSLATE id, x, y, z`, `GL.ROTATE id, rx, ry, rz` (degrees), `GL.SCALE id, sx, sy, sz`
- `GL.PARENT child, parent` (parent=0 detaches to scene root)
- `GL.SHOW id`, `GL.HIDE id`
- `GL.INSTANCE srcId, x, y, z, dx, dy, dz, roll, pitch` — cheap instanced copy

**Particles** (parented + transformed like normal meshes)
- `GL.PARTICLES preset$, count [, yR, yG, yB, oR, oG, oB, trail, spread]` — `'fire'/'plasma'/'sparks'/'smoke'`
- `GL.PARTICLES_PARAM id, name$, value` — tune `lifetime`, `trailMul`, `spreadMul`, `pointSize`, `opacity`, `intensity`, etc.
- `GL.PARTICLES_TICK [dt]` — advance the global time uniform
- `GL.PARTICLES_EMIT id, flag` — start/stop emission

**Rendering**
- `GL.CAMERA x, y, z`, `GL.LOOKAT x, y, z`, `GL.CAMERAROLL deg`
- `GL.RFPS flag`, `GL.AA flag`, `GL.PIXELRATIO ratio`, `GL.BLOOM strength`
- `GL.CLS r, g, b`, `GL.DRAWALL`

**Misc**
- `GL.OBSTACLE x, y, z, r` + `GL.OBSTACLEHIT x, z, r` → `GL.HITID/HITDIST` — sphere-vs-sphere XZ collision (the SKYFOX tank API). **Not** a general mesh-vs-mesh check.
- `GL.PROFILE flag` — engine flight recorder (separate from MADMAX's FR)
- `GL.WIREALL flag`, `GL.LIGHTSOFF`

---

## 5. Roadmap: upgrade Three.js from r128 → latest

**Current state:** `core/three.min.js` is r128 (released Dec 2020). Pinned in `CLAUDE.md`:
> three.min.js — Three.js r128 (vendored, do not modify)
> GLTFLoader.js — Three.js r128 GLTFLoader, non-module build (vendored, do not modify) — used by GL.LOAD

Vendored addons in `core/loaders/`: `GLTFLoader`, `EffectComposer`, `RenderPass`, `ShaderPass`, `CopyShader`, `FXAAShader`, `LuminosityHighPassShader`, `UnrealBloomPass`, `Sky`, `RectAreaLightUniformsLib`. All r128-era non-module builds.

**Why upgrade:** Five years of fixes, perf wins, modern WebGL2 features, better mobile support. Newer logarithmic-depth implementation is more numerically stable. Sky/ClearCoat/PBR improvements. Better env-map handling for the GLB models we already load.

**Why it's a real project:**
1. **Non-module builds are deprecated.** From r147 on, three.js stopped publishing the UMD/global `THREE.X` bundle. Modern three is ES modules only. OSaware loads `three.min.js` via a plain `<script>` tag — same for every addon. The upgrade must either:
   - **(A)** Keep using community-built UMD bundles (someone usually publishes them on jsdelivr/cdnjs) and hope they stay current; or
   - **(B)** Switch `index.html` to `<script type="module">` + an importmap to resolve `three` and `three/addons/*` consistently. This is the "right" answer but touches every `<script>` ref in `index.html` and every `THREE.X` global ref in `core/drivers/gl3d.js`.
2. **Custom shader chunks have changed.** The `<logdepthbuf_*>` chunks (and probably `<common>`, `<fog_*>`, etc.) have been reshuffled across versions. The terrain + particle + cloud shaders will need re-validation. See `[[logdepthbuf_custom_shadermaterial_rule]]`.
3. **GLTFLoader API drift.** Constructor, `.load(url, onLoad, onProgress, onError)` signature has been stable but `gltf.scene.traverse` patterns and animation mixer setup have minor changes.
4. **Sky / Bloom addons:** the Sky uniform names (`sunPosition`, `turbidity`, `mieDirectionalG`, etc.) are stable through r150; bloom passes also stable. After r150 there are some renames in the postprocessing shaders.
5. **Deprecations we use:** `Geometry` → `BufferGeometry` already done in r128; that's why nothing breaks immediately. `THREE.Color.setHex` etc. all stable. `OrbitControls` we don't ship. `Math.sign` polyfills no longer needed.

**Suggested phased migration (low-risk path):**

1. **Audit current usage.** Grep `core/drivers/gl3d.js` and `core/drivers/gfx.js` for every `THREE.X` reference. Categorize into:
   - Core geometry/material classes (`BoxGeometry`, `Mesh`, `MeshPhongMaterial`, `ShaderMaterial`, `Color`, `Vector3`, etc.) — all extremely stable.
   - Renderer / camera (`WebGLRenderer`, `PerspectiveCamera`, `OrthographicCamera`).
   - Loader (`GLTFLoader`).
   - Postprocessing (`EffectComposer`, `RenderPass`, `ShaderPass`, `UnrealBloomPass`, `FXAAShader`).
   - Sky addon.
   - Shader chunks (`<logdepthbuf_*>`, `<common>`, etc.).
2. **Pick target version.** Recommend r163 (LTS-feel, well-tested, still has UMD bundles on community CDNs) as a first step. Don't jump straight to r170+ which is module-only.
3. **Drop r163 `three.min.js` + addons in a branch.** Adjust `<script>` refs in `index.html` if filenames changed. Don't touch BASIC programs yet.
4. **Run the smoke programs** in order: VIEWER, MAZE3D, SKYFOX (demo mode), MADMAX (autopilot or single-player), TRACKBUILDER. Most break-points will be in `gl3d.js` shaders.
5. **Patch shader chunks** as compile errors surface. The log-depth chunk names are stable; `<common>` may have moved. `extensions: { derivatives: true }` may no longer be needed (WebGL2 default).
6. **Validate particles + clouds.** These have the most custom shader code. Karsten cares about them most.
7. **Validate GLTF loads.** `jahship.glb`, `tank.glb`. Watch for `_isLoaded`, animations, the pivot-centering logic in `cmdGL_LOAD`.
8. **Drop the camera ground-probe clamp re-check.** SKYFOX's third-person camera was carefully tuned around r128's near-plane behavior; verify it still looks right.

**Out of scope for the first upgrade:**
- WebGL2-only features (instanced rendering improvements, transform feedback).
- Importmap conversion (defer to a follow-up).
- WebGPU experiments (r155+ has experimental WebGPU renderer — too soon).

**Risk hot-spots if anything breaks first:**
1. Particle shaders (most custom GLSL).
2. Terrain shader (only one using `logdepthbuf` directly written by us).
3. `GL.SKY` (relies on internal Sky uniform structure).
4. `GL.PROFILE` flight recorder (timing/perf telemetry; format may change).

**Suggested first conversation when this task picks up:** ask Karsten which target version (r155 / r163 / r170-with-modules) and whether to do it in-place or via a feature branch.

---

## 6. State of the code right now

- `main` is at commit `1681bb8` — MADMAX car gameplay.
- Working tree clean except an untracked screenshot (`Screenshot 2026-06-06 at 01.32.35.png`).
- Cachebuster in `VERSION` was last bumped in the same commit.
- **Open follow-ups Karsten mentioned** but didn't push to commit yet:
  - Green boost-cubes are spawned but he reported not seeing them; might be z-fighting against the floor — easy fix is `OBSWY += 2` in `DoSpawnGreens`.
  - The halfpipe inside walls were raised via `WALL_RISE = 10` but Karsten said visually the walls "look the same". May need more, or may need to also extend the inner curve points (RAY1/2/3 family) not just `RCOPING_SY`.
  - Red `OBSR` spheres at high `|u|` still sometimes clip the wall — could move to a `(s, u)` collision space instead of XZ (would need to store `TQS/TQU` per obstacle in extra OBSR fields).
  - Ship-vs-track "ship goes under the floor" on steep slopes was mitigated with `CAR_LIFT = 10` + `CAR_PITCHMAX = 0.35`. If it returns, the real fix is true mesh collision — needs a new engine command.

---

## 7. Memory index (cheat sheet)

For full memory, see `/Users/jahshaka/.claude/projects/-Users-jahshaka-Desktop-Development-osaware-OSAWAREREPO-OSaware/memory/MEMORY.md`. The entries most likely to be relevant this session:

| File | Topic |
|---|---|
| `madmax_car_gameplay_2026_06_07.md` | This session's MADMAX rewrite, math gotchas |
| `gl_terrain_carve_command.md` | `GL.TERRAIN_CARVE` API + carve-vs-probe gotcha |
| `logdepthbuf_custom_shadermaterial_rule.md` | All custom ShaderMaterials need the 4 chunks |
| `feedback_edit_freely.md` | Default permission level |
| `feedback_bump_cachebuster_every_change.md` | `./bump.sh` after every change |
| `feedback_no_coauthor.md` | No `Co-Authored-By` |
| `feedback_spec_iteration_freetext.md` | Plain-text Q&A during spec |
| `basic_*` (~10 files) | BASIC parser/runtime gotchas |
| `gl_loop_audit_2026_05_18.md` | 3D core-loop audit findings |
| `skyfox_game.md` / `skyfox_2ship_gamestep.md` | SKYFOX architectural decisions MADMAX inherited |

---

## 8. First-five-minute checklist for the new session

1. Read this file in full.
2. `git status` and `git log --oneline -5` to confirm we're still at `1681bb8`.
3. Glance at `MEMORY.md` index for any memory entries newer than 2026-06-08.
4. If Karsten asks "what should I test first" → MADMAX mode 2, drive a lap, confirm: steering responds to mouse drag + arrows, shift accelerates, space fires, purple gets shot, yellow gets collected, green triggers a 2-sec speed boost (HUD shows `x1.5`), bullet hits on P2 slow it for ~1 sec.
5. If he says "build X" → do it; bump cachebuster; don't commit/push without an explicit ask.
6. If he wants to start the three.js upgrade → see section 5; ask which target version + branch policy first.

Welcome back. Good luck.

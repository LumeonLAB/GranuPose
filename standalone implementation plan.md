Here’s a concrete implementation plan based on what’s **already in your repo** (`pose-controller` Electron/React app + `EmissionControl2` C++ app). I’ll reference the exact files/behaviors I found so it’s actionable.

## 0) What you have today (repo reality check)

### Pose Controller (already “EC2-aware”)

* `pose-controller` is **Electron + React** and already talks OSC to EC2:

  * Sends parameter OSC like `/GrainRate`, `/ScanBegin`, `/Amplitude`, etc.
  * Has audio “bridge” UI that sends:

    * `/transport` (start/stop audio engine)
    * `/record`, `/fileName`, `/outputFolder`
    * `/loadSoundFile`, `/SoundFile`
    * `/audioDevice`
* OSC send is implemented in:

  * `pose-controller/electron/main.cjs` (UDP sender)
  * `pose-controller/electron/preload.cjs` (exposes `window.granuPose.osc`)
  * UI uses `sendOscMessage()` in `pose-controller/src/App.tsx`

So the Pose Controller is *not* “just pose”; it’s already a full EC2 controller. The only missing piece for a standalone device is: **EC2 engine is an external app you must run separately**.

### EmissionControl2 (engine is inside, but currently GUI-app oriented)

* `EmissionControl2/ecSource/src/main.cpp` runs `ecInterface app; app.start();`
* EC2 receives OSC in `ecInterface::onMessage()` (in `ecSource/src/ecInterface.cpp`).
* Important: EC2 only processes OSC if `isOSCOn == true` (currently toggled via GUI checkbox).
* Audio engine is **not running by default**; it’s started by:

  * space bar in GUI, or
  * OSC `/transport` (already implemented in `onMessage()`)

## 1) Recommended integration architecture (best fit for your codebase)

### ✅ Recommended: “Bundle + Spawn a Headless EC2 Engine Process”

Keep EC2’s realtime audio in a **separate native process**, but ship/manage it from the Pose Controller Electron app.

Why this is the best fit:

* Your Pose Controller already speaks OSC to EC2 (no protocol rewrite).
* Realtime audio stays out of Electron/Node event loops (stability + latency).
* You get a “single device / single app install” user experience:

  * User launches Pose Controller
  * Pose Controller auto-starts the EC2 engine in the background
  * UI controls engine locally over `127.0.0.1`

### Alternatives (not recommended initially)

* **Node native addon (N-API) wrapping EC2 engine**: doable but high risk/effort (audio thread + cross-platform builds).
* **WASM/WebAudio port**: unrealistic for EC2’s dependencies and performance.

## 2) Target end-state

A single standalone “GranuPose” app that:

1. Launches Pose Controller UI (Electron)
2. Auto-launches **EC2 headless engine** bundled inside the app
3. Uses OSC loopback:

   * Pose Controller → `127.0.0.1:16447` (engine listen)
   * Engine → `127.0.0.1:16448` (telemetry / status optional)
4. Manages engine lifecycle: start/stop/restart, logs, crash recovery
5. Uses Pose Controller UI as the *only* UI (no EC2 GUI window)

## 3) Workstreams and implementation phases

---

## Phase A — Create a Headless EC2 Engine Binary

### A1) Add a new “headless engine” executable target

Goal: build something like `ec2_headless` that runs audio + OSC **without EC2 GUI**.

**Changes in `EmissionControl2/ecSource/CMakeLists.txt`:**

* Split code into “core” and “gui” to avoid pulling ImGui/UI deps into headless binary.

Recommended structure:

* `ec2_core` library:

  * `src/emissionControl.cpp`
  * `src/ecSynth.cpp`
  * `src/utility.cpp`
  * plus headers in `include/`
* `EmissionControl2` GUI app links `ec2_core` + UI bits (`ecInterface.cpp`)
* `ec2_headless` links `ec2_core` + an OSC controller module (see next step)

This keeps the headless engine smaller and easier to package.

### A2) Extract OSC handling out of `ecInterface::onMessage()`

Right now, OSC logic lives inside the GUI app class (`ecInterface`), but you need it in headless too.

Create a reusable OSC router/controller, e.g.:

* `EmissionControl2/ecSource/include/ecOscRouter.h`
* `EmissionControl2/ecSource/src/ecOscRouter.cpp`

It should own references to:

* `ecSynth& granulator`
* `al::AudioIO& audioIO`
* `al::OutputRecorder& recorder`
* output folder + filename strings

Then you can:

* call it from `ecInterface::onMessage()` (GUI build)
* call it from `ecHeadlessApp::onMessage()` (headless build)

You will port the existing cases already in `onMessage()`:

* Parameter setting (`/GrainRate` etc)
* Mod params and LFO params
* `/morphTime`, `/preset` (optional but easy to keep)
* `/fileName`, `/outputFolder`, `/record`
* `/transport`
* `/audioDevice`
* `/loadSoundFile`, `/clearSoundFiles`, `/removeCurrentSoundFile`

### A3) Ensure OSC is always enabled in headless mode

In EC2 GUI, OSC is gated behind `isOSCOn`.

For headless:

* Start OSC receiver unconditionally.
* Default bind: `0.0.0.0:16447` or `127.0.0.1:16447` (I recommend `127.0.0.1` for a self-contained device).

### A4) Add CLI flags / env vars for paths + ports (packaging-critical)

This is the biggest “standalone device” enabler, because EC2 currently expects OS-specific install paths (especially on Linux).

Add support for:

* `--osc-host`, `--osc-port`
* `--telemetry-host`, `--telemetry-port` (optional)
* `--data-dir` (where to store config/presets/output)
* `--samples-dir` (where sample WAVs live)
* `--autostart-audio` (start audio immediately)
* `--no-audio` (for CI testing / headless smoke tests)

Implementation detail:

* In headless `onInit()`, compute:

  * config path
  * presets path
  * samples path
    using CLI overrides first, then fallback to existing logic.

### A5) Headless engine app skeleton

Add:

* `EmissionControl2/ecSource/src/headless_main.cpp`
* `EmissionControl2/ecSource/include/ecHeadlessApp.h`
* `EmissionControl2/ecSource/src/ecHeadlessApp.cpp`

`ecHeadlessApp` should:

* initialize config + load initial samples (same logic as `ecInterface::onInit()` but without UI)
* open audio device (same logic you already have)
* start OSC receiver
* optionally start audio engine (or rely on Pose Controller to send `/transport 1`)

### A6) Optional but highly useful: add a “hello/status” OSC publish

Right now Pose Controller can’t *really* know if engine is ready, because OSC is UDP.

Add a one-shot message emitted by the engine on startup:

* to telemetry port `16448`, address `/ec2/hello`
* args: version string, pid, sampleRate, bufferSize, etc.

That lets the Electron app show “Engine connected ✅”.

---

## Phase B — Add EC2 Engine Lifecycle Management to the Electron App

### B1) Add an EngineManager to Electron main process

Modify:

* `pose-controller/electron/main.cjs`

Add a module/class that:

* finds the bundled engine binary path (dev vs packaged)
* spawns it via `child_process.spawn()`
* captures stdout/stderr for logs
* restarts on crash (optional)
* stops it on app exit

Example responsibilities:

* `startEngine()`
* `stopEngine()`
* `restartEngine()`
* `getEngineStatus()`
* `subscribeEngineLogs()` (push to renderer)

### B2) Expose IPC + preload API

Modify:

* `pose-controller/electron/preload.cjs`
* `pose-controller/src/types/electron.ts`

Add something like:

* `window.granuPose.engine.start()`
* `window.granuPose.engine.stop()`
* `window.granuPose.engine.status()`
* `window.granuPose.engine.subscribeLogs(cb)`

### B3) UI: show engine status + controls

Modify:

* `pose-controller/src/App.tsx`

Add a section (likely near the existing OSC/EC2 settings) showing:

* Engine: `stopped | starting | running | error`
* Buttons: Start / Stop / Restart
* Last N log lines (collapsible)

### B4) Auto-configure OSC target to localhost when engine is managed internally

Today defaults are already `127.0.0.1:16447`, but users can change them.

For the standalone device mode:

* when engine is started by Pose Controller, force:

  * `oscTargetHost = 127.0.0.1`
  * `oscTargetPort = 16447`

Or provide a toggle:

* “Managed local engine (standalone mode)” vs “Remote engine”.

### B5) Startup sequencing

On Electron app ready:

1. `EngineManager.startEngine()`
2. Once started (or after small delay / hello message), Pose Controller:

   * connects OSC output client
   * optionally sends `/transport 1`
   * optionally loads selected sound source:

     * `/loadSoundFile "path"`
     * `/SoundFile <index>`
   * sends `/Amplitude` master level from stored settings

This aligns with existing UI behavior.

---

## Phase C — Bundle + Package as One Standalone Install

Right now Pose Controller has no packaging step (no electron-builder / forge). You’ll need one.

### C1) Add an Electron packager

Recommended: **electron-builder** (common, supports extraResources well).

Changes:

* add `electron-builder` devDependency
* add scripts like:

  * `build:engine`
  * `dist`

### C2) Build EC2 headless as part of the Pose Controller build

Add a script in `pose-controller/scripts/` that:

* initializes submodules for EC2 if needed
* runs CMake build for `ec2_headless`
* copies resulting binary into something like:

  * `pose-controller/engine-bin/<platform>/ec2_headless[.exe]`

### C3) Bundle EC2 resources

You already reference a default WAV in Electron main:

* `EmissionControl2/externalResources/samples/440sine48k.wav`

For a fully self-contained app:

* ship `EmissionControl2/externalResources/samples/` inside Electron `resources/`
* optionally ship any libsndfile dependencies (esp. macOS needs dylibs)

### C4) Runtime path strategy (critical)

When spawning engine, pass:

* `--data-dir <electron app userData>/ec2/`
* `--samples-dir <electron resources>/ec2/samples/`
* and any dylib/dll search paths as env:

  * macOS: `DYLD_LIBRARY_PATH`
  * linux: `LD_LIBRARY_PATH`
  * windows: ship `.dll` next to binary

This avoids relying on `/usr/share/emissioncontrol2/...` and makes it truly standalone on Linux too.

---

## Phase D — Telemetry + Reliability Polish (optional but recommended)

### D1) Implement `/ec2/telemetry/scan` in the headless engine

Pose Controller already listens on UDP port `16448` for `/ec2/telemetry/scan` (see `pose-controller/electron/main.cjs` and bridge).

Implement a lightweight telemetry sender thread (not in audio callback) that publishes at ~20–60 Hz:

* playheadNorm
* scanHeadNorm
* scanRangeNorm
* soundFileFrames (optional)
* activeGrainIndices (optional, can be heavy but Pose Controller supports it)

You already have helper methods in `ecSynth`:

* `getCurrentIndex()`
* `copyActiveGrainIndicies(...)`

### D2) Engine watchdog + crash recovery

In Electron main:

* if engine exits unexpectedly:

  * update UI status
  * optionally auto-restart (with backoff)

### D3) Add a “no-audio” mode for CI and diagnostics

So you can run “headless engine starts + OSC binds” in GitHub Actions without an audio device.

---

## 4) File-by-file checklist (what you’ll actually touch)

### EmissionControl2

* `ecSource/CMakeLists.txt`

  * split core vs gui
  * add `ec2_headless` target
* New files:

  * `ecSource/src/headless_main.cpp`
  * `ecSource/src/ecHeadlessApp.cpp` + `include/ecHeadlessApp.h`
  * `ecSource/src/ecOscRouter.cpp` + `include/ecOscRouter.h`
* Refactor:

  * `ecSource/src/ecInterface.cpp`

    * replace big `onMessage()` body with calls into `ecOscRouter`
* Optional telemetry:

  * new `ecTelemetrySender` module

### pose-controller

* `electron/main.cjs`

  * add EngineManager + spawn logic
  * add ipcMain handlers: `granuPose:engine:*`
* `electron/preload.cjs`

  * expose `window.granuPose.engine.*`
* `src/types/electron.ts`

  * add types for engine IPC + log subscription
* `src/App.tsx`

  * add engine status + start/stop UI
  * add “standalone mode” toggle logic
* Build/packaging additions:

  * `pose-controller/package.json` scripts + builder config
  * `pose-controller/scripts/build-engine.(sh|ps1|js)`

---

## 5) Biggest risks / gotchas (so you don’t get stuck)

### 1) EC2 build dependencies (submodules)

In your zip, `EmissionControl2/ecSource/external/allolib` etc are empty because they’re submodules.
Your build scripts must do:

* `git submodule update --init --recursive`

### 2) Linux resource paths

EC2 currently expects `/usr/share/emissioncontrol2/samples/` on Linux unless installed.
Standalone packaging requires the `--samples-dir` override (or similar) so the engine can load samples from inside your Electron bundle.

### 3) OSC “enabled” gate

If you don’t force OSC on in headless mode, Pose Controller will send messages and nothing will happen.
Headless must always listen/process.

### 4) Licensing

EmissionControl2 is **GPL-3.0**. Pose Controller is effectively ISC today.
If you distribute a single packaged product that includes EC2 (especially if you link it into the same binary, but even bundling can have implications), you should treat this as a **GPL compliance project**:

* include source availability obligations
* ensure license notices are shipped
* potentially relicense Pose Controller as GPL-compatible if needed

(You don’t need to change code for this, but you should plan it as part of the deliverable.)

---

## 6) Suggested “minimum viable merge” (fast path)

If you want a first working standalone device ASAP:

1. Build `ec2_headless` that:

* starts OSC receiver immediately on `127.0.0.1:16447`
* opens audio device (system default)
* supports `/transport` and parameter OSC

2. Electron app:

* spawns `ec2_headless` on startup
* sets OSC target to localhost
* adds a small status indicator + restart button

Everything else (telemetry, fancy packaging, presets) can come after.

---

If you want, I can also provide a **concrete folder layout** for the packaged app (`resources/ec2/...` + `userData/ec2/...`) and an example `EngineManager` skeleton that fits directly into your current `pose-controller/electron/main.cjs` style.

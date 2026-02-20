# Standalone Validation Matrix Run (2026-02-19)

## Scope

Task: `2ac5ac26-773e-4a68-90cd-1f8c7fac73d8`  
Baseline checklist: `pose-controller/docs/standalone-acceptance-checklist.md`

This run focuses on startup-gate prerequisites, headless parity checks for transport/scan telemetry (`180b...` scope), a safe-workflow Electron-managed validation pass executed from a shadow workspace copy to avoid local VS Code lock interference, and follow-up automated validations for Step 1 (`A3`, `B3`), Step 2 (`C1`, `C2`, `C3`), Step 3 (`D1`, `D2`), and Step 4 (`E3`).

## 2026-02-20 Follow-up Automation Addendum

Additional automation was implemented to unblock remaining checklist items from code-side:

1. `B2` matrix evidence harness:
   - Command: `npm run validate:b2-matrix`
   - Artifact: `pose-controller/docs/b2-ec2-matrix-evidence-latest.json`
   - Current local result: `pass=true`
   - Evidence includes:
     - 8 default matrix-target OSC params (`/GrainRate`, `/GrainDuration`, `/ScanSpeed`, `/Asynchronicity`, `/Intermittency`, `/PlaybackRate`, `/ScanBegin`, `/ScanRange`)
     - `/loadSoundFile` + `/SoundFile` selection sequence
     - `/fileName`, `/outputFolder`, `/record 1/0`, `/transport 1/0` observations
     - telemetry cadence + transport movement/latency observations

2. `F2` packaged clean-profile smoke harness:
   - Command: `npm run validate:packaged-clean-smoke`
   - Artifact: `pose-controller/docs/packaged-clean-smoke-latest.json`
   - Current local result: `pass=false`
   - Failure mode captured: packaged app process exits before `/ec2/hello` (`app_exited_before_hello(exitCode=0,signal=none)`), so A1/B1/C1 packaged smoke remains blocked in this host context.

## Evidence Captured

1. `ec2_headless` source compiles with MSVC (`headless_main.cpp`).
2. Runtime smoke confirms startup hello telemetry:
   - UDP listener on `127.0.0.1:16448` received datagram.
   - OSC address decoded as `/ec2/hello`.
3. Hello payload includes expected startup metadata:
   - `version=1.2`
   - `build=<date time>`
   - `pid=<process id>`
   - `osc=127.0.0.1:16447`
   - `telemetry=127.0.0.1:16448`
   - `telemetryIntervalMs=50`
   - `startupTransport=<0|1>`
   - runtime/config flags and paths
4. Runtime smoke confirms periodic `/ec2/telemetry/scan` emission at configured cadence:
   - received 12 scan packets in idle pre-transport window (`span=0.0`, playhead stable)
   - received 17 scan packets after `/transport 1` (`span=0.0193`, playhead advancing)
   - received 17 scan packets after `/transport 0` (`span=0.0`, playhead stabilized)
5. `--no-audio` mode behavior smoke:
   - `--no-audio` overrides `--autostart-audio` (startup log + hello payload `startupTransport=0`)
   - `/transport 1` is explicitly ignored in no-audio mode
   - scan telemetry remains stable (`span=0.0`) while no-audio is active
6. OSC bind evidence:
   - headless process binds local receiver on `127.0.0.1:16447`.
7. Electron-managed launch/shutdown validation (safe-workflow pass, shadow workspace):
   - `npm ci` succeeds in `GranuPose_shadow/pose-controller` without `default_app.asar` lock contention.
   - Electron app process launch auto-starts managed `ec2_headless` with `GRANUPOSE_ENGINE_AUTOSTART=1`.
   - Telemetry listener receives `/ec2/hello` from managed run (`engine_pid_from_hello=22832` in sample pass).
   - Managed app termination leaves no orphan `ec2_headless` process after shutdown wait.
8. Electron-managed telemetry cadence validation (safe-workflow pass):
   - During managed run, telemetry listener received `scan_count=325` packets.
   - Observed scan cadence ~`16.39 Hz` under no-audio autostart policy for that run.
9. Automated Step 1 (`A3` + `B3`) validation pass:
   - Command: `npm run validate:step1` (spawns renderer + Electron validation harness).
   - Artifact: `pose-controller/docs/standalone-step1-validation-latest.json`.
   - Result: `pass=true`, with two full `start/stop/restart` command cycles and managed-mode OSC lock toggle/restore checks.
10. Automated Step 2 (`C1` + `C2` + `C3`) validation pass:
   - Command: `npm run validate:step2` (spawns renderer + Electron validation harness).
   - Artifact: `pose-controller/docs/standalone-step2-validation-latest.json`.
   - Result: `pass=true`, including:
     - `C1`: `/transport 1` via full app UI path with telemetry movement (`playheadSpan=0.0416`, `scan_count=35`) and engine `transport 1` log marker.
     - `C2`: repeated `/transport 0` cycles (`3x`) with stable post-stop telemetry and engine process remaining `running`.
     - `C3`: startup-flag matrix (`startupTransport=0` baseline, `startupTransport=1` with `--autostart-audio`, `startupTransport=0` with `--autostart-audio --no-audio`) plus no-audio ignore marker (`ignored /transport 1 because --no-audio is active`).
11. Automated Step 3 (`D1` + `D2`) validation pass:
   - Command: `npm run validate:step3` (spawns renderer + Electron validation harness).
   - Artifact: `pose-controller/docs/standalone-step3-validation-latest.json`.
   - Result: `pass=true`, including:
     - `D1`: one ~10s record cycle via UI path (`/fileName`, `/outputFolder`, `/record 1/0`) generating `take.wav` with non-zero size (`1923100` bytes).
     - `D2`: three consecutive record cycles generating collision-safe files (`take_1.wav`, `take_2.wav`, `take_3.wav`) with non-zero sizes and engine staying healthy (`status=running` until cleanup).
12. Packaging/distribution run (`F1/F3/F4` implementation evidence):
   - Command: `npm run dist` in `pose-controller`.
   - Build pipeline executed: `build:frontend` -> `build:engine:stage` -> `compliance:stage` -> `electron-builder`.
   - Produced installer artifact: `pose-controller/release-artifacts/GranuPose Setup 1.0.0.exe`.
   - Installer SHA256: `13fb61708c529c789320d37d458db8ce678516f54f10fe771755fbc1d6dc3cee`.
   - Verified packaged resource payload in `win-unpacked`:
     - `resources/engine-bin/win32/ec2_headless.exe` (SHA256 `1a1388cc59b49282ff7273d36575c9333877099f810b90da4797ee3e8067f317`)
     - `resources/ec2/samples/440sine48k.wav` (SHA256 `27fe9a23d35e3f8ff6f3acaa4b23dfccfe29d25d92df950ba49735cda132b795`)
     - `resources/compliance/licenses/EmissionControl2-GPL-3.0.txt` (SHA256 `230184f60bae2feaf244f10a8bac053c8ff33a183bcc365b4d8b876d2b7f4809`)
   - Supporting docs/manifests:
     - `pose-controller/docs/packaged-resource-inventory.md`
     - `pose-controller/docs/gpl-compliance-checklist.md`
     - `pose-controller/engine-resources/stage-manifest.json`
     - `pose-controller/release-compliance/manifest.json`
13. Repeatable CI headless smoke command added:
   - Command: `npm run validate:headless-smoke`
   - Script: `pose-controller/scripts/headless-smoke-test.cjs`
   - Artifact: `pose-controller/docs/headless-smoke-latest.json`
   - Assertions: `/ec2/hello` observed, scan telemetry observed, `/Amplitude` + `/transport` command dispatch, expected transport log evidence, process health after command sequence.
14. Automated Step 4 (`E3`) validation pass:
   - Command: `npm run validate:step4` (spawns renderer + Electron validation harness).
   - Artifact: `pose-controller/docs/standalone-step4-validation-latest.json`.
   - Result: `pass=true`, including:
     - forced unexpected engine exit (`SIGKILL`) while managed session is running
     - UI status transitions through `Engine error`
     - watchdog restart scheduling/execution logs observed
     - engine recovery to `running` with new PID and restart attempt counter increment.

## Incident Note (Host Stability)

- During earlier lock-clearing attempts in the primary workspace, host experienced an unexpected reboot.
- Windows log evidence indicates a kernel bugcheck (not a normal process-requested shutdown):
  - `Kernel-Power 41` + `EventLog 6008`
  - `WER-SystemErrorReporting 1001` bugcheck `0x0000004e` with dump `C:\\Windows\\Minidump\\021926-17468-01.dmp`
- Correlation only: repeated kernel-mode utility driver install events (`RTCore64`, `IOMap`) are present in nearby boot logs; root cause remains system-level and outside repository code.
- Mitigation used for this task: continue validation in a shadow workspace and avoid terminating VS Code-owned utility processes directly.

## Hello-Gate Specific Artifacts

- Startup gate transition markers were implemented in renderer logs/UI (`engine_start_requested`, `engine_running`, `hello_received|hello_timeout_fallback`, `startup_sync_applied`, `startup_ready`).
- Startup transport policy is now explicit and deterministic (`/transport 1` only when enabled by setting).
- `/ec2/hello` payload capture confirms engine-side readiness signal exists (not timeout-only fallback path).

## Matrix Status (Current Run)

| Item | Status | Notes |
| --- | --- | --- |
| A1 Engine launch | PASS (safe-workflow run) | In shadow workspace run, Electron launch auto-started managed `ec2_headless` and emitted `/ec2/hello` within run window. |
| A2 Engine shutdown | PASS (safe-workflow run) | In same run, terminating Electron left no orphan `ec2_headless` process after shutdown wait. |
| A3 UI/IPC start-stop-restart | PASS (automated step1 run) | `standalone-step1-validation-latest.json` shows two full `start/stop/restart` cycles via UI button path, expected engine status transitions, startup-audit trail, and matching main-process log lines. |
| B1 OSC accepts local endpoint | PASS (headless smoke) | Verified by dedicated headless smoke automation (`npm run validate:headless-smoke`) with telemetry hello/scan evidence and command dispatch trace artifact. |
| B2 Core parameter E2E control | BLOCKED | Shared `ecOscRouter` extraction/rewire landed for GUI + headless paths; full 8-param E2E behavior verification pass is still pending. |
| B3 Managed-mode OSC lock | PASS (automated step1 run) | Same artifact confirms remote-mode unlock/edit (`192.168.0.99:17777`) and re-lock to managed target (`127.0.0.1:16447`) with lock indicator transitions (`Remote Target` -> `Standalone Local`). |
| C1 `/transport 1` start audio | PASS (automated step2 run) | `standalone-step2-validation-latest.json` confirms UI-triggered `/transport 1` in managed full-app run with live telemetry movement and transport log evidence. |
| C2 `/transport 0` stop audio | PASS (automated step2 run) | Same artifact confirms repeated `/transport 0` cycles (`>=3`) remain stable and engine stays healthy (no crash/hang or unexpected-exit marker). |
| C3 autostart/no-audio modes | PASS (automated step2 run) | Same artifact validates startup flag matrix and no-audio override behavior, including ignored runtime `/transport 1` command evidence. |
| D1 Recording controls | PASS (automated step3 run) | `standalone-step3-validation-latest.json` confirms UI-driven `/fileName`, `/outputFolder`, `/record 1/0` creates output file in requested folder with non-zero size and record start/stop logs. |
| D2 Repeated record cycles | PASS (automated step3 run) | Same artifact confirms `3x` consecutive record cycles create distinct collision-safe files (`take_1.wav..take_3.wav`) with non-zero sizes while engine remains healthy. |
| E1 Startup hello telemetry | PASS | Captured one-shot `/ec2/hello` message and metadata. |
| E2 Periodic scan telemetry | PASS (headless smoke) | `/ec2/telemetry/scan` publisher implemented and consumed by existing listener parse contract (`playheadNorm`, `scanHeadNorm`, `scanRangeNorm`, frames, active-grain indices). |
| E3 Crash visibility/restart policy | PASS (automated step4 run) | `standalone-step4-validation-latest.json` confirms forced unexpected engine exit, UI `Engine error` state exposure, watchdog restart scheduling/execution, and successful recovery to `running` with restart-attempt evidence. |
| F1 Packaged artifact includes UI + headless | PASS | `npm run dist` produced NSIS installer (`release-artifacts/GranuPose Setup 1.0.0.exe`) and unpacked app includes bundled `ec2_headless` + renderer assets. |
| F2 Clean-machine smoke | BLOCKED | Packaging + deploy test not executed in this run. |
| F3 Bundled resources completeness | PASS | Packaged resources include staged engine binary, sample WAV bundle, runtime path wiring docs, and manifests (`docs/packaged-resource-inventory.md`). |
| F4 GPL compliance artifacts | PASS | Release bundle now includes GPL license, notice, source-offer, and compliance manifest under `resources/compliance`. |

## Result

Current result: **partial validation only**.  
This run now includes managed Electron launch/shutdown evidence, managed telemetry capture, automated passes closing Step 1 (`A3`, `B3`), Step 2 (`C1`, `C2`, `C3`), Step 3 (`D1`, `D2`), Step 4 (`E3`), repeatable CI headless smoke automation for OSC/transport evidence capture, plus packaging/compliance closure for `F1`, `F3`, and `F4`. Full standalone acceptance remains blocked by `B2` runtime matrix evidence and `F2` clean-machine smoke.

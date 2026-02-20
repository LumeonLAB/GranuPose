# GranuPose Standalone Merge Scope and Acceptance Checklist

Last updated: 2026-02-19

## Scope Baseline

This checklist defines the minimum accepted behavior for merging Pose Controller and EC2 into one standalone desktop device/app experience:

1. One app launch starts both UI and local managed engine.
2. Engine runs headless (no EC2 GUI required for operator workflow).
3. Pose Controller remains the primary control surface for transport, recording, and core OSC parameter control.
4. Packaged output includes all required runtime assets to run without system-level EC2 install paths.

## Pass/Fail Rules

1. A checklist item is `PASS` only when its validation method succeeds and required evidence is captured.
2. Any `FAIL` in sections A-F blocks standalone release readiness.
3. `N/A` is allowed only with explicit rationale and project approval.

## Acceptance Matrix

| ID | Area | Requirement (Pass Condition) | Validation Method | Evidence |
|---|---|---|---|---|
| A1 | Engine launch | Launching the Electron app starts a managed `ec2_headless` process automatically within 5s. | Cold start app 3 times; inspect engine status in UI and process list. | Run log with timestamped start events and PID. |
| A2 | Engine launch | Managed engine shuts down cleanly when app exits (no orphan process after 10s). | Close app normally and verify process list. | Exit log and post-exit process check output. |
| A3 | Engine launch | Manual engine controls (`start/stop/restart`) work from UI/IPC without crashing renderer. | Trigger each command twice during same session. | UI state transitions + main-process logs. |
| B1 | OSC control | Engine accepts OSC at configured local endpoint (default `127.0.0.1:16447`) immediately after startup. | Send `/Amplitude` and `/ScanSpeed` after app start; confirm no route errors. | Engine receive logs and parameter state change. |
| B2 | OSC control | Core parameter set remains controllable end-to-end from Pose Controller mapping/output path. | Exercise at least 8 mapped params (existing matrix targets). | Capture sent OSC messages and audible/telemetry response notes. |
| B3 | OSC control | Standalone managed mode enforces local OSC target lock (`127.0.0.1:16447`) or explicitly signals remote mode. | Toggle managed mode and inspect target host/port behavior. | Settings snapshot + status indicator proof. |
| C1 | Transport | `/transport 1` starts audio engine playback path when audio mode is enabled. | Issue start command after cold launch. | Log marker and audible output confirmation. |
| C2 | Transport | `/transport 0` stops playback cleanly without engine crash/hang. | Issue stop command repeatedly (>=3 times). | Log marker and stable process status. |
| C3 | Transport | Startup behavior flags (`autostart-audio` and `no-audio`) behave as documented. | Run smoke scenarios for each mode. | Scenario table with expected/actual results. |
| D1 | Recording | `/fileName`, `/outputFolder`, `/record 1/0` controls create an output file in selected location. | Run one 10s record cycle with custom filename/path. | File existence + size > 0 bytes + logs. |
| D2 | Recording | Record start/stop can be repeated in one session without app restart. | Execute 3 consecutive record cycles. | Generated file list and no-crash log trace. |
| E1 | Telemetry | Engine emits startup `/ec2/hello` with process/build/runtime info to telemetry port. | Start engine and listen on telemetry receiver (`16448` default). | Captured hello payload. |
| E2 | Telemetry | Engine emits periodic `/ec2/telemetry/scan` updates consumable by existing Pose Controller listener. | Observe telemetry stream for 10s while running. | Telemetry sample capture with timestamp cadence. |
| E3 | Telemetry | Unexpected engine exit is surfaced to UI and restart handling follows configured policy. | Kill engine process during session and observe behavior. | UI error state and restart/backoff log trace. |
| F1 | Packaging output | `npm run dist` (or equivalent release command) produces installable artifact containing UI + headless engine binary. | Build packaged app on target platform. | Artifact list with paths and checksums. |
| F2 | Packaging output | Packaged app runs on clean machine profile without relying on system EC2 sample/install paths. | Launch packaged app in clean env and run A1/B1/C1 smoke checks. | Smoke report and resolved runtime path log. |
| F3 | Packaging output | Bundled resources include required samples/libs/licenses for runtime and compliance. | Inspect package contents and launch logs. | Resource inventory checklist. |
| F4 | Packaging output | GPL distribution obligations are included in release bundle/documentation. | Verify notices/source-offer artifacts are present in release output. | Compliance artifact manifest. |

## Minimum Release Gate

Release candidate is approved only if:

1. All items A1-F4 are `PASS` (or approved `N/A`).
2. Validation evidence is attached to `Run end-to-end standalone validation matrix` task output.
3. Blocking defects have linked remediation tasks with owners and due dates.

## Traceability to Implementation Work

This checklist is the acceptance baseline for standalone tasks in these features:

1. `Standalone Planning`
2. `EC2 Headless Engine`
3. `EC2 OSC Router`
4. `Electron Managed Engine`
5. `Telemetry & Reliability`
6. `Packaging & Distribution`
7. `Validation`

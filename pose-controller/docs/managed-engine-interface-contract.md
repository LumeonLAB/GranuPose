# Managed Engine Interface Contract (EC2 Headless <-> Pose Controller)

Last updated: 2026-02-19  
Status: Baseline for standalone merge implementation

## Purpose

Define the canonical runtime interface between Electron (Pose Controller) and bundled `ec2_headless` process.

## Process Model

1. Electron main process owns engine lifecycle.
2. Renderer never spawns native process directly.
3. Renderer communicates only through typed IPC exposed in preload.

## Engine Binary Contract

1. Binary name:
   - Windows: `ec2_headless.exe`
   - macOS/Linux: `ec2_headless`
2. Resolution order:
   - `GRANUPOSE_ENGINE_PATH` (absolute or relative)
   - packaged/resource candidate paths (engine staging folders)
   - workspace/dev candidate paths
3. Missing binary behavior:
   - Engine status transitions to `error`
   - Last error includes binary lookup failure detail

## CLI Flags (Canonical)

Electron passes these flags when supported by engine build:

1. `--osc-host <host>`
2. `--osc-port <port>`
3. `--telemetry-host <host>`
4. `--telemetry-port <port>`
5. `--data-dir <path>`
6. `--samples-dir <path>`
7. `--autostart-audio` (boolean switch)
8. `--no-audio` (boolean switch)

Defaults for managed standalone mode:

1. OSC host/port: `127.0.0.1:16447`
2. Telemetry host/port: `127.0.0.1:16448`
3. Data dir: `<electron userData>/ec2`
4. Samples dir: bundled EC2 samples path if found
5. `--autostart-audio`: disabled unless explicitly enabled
6. `--no-audio`: disabled unless explicitly enabled

## OSC Contract

1. Pose Controller -> Engine input (UDP):
   - target `127.0.0.1:16447` in managed mode
   - supports parameter OSC addresses already used by app (`/Amplitude`, `/ScanBegin`, `/transport`, `/record`, `/loadSoundFile`, etc.)
2. Engine -> Pose Controller telemetry (UDP):
   - listener `127.0.0.1:16448` (Electron)
   - `/ec2/hello` startup message (when implemented)
   - `/ec2/telemetry/scan` periodic scan payload

## IPC Contract (`granuPose:engine:*`)

Main-process handlers:

1. `granuPose:engine:start`
2. `granuPose:engine:stop`
3. `granuPose:engine:restart`
4. `granuPose:engine:status`
5. `granuPose:engine:getLogs`

Renderer event channels:

1. `granuPose:engine:status` (push state changes)
2. `granuPose:engine:log` (streamed stdout/stderr/system lines)

## Engine State Model

`stopped | starting | running | stopping | error`

State payload fields:

1. `status`
2. `pid` (nullable)
3. `binaryPath` (nullable)
4. `args` (argv list)
5. `startedAtMs` (nullable)
6. `stoppedAtMs` (nullable)
7. `lastError` (nullable)

## Environment Overrides

1. `GRANUPOSE_ENGINE_PATH`
2. `GRANUPOSE_ENGINE_OSC_HOST`
3. `GRANUPOSE_ENGINE_OSC_PORT`
4. `GRANUPOSE_ENGINE_TELEMETRY_HOST`
5. `GRANUPOSE_ENGINE_TELEMETRY_PORT`
6. `GRANUPOSE_ENGINE_DATA_DIR`
7. `GRANUPOSE_ENGINE_SAMPLES_DIR`
8. `GRANUPOSE_ENGINE_AUTOSTART_AUDIO`
9. `GRANUPOSE_ENGINE_NO_AUDIO`
10. `GRANUPOSE_ENGINE_AUTOSTART` (process autostart toggle)
11. `GRANUPOSE_ENGINE_WATCHDOG_RESTART` (enable/disable crash auto-restart)
12. `GRANUPOSE_ENGINE_RESTART_BASE_DELAY_MS`
13. `GRANUPOSE_ENGINE_RESTART_MAX_DELAY_MS`
14. `GRANUPOSE_ENGINE_RESTART_MAX_ATTEMPTS`
15. `GRANUPOSE_ENGINE_RESTART_BACKOFF_RESET_MS`

## Error Handling

1. Start failure returns `ok: false` with `error`.
2. Unexpected process exit sets state to `error` and logs exit code/signal.
3. Watchdog can auto-restart with capped exponential backoff.
4. Auto-restart is suppressed for intentional stop/quit paths.
5. Logs are retained in bounded ring buffer for diagnostics.

## Acceptance Mapping

This contract directly supports checklist document:

- Archon: `467eede9-b70b-46ba-b5f2-364de957aaa8`
- Repo: `pose-controller/docs/standalone-acceptance-checklist.md`

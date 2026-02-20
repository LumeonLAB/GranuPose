# GranuPose Pose Controller

Desktop and hosted controller for body-driven granular synthesis control.

## Modes

- Desktop mode: Electron renderer + local integrations.
- Hosted mode: Browser UI + bridge service (WebSocket/HTTP to OSC UDP).

## Local Development

- Electron app: `npm run dev`
- Hosted stack (non-container): `npm run dev:hosted`
- Bridge only: `npm run dev:bridge`

## Standalone Packaging

- Stage EC2 engine binary + samples/libs: `npm run build:engine:stage`
- Stage GPL/compliance bundle: `npm run compliance:stage`
- Build frontend + stage engine + stage compliance: `npm run build:standalone`
- Build installable artifacts (`electron-builder`): `npm run dist`
- Build unpacked directory only: `npm run dist:dir`

## Validation Automation

- Headless OSC/transport smoke (CI-suitable): `npm run validate:headless-smoke`
- Smoke report output: `docs/headless-smoke-latest.json`
- B2 EC2 matrix evidence harness (8 params + load/record/transport): `npm run validate:b2-matrix`
- B2 matrix report output: `docs/b2-ec2-matrix-evidence-latest.json`
- F2 packaged clean-profile smoke harness (A1/B1/C1): `npm run validate:packaged-clean-smoke`
- Packaged clean smoke report output: `docs/packaged-clean-smoke-latest.json`
- Managed-engine crash/restart watchdog validation (E3): `npm run validate:step4`
- Step4 report output: `docs/standalone-step4-validation-latest.json`
- Optional overrides: `HEADLESS_SMOKE_BINARY_PATH`, `HEADLESS_SMOKE_OUTPUT`, `HEADLESS_SMOKE_TIMEOUT_MS`, `HEADLESS_SMOKE_OSC_PORT`, `HEADLESS_SMOKE_TELEMETRY_PORT`

Useful env overrides:

- `GRANUPOSE_ENGINE_PATH` explicit engine binary path
- `GRANUPOSE_ENGINE_SAMPLES_DIR` explicit samples directory path
- `GRANUPOSE_ENGINE_LIB_DIR` explicit runtime-libs directory path
- `GRANUPOSE_SOURCE_URL` source URL embedded in compliance `SOURCE_OFFER.txt`
- `GRANUPOSE_ENGINE_SKIP_BUILD=1` skip CMake compile and stage existing binary
- `GRANUPOSE_ENGINE_SKIP_SUBMODULE_UPDATE=1` skip submodule bootstrap in stage script
- `GRANUPOSE_ENGINE_SKIP_VCVARS=1` skip `vcvars64` shell bootstrap and use current terminal toolchain env

## Docker Deployment

- Prod-like stack + OSC monitor terminal (Windows): `npm run docker:up`
- Dev profile stack + OSC monitor terminal (Windows): `npm run docker:up:dev`
- Prod-like stack without monitor (cross-platform): `npm run docker:up:no-monitor`
- Dev profile stack without monitor (cross-platform): `npm run docker:up:dev:no-monitor`
- Stop stack: `npm run docker:down`

Performance tuning env vars (set before `docker compose up`):

- `VITE_POSE_DELEGATE=GPU` to prefer GPU delegate (fallback to CPU if unavailable).
- `VITE_POSE_INFERENCE_FPS=30` to cap inference frequency.
- `VITE_POSE_NEW_FRAME_ONLY=true` to skip duplicate inference on unchanged camera frames.
- `BRIDGE_CPU_LIMIT=8.0` and `BRIDGE_MEM_LIMIT=8g` to prevent host saturation.
- `UV_THREADPOOL_SIZE=4` plus `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`, `MKL_NUM_THREADS=1` for conservative thread usage defaults.
- `OSC_ACTIVITY_LOG_INTERVAL_MS=1000` to print bridge OSC/telemetry activity summaries every second (`0` disables activity logs).

For the `prod` profile, `VITE_*` settings are build arguments and require image rebuild (the provided `docker:up` scripts include `--build`).

The bridge exposes:

- `GET /health`
- `POST /api/channels`
- `POST /api/channels/batch`
- WebSocket: `/ws`

## Notes

- Browser webcam access requires HTTPS on non-localhost hosts.
- EC2 OSC default target is `127.0.0.1:16447`; in Docker, set `OSC_TARGET_HOST` as needed.
- Telemetry listener defaults to `0.0.0.0:16448` (`TELEMETRY_LISTEN_HOST`, `TELEMETRY_LISTEN_PORT`).
- Output mode selection:
  - Runtime protocol is selected in the UI (`OSC` or `MIDI`) with live connection indicator and message rate meter.
  - `OSC` uses Electron IPC UDP sender in desktop mode and bridge WebSocket relay in hosted mode.
- `MIDI` uses Electron main-process MIDI output (`jzz`) in desktop mode, with Web MIDI fallback in hosted browser mode.
- Desktop OSC target can be set with `VITE_OSC_TARGET_HOST` and `VITE_OSC_TARGET_PORT`.
- Optional MIDI defaults: `VITE_MIDI_DEVICE_ID`, `VITE_MIDI_CHANNEL`, `VITE_MIDI_CC_START`.
- EC2 settings panel includes version selector (`v1.2`, `v1.3+`, `custom`) and profile selection with capability indicators.
- Canonical EC2 parameter registry: `shared/ec2/params.json` (typed access via `src/modules/output/ec2Params.ts`).
- OSC channel schema is documented in `docs/osc-schema.md`.
- Fast startup/testing onboarding runbook: `docs/app-onboarding-fast-start.md`.
- Audio bridge includes native WAV file picker in Electron (`Load Sound File`), source dropdown selection, output-folder picker, master amplitude slider, and main audio-output device routing (`/audioDevice`).
- Realtime performance view now supports engine telemetry (`/ec2/telemetry/scan`) for true playhead/active-grain display, with automatic fallback to control-derived estimation.
- See `docs/deployment-modes.md` and `docs/bridge-api.md`.
- Packaging/resource inventory: `docs/packaged-resource-inventory.md`.
- GPL compliance checklist: `docs/gpl-compliance-checklist.md`.

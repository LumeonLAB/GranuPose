# GranuPose

**Body-driven granular synthesis — turn movement into sound.**

GranuPose is a standalone desktop application that pairs real-time pose estimation with the [EmissionControl2](https://github.com/EmissionControl2/EmissionControl2) granular synthesis engine. Point a webcam at a performer, map body landmarks to synthesis parameters, and sculpt sound through gesture.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  GranuPose (Electron)                           │
│                                                 │
│  ┌──────────┐   ┌─────────┐   ┌─────────────┐  │
│  │ MediaPipe │──▶│ Mapping │──▶│ OSC / MIDI  │──┼──▶ EC2 Engine
│  │ Pose      │   │ Engine  │   │ Output      │  │    (bundled)
│  └──────────┘   └─────────┘   └─────────────┘  │
│       ▲                                         │
│       │  webcam                                 │
└─────────────────────────────────────────────────┘
```

The Electron app manages the EC2 engine as a child process, communicating over OSC on `127.0.0.1`. No external software is required — one install, one launch.

## Repository Structure

```
GranuPose/
├── pose-controller/        # Electron + React + TypeScript application
│   ├── electron/           #   Main process (engine manager, OSC, MIDI)
│   ├── bridge/             #   WebSocket-to-OSC bridge for hosted mode
│   ├── src/                #   React renderer (pose, mapping, output UI)
│   ├── scripts/            #   Build, staging & validation scripts
│   ├── shared/             #   Shared data (EC2 param registry)
│   └── docs/               #   Technical docs, validation reports
├── EmissionControl2/       # EC2 granular synthesis engine (git submodule)
└── .github/workflows/      # CI pipeline
```

## Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| Git | with submodule support |

### Clone & Install

```bash
git clone --recurse-submodules https://github.com/LumeonLAB/GranuPose.git
cd GranuPose/pose-controller
npm install
```

### Run (Desktop / Electron)

```bash
npm run dev
```

This launches the Vite dev server and the Electron shell side-by-side.

### Run (Hosted / Browser)

```bash
npm run dev:hosted
```

Opens the UI at `http://localhost:5173` with the WebSocket-to-OSC bridge running alongside.

## Standalone Packaging

Build a distributable installer (Windows NSIS, macOS DMG, Linux AppImage):

```bash
# Stage the EC2 engine binary + samples + GPL compliance bundle, then package
npm run dist
```

See [`pose-controller/README.md`](pose-controller/README.md) for the full list of build scripts, validation harnesses, Docker deployment, and environment variable reference.

## Key Features

- **Real-time pose estimation** — MediaPipe Pose Landmarker running in-browser or Electron renderer
- **Flexible parameter mapping** — map any landmark axis/distance/angle to any EC2 parameter with custom curves
- **Dual output protocols** — OSC (UDP) and MIDI with live connection indicators
- **Managed engine lifecycle** — auto-start, crash recovery, and log streaming for the bundled EC2 process
- **Desktop & hosted modes** — native Electron app or browser UI with a WebSocket bridge
- **Docker deployment** — production and dev Docker Compose profiles included
- **EC2 profile system** — version-aware parameter profiles with capability indicators
- **Audio bridge controls** — WAV file picker, source selection, recording, device routing
- **Validation automation** — headless smoke tests, B2 parameter matrix, packaged clean-profile checks

## Documentation

| Document | Description |
|----------|-------------|
| [`pose-controller/README.md`](pose-controller/README.md) | Full dev & ops reference |
| [`pose-controller/docs/bridge-api.md`](pose-controller/docs/bridge-api.md) | Bridge HTTP + WebSocket API |
| [`pose-controller/docs/deployment-modes.md`](pose-controller/docs/deployment-modes.md) | Desktop vs hosted vs Docker |
| [`pose-controller/docs/osc-schema.md`](pose-controller/docs/osc-schema.md) | OSC channel schema |
| [`pose-controller/docs/gpl-compliance-checklist.md`](pose-controller/docs/gpl-compliance-checklist.md) | GPL compliance notes |

## Tech Stack

**Renderer:** React 19 · TypeScript · Vite 7 · Zustand · MediaPipe Tasks-Vision  
**Main process:** Electron 40 · Node.js · `osc` (UDP) · `jzz` (MIDI)  
**Bridge:** Express 5 · WebSocket (`ws`)  
**Engine:** EmissionControl2 (C++ / allolib / libsndfile)  
**Packaging:** electron-builder · NSIS / DMG / AppImage

## License

The **pose-controller** application code is released under the [ISC License](pose-controller/package.json).  
**EmissionControl2** is licensed under [GPL-3.0](EmissionControl2/LICENSE). Bundled distributions that include the EC2 engine binary must comply with GPL-3.0 obligations — see the [compliance checklist](pose-controller/docs/gpl-compliance-checklist.md).


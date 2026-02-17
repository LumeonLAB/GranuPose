# Deployment Modes

This project supports two runtime modes from the same codebase.

## 1) Desktop Local Mode

- Runtime: Electron + React renderer.
- Transport: local process path to OSC/MIDI emitters.
- Target: EmissionControl2 running on the same machine.
- Strength: lowest latency and easiest hardware MIDI routing.

## 2) Hosted Web Mode

- Runtime: browser frontend + bridge backend.
- Transport: browser sends normalized control data to bridge over WebSocket/HTTP.
- Bridge responsibility: convert control data to OSC UDP for EC2.
- Strength: remotely hostable UI and multi-user browser access.

## Why Bridge Is Required

Browsers cannot send raw UDP packets directly. EC2 listens on UDP OSC (port `16447` by default), so hosted mode requires a server-side relay:

- Browser -> WebSocket/HTTP -> Bridge
- Bridge -> UDP OSC -> EC2

## Feature Parity Matrix

- Pose tracking and feature extraction: parity across both modes.
- OSC output: parity via bridge in hosted mode.
- MIDI virtual device output: best in desktop mode; hosted mode depends on server-side MIDI environment.
- Camera input: parity, but hosted mode requires HTTPS (except localhost).

## Hosting Guardrails

- Use HTTPS in hosted environments for webcam APIs.
- Restrict CORS to trusted origins (`ALLOWED_ORIGIN`).
- Deploy bridge behind an authenticated network boundary for public hosting.
- Keep bridge and EC2 close on network topology to reduce OSC latency.

## Current Containerized Topology

- `frontend` container: static web app served by Nginx.
- `bridge` container: WebSocket/HTTP ingress + OSC UDP relay.
- `docker-compose.yml`: runs both services for local/prod-like deployment.

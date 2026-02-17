# GranuPose Pose Controller

Desktop and hosted controller for body-driven granular synthesis control.

## Modes

- Desktop mode: Electron renderer + local integrations.
- Hosted mode: Browser UI + bridge service (WebSocket/HTTP to OSC UDP).

## Local Development

- Electron app: `npm run dev`
- Hosted stack (non-container): `npm run dev:hosted`
- Bridge only: `npm run dev:bridge`

## Docker Deployment

- Prod-like stack: `npm run docker:up`
- Dev profile stack: `npm run docker:up:dev`
- Stop stack: `npm run docker:down`

The bridge exposes:

- `GET /health`
- `POST /api/channels`
- `POST /api/channels/batch`
- WebSocket: `/ws`

## Notes

- Browser webcam access requires HTTPS on non-localhost hosts.
- EC2 OSC default target is `127.0.0.1:16447`; in Docker, set `OSC_TARGET_HOST` as needed.
- See `docs/deployment-modes.md` and `docs/bridge-api.md`.

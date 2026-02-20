# Bridge API

Base URL: `http://<bridge-host>:8787`

## Health

- `GET /health`
- Returns bridge and OSC readiness, counters, and runtime config.

## Channel Control

- `POST /api/channels`
- Body:
```json
{ "channel": 1, "value": 0.42 }
```

Channel values are forwarded to OSC using zero-padded addresses:

- `1` -> `/pose/out/01`
- `16` -> `/pose/out/16`

- `POST /api/channels/batch`
- Body:
```json
{
  "channels": [
    { "channel": 1, "value": 0.42 },
    { "channel": 2, "value": 0.75 }
  ]
}
```

See `docs/osc-schema.md` for the canonical channel and trigger schema.

## Raw OSC

- `POST /api/osc`
- Body:
```json
{
  "address": "/filterCenter",
  "args": [{ "type": "f", "value": 1200.0 }]
}
```

- `POST /api/osc/batch`
- Body:
```json
{
  "messages": [
    {
      "address": "/scanSpeed",
      "args": [{ "type": "f", "value": 0.5 }]
    }
  ]
}
```

## WebSocket

- URL: `ws://<bridge-host>:8787/ws`
- Client -> bridge message types accepted:
  - `ping`
  - `channel:set`
  - `channels:set`
  - `osc:send`
  - `osc:batch`

- Bridge -> client push message types:
  - `bridge:hello`
  - `bridge:ack`
  - `bridge:error`
  - `telemetry:scan`

Example:
```json
{
  "type": "channel:set",
  "payload": { "channel": 1, "value": 0.65 }
}
```

Telemetry push example:
```json
{
  "type": "telemetry:scan",
  "payload": {
    "source": "bridge",
    "timestampMs": 1739900000000,
    "playheadNorm": 0.42,
    "scanHeadNorm": 0.33,
    "scanRangeNorm": 0.17,
    "soundFileFrames": 1536000,
    "activeGrainCount": 64,
    "activeGrainIndices": [741233, 741812, 742021],
    "activeGrainNormPositions": [0.4826, 0.4830, 0.4832]
  }
}
```

## Telemetry OSC Ingest

Bridge can ingest engine telemetry from EC2 via UDP OSC and rebroadcast it over WebSocket.

- Environment variables:
  - `TELEMETRY_LISTEN_HOST` (default `0.0.0.0`)
  - `TELEMETRY_LISTEN_PORT` (default `16448`)
  - `TELEMETRY_SCAN_ADDRESS` (default `/ec2/telemetry/scan`)

- Expected OSC args for `TELEMETRY_SCAN_ADDRESS`:
  1. `playheadNorm` (`0..1`)
  2. `scanHeadNorm` (`0..1`)
  3. `scanRangeNorm` (`0..1`)
  4. `soundFileFrames` (int, optional)
  5. `activeGrainIndex[0]` (int frame index)
  6. `activeGrainIndex[1]`
  7. ...

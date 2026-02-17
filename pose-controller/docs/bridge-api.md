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
- Message types accepted:
  - `ping`
  - `channel:set`
  - `channels:set`
  - `osc:send`
  - `osc:batch`

Example:
```json
{
  "type": "channel:set",
  "payload": { "channel": 1, "value": 0.65 }
}
```

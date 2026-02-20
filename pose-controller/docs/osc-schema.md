# OSC Message Schema

This document defines the controller OSC schema used by GranuPose.

## Continuous Output Channels

- Prefix: `/pose/out`
- Channel count: `16` by default, expandable to `32`
- Address format: `/pose/out/01` ... `/pose/out/16`
- Value type: `float`
- Value range: normalized `0.0` to `1.0`

Examples:

- `/pose/out/01` with `0.15`
- `/pose/out/08` with `0.90`
- `/pose/out/16` with `0.42`

## Gesture Trigger Channels

- Prefix: `/pose/trig`
- Address format: `/pose/trig/<gesture-name>`
- Gesture names are lowercase and slug-safe (`[a-z0-9_-]`)
- Value type: `float`
- Typical trigger value: `1.0`

Examples:

- `/pose/trig/hands-together` with `1.0`
- `/pose/trig/right-hand-above-head` with `1.0`

## TypeScript Source of Truth

Schema constants and helpers live in:

- `src/modules/output/oscSchema.ts`

Main exports:

- `OSC_OUTPUT_PREFIX`
- `OSC_GESTURE_TRIGGER_PREFIX`
- `DEFAULT_OUTPUT_CHANNEL_COUNT`
- `MAX_OUTPUT_CHANNEL_COUNT`
- `OutputChannel` type
- `createOutputChannels(...)`
- `formatOutputChannelAddress(...)`
- `formatGestureTriggerAddress(...)`

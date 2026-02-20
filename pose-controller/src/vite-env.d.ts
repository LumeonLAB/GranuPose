/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OUTPUT_MODE?: string;
  readonly VITE_BRIDGE_WS_URL?: string;
  readonly VITE_OUTPUT_CHANNEL_COUNT?: string;
  readonly VITE_OSC_TARGET_HOST?: string;
  readonly VITE_OSC_TARGET_PORT?: string;
  readonly VITE_MIDI_DEVICE_ID?: string;
  readonly VITE_MIDI_CHANNEL?: string;
  readonly VITE_MIDI_CC_START?: string;
  readonly VITE_POSE_DELEGATE?: string;
  readonly VITE_POSE_INFERENCE_FPS?: string;
  readonly VITE_POSE_NEW_FRAME_ONLY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

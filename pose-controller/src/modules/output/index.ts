import {
  BridgeOutputClient,
  type BridgeConnectionStatus,
} from './bridgeOutput';
import {
  createElectronOscOutputClientFromEnv,
  ElectronOscOutputClient,
  type ElectronOscConnectionStatus,
} from './electronOscOutput';
import {
  createMidiOutputClientFromEnv,
  MidiOutputClient,
  type MidiConnectionStatus,
  type MidiOutputDevice,
} from './midiOutput';

export * from './oscSchema';
export * from './ec2Params';
export * from './ec2Profiles';
export * from './bridgeOutput';
export * from './electronOscOutput';
export * from './midiOutput';

export type OutputProtocol = 'osc' | 'midi';
export type OutputConnectionStatus =
  | BridgeConnectionStatus
  | ElectronOscConnectionStatus
  | MidiConnectionStatus;

export type OutputClient = BridgeOutputClient | ElectronOscOutputClient | MidiOutputClient;

export interface OutputClientConfig {
  protocol: OutputProtocol;
  oscTargetHost?: string;
  oscTargetPort?: number;
  midiDeviceId?: string;
  midiChannel?: number;
  midiCcStart?: number;
}

function parsePort(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(1, Math.min(65535, rounded));
}

function parseBoundedInt(rawValue: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
}

export function createOutputClient(config: OutputClientConfig): OutputClient {
  if (config.protocol === 'midi') {
    return createMidiOutputClientFromEnv({
      deviceId: config.midiDeviceId,
      midiChannel: config.midiChannel,
      ccStart: config.midiCcStart,
    });
  }

  const electronClient = createElectronOscOutputClientFromEnv();
  if (electronClient) {
    return new ElectronOscOutputClient({
      targetHost: config.oscTargetHost,
      targetPort: config.oscTargetPort,
    });
  }

  return new BridgeOutputClient({
    wsUrl: import.meta.env.VITE_BRIDGE_WS_URL,
  });
}

export function getDefaultOutputConfig(): OutputClientConfig {
  return {
    protocol: 'osc',
    oscTargetHost: import.meta.env.VITE_OSC_TARGET_HOST || '127.0.0.1',
    oscTargetPort: parsePort(import.meta.env.VITE_OSC_TARGET_PORT, 16447),
    midiDeviceId: import.meta.env.VITE_MIDI_DEVICE_ID || '',
    midiChannel: parseBoundedInt(import.meta.env.VITE_MIDI_CHANNEL, 1, 1, 16),
    midiCcStart: parseBoundedInt(import.meta.env.VITE_MIDI_CC_START, 1, 0, 127),
  };
}

export function isMidiOutputClient(client: OutputClient | null): client is MidiOutputClient {
  return client instanceof MidiOutputClient;
}

export type { MidiOutputDevice };

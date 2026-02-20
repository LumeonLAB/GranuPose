import type {
  ElectronMidiListResponse,
  ElectronMidiOutputDevice,
  ElectronMidiStatusResponse,
} from '../../types';
import {
  createOutputChannels,
  DEFAULT_OUTPUT_CHANNEL_COUNT,
  isOutputChannelNumber,
  MAX_OUTPUT_CHANNEL_COUNT,
  type OutputChannel,
} from './oscSchema';
import type { OscMessage, ScanTelemetryListener } from './bridgeOutput';

export type MidiConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export interface MidiOutputDevice {
  id: string;
  name: string;
  state: MIDIPortDeviceState;
}

type StatusListener = (status: MidiConnectionStatus) => void;
type DeviceListener = (devices: MidiOutputDevice[]) => void;

interface MidiOutputClientOptions {
  deviceId?: string;
  channelCount?: number;
  midiChannel?: number;
  ccStart?: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseMidiChannel(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(1, Math.min(16, rounded));
}

function parseCcStart(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(0, Math.min(127, rounded));
}

function getDefaultChannelCount(): number {
  const fromEnv = Number(import.meta.env.VITE_OUTPUT_CHANNEL_COUNT);
  if (!Number.isFinite(fromEnv)) {
    return DEFAULT_OUTPUT_CHANNEL_COUNT;
  }

  const rounded = Math.trunc(fromEnv);
  return Math.max(1, Math.min(MAX_OUTPUT_CHANNEL_COUNT, rounded));
}

function hasWebMidiSupport(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

function hasElectronMidiApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.granuPose?.midi);
}

function mapElectronOutputs(outputs: ElectronMidiOutputDevice[]): MidiOutputDevice[] {
  return outputs.map((output) => ({
    id: output.id,
    name: output.name,
    state: output.state,
  }));
}

function mapWebOutput(output: MIDIOutput): MidiOutputDevice {
  return {
    id: output.id,
    name: output.name || `MIDI Output ${output.id}`,
    state: output.state,
  };
}

export class MidiOutputClient {
  private readonly channelCount: number;
  private readonly midiChannel: number;
  private readonly ccStart: number;
  private preferredDeviceId: string;
  private closed: boolean;
  private status: MidiConnectionStatus;
  private readonly statusListeners: Set<StatusListener>;
  private readonly deviceListeners: Set<DeviceListener>;
  private midiAccess: MIDIAccess | null;
  private midiOutput: MIDIOutput | null;
  private electronOutputs: MidiOutputDevice[];
  private mode: 'electron' | 'web' | null;

  constructor(options: MidiOutputClientOptions = {}) {
    this.channelCount = options.channelCount ?? getDefaultChannelCount();
    this.midiChannel = parseMidiChannel(options.midiChannel, 1);
    this.ccStart = parseCcStart(options.ccStart, 1);
    this.preferredDeviceId = options.deviceId ?? '';
    this.closed = false;
    this.status = 'disconnected';
    this.statusListeners = new Set();
    this.deviceListeners = new Set();
    this.midiAccess = null;
    this.midiOutput = null;
    this.electronOutputs = [];
    this.mode = null;
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribeDevices(listener: DeviceListener): () => void {
    this.deviceListeners.add(listener);
    listener(this.getAvailableOutputs());
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  subscribeScanTelemetry(listener: ScanTelemetryListener): () => void {
    void listener;
    return () => {};
  }

  private setStatus(nextStatus: MidiConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }

    this.status = nextStatus;
    this.statusListeners.forEach((listener) => listener(nextStatus));
  }

  private emitDevices(): void {
    const devices = this.getAvailableOutputs();
    this.deviceListeners.forEach((listener) => listener(devices));
  }

  private getWebOutputs(): MidiOutputDevice[] {
    if (!this.midiAccess) {
      return [];
    }

    return Array.from(this.midiAccess.outputs.values()).map((output) => mapWebOutput(output));
  }

  getAvailableOutputs(): MidiOutputDevice[] {
    if (this.mode === 'electron') {
      return [...this.electronOutputs];
    }

    return this.getWebOutputs();
  }

  private getPreferredOutput(): MIDIOutput | null {
    if (!this.midiAccess) {
      return null;
    }

    if (this.preferredDeviceId) {
      const selected = this.midiAccess.outputs.get(this.preferredDeviceId);
      if (selected) {
        return selected;
      }
    }

    const first = this.midiAccess.outputs.values().next();
    return first.done ? null : first.value;
  }

  private refreshWebOutputBinding(): void {
    const output = this.getPreferredOutput();
    this.midiOutput = output;
    this.emitDevices();

    if (!output || output.state !== 'connected') {
      this.setStatus('disconnected');
      return;
    }

    void output
      .open()
      .then(() => {
        if (this.closed) {
          return;
        }
        this.setStatus('connected');
      })
      .catch(() => {
        if (this.closed) {
          return;
        }
        this.setStatus('disconnected');
      });
  }

  private async connectElectronMidi(): Promise<void> {
    const midiApi = window.granuPose?.midi;
    if (!midiApi) {
      this.setStatus('disabled');
      this.electronOutputs = [];
      this.emitDevices();
      return;
    }

    this.mode = 'electron';
    this.setStatus('connecting');

    try {
      const status = await midiApi.configure({
        deviceId: this.preferredDeviceId,
        midiChannel: this.midiChannel,
        ccStart: this.ccStart,
      });
      const outputsResult = await midiApi.listOutputs();
      this.applyElectronOutputs(outputsResult);
      this.applyElectronStatus(status);
    } catch {
      if (this.closed) {
        return;
      }
      this.setStatus('disconnected');
      this.electronOutputs = [];
      this.emitDevices();
    }
  }

  private applyElectronOutputs(result: ElectronMidiListResponse): void {
    this.electronOutputs = result.ok ? mapElectronOutputs(result.outputs) : [];
    this.emitDevices();
  }

  private applyElectronStatus(status: ElectronMidiStatusResponse): void {
    if (this.closed) {
      return;
    }

    if (status.deviceId) {
      this.preferredDeviceId = status.deviceId;
    }

    this.setStatus(status.ok && status.midiReady ? 'connected' : 'disconnected');
  }

  private async connectWebMidi(): Promise<void> {
    if (!hasWebMidiSupport()) {
      this.mode = 'web';
      this.setStatus('disabled');
      this.emitDevices();
      return;
    }

    this.mode = 'web';
    this.setStatus('connecting');

    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      this.midiAccess.onstatechange = () => {
        if (this.closed) {
          return;
        }
        this.refreshWebOutputBinding();
      };

      this.refreshWebOutputBinding();
    } catch {
      if (this.closed) {
        return;
      }
      this.setStatus('disconnected');
      this.emitDevices();
    }
  }

  async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (hasElectronMidiApi()) {
      await this.connectElectronMidi();
      return;
    }

    await this.connectWebMidi();
  }

  sendChannel(channel: number, value: number): void {
    if (this.closed) {
      return;
    }

    if (!isOutputChannelNumber(channel, this.channelCount)) {
      return;
    }

    if (this.mode === 'electron') {
      const midiApi = window.granuPose?.midi;
      if (!midiApi) {
        this.setStatus('disabled');
        return;
      }

      void midiApi
        .sendChannel({
          channel,
          value: clamp01(value),
        })
        .then((result) => {
          if (this.closed) {
            return;
          }
          this.setStatus(result.ok ? 'connected' : 'disconnected');
        })
        .catch(() => {
          if (this.closed) {
            return;
          }
          this.setStatus('disconnected');
        });

      return;
    }

    if (!this.midiOutput) {
      this.setStatus('disconnected');
      return;
    }

    const controller = Math.max(0, Math.min(127, this.ccStart + (channel - 1)));
    const ccValue = Math.round(clamp01(value) * 127);
    const status = 0xb0 + (this.midiChannel - 1);

    try {
      this.midiOutput.send([status, controller, ccValue]);
      this.setStatus('connected');
    } catch {
      this.setStatus('disconnected');
    }
  }

  sendOscMessage(message: OscMessage): void {
    // OSC passthrough is intentionally unavailable in MIDI mode.
    void message;
  }

  getOutputChannels(): OutputChannel[] {
    return createOutputChannels(this.channelCount);
  }

  close(): void {
    this.closed = true;

    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
    }

    if (this.midiOutput) {
      void this.midiOutput.close().catch(() => undefined);
    }

    this.mode = null;
    this.electronOutputs = [];
    this.midiOutput = null;
    this.midiAccess = null;
    this.setStatus('disconnected');
    this.emitDevices();
  }
}

export function createMidiOutputClientFromEnv(options: MidiOutputClientOptions = {}): MidiOutputClient {
  return new MidiOutputClient({
    deviceId: options.deviceId ?? import.meta.env.VITE_MIDI_DEVICE_ID ?? '',
    midiChannel: options.midiChannel ?? Number(import.meta.env.VITE_MIDI_CHANNEL || 1),
    ccStart: options.ccStart ?? Number(import.meta.env.VITE_MIDI_CC_START || 1),
    channelCount: options.channelCount ?? getDefaultChannelCount(),
  });
}

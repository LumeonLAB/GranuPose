import {
  createOutputChannels,
  DEFAULT_OUTPUT_CHANNEL_COUNT,
  isOutputChannelNumber,
  MAX_OUTPUT_CHANNEL_COUNT,
  type OutputChannel,
} from './oscSchema';
import type { Ec2ScanTelemetry, OscMessage, ScanTelemetryListener } from './bridgeOutput';

export type ElectronOscConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected';

type StatusListener = (status: ElectronOscConnectionStatus) => void;

interface ElectronOscOutputClientOptions {
  targetHost?: string;
  targetPort?: number;
  channelCount?: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNormalizedNumber(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  return clamp01(parsed);
}

function parsePositiveIntOrNull(value: unknown): number | null {
  const parsed = parseFiniteNumber(value);
  if (parsed == null) {
    return null;
  }
  const rounded = Math.trunc(parsed);
  if (rounded <= 0) {
    return null;
  }
  return rounded;
}

function parseNumericArray(value: unknown, maxLength: number): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: number[] = [];
  for (const item of value) {
    const numeric = parseFiniteNumber(item);
    if (numeric == null) {
      continue;
    }
    parsed.push(numeric);
    if (parsed.length >= maxLength) {
      break;
    }
  }
  return parsed;
}

function parseElectronTelemetryPayload(payload: unknown): Ec2ScanTelemetry | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const playheadNorm = parseNormalizedNumber(record.playheadNorm);
  const scanHeadNorm = parseNormalizedNumber(record.scanHeadNorm);
  const scanRangeNorm = parseNormalizedNumber(record.scanRangeNorm);
  if (playheadNorm == null || scanHeadNorm == null || scanRangeNorm == null) {
    return null;
  }

  const soundFileFrames = parsePositiveIntOrNull(record.soundFileFrames);
  const activeGrainIndices = parseNumericArray(record.activeGrainIndices, 2048).map((value) =>
    Math.max(0, Math.trunc(value)),
  );
  const providedNorms = parseNumericArray(record.activeGrainNormPositions, 2048).map((value) =>
    clamp01(value),
  );
  const activeGrainNormPositions =
    providedNorms.length > 0
      ? providedNorms
      : activeGrainIndices.map((index) =>
          soundFileFrames && soundFileFrames > 1 ? clamp01(index / soundFileFrames) : clamp01(index),
        );

  return {
    source: 'electron',
    receivedAtMs: Date.now(),
    playheadNorm,
    scanHeadNorm,
    scanRangeNorm,
    soundFileFrames,
    activeGrainCount: activeGrainIndices.length,
    activeGrainIndices,
    activeGrainNormPositions,
  };
}

function parsePort(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(1, Math.min(65535, rounded));
}

function getDefaultTargetHost(): string {
  return import.meta.env.VITE_OSC_TARGET_HOST || '127.0.0.1';
}

function getDefaultTargetPort(): number {
  return parsePort(import.meta.env.VITE_OSC_TARGET_PORT, 16447);
}

function getDefaultChannelCount(): number {
  const fromEnv = Number(import.meta.env.VITE_OUTPUT_CHANNEL_COUNT);
  if (!Number.isFinite(fromEnv)) {
    return DEFAULT_OUTPUT_CHANNEL_COUNT;
  }

  const rounded = Math.trunc(fromEnv);
  return Math.max(1, Math.min(MAX_OUTPUT_CHANNEL_COUNT, rounded));
}

export function hasElectronOscApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.granuPose?.osc);
}

export class ElectronOscOutputClient {
  private readonly targetHost: string;
  private readonly targetPort: number;
  private readonly channelCount: number;
  private closed: boolean;
  private status: ElectronOscConnectionStatus;
  private readonly listeners: Set<StatusListener>;

  constructor(options: ElectronOscOutputClientOptions = {}) {
    this.targetHost = options.targetHost || getDefaultTargetHost();
    this.targetPort = options.targetPort ?? getDefaultTargetPort();
    this.channelCount = options.channelCount ?? getDefaultChannelCount();
    this.closed = false;
    this.status = 'disconnected';
    this.listeners = new Set();
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeScanTelemetry(listener: ScanTelemetryListener): () => void {
    const telemetryApi = window.granuPose?.telemetry;
    if (!telemetryApi) {
      return () => {};
    }

    return telemetryApi.subscribeScan((payload) => {
      const parsed = parseElectronTelemetryPayload(payload);
      if (!parsed) {
        return;
      }
      listener(parsed);
    });
  }

  private setStatus(nextStatus: ElectronOscConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }

    this.status = nextStatus;
    this.listeners.forEach((listener) => listener(nextStatus));
  }

  async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    const oscApi = window.granuPose?.osc;
    if (!oscApi) {
      this.setStatus('disabled');
      return;
    }

    this.setStatus('connecting');

    try {
      const result = await oscApi.configure({
        targetHost: this.targetHost,
        targetPort: this.targetPort,
      });

      if (this.closed) {
        return;
      }

      this.setStatus(result.ok ? 'connected' : 'disconnected');
    } catch {
      if (this.closed) {
        return;
      }
      this.setStatus('disconnected');
    }
  }

  sendChannel(channel: number, value: number): void {
    if (this.closed) {
      return;
    }

    if (!isOutputChannelNumber(channel, this.channelCount)) {
      return;
    }

    const oscApi = window.granuPose?.osc;
    if (!oscApi) {
      this.setStatus('disabled');
      return;
    }

    void oscApi
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
  }

  sendOscMessage(message: OscMessage): void {
    if (this.closed) {
      return;
    }

    const address = message.address.trim();
    if (!address.startsWith('/')) {
      return;
    }

    const oscApi = window.granuPose?.osc;
    if (!oscApi) {
      this.setStatus('disabled');
      return;
    }

    void oscApi
      .sendMessage({
        address,
        args: message.args ?? [],
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
  }

  getOutputChannels(): OutputChannel[] {
    return createOutputChannels(this.channelCount);
  }

  close(): void {
    this.closed = true;
    this.setStatus('disconnected');
  }
}

export function createElectronOscOutputClientFromEnv(): ElectronOscOutputClient | null {
  if (!hasElectronOscApi()) {
    return null;
  }

  return new ElectronOscOutputClient({
    targetHost: getDefaultTargetHost(),
    targetPort: getDefaultTargetPort(),
    channelCount: getDefaultChannelCount(),
  });
}

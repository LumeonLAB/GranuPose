export const OSC_OUTPUT_PREFIX = '/pose/out';
export const OSC_GESTURE_TRIGGER_PREFIX = '/pose/trig';

export const DEFAULT_OUTPUT_CHANNEL_COUNT = 16;
export const MAX_OUTPUT_CHANNEL_COUNT = 32;
export const OUTPUT_VALUE_MIN = 0;
export const OUTPUT_VALUE_MAX = 1;

export interface OutputChannel {
  id: string;
  channel: number;
  label: string;
  address: string;
  valueMin: typeof OUTPUT_VALUE_MIN;
  valueMax: typeof OUTPUT_VALUE_MAX;
}

function normalizeChannelCount(channelCount: number): number {
  const rounded = Math.trunc(channelCount);
  return Math.max(1, Math.min(MAX_OUTPUT_CHANNEL_COUNT, rounded));
}

export function isOutputChannelNumber(channel: number, channelCount = DEFAULT_OUTPUT_CHANNEL_COUNT): boolean {
  if (!Number.isInteger(channel)) {
    return false;
  }

  const maxChannel = normalizeChannelCount(channelCount);
  return channel >= 1 && channel <= maxChannel;
}

export function formatOutputChannelId(channel: number): string {
  return `out-${String(channel).padStart(2, '0')}`;
}

export function formatOutputChannelAddress(channel: number, prefix = OSC_OUTPUT_PREFIX): string {
  return `${prefix}/${String(channel).padStart(2, '0')}`;
}

export function createOutputChannels(channelCount = DEFAULT_OUTPUT_CHANNEL_COUNT): OutputChannel[] {
  const safeCount = normalizeChannelCount(channelCount);
  const channels: OutputChannel[] = [];

  for (let channel = 1; channel <= safeCount; channel += 1) {
    channels.push({
      id: formatOutputChannelId(channel),
      channel,
      label: `Output ${String(channel).padStart(2, '0')}`,
      address: formatOutputChannelAddress(channel),
      valueMin: OUTPUT_VALUE_MIN,
      valueMax: OUTPUT_VALUE_MAX,
    });
  }

  return channels;
}

function sanitizeGestureName(gestureName: string): string {
  const normalized = gestureName.trim().toLowerCase();
  return normalized.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function formatGestureTriggerAddress(
  gestureName: string,
  prefix = OSC_GESTURE_TRIGGER_PREFIX,
): string {
  const safeGesture = sanitizeGestureName(gestureName) || 'unknown';
  return `${prefix}/${safeGesture}`;
}

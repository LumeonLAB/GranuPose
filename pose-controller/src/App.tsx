import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type {
  PoseLandmarker,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import {
  createDefaultPoseToEc2Mappings,
  evaluatePoseToEc2Mappings,
  normalizePoseMappingCombiner,
  normalizePoseMappingTransformChain,
  POSE_MAPPING_COMBINER_OPTIONS,
  POSE_MAPPING_CURVE_OPTIONS,
  POSE_SIGNAL_DEFINITIONS,
  type PoseMappingCombiner,
  type PoseMappingCurve,
  type PoseSignalId,
  type PoseToEc2Mapping,
} from './modules/mapping';
import {
  createOutputClient,
  getDefaultOutputConfig,
  getDefaultProfileIdForVersion,
  getEc2ParamById,
  getProfileById,
  getProfilesForVersion,
  isEc2ParamId,
  isMidiOutputClient,
  listEc2ParamIds,
  type Ec2ParamId,
  type Ec2ParamDefinition,
  type Ec2ScanTelemetry,
  type Ec2Version,
  type MidiOutputDevice,
  type OscArg,
  type OutputClient,
  type OutputConnectionStatus,
  type OutputProtocol,
} from './modules/output';
import {
  computeTrackingConfidence,
  drawPoseSkeleton,
  getPoseLandmarker,
  getPoseRuntimeConfig,
} from './modules/pose';
import { drawHud } from './modules/ui';
import { drawVideoFrame, useCamera } from './modules/video';
import type { ResolutionPreset, TargetFps } from './modules/video';
import type {
  ElectronAudioRecordingEntry,
  ElectronEngineLogEntry,
  ElectronEngineStatusResponse,
  ElectronHelloTelemetryPayload,
  HudMetrics,
} from './types';

const RESOLUTION_OPTIONS: ResolutionPreset[] = ['480p', '720p', '1080p'];
const FPS_OPTIONS: TargetFps[] = [30, 60];
const OUTPUT_SETTINGS_STORAGE_KEY = 'granupose.output.settings.v1';
const MAPPING_SETTINGS_STORAGE_KEY = 'granupose.mapping.settings.v2';
const MAPPING_SETTINGS_STORAGE_KEY_LEGACY = 'granupose.mapping.settings.v1';
const AUDIO_BRIDGE_SETTINGS_STORAGE_KEY = 'granupose.audio.bridge.settings.v1';
const DEFAULT_EC2_VERSION: Ec2Version = 'v1.3+';
const DEFAULT_EC2_PROFILE_ID = getDefaultProfileIdForVersion(DEFAULT_EC2_VERSION);
const MANAGED_ENGINE_OSC_HOST = '127.0.0.1';
const MANAGED_ENGINE_OSC_PORT = 16447;
const ENGINE_LOG_TAIL_LIMIT = 80;
const STARTUP_AUDIT_TRAIL_LIMIT = 24;
const MANAGED_ENGINE_HELLO_TIMEOUT_MS = 4000;
const MANAGED_ENGINE_HELLO_SKEW_MS = 1000;
const MAPPING_SEND_EPSILON = 0.001;
const MAPPING_SEND_KEEPALIVE_MS = 250;
const OUTPUT_WAVEFORM_POINT_COUNT = 180;
const OUTPUT_WAVEFORM_DRAW_INTERVAL_MS = 33;
const MAX_ACTIVE_GRAINS = 2048;
const EMPTY_WAVEFORM_SAMPLES = Array.from({ length: OUTPUT_WAVEFORM_POINT_COUNT }, () => 0);
const SCAN_REGION_LABELS = ['R1', 'R2', 'R3', 'R4'] as const;
const SCAN_REGION_RANGE_LABELS = ['0-25%', '25-50%', '50-75%', '75-100%'] as const;
type ScanRegionIndex = 0 | 1 | 2 | 3;
type ScanRegionTuple = [number, number, number, number];
const MATRIX_PARAM_IDS: ReadonlyArray<Ec2ParamId> = [
  'grainRate',
  'grainDuration',
  'scanSpeed',
  'asynchronicity',
  'intermittency',
  'playbackRate',
  'scanBegin',
  'scanRange',
];

const MATRIX_PARAM_LABELS: Partial<Record<Ec2ParamId, string>> = {
  grainDuration: 'Grain Duration Control',
};
const UNASSIGNED_MAPPING_OPTION_VALUE = '';
const DEFAULT_MATRIX_PARAM_ID: Ec2ParamId = 'grainRate';
const DEFAULT_POSE_SIGNAL_ID: PoseSignalId = 'rightWristY';

const POSE_MAPPING_STORAGE_VERSION = 2 as const;

const DEFAULT_OUTPUT_CONFIG = getDefaultOutputConfig();
const AMPLITUDE_PARAM = getEc2ParamById('amplitude');
const MASTER_AMPLITUDE_MIN_DB = AMPLITUDE_PARAM.defaultRange[0];
const MASTER_AMPLITUDE_MAX_DB = AMPLITUDE_PARAM.defaultRange[1];
const MASTER_AMPLITUDE_DEFAULT_DB = AMPLITUDE_PARAM.defaultValue;

interface OutputSettings {
  protocol: OutputProtocol;
  oscTargetHost: string;
  oscTargetPort: number;
  oscParamPrefix: string;
  midiDeviceId: string;
  midiChannel: number;
  midiCcStart: number;
  ec2Version: Ec2Version;
  ec2ProfileId: string;
  managedLocalEngine: boolean;
  managedStartupTransportAutostart: boolean;
}

const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  protocol: DEFAULT_OUTPUT_CONFIG.protocol,
  oscTargetHost: DEFAULT_OUTPUT_CONFIG.oscTargetHost || '127.0.0.1',
  oscTargetPort: DEFAULT_OUTPUT_CONFIG.oscTargetPort || 16447,
  oscParamPrefix: '',
  midiDeviceId: DEFAULT_OUTPUT_CONFIG.midiDeviceId || '',
  midiChannel: DEFAULT_OUTPUT_CONFIG.midiChannel || 1,
  midiCcStart: DEFAULT_OUTPUT_CONFIG.midiCcStart || 1,
  ec2Version: DEFAULT_EC2_VERSION,
  ec2ProfileId: DEFAULT_EC2_PROFILE_ID,
  managedLocalEngine: true,
  managedStartupTransportAutostart: false,
};

interface AudioBridgeSettings {
  soundFilePath: string;
  soundFileIndex: number;
  soundSources: string[];
  selectedSoundSourcePath: string;
  playheadDirection: PlayheadDirectionMode;
  recordFileName: string;
  outputFolder: string;
  masterAmplitudeDb: number;
  audioOutputDeviceId: string;
  audioOutputDeviceName: string;
}

type PlayheadDirectionMode = 'forward' | 'reverse' | 'random';

const PLAYHEAD_DIRECTION_OPTIONS: ReadonlyArray<{
  value: PlayheadDirectionMode;
  label: string;
}> = [
  { value: 'forward', label: 'Forward' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'random', label: 'Random Jumping' },
];

const DEFAULT_AUDIO_BRIDGE_SETTINGS: AudioBridgeSettings = {
  soundFilePath: '',
  soundFileIndex: 1,
  soundSources: [],
  selectedSoundSourcePath: '',
  playheadDirection: 'forward',
  recordFileName: 'pose_take.wav',
  outputFolder: '',
  masterAmplitudeDb: MASTER_AMPLITUDE_DEFAULT_DB,
  audioOutputDeviceId: '',
  audioOutputDeviceName: '',
};

interface FpsCounter {
  frames: number;
  fps: number;
  lastMs: number;
}

interface SendRateTracker {
  count: number;
  lastMs: number;
}

interface MappingSendState {
  value: number;
  sentAtMs: number;
}

interface StoredPoseMappingPreset {
  version: typeof POSE_MAPPING_STORAGE_VERSION;
  savedAt?: string;
  mappings: PoseToEc2Mapping[];
}

interface AudioOutputDeviceOption {
  id: string;
  label: string;
  ec2DeviceName: string;
}

type StartupAuditEvent =
  | 'engine_start_requested'
  | 'engine_running'
  | 'hello_received'
  | 'hello_timeout_fallback'
  | 'startup_sync_applied'
  | 'startup_ready';

const DEFAULT_HUD_METRICS: HudMetrics = {
  confidence: 0,
  inferenceMs: 0,
  poseFps: 0,
  renderFps: 0,
};
const DEFAULT_POSE_RUNTIME_CONFIG = getPoseRuntimeConfig();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizePathForCompare(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function getDisplayNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || path;
}

function getDirectoryFromPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return '';
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (separatorIndex <= 0) {
    return '';
  }

  return trimmed.slice(0, separatorIndex);
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function parseRecordingPathFromEngineLine(line: string): string {
  const match = /record\s+[01]\s+path\s+(.+)$/i.exec(line);
  return match?.[1]?.trim() || '';
}

function isPlayheadDirectionMode(value: string): value is PlayheadDirectionMode {
  return value === 'forward' || value === 'reverse' || value === 'random';
}

function upsertSoundSourceList(current: string[], nextPath: string): string[] {
  const trimmed = nextPath.trim();
  if (!trimmed) {
    return current;
  }

  const normalized = normalizePathForCompare(trimmed);
  const deduped: string[] = [];

  for (const sourcePath of current) {
    const sourceTrimmed = sourcePath.trim();
    if (!sourceTrimmed) {
      continue;
    }

    const sourceNormalized = normalizePathForCompare(sourceTrimmed);
    if (sourceNormalized === normalized) {
      continue;
    }

    if (!deduped.some((existing) => normalizePathForCompare(existing) === sourceNormalized)) {
      deduped.push(sourceTrimmed);
    }
  }

  deduped.push(trimmed);
  return deduped.slice(0, 64);
}

function resolveSoundSourceIndex(soundSources: string[], selectedPath: string): number {
  const normalized = normalizePathForCompare(selectedPath);
  const index = soundSources.findIndex((source) => normalizePathForCompare(source) === normalized);
  return index >= 0 ? index + 1 : 1;
}

function createDefaultEc2ParamSnapshot(): Record<Ec2ParamId, number> {
  const result = {} as Record<Ec2ParamId, number>;
  for (const paramId of listEc2ParamIds()) {
    result[paramId] = getEc2ParamById(paramId).defaultValue;
  }
  return result;
}

function toNormalizedAmplitudeFromDb(amplitudeDb: number): number {
  const bounded = clamp(amplitudeDb, -60, 24);
  return clamp01((bounded + 60) / 84);
}

interface GrainActivityEstimate {
  activeGrains: number;
  grainsPerSecond: number;
  density: number;
}

interface ScanSegment {
  startNorm: number;
  endNorm: number;
}

interface ScanGrainTrace {
  positionNorm: number;
  regionIndex: ScanRegionIndex;
  ageSeconds: number;
  ttlSeconds: number;
  jitter: number;
}

interface ScanTelemetrySnapshot {
  source: 'estimated' | 'engine';
  telemetryAgeMs: number;
  playheadNorm: number;
  scanHeadNorm: number;
  scanRangeNorm: number;
  activeGrainCount: number;
  dominantRegion: ScanRegionIndex;
  regionCounts: ScanRegionTuple;
  regionLevels: ScanRegionTuple;
}

const DEFAULT_SCAN_TELEMETRY: ScanTelemetrySnapshot = {
  source: 'estimated',
  telemetryAgeMs: 0,
  playheadNorm: 0,
  scanHeadNorm: 0,
  scanRangeNorm: 0,
  activeGrainCount: 0,
  dominantRegion: 0,
  regionCounts: [0, 0, 0, 0],
  regionLevels: [0, 0, 0, 0],
};

type WebkitAudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const audioWindow = window as WebkitAudioWindow;
  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null;
}

function buildWaveformPreviewSamples(audioBuffer: AudioBuffer, pointCount: number): number[] {
  const totalSamples = Math.max(0, audioBuffer.length);
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const safePointCount = Math.max(16, Math.trunc(pointCount));
  if (totalSamples <= 0) {
    return Array.from({ length: safePointCount }, () => 0);
  }

  const channels = Array.from({ length: channelCount }, (_unused, channelIndex) =>
    audioBuffer.getChannelData(channelIndex),
  );
  const samplesPerPoint = Math.max(1, Math.floor(totalSamples / safePointCount));
  const preview = Array.from({ length: safePointCount }, () => 0);

  for (let pointIndex = 0; pointIndex < safePointCount; pointIndex += 1) {
    const start = pointIndex * samplesPerPoint;
    const end =
      pointIndex === safePointCount - 1
        ? totalSamples
        : Math.min(totalSamples, start + samplesPerPoint);

    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      let mixed = 0;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        mixed += channels[channelIndex]?.[sampleIndex] ?? 0;
      }
      mixed /= channelCount;
      if (Math.abs(mixed) > Math.abs(peak)) {
        peak = mixed;
      }
    }

    preview[pointIndex] = peak;
  }

  let maxAbs = 0;
  for (const value of preview) {
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }

  if (maxAbs <= 0) {
    return preview;
  }

  return preview.map((value) => value / maxAbs);
}

function decodeBase64ToArrayBuffer(base64Data: string): ArrayBuffer {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function decodeWaveformPreviewSamples(
  arrayBuffer: ArrayBuffer,
  pointCount: number,
): Promise<number[] | null> {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    return null;
  }

  const context = new AudioContextConstructor();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    return buildWaveformPreviewSamples(decoded, pointCount);
  } catch {
    return null;
  } finally {
    void context.close().catch(() => {});
  }
}

function estimateGrainActivity(params: Record<Ec2ParamId, number>): GrainActivityEstimate {
  const grainRate = Math.max(0, params.grainRate);
  const streams = Math.max(1, params.streams);
  const intermittency = clamp01(params.intermittency);
  const grainDurationSeconds = Math.max(0.001, params.grainDuration / 1000);
  const grainsPerSecond = grainRate * streams * (1 - intermittency * 0.9);
  const estimatedActive = Math.round(grainsPerSecond * grainDurationSeconds * 24);
  const activeGrains = Math.max(0, Math.min(MAX_ACTIVE_GRAINS, estimatedActive));

  return {
    activeGrains,
    grainsPerSecond,
    density: clamp01(activeGrains / MAX_ACTIVE_GRAINS),
  };
}

const DEFAULT_EC2_PARAM_SNAPSHOT = createDefaultEc2ParamSnapshot();

function drawScanDisplayCanvas(
  canvas: HTMLCanvasElement,
  samples: ReadonlyArray<number>,
  hasWaveformSource: boolean,
  amplitudeNorm: number,
  scanSegments: ReadonlyArray<ScanSegment>,
  scanHeadNorm: number,
  playheadNorm: number,
  grainTraces: ReadonlyArray<ScanGrainTrace>,
  regionLevels: ScanRegionTuple,
): void {
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  const displayWidth = Math.max(1, Math.floor(canvas.clientWidth));
  const displayHeight = Math.max(1, Math.floor(canvas.clientHeight));
  const devicePixelRatio = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const backingWidth = displayWidth * devicePixelRatio;
  const backingHeight = displayHeight * devicePixelRatio;

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, displayWidth, displayHeight);

  const topHeight = Math.floor(displayHeight * 0.72);
  const regionY = topHeight + 8;
  const regionHeight = Math.max(14, displayHeight - regionY - 6);
  const regionWidth = displayWidth / 4;
  const regionColorRgb = ['111, 205, 255', '114, 236, 175', '255, 205, 116', '255, 154, 128'] as const;

  const panelGradient = context.createLinearGradient(0, 0, 0, displayHeight);
  panelGradient.addColorStop(0, '#050910');
  panelGradient.addColorStop(1, '#060d16');
  context.fillStyle = panelGradient;
  context.fillRect(0, 0, displayWidth, displayHeight);

  context.strokeStyle = 'rgba(160, 190, 230, 0.18)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, topHeight * 0.5);
  context.lineTo(displayWidth, topHeight * 0.5);
  context.moveTo(0, topHeight * 0.2);
  context.lineTo(displayWidth, topHeight * 0.2);
  context.moveTo(0, topHeight * 0.8);
  context.lineTo(displayWidth, topHeight * 0.8);
  for (let regionIndex = 1; regionIndex < 4; regionIndex += 1) {
    const x = regionWidth * regionIndex;
    context.moveTo(x, 0);
    context.lineTo(x, displayHeight);
  }
  context.stroke();

  context.fillStyle = 'rgba(82, 157, 240, 0.2)';
  for (const segment of scanSegments) {
    const startX = segment.startNorm * displayWidth;
    const endX = segment.endNorm * displayWidth;
    if (endX <= startX) {
      continue;
    }
    context.fillRect(startX, 0, endX - startX, topHeight);
  }

  const wrappedScanHead = wrap01(scanHeadNorm);
  const wrappedPlayhead = wrap01(playheadNorm);
  const scanHeadX = wrappedScanHead * displayWidth;
  const playheadX = wrappedPlayhead * displayWidth;

  context.strokeStyle = 'rgba(92, 190, 255, 0.9)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(scanHeadX, 0);
  context.lineTo(scanHeadX, topHeight);
  context.stroke();

  context.strokeStyle = 'rgba(255, 246, 221, 0.95)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, topHeight);
  context.stroke();

  context.fillStyle = 'rgba(255, 246, 221, 0.88)';
  context.beginPath();
  context.moveTo(playheadX, topHeight + 1);
  context.lineTo(playheadX - 5, topHeight + 7);
  context.lineTo(playheadX + 5, topHeight + 7);
  context.closePath();
  context.fill();

  if (hasWaveformSource) {
    const glowAlpha = 0.3 + amplitudeNorm * 0.6;
    context.strokeStyle = `rgba(109, 214, 154, ${glowAlpha.toFixed(3)})`;
    context.lineWidth = 2;
    context.beginPath();

    for (let index = 0; index < samples.length; index += 1) {
      const x = (index / Math.max(1, samples.length - 1)) * displayWidth;
      const sampleValue = samples[index] ?? 0;
      const y = topHeight * 0.5 - sampleValue * (topHeight * 0.44);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.stroke();
  } else {
    const baselineY = topHeight * 0.5;
    context.strokeStyle = 'rgba(131, 170, 214, 0.45)';
    context.lineWidth = 1.5;
    context.setLineDash([6, 4]);
    context.beginPath();
    context.moveTo(0, baselineY);
    context.lineTo(displayWidth, baselineY);
    context.stroke();
    context.setLineDash([]);

    context.font = '11px Menlo, Consolas, monospace';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(190, 213, 244, 0.74)';
    context.fillText('No WAV source loaded', 8, Math.max(10, baselineY - 10));
  }

  for (const trace of grainTraces) {
    const life = clamp01(1 - trace.ageSeconds / trace.ttlSeconds);
    if (life <= 0) {
      continue;
    }

    const x = wrap01(trace.positionNorm) * displayWidth;
    const y = 6 + trace.jitter * Math.max(8, topHeight - 14);
    const alpha = 0.16 + life * 0.82;
    context.strokeStyle = `rgba(${regionColorRgb[trace.regionIndex]}, ${alpha.toFixed(3)})`;
    context.lineWidth = 1 + life * 1.4;
    context.beginPath();
    context.moveTo(x, y - 4);
    context.lineTo(x, y + 4);
    context.stroke();
  }

  context.font = '11px Menlo, Consolas, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'middle';

  for (let regionIndex = 0; regionIndex < 4; regionIndex += 1) {
    const x = regionWidth * regionIndex + 5;
    const barWidth = Math.max(8, regionWidth - 10);
    const level = clamp01(regionLevels[regionIndex as ScanRegionIndex]);
    context.fillStyle = 'rgba(8, 16, 28, 0.88)';
    context.fillRect(x, regionY, barWidth, regionHeight);
    context.fillStyle = `rgba(${regionColorRgb[regionIndex as ScanRegionIndex]}, 0.62)`;
    context.fillRect(x, regionY, barWidth * level, regionHeight);
    context.strokeStyle = 'rgba(163, 197, 236, 0.2)';
    context.lineWidth = 1;
    context.strokeRect(x + 0.5, regionY + 0.5, barWidth - 1, regionHeight - 1);
    context.fillStyle = 'rgba(212, 230, 249, 0.78)';
    context.fillText(SCAN_REGION_LABELS[regionIndex as ScanRegionIndex], x + 5, regionY + regionHeight / 2);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wrap01(value: number): number {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

function getScanSegments(scanHeadNorm: number, scanRangeNorm: number): ScanSegment[] {
  const startNorm = wrap01(scanHeadNorm);
  const rangeNorm = clamp(scanRangeNorm, 0.001, 1);
  if (rangeNorm >= 0.999) {
    return [{ startNorm: 0, endNorm: 1 }];
  }

  const endNorm = startNorm + rangeNorm;
  if (endNorm <= 1) {
    return [{ startNorm, endNorm }];
  }

  return [
    { startNorm, endNorm: 1 },
    { startNorm: 0, endNorm: endNorm - 1 },
  ];
}

function getScanRegionIndex(positionNorm: number): ScanRegionIndex {
  const normalized = clamp01(positionNorm);
  if (normalized < 0.25) {
    return 0;
  }
  if (normalized < 0.5) {
    return 1;
  }
  if (normalized < 0.75) {
    return 2;
  }
  return 3;
}

function getDominantScanRegion(regionLevels: ScanRegionTuple): ScanRegionIndex {
  let dominantIndex: ScanRegionIndex = 0;
  let dominantValue = regionLevels[0];
  for (let regionIndex = 1; regionIndex < 4; regionIndex += 1) {
    const index = regionIndex as ScanRegionIndex;
    if (regionLevels[index] > dominantValue) {
      dominantValue = regionLevels[index];
      dominantIndex = index;
    }
  }
  return dominantIndex;
}

function parseFiniteNumber(rawValue: unknown, fallback: number): number {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumberInRange(rawValue: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseFiniteNumber(rawValue, fallback);
  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
}

function isPoseSignalId(value: string): value is PoseSignalId {
  return POSE_SIGNAL_DEFINITIONS.some((signal) => signal.id === value);
}

function isMatrixParamId(value: string): value is Ec2ParamId {
  return MATRIX_PARAM_IDS.includes(value as Ec2ParamId);
}

function getMatrixParamLabel(paramId: Ec2ParamId): string {
  return MATRIX_PARAM_LABELS[paramId] || getEc2ParamById(paramId).label;
}

function formatMappingCurveLabel(curve: PoseMappingCurve): string {
  if (curve === 'easeIn') {
    return 'Ease In';
  }
  if (curve === 'easeOut') {
    return 'Ease Out';
  }
  if (curve === 'sCurve') {
    return 'S Curve';
  }
  return 'Linear';
}

function formatMappingCombinerLabel(combiner: PoseMappingCombiner): string {
  if (combiner === 'sum') {
    return 'Sum';
  }
  if (combiner === 'average') {
    return 'Average';
  }
  if (combiner === 'min') {
    return 'Minimum';
  }
  if (combiner === 'max') {
    return 'Maximum';
  }
  if (combiner === 'multiply') {
    return 'Multiply';
  }
  return 'Override';
}

function combineMappedValues(
  current: number,
  next: number,
  combiner: PoseMappingCombiner,
  index: number,
): number {
  if (combiner === 'sum') {
    return current + next;
  }
  if (combiner === 'average') {
    return current + (next - current) / Math.max(1, index + 1);
  }
  if (combiner === 'min') {
    return Math.min(current, next);
  }
  if (combiner === 'max') {
    return Math.max(current, next);
  }
  if (combiner === 'multiply') {
    return current * next;
  }
  return next;
}

function getParamControlStep(param: Ec2ParamDefinition): number {
  if (param.specialCases.integer === true) {
    return 1;
  }

  const span = Math.abs(param.absoluteRange[1] - param.absoluteRange[0]);
  if (span <= 1) {
    return 0.001;
  }
  if (span <= 20) {
    return 0.01;
  }
  if (span <= 200) {
    return 0.1;
  }

  return 1;
}

function lockManagedOscTarget(settings: OutputSettings): OutputSettings {
  if (!settings.managedLocalEngine) {
    return settings;
  }

  return {
    ...settings,
    oscTargetHost: MANAGED_ENGINE_OSC_HOST,
    oscTargetPort: MANAGED_ENGINE_OSC_PORT,
  };
}

function parseStoredOutputSettings(raw: string | null): OutputSettings {
  if (!raw) {
    return lockManagedOscTarget(DEFAULT_OUTPUT_SETTINGS);
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OutputSettings>;
    const ec2Version: Ec2Version =
      parsed.ec2Version === 'v1.2' || parsed.ec2Version === 'v1.3+' || parsed.ec2Version === 'custom'
        ? parsed.ec2Version
        : DEFAULT_OUTPUT_SETTINGS.ec2Version;
    const versionProfiles = getProfilesForVersion(ec2Version);
    const fallbackProfileId = getDefaultProfileIdForVersion(ec2Version);
    const ec2ProfileId =
      typeof parsed.ec2ProfileId === 'string' &&
      versionProfiles.some((profile) => profile.id === parsed.ec2ProfileId)
        ? parsed.ec2ProfileId
        : fallbackProfileId;

    const parsedSettings: OutputSettings = {
      protocol: parsed.protocol === 'midi' ? 'midi' : 'osc',
      oscTargetHost: parsed.oscTargetHost?.trim() || DEFAULT_OUTPUT_SETTINGS.oscTargetHost,
      oscTargetPort: parseNumberInRange(
        parsed.oscTargetPort,
        DEFAULT_OUTPUT_SETTINGS.oscTargetPort,
        1,
        65535,
      ),
      oscParamPrefix:
        typeof parsed.oscParamPrefix === 'string'
          ? parsed.oscParamPrefix.trim()
          : DEFAULT_OUTPUT_SETTINGS.oscParamPrefix,
      midiDeviceId: parsed.midiDeviceId ?? DEFAULT_OUTPUT_SETTINGS.midiDeviceId,
      midiChannel: parseNumberInRange(parsed.midiChannel, DEFAULT_OUTPUT_SETTINGS.midiChannel, 1, 16),
      midiCcStart: parseNumberInRange(parsed.midiCcStart, DEFAULT_OUTPUT_SETTINGS.midiCcStart, 0, 127),
      ec2Version,
      ec2ProfileId,
      managedLocalEngine:
        typeof parsed.managedLocalEngine === 'boolean'
          ? parsed.managedLocalEngine
          : DEFAULT_OUTPUT_SETTINGS.managedLocalEngine,
      managedStartupTransportAutostart:
        typeof parsed.managedStartupTransportAutostart === 'boolean'
          ? parsed.managedStartupTransportAutostart
          : DEFAULT_OUTPUT_SETTINGS.managedStartupTransportAutostart,
    };
    return lockManagedOscTarget(parsedSettings);
  } catch {
    return lockManagedOscTarget(DEFAULT_OUTPUT_SETTINGS);
  }
}

function parseStoredPoseMappingsPayload(raw: string | null): Partial<PoseToEc2Mapping>[] | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as Partial<PoseToEc2Mapping>[];
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const preset = parsed as Partial<StoredPoseMappingPreset>;
    if (
      preset.version === POSE_MAPPING_STORAGE_VERSION &&
      Array.isArray(preset.mappings)
    ) {
      return preset.mappings as Partial<PoseToEc2Mapping>[];
    }

    if (Array.isArray((preset as { mappings?: unknown }).mappings)) {
      return (preset as { mappings: Partial<PoseToEc2Mapping>[] }).mappings;
    }

    return null;
  } catch {
    return null;
  }
}

function parseStoredPoseMappings(
  rawV2: string | null,
  rawLegacy: string | null,
): PoseToEc2Mapping[] {
  const defaults = createDefaultPoseToEc2Mappings();
  const parsed =
    parseStoredPoseMappingsPayload(rawV2) ??
    parseStoredPoseMappingsPayload(rawLegacy);
  if (!parsed) {
    return defaults;
  }

  return defaults.map((fallback, index) => {
    const candidate = parsed[index] as Partial<PoseToEc2Mapping> | undefined;
    if (!candidate || typeof candidate !== 'object') {
      return fallback;
    }

    const fallbackParamId =
      fallback.paramId && isMatrixParamId(fallback.paramId)
        ? fallback.paramId
        : DEFAULT_MATRIX_PARAM_ID;
    const fallbackSignalId =
      fallback.poseSignalId && isPoseSignalId(fallback.poseSignalId)
        ? fallback.poseSignalId
        : DEFAULT_POSE_SIGNAL_ID;

    const rawParamId =
      typeof candidate.paramId === 'string'
        ? candidate.paramId.trim()
        : candidate.paramId === null
          ? null
          : fallbackParamId;
    const paramId =
      rawParamId === null || rawParamId.length === 0
        ? null
        : isEc2ParamId(rawParamId) && isMatrixParamId(rawParamId)
          ? rawParamId
          : fallbackParamId;
    const paramForBounds = getEc2ParamById(paramId ?? fallbackParamId);

    const rawSignalId =
      typeof candidate.poseSignalId === 'string'
        ? candidate.poseSignalId.trim()
        : candidate.poseSignalId === null
          ? null
          : fallbackSignalId;
    const poseSignalId =
      rawSignalId === null || rawSignalId.length === 0
        ? null
        : isPoseSignalId(rawSignalId)
          ? rawSignalId
          : fallbackSignalId;

    return {
      ...fallback,
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : fallback.enabled,
      poseSignalId,
      paramId,
      outputMin: clamp(
        parseFiniteNumber(candidate.outputMin, fallback.outputMin),
        paramForBounds.absoluteRange[0],
        paramForBounds.absoluteRange[1],
      ),
      outputMax: clamp(
        parseFiniteNumber(candidate.outputMax, fallback.outputMax),
        paramForBounds.absoluteRange[0],
        paramForBounds.absoluteRange[1],
      ),
      offset: clamp(parseFiniteNumber(candidate.offset, fallback.offset), -1, 1),
      transforms: normalizePoseMappingTransformChain(candidate.transforms),
      combiner: normalizePoseMappingCombiner(candidate.combiner),
    };
  });
}

function createStoredPoseMappingPreset(mappings: PoseToEc2Mapping[]): StoredPoseMappingPreset {
  return {
    version: POSE_MAPPING_STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    mappings,
  };
}

function parseStoredAudioBridgeSettings(raw: string | null): AudioBridgeSettings {
  if (!raw) {
    return DEFAULT_AUDIO_BRIDGE_SETTINGS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AudioBridgeSettings>;
    const fromStoredList = Array.isArray(parsed.soundSources)
      ? parsed.soundSources.filter(
          (source): source is string => typeof source === 'string' && source.trim().length > 0,
        )
      : [];
    const fromPath = parsed.soundFilePath?.trim() ? [parsed.soundFilePath.trim()] : [];
    let soundSources: string[] = [];
    for (const source of fromStoredList) {
      if (
        !soundSources.some(
          (existingSource) =>
            normalizePathForCompare(existingSource) === normalizePathForCompare(source),
        )
      ) {
        soundSources.push(source.trim());
      }
    }
    for (const source of fromPath) {
      soundSources = upsertSoundSourceList(soundSources, source);
    }
    const selectedSoundSourcePath =
      parsed.selectedSoundSourcePath?.trim() ||
      parsed.soundFilePath?.trim() ||
      soundSources[0] ||
      DEFAULT_AUDIO_BRIDGE_SETTINGS.selectedSoundSourcePath;
    const storedDirection = typeof parsed.playheadDirection === 'string' ? parsed.playheadDirection.trim() : '';
    const playheadDirection = isPlayheadDirectionMode(storedDirection)
      ? storedDirection
      : DEFAULT_AUDIO_BRIDGE_SETTINGS.playheadDirection;

    return {
      soundFilePath: parsed.soundFilePath?.trim() || DEFAULT_AUDIO_BRIDGE_SETTINGS.soundFilePath,
      soundFileIndex: parseNumberInRange(
        parsed.soundFileIndex,
        DEFAULT_AUDIO_BRIDGE_SETTINGS.soundFileIndex,
        1,
        9999,
      ),
      soundSources,
      selectedSoundSourcePath,
      playheadDirection,
      recordFileName: parsed.recordFileName?.trim() || DEFAULT_AUDIO_BRIDGE_SETTINGS.recordFileName,
      outputFolder: parsed.outputFolder?.trim() || DEFAULT_AUDIO_BRIDGE_SETTINGS.outputFolder,
      masterAmplitudeDb: clamp(
        parseFiniteNumber(parsed.masterAmplitudeDb, DEFAULT_AUDIO_BRIDGE_SETTINGS.masterAmplitudeDb),
        MASTER_AMPLITUDE_MIN_DB,
        MASTER_AMPLITUDE_MAX_DB,
      ),
      audioOutputDeviceId:
        parsed.audioOutputDeviceId?.trim() || DEFAULT_AUDIO_BRIDGE_SETTINGS.audioOutputDeviceId,
      audioOutputDeviceName:
        parsed.audioOutputDeviceName?.trim() || DEFAULT_AUDIO_BRIDGE_SETTINGS.audioOutputDeviceName,
    };
  } catch {
    return DEFAULT_AUDIO_BRIDGE_SETTINGS;
  }
}

function createFpsCounter(): FpsCounter {
  return {
    frames: 0,
    fps: 0,
    lastMs: performance.now(),
  };
}

function createSendRateTracker(): SendRateTracker {
  return {
    count: 0,
    lastMs: performance.now(),
  };
}

function updateFps(counter: FpsCounter, nowMs: number): number {
  counter.frames += 1;
  const elapsed = nowMs - counter.lastMs;
  if (elapsed >= 1000) {
    counter.fps = (counter.frames * 1000) / elapsed;
    counter.frames = 0;
    counter.lastMs = nowMs;
  }
  return counter.fps;
}

function formatDeviceLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Camera ${index + 1}`;
}

function formatAudioOutputLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Audio Output ${index + 1}`;
}

function normalizeAudioOutputName(value: string): string {
  return value.trim().toLowerCase();
}

function isAnonymousAudioOutputLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length === 0 || /^Audio Output \d+$/i.test(trimmed);
}

function mergeAudioOutputDevices(
  browserOutputs: AudioOutputDeviceOption[],
  systemOutputs: AudioOutputDeviceOption[],
): AudioOutputDeviceOption[] {
  const seenIds = new Set<string>();
  const seenDeviceNames = new Set<string>();
  const merged: AudioOutputDeviceOption[] = [];

  const pushDevice = (device: AudioOutputDeviceOption): void => {
    const normalizedId = device.id.trim();
    if (!normalizedId || seenIds.has(normalizedId)) {
      return;
    }

    const normalizedName = normalizeAudioOutputName(device.ec2DeviceName);
    if (normalizedName && seenDeviceNames.has(normalizedName)) {
      return;
    }

    seenIds.add(normalizedId);
    if (normalizedName) {
      seenDeviceNames.add(normalizedName);
    }
    merged.push(device);
  };

  const browserWithoutDefault = browserOutputs.filter((device) => device.id !== 'default');
  const defaultDevice = browserOutputs.find((device) => device.id === 'default') || {
    id: 'default',
    label: 'System Default',
    ec2DeviceName: 'default',
  };

  if (browserOutputs.length > 0 || systemOutputs.length > 0) {
    pushDevice(defaultDevice);
  }

  for (const device of browserWithoutDefault) {
    pushDevice(device);
  }

  for (const device of systemOutputs) {
    pushDevice(device);
  }

  return merged;
}

function getStatusTone(status: OutputConnectionStatus): 'good' | 'warn' | 'bad' | 'idle' {
  if (status === 'connected') {
    return 'good';
  }
  if (status === 'connecting') {
    return 'warn';
  }
  if (status === 'disabled') {
    return 'idle';
  }
  return 'bad';
}

function getEngineStatusTone(status: ElectronEngineStatusResponse['status'] | null): 'good' | 'warn' | 'bad' | 'idle' {
  if (status === 'running') {
    return 'good';
  }
  if (status === 'starting' || status === 'stopping') {
    return 'warn';
  }
  if (status === 'stopped' || status == null) {
    return 'idle';
  }
  return 'bad';
}

function formatEngineLogEntry(entry: ElectronEngineLogEntry): string {
  const stamp = new Date(entry.timestampMs).toLocaleTimeString();
  return `[${stamp}] ${entry.source.toUpperCase()}: ${entry.line}`;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputWaveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const browserWavInputRef = useRef<HTMLInputElement>(null);
  const frameHandleRef = useRef<number | null>(null);
  const waveformHandleRef = useRef<number | null>(null);
  const outputClientRef = useRef<OutputClient | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const poseResultRef = useRef<PoseLandmarkerResult | null>(null);
  const poseErrorRef = useRef<string | null>(null);
  const renderFpsRef = useRef<FpsCounter>(createFpsCounter());
  const poseFpsRef = useRef<FpsCounter>(createFpsCounter());
  const sendRateRef = useRef<SendRateTracker>(createSendRateTracker());
  const hudMetricsRef = useRef<HudMetrics>(DEFAULT_HUD_METRICS);
  const lastSnapshotRef = useRef(0);
  const mappingSignalStateRef = useRef<Map<string, number>>(new Map());
  const lastParamSendRef = useRef<Map<Ec2ParamId, MappingSendState>>(new Map());
  const mappingValuesRef = useRef<Record<string, number>>({});
  const liveParamValuesRef = useRef<Record<Ec2ParamId, number>>({
    ...DEFAULT_EC2_PARAM_SNAPSHOT,
  });
  const sourceWaveformSamplesRef = useRef<number[] | null>(null);
  const sourceWaveformCacheRef = useRef<Map<string, number[]>>(new Map());
  const sourceWaveformRequestIdRef = useRef(0);
  const defaultStaticWavAttemptedRef = useRef(false);
  const scanPlayheadProgressRef = useRef(0);
  const scanRandomJumpAccumulatorRef = useRef(0);
  const scanRandomJumpPositionRef = useRef(0);
  const scanGrainTracesRef = useRef<ScanGrainTrace[]>([]);
  const engineScanTelemetryRef = useRef<Ec2ScanTelemetry | null>(null);
  const engineScanTelemetryAtMsRef = useRef(0);
  const scanTelemetryLastUpdateMsRef = useRef(0);
  const outputWaveformLastStepMsRef = useRef(0);
  const outputWaveformLastDrawMsRef = useRef(0);
  const lastInferenceMsRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const [poseReady, setPoseReady] = useState(false);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [poseRuntimeConfig, setPoseRuntimeConfig] = useState(DEFAULT_POSE_RUNTIME_CONFIG);
  const [outputStatus, setOutputStatus] = useState<OutputConnectionStatus>('disabled');
  const [outputSendRate, setOutputSendRate] = useState(0);
  const [hudSnapshot, setHudSnapshot] = useState<HudMetrics>(DEFAULT_HUD_METRICS);
  const [mappingSnapshot, setMappingSnapshot] = useState<Record<string, number>>({});
  const [liveParamSnapshot, setLiveParamSnapshot] = useState<Record<Ec2ParamId, number>>({
    ...DEFAULT_EC2_PARAM_SNAPSHOT,
  });
  const [scanTelemetrySnapshot, setScanTelemetrySnapshot] =
    useState<ScanTelemetrySnapshot>(DEFAULT_SCAN_TELEMETRY);
  const [audioBridgeFeedback, setAudioBridgeFeedback] = useState<string>('');
  const [recordingFiles, setRecordingFiles] = useState<ElectronAudioRecordingEntry[]>([]);
  const [recordingsBusy, setRecordingsBusy] = useState(false);
  const [recordingDownloadPath, setRecordingDownloadPath] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTransportRunning, setIsTransportRunning] = useState(false);
  const [engineFeedback, setEngineFeedback] = useState<string>('');
  const [engineStatus, setEngineStatus] = useState<ElectronEngineStatusResponse | null>(null);
  const [engineHello, setEngineHello] = useState<ElectronHelloTelemetryPayload | null>(null);
  const [engineLogLines, setEngineLogLines] = useState<string[]>([]);
  const [startupAuditTrail, setStartupAuditTrail] = useState<string[]>([]);
  const [engineActionBusy, setEngineActionBusy] = useState(false);
  const [showEngineLogs, setShowEngineLogs] = useState(false);
  const [midiDevices, setMidiDevices] = useState<MidiOutputDevice[]>([]);
  const [outputSettings, setOutputSettings] = useState<OutputSettings>(() =>
    parseStoredOutputSettings(localStorage.getItem(OUTPUT_SETTINGS_STORAGE_KEY)),
  );
  const [oscTargetHostInput, setOscTargetHostInput] = useState(outputSettings.oscTargetHost);
  const [oscTargetPortInput, setOscTargetPortInput] = useState(String(outputSettings.oscTargetPort));
  const [oscParamPrefixInput, setOscParamPrefixInput] = useState(outputSettings.oscParamPrefix);
  const [poseMappings, setPoseMappings] = useState<PoseToEc2Mapping[]>(() =>
    parseStoredPoseMappings(
      localStorage.getItem(MAPPING_SETTINGS_STORAGE_KEY),
      localStorage.getItem(MAPPING_SETTINGS_STORAGE_KEY_LEGACY),
    ),
  );
  const [audioBridgeSettings, setAudioBridgeSettings] = useState<AudioBridgeSettings>(() =>
    parseStoredAudioBridgeSettings(localStorage.getItem(AUDIO_BRIDGE_SETTINGS_STORAGE_KEY)),
  );
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioOutputDeviceOption[]>([]);

  const poseMappingsRef = useRef(poseMappings);
  const audioBridgeSettingsRef = useRef(audioBridgeSettings);
  const transportRunningRef = useRef(isTransportRunning);
  const startupReadySyncAppliedRef = useRef(false);
  const previousEngineStatusRef = useRef<ElectronEngineStatusResponse['status'] | null>(null);
  const startupAuditCycleRef = useRef(0);
  const startupAuditMarkersRef = useRef<Set<string>>(new Set());

  const { devices, error: cameraError, isActive, settings, setSettings, stream } = useCamera();
  const hasManagedElectronRuntime = Boolean(window.granuPose?.engine && window.granuPose?.telemetry);
  const engineStartedAtMs = engineStatus?.startedAtMs ?? null;
  const engineHelloTimestampMs = engineHello?.timestampMs ?? null;
  const engineHelloForCurrentRun = Boolean(
    engineHelloTimestampMs != null &&
      (engineStartedAtMs == null || engineHelloTimestampMs + MANAGED_ENGINE_HELLO_SKEW_MS >= engineStartedAtMs),
  );
  const managedEngineHelloTimedOut = Boolean(
    outputSettings.managedLocalEngine &&
      hasManagedElectronRuntime &&
      engineStatus?.status === 'running' &&
      !engineHelloForCurrentRun &&
      engineStartedAtMs != null &&
      Date.now() - engineStartedAtMs >= MANAGED_ENGINE_HELLO_TIMEOUT_MS,
  );
  const managedEngineStartupReady = Boolean(
    !outputSettings.managedLocalEngine ||
      !hasManagedElectronRuntime ||
      (engineStatus?.status === 'running' && (engineHelloForCurrentRun || managedEngineHelloTimedOut)),
  );
  const oscStartupReady =
    outputSettings.protocol === 'osc' &&
    outputStatus === 'connected' &&
    managedEngineStartupReady;

  const appendEngineLogLine = useCallback((line: string): void => {
    setEngineLogLines((current) => {
      const next = [...current, line];
      if (next.length > ENGINE_LOG_TAIL_LIMIT) {
        next.splice(0, next.length - ENGINE_LOG_TAIL_LIMIT);
      }
      return next;
    });
  }, []);

  const emitStartupAuditMarker = useCallback(
    (
      event: StartupAuditEvent,
      detail?: string,
      options?: {
        allowRepeat?: boolean;
      },
    ): void => {
      const markerKey = `${startupAuditCycleRef.current}:${event}`;
      if (!options?.allowRepeat && startupAuditMarkersRef.current.has(markerKey)) {
        return;
      }

      startupAuditMarkersRef.current.add(markerKey);
      const stamp = new Date().toLocaleTimeString();
      const suffix = detail ? ` ${detail}` : '';
      const markerLine = `[${stamp}] STARTUP: ${event}${suffix}`;
      appendEngineLogLine(markerLine);
      setStartupAuditTrail((current) => {
        const next = [...current, markerLine];
        if (next.length > STARTUP_AUDIT_TRAIL_LIMIT) {
          next.splice(0, next.length - STARTUP_AUDIT_TRAIL_LIMIT);
        }
        return next;
      });
    },
    [appendEngineLogLine],
  );

  const listBrowserAudioOutputDevices = useCallback(async (): Promise<AudioOutputDeviceOption[]> => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return [];
    }

    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    return mediaDevices
      .filter((device): device is MediaDeviceInfo => device.kind === 'audiooutput')
      .map((device, index) => {
        const label = formatAudioOutputLabel(device, index);
        return {
          id: device.deviceId || `audio-output-${index + 1}`,
          label,
          ec2DeviceName: device.label.trim() || label,
        };
      });
  }, []);

  const listSystemAudioOutputDevices = useCallback(async (): Promise<AudioOutputDeviceOption[]> => {
    const audioApi = window.granuPose?.audio;
    if (!audioApi || typeof audioApi.listOutputs !== 'function') {
      return [];
    }

    try {
      const result = await audioApi.listOutputs();
      if (!result.ok || !Array.isArray(result.outputs)) {
        return [];
      }

      return result.outputs
        .map((output, index) => {
          const label = typeof output.name === 'string' ? output.name.trim() : '';
          if (!label) {
            return null;
          }

          const id =
            typeof output.id === 'string' && output.id.trim().length > 0
              ? output.id.trim()
              : `system-output-${index + 1}`;
          return {
            id,
            label,
            ec2DeviceName: label,
          };
        })
        .filter((device): device is AudioOutputDeviceOption => Boolean(device));
    } catch {
      return [];
    }
  }, []);

  const requestAudioOutputLabelAccess = useCallback(async (): Promise<boolean> => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      return false;
    }

    try {
      const streamHandle = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      for (const track of streamHandle.getTracks()) {
        track.stop();
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshAudioOutputDevices = useCallback(async (showFeedback = false): Promise<void> => {
    try {
      const [browserOutputs, systemOutputs] = await Promise.all([
        listBrowserAudioOutputDevices(),
        listSystemAudioOutputDevices(),
      ]);
      const mergedOutputs = mergeAudioOutputDevices(browserOutputs, systemOutputs);

      setAudioOutputDevices(mergedOutputs);
      setAudioBridgeSettings((current) => {
        const normalizedCurrentName = normalizeAudioOutputName(current.audioOutputDeviceName);
        if (current.audioOutputDeviceId) {
          const activeById = mergedOutputs.find((device) => device.id === current.audioOutputDeviceId);
          if (activeById) {
            if (normalizedCurrentName) {
              return current;
            }
            return {
              ...current,
              audioOutputDeviceName: activeById.ec2DeviceName,
            };
          }
        }

        if (normalizedCurrentName) {
          const activeByName = mergedOutputs.find(
            (device) => normalizeAudioOutputName(device.ec2DeviceName) === normalizedCurrentName,
          );
          if (activeByName) {
            return {
              ...current,
              audioOutputDeviceId: activeByName.id,
            };
          }
        }

        const nextDefaultDevice = mergedOutputs[0];
        return {
          ...current,
          audioOutputDeviceId: nextDefaultDevice?.id || '',
          audioOutputDeviceName:
            normalizedCurrentName || !nextDefaultDevice ? current.audioOutputDeviceName : nextDefaultDevice.ec2DeviceName,
        };
      });

      if (showFeedback) {
        if (mergedOutputs.length === 0) {
          setAudioBridgeFeedback('No audio output devices were detected.');
          return;
        }

        const hasNamedBrowserOutputs = browserOutputs.some(
          (device) => !isAnonymousAudioOutputLabel(device.label),
        );
        if (!hasNamedBrowserOutputs && browserOutputs.length > 0 && systemOutputs.length === 0) {
          setAudioBridgeFeedback(
            'Detected outputs but labels are hidden. Click "Unlock Output Labels" and allow mic access.',
          );
          return;
        }

        const fromSystemCount = systemOutputs.length;
        const fromBrowserCount = browserOutputs.length;
        setAudioBridgeFeedback(
          `Detected ${mergedOutputs.length} output option${mergedOutputs.length === 1 ? '' : 's'} (${fromBrowserCount} browser, ${fromSystemCount} system).`,
        );
      }
    } catch (error) {
      setAudioOutputDevices([]);
      if (showFeedback) {
        setAudioBridgeFeedback(
          error instanceof Error
            ? `Failed to list audio outputs: ${error.message}`
            : 'Failed to list audio outputs.',
        );
      }
    }
  }, [listBrowserAudioOutputDevices, listSystemAudioOutputDevices]);

  const onUnlockAudioOutputLabels = useCallback(async (): Promise<void> => {
    const granted = await requestAudioOutputLabelAccess();
    if (!granted) {
      setAudioBridgeFeedback(
        'Microphone access was not granted. Enter EC2 device name manually or keep using System Default.',
      );
      return;
    }

    await refreshAudioOutputDevices(true);
  }, [refreshAudioOutputDevices, requestAudioOutputLabelAccess]);

  const refreshRecordingFiles = useCallback(
    async (showFeedback = false, directoryOverride?: string): Promise<void> => {
      const audioApi = window.granuPose?.audio;
      if (!audioApi || typeof audioApi.listRecordings !== 'function') {
        setRecordingFiles([]);
        if (showFeedback) {
          setAudioBridgeFeedback('Recording file library is available in desktop Electron mode.');
        }
        return;
      }

      const directoryPath = (directoryOverride ?? audioBridgeSettingsRef.current.outputFolder).trim();
      if (!directoryPath) {
        setRecordingFiles([]);
        if (showFeedback) {
          setAudioBridgeFeedback('Set an output folder first to list recordings.');
        }
        return;
      }

      setRecordingsBusy(true);
      try {
        const result = await audioApi.listRecordings({
          directoryPath,
          limit: 128,
        });
        if (!result.ok) {
          setRecordingFiles([]);
          if (showFeedback) {
            setAudioBridgeFeedback(result.error || 'Failed to list recording files.');
          }
          return;
        }

        const files = Array.isArray(result.recordings) ? result.recordings : [];
        setRecordingFiles(files);
        if (showFeedback) {
          setAudioBridgeFeedback(
            files.length > 0
              ? `Recording library refreshed (${files.length} files).`
              : 'Recording library is empty for the selected output folder.',
          );
        }
      } catch (error) {
        setRecordingFiles([]);
        if (showFeedback) {
          setAudioBridgeFeedback(
            error instanceof Error ? error.message : 'Failed to list recording files.',
          );
        }
      } finally {
        setRecordingsBusy(false);
      }
    },
    [],
  );

  const onDownloadRecording = useCallback(
    async (recording: ElectronAudioRecordingEntry): Promise<void> => {
      const audioApi = window.granuPose?.audio;
      if (!audioApi || typeof audioApi.readRecordingAsBase64 !== 'function') {
        setAudioBridgeFeedback('Recording download is available in desktop Electron mode.');
        return;
      }

      setRecordingDownloadPath(recording.path);
      try {
        const response = await audioApi.readRecordingAsBase64({
          filePath: recording.path,
        });
        if (!response.ok || typeof response.base64Data !== 'string') {
          setAudioBridgeFeedback(response.error || `Failed to read recording ${recording.name}.`);
          return;
        }

        const payload = decodeBase64ToArrayBuffer(response.base64Data);
        const blob = new Blob([payload], {
          type: response.mimeType || 'audio/wav',
        });
        const objectUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = objectUrl;
        downloadLink.download = response.fileName || recording.name || 'recording.wav';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        URL.revokeObjectURL(objectUrl);
        setAudioBridgeFeedback(`Downloaded recording: ${downloadLink.download}`);
      } catch (error) {
        setAudioBridgeFeedback(
          error instanceof Error ? error.message : `Failed to download recording ${recording.name}.`,
        );
      } finally {
        setRecordingDownloadPath('');
      }
    },
    [],
  );

  const cacheWaveformSamplesForSource = useCallback(
    async (sourcePath: string, arrayBuffer: ArrayBuffer): Promise<number[] | null> => {
      const trimmed = sourcePath.trim();
      if (!trimmed) {
        return null;
      }

      const waveformSamples = await decodeWaveformPreviewSamples(
        arrayBuffer,
        OUTPUT_WAVEFORM_POINT_COUNT,
      );
      if (!waveformSamples) {
        return null;
      }

      const cacheKey = normalizePathForCompare(trimmed);
      sourceWaveformCacheRef.current.set(cacheKey, waveformSamples);
      return waveformSamples;
    },
    [],
  );

  const loadSourceWaveformFromPath = useCallback(
    async (sourcePath: string): Promise<void> => {
      const trimmed = sourcePath.trim();
      if (!trimmed) {
        sourceWaveformSamplesRef.current = null;
        return;
      }

      const cacheKey = normalizePathForCompare(trimmed);
      const cachedSamples = sourceWaveformCacheRef.current.get(cacheKey);
      if (cachedSamples) {
        sourceWaveformSamplesRef.current = cachedSamples;
        return;
      }

      const fileReader = window.granuPose?.dialog?.readWavFileAsBase64;
      if (!fileReader) {
        return;
      }

      const requestId = sourceWaveformRequestIdRef.current + 1;
      sourceWaveformRequestIdRef.current = requestId;
      sourceWaveformSamplesRef.current = null;

      try {
        const result = await fileReader({ filePath: trimmed });
        if (sourceWaveformRequestIdRef.current !== requestId) {
          return;
        }

        if (!result.ok || typeof result.base64Data !== 'string' || result.base64Data.length === 0) {
          sourceWaveformSamplesRef.current = sourceWaveformCacheRef.current.get(cacheKey) ?? null;
          return;
        }

        const arrayBuffer = decodeBase64ToArrayBuffer(result.base64Data);
        const waveformSamples = await cacheWaveformSamplesForSource(trimmed, arrayBuffer);
        if (sourceWaveformRequestIdRef.current !== requestId) {
          return;
        }
        sourceWaveformSamplesRef.current = waveformSamples;
      } catch {
        if (sourceWaveformRequestIdRef.current === requestId) {
          sourceWaveformSamplesRef.current = sourceWaveformCacheRef.current.get(cacheKey) ?? null;
        }
      }
    },
    [cacheWaveformSamplesForSource],
  );

  const setPoseErrorState = (value: string | null): void => {
    poseErrorRef.current = value;
    setPoseError(value);
  };

  const sendOscMessage = useCallback(
    (address: string, args: OscArg[]): void => {
      if (outputSettings.protocol !== 'osc') {
        return;
      }

      const client = outputClientRef.current;
      if (!client) {
        return;
      }

      client.sendOscMessage({
        address,
        args,
        rateLimitKey: address,
      });
      sendRateRef.current.count += 1;
    },
    [outputSettings.protocol],
  );

  const updatePoseMapping = useCallback((mappingId: string, patch: Partial<PoseToEc2Mapping>): void => {
    setPoseMappings((current) =>
      current.map((mapping) => {
        if (mapping.id !== mappingId) {
          return mapping;
        }

        const nextParamId =
          patch.paramId !== undefined ? patch.paramId : mapping.paramId;
        const boundedOffset = clamp(patch.offset ?? mapping.offset, -1, 1);
        const transforms = normalizePoseMappingTransformChain(patch.transforms ?? mapping.transforms);
        const combiner = normalizePoseMappingCombiner(patch.combiner ?? mapping.combiner);
        if (!nextParamId) {
          return {
            ...mapping,
            ...patch,
            paramId: null,
            outputMin: patch.outputMin ?? mapping.outputMin,
            outputMax: patch.outputMax ?? mapping.outputMax,
            offset: boundedOffset,
            transforms,
            combiner,
          };
        }

        const param = getEc2ParamById(nextParamId);
        return {
          ...mapping,
          ...patch,
          paramId: nextParamId,
          outputMin: clamp(
            patch.outputMin ?? mapping.outputMin,
            param.absoluteRange[0],
            param.absoluteRange[1],
          ),
          outputMax: clamp(
            patch.outputMax ?? mapping.outputMax,
            param.absoluteRange[0],
            param.absoluteRange[1],
          ),
          offset: boundedOffset,
          transforms,
          combiner,
        };
      }),
    );
  }, []);

  const resetPoseMappings = useCallback((): void => {
    setPoseMappings(createDefaultPoseToEc2Mappings());
    mappingValuesRef.current = {};
    setMappingSnapshot({});
    mappingSignalStateRef.current.clear();
    lastParamSendRef.current.clear();
  }, []);

  useEffect(() => {
    localStorage.setItem(OUTPUT_SETTINGS_STORAGE_KEY, JSON.stringify(outputSettings));
  }, [outputSettings]);

  useEffect(() => {
    setOscTargetHostInput(outputSettings.oscTargetHost);
    setOscTargetPortInput(String(outputSettings.oscTargetPort));
  }, [outputSettings.oscTargetHost, outputSettings.oscTargetPort]);

  useEffect(() => {
    if (!outputSettings.managedLocalEngine) {
      return;
    }

    if (
      outputSettings.oscTargetHost === MANAGED_ENGINE_OSC_HOST &&
      outputSettings.oscTargetPort === MANAGED_ENGINE_OSC_PORT
    ) {
      return;
    }

    setOutputSettings((current) => lockManagedOscTarget(current));
  }, [outputSettings.managedLocalEngine, outputSettings.oscTargetHost, outputSettings.oscTargetPort]);

  useEffect(() => {
    poseMappingsRef.current = poseMappings;
    lastParamSendRef.current.clear();
    const activeIds = new Set(poseMappings.map((mapping) => mapping.id));
    for (const mappingId of Array.from(mappingSignalStateRef.current.keys())) {
      if (!activeIds.has(mappingId)) {
        mappingSignalStateRef.current.delete(mappingId);
      }
    }
    localStorage.setItem(
      MAPPING_SETTINGS_STORAGE_KEY,
      JSON.stringify(createStoredPoseMappingPreset(poseMappings)),
    );
    localStorage.removeItem(MAPPING_SETTINGS_STORAGE_KEY_LEGACY);
  }, [poseMappings]);

  useEffect(() => {
    audioBridgeSettingsRef.current = audioBridgeSettings;
    localStorage.setItem(AUDIO_BRIDGE_SETTINGS_STORAGE_KEY, JSON.stringify(audioBridgeSettings));
  }, [audioBridgeSettings]);

  useEffect(() => {
    transportRunningRef.current = isTransportRunning;
  }, [isTransportRunning]);

  useEffect(() => {
    scanPlayheadProgressRef.current = 0;
    scanRandomJumpAccumulatorRef.current = 0;
    scanRandomJumpPositionRef.current =
      audioBridgeSettings.playheadDirection === 'random' && isTransportRunning ? Math.random() : 0;
  }, [audioBridgeSettings.playheadDirection, isTransportRunning]);

  useEffect(() => {
    if (!audioBridgeSettings.outputFolder.trim()) {
      setRecordingFiles([]);
      return;
    }

    void refreshRecordingFiles(false);
  }, [audioBridgeSettings.outputFolder, refreshRecordingFiles]);

  useEffect(() => {
    const selectedSourcePath = audioBridgeSettings.selectedSoundSourcePath.trim();
    void loadSourceWaveformFromPath(selectedSourcePath);
  }, [audioBridgeSettings.selectedSoundSourcePath, loadSourceWaveformFromPath]);

  useEffect(() => {
    void refreshAudioOutputDevices(false);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.addEventListener !== 'function'
    ) {
      return;
    }

    const handleDeviceChange = (): void => {
      void refreshAudioOutputDevices(false);
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshAudioOutputDevices]);

  useEffect(() => {
    liveParamValuesRef.current = {
      ...liveParamValuesRef.current,
      amplitude: audioBridgeSettings.masterAmplitudeDb,
    };
  }, [audioBridgeSettings.masterAmplitudeDb]);

  useEffect(() => {
    if (!oscStartupReady) {
      return;
    }

    sendOscMessage('/Amplitude', [{ type: 'f', value: audioBridgeSettings.masterAmplitudeDb }]);
  }, [audioBridgeSettings.masterAmplitudeDb, oscStartupReady, sendOscMessage]);

  useEffect(() => {
    if (!oscStartupReady) {
      return;
    }

    sendOscMessage('/playheadDirection', [{ type: 's', value: audioBridgeSettings.playheadDirection }]);
  }, [audioBridgeSettings.playheadDirection, oscStartupReady, sendOscMessage]);

  useEffect(() => {
    if (!oscStartupReady) {
      return;
    }

    const selectedPath = audioBridgeSettings.selectedSoundSourcePath.trim();
    if (!selectedPath) {
      return;
    }

    const sourceIndex = resolveSoundSourceIndex(audioBridgeSettings.soundSources, selectedPath);
    sendOscMessage('/loadSoundFile', [{ type: 's', value: selectedPath }]);
    sendOscMessage('/SoundFile', [{ type: 'f', value: sourceIndex }]);
  }, [
    audioBridgeSettings.selectedSoundSourcePath,
    audioBridgeSettings.soundSources,
    oscStartupReady,
    sendOscMessage,
  ]);

  useEffect(() => {
    if (!oscStartupReady || !outputSettings.managedLocalEngine) {
      startupReadySyncAppliedRef.current = false;
      return;
    }

    if (startupReadySyncAppliedRef.current) {
      return;
    }

    startupReadySyncAppliedRef.current = true;

    const outputDeviceName = audioBridgeSettings.audioOutputDeviceName.trim();
    if (outputDeviceName) {
      sendOscMessage('/audioDevice', [{ type: 's', value: outputDeviceName }]);
    }

    const recordFileName = audioBridgeSettings.recordFileName.trim() || 'pose_take.wav';
    sendOscMessage('/fileName', [{ type: 's', value: recordFileName }]);

    const outputFolder = audioBridgeSettings.outputFolder.trim();
    if (outputFolder) {
      sendOscMessage('/outputFolder', [{ type: 's', value: outputFolder }]);
    }

    sendOscMessage('/playheadDirection', [{ type: 's', value: audioBridgeSettings.playheadDirection }]);

    if (outputSettings.managedStartupTransportAutostart) {
      sendOscMessage('/transport', [{ type: 'i', value: 1 }]);
      setIsTransportRunning(true);
    } else {
      setIsTransportRunning(false);
    }

    emitStartupAuditMarker(
      'startup_sync_applied',
      outputSettings.managedStartupTransportAutostart ? 'transport=1' : 'transport=none',
    );
  }, [
    audioBridgeSettings.audioOutputDeviceName,
    audioBridgeSettings.outputFolder,
    audioBridgeSettings.playheadDirection,
    audioBridgeSettings.recordFileName,
    emitStartupAuditMarker,
    outputSettings.managedLocalEngine,
    outputSettings.managedStartupTransportAutostart,
    oscStartupReady,
    sendOscMessage,
  ]);

  useEffect(() => {
    const outputClient = createOutputClient({
      protocol: outputSettings.protocol,
      oscTargetHost: outputSettings.oscTargetHost,
      oscTargetPort: outputSettings.oscTargetPort,
      midiDeviceId: outputSettings.midiDeviceId,
      midiChannel: outputSettings.midiChannel,
      midiCcStart: outputSettings.midiCcStart,
    });
    outputClientRef.current = outputClient;
    engineScanTelemetryRef.current = null;
    engineScanTelemetryAtMsRef.current = 0;

    const unsubscribeStatus = outputClient.subscribeStatus(setOutputStatus);
    const unsubscribeScanTelemetry = outputClient.subscribeScanTelemetry((payload) => {
      engineScanTelemetryRef.current = payload;
      engineScanTelemetryAtMsRef.current = performance.now();
    });
    let unsubscribeDevices: () => void = () => {};

    if (isMidiOutputClient(outputClient)) {
      unsubscribeDevices = outputClient.subscribeDevices((availableDevices) => {
        setMidiDevices(availableDevices);
      });
    }

    void outputClient.connect();

    return () => {
      unsubscribeStatus();
      unsubscribeScanTelemetry();
      unsubscribeDevices();
      outputClient.close();
      outputClientRef.current = null;
    };
  }, [
    outputSettings.protocol,
    outputSettings.oscTargetHost,
    outputSettings.oscTargetPort,
    outputSettings.midiDeviceId,
    outputSettings.midiChannel,
    outputSettings.midiCcStart,
  ]);

  useEffect(() => {
    const engineApi = window.granuPose?.engine;
    if (!engineApi) {
      setEngineStatus(null);
      setEngineLogLines([]);
      setStartupAuditTrail([]);
      setIsRecording(false);
      previousEngineStatusRef.current = null;
      startupAuditCycleRef.current = 0;
      startupAuditMarkersRef.current.clear();
      return;
    }

    let disposed = false;

    void engineApi
      .getStatus()
      .then((status) => {
        if (!disposed) {
          setEngineStatus(status);
        }
      })
      .catch(() => undefined);

    void engineApi
      .getLogs({ limit: ENGINE_LOG_TAIL_LIMIT })
      .then((response) => {
        if (!disposed && response.ok) {
          setEngineLogLines(response.entries.map((entry) => formatEngineLogEntry(entry)));
        }
      })
      .catch(() => undefined);

    const unsubscribeStatus = engineApi.subscribeStatus((status) => {
      if (!disposed) {
        setEngineStatus(status);
      }
    });

    const unsubscribeLogs = engineApi.subscribeLogs((entry) => {
      if (disposed) {
        return;
      }

      const rawLine = typeof entry.line === 'string' ? entry.line : '';
      const normalizedLine = rawLine.toLowerCase();
      if (normalizedLine.includes('record 1 path')) {
        setIsRecording(true);
        const recordedFilePath = parseRecordingPathFromEngineLine(rawLine);
        if (recordedFilePath) {
          const nextFolder = getDirectoryFromPath(recordedFilePath);
          const nextFileName = getDisplayNameFromPath(recordedFilePath);
          setAudioBridgeSettings((current) => ({
            ...current,
            outputFolder: nextFolder || current.outputFolder,
            recordFileName: nextFileName || current.recordFileName,
          }));
          if (nextFolder) {
            void refreshRecordingFiles(false, nextFolder);
          }
        }
      } else if (
        normalizedLine.includes('record 0 path') ||
        normalizedLine.includes('record stop')
      ) {
        setIsRecording(false);
        const recordedFilePath = parseRecordingPathFromEngineLine(rawLine);
        const nextFolder =
          getDirectoryFromPath(recordedFilePath) ||
          audioBridgeSettingsRef.current.outputFolder.trim();
        if (nextFolder) {
          void refreshRecordingFiles(false, nextFolder);
        }
      } else if (normalizedLine.includes('record start rejected')) {
        setIsRecording(false);
      }

      if (/\btransport\s+1\b/.test(normalizedLine)) {
        setIsTransportRunning(true);
      } else if (
        /\btransport\s+0\b/.test(normalizedLine) ||
        normalizedLine.includes('ignored /transport 1 because --no-audio is active')
      ) {
        setIsTransportRunning(false);
      }

      appendEngineLogLine(formatEngineLogEntry(entry));
    });

    return () => {
      disposed = true;
      unsubscribeStatus();
      unsubscribeLogs();
    };
  }, [appendEngineLogLine, refreshRecordingFiles]);

  useEffect(() => {
    const telemetryApi = window.granuPose?.telemetry;
    if (!telemetryApi) {
      setEngineHello(null);
      return;
    }

    let disposed = false;

    void telemetryApi
      .getStatus()
      .then((status) => {
        if (disposed) {
          return;
        }

        setEngineHello(status.lastHello ?? null);
      })
      .catch(() => undefined);

    const unsubscribeHello = telemetryApi.subscribeHello((payload) => {
      if (!disposed) {
        setEngineHello(payload);
      }
    });

    return () => {
      disposed = true;
      unsubscribeHello();
    };
  }, []);

  useEffect(() => {
    if (!outputSettings.managedLocalEngine || !hasManagedElectronRuntime) {
      return;
    }

    if (
      engineStatus?.status === 'starting' ||
      engineStatus?.status === 'stopped' ||
      engineStatus?.status === 'error'
    ) {
      setEngineHello(null);
    }
  }, [
    engineStatus?.status,
    hasManagedElectronRuntime,
    outputSettings.managedLocalEngine,
  ]);

  useEffect(() => {
    if (
      engineStatus?.status === 'starting' ||
      engineStatus?.status === 'stopped' ||
      engineStatus?.status === 'error' ||
      engineStatus?.status === 'stopping'
    ) {
      setIsRecording(false);
      setIsTransportRunning(false);
    }
  }, [engineStatus?.status]);

  useEffect(() => {
    const currentStatus = engineStatus?.status ?? null;
    const previousStatus = previousEngineStatusRef.current;

    if (!outputSettings.managedLocalEngine || !hasManagedElectronRuntime) {
      previousEngineStatusRef.current = currentStatus;
      return;
    }

    if (currentStatus !== previousStatus) {
      if (currentStatus === 'starting') {
        startupAuditCycleRef.current += 1;
        startupAuditMarkersRef.current.clear();
        emitStartupAuditMarker('engine_start_requested');
      }

      if (currentStatus === 'running') {
        if (startupAuditCycleRef.current === 0) {
          startupAuditCycleRef.current = 1;
          startupAuditMarkersRef.current.clear();
          emitStartupAuditMarker('engine_start_requested', 'inferred');
        }
        const pidLabel = engineStatus?.pid != null ? `pid=${engineStatus.pid}` : 'pid=unknown';
        emitStartupAuditMarker('engine_running', pidLabel);
      }
    }

    previousEngineStatusRef.current = currentStatus;
  }, [
    emitStartupAuditMarker,
    engineStatus?.pid,
    engineStatus?.status,
    hasManagedElectronRuntime,
    outputSettings.managedLocalEngine,
  ]);

  useEffect(() => {
    if (!outputSettings.managedLocalEngine || !hasManagedElectronRuntime) {
      return;
    }

    if (engineStatus?.status !== 'running') {
      return;
    }

    if (engineHelloForCurrentRun) {
      const helloAddress = engineHello?.address || '/ec2/hello';
      emitStartupAuditMarker('hello_received', `address=${helloAddress}`);
      return;
    }

    if (managedEngineHelloTimedOut) {
      emitStartupAuditMarker('hello_timeout_fallback', `timeoutMs=${MANAGED_ENGINE_HELLO_TIMEOUT_MS}`);
    }
  }, [
    emitStartupAuditMarker,
    engineHello?.address,
    engineHelloForCurrentRun,
    engineStatus?.status,
    hasManagedElectronRuntime,
    managedEngineHelloTimedOut,
    outputSettings.managedLocalEngine,
  ]);

  useEffect(() => {
    if (!outputSettings.managedLocalEngine || !hasManagedElectronRuntime) {
      return;
    }

    if (engineStatus?.status !== 'running' || !managedEngineStartupReady) {
      return;
    }

    emitStartupAuditMarker('startup_ready');
  }, [
    emitStartupAuditMarker,
    engineStatus?.status,
    hasManagedElectronRuntime,
    managedEngineStartupReady,
    outputSettings.managedLocalEngine,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const nowMs = performance.now();
      const elapsedMs = nowMs - sendRateRef.current.lastMs;
      if (elapsedMs < 1000) {
        return;
      }

      const nextRate = (sendRateRef.current.count * 1000) / elapsedMs;
      setOutputSendRate(nextRate);
      sendRateRef.current.count = 0;
      sendRateRef.current.lastMs = nowMs;
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    getPoseLandmarker()
      .then((landmarker) => {
        if (!mounted) {
          return;
        }
        poseLandmarkerRef.current = landmarker;
        setPoseRuntimeConfig(getPoseRuntimeConfig());
        setPoseReady(true);
        setPoseErrorState(null);
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        setPoseRuntimeConfig(getPoseRuntimeConfig());
        setPoseReady(false);
        setPoseErrorState(
          error instanceof Error ? error.message : 'Failed to initialize pose landmarker.',
        );
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    videoElement.srcObject = stream;
    if (!stream) {
      lastInferenceMsRef.current = 0;
      lastVideoTimeRef.current = -1;
      return;
    }

    lastInferenceMsRef.current = 0;
    lastVideoTimeRef.current = -1;

    videoElement
      .play()
      .then(() => undefined)
      .catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    let disposed = false;

    const renderFrame = (): void => {
      const canvasElement = canvasRef.current;
      const videoElement = videoRef.current;

      if (!canvasElement || !videoElement || disposed) {
        frameHandleRef.current = window.requestAnimationFrame(renderFrame);
        return;
      }

      const context = canvasElement.getContext('2d');
      if (!context) {
        frameHandleRef.current = window.requestAnimationFrame(renderFrame);
        return;
      }

      const sourceWidth = videoElement.videoWidth;
      const sourceHeight = videoElement.videoHeight;

      if (sourceWidth > 0 && sourceHeight > 0) {
        if (canvasElement.width !== sourceWidth || canvasElement.height !== sourceHeight) {
          canvasElement.width = sourceWidth;
          canvasElement.height = sourceHeight;
        }

        drawVideoFrame(context, videoElement, sourceWidth, sourceHeight, settings.mirror);

        const landmarker = poseLandmarkerRef.current;
        const nowMs = performance.now();
        const hasNewVideoFrame = videoElement.currentTime !== lastVideoTimeRef.current;
        const elapsedSinceInference = nowMs - lastInferenceMsRef.current;
        const shouldRunInference =
          elapsedSinceInference >= poseRuntimeConfig.inferenceIntervalMs &&
          (!poseRuntimeConfig.newFrameOnly || hasNewVideoFrame);

        if (landmarker && shouldRunInference) {
          lastInferenceMsRef.current = nowMs;
          try {
            const detectStart = performance.now();
            const result = landmarker.detectForVideo(videoElement, detectStart);
            const detectEnd = performance.now();
            lastVideoTimeRef.current = videoElement.currentTime;

            poseResultRef.current = result;
            hudMetricsRef.current.inferenceMs = detectEnd - detectStart;
            hudMetricsRef.current.poseFps = updateFps(poseFpsRef.current, detectEnd);
            hudMetricsRef.current.confidence = computeTrackingConfidence(result);

            const mappingOutputs = evaluatePoseToEc2Mappings(result, poseMappingsRef.current, {
              oscAddressPrefix: outputSettings.oscParamPrefix,
              smoothingState: mappingSignalStateRef.current,
            });
            const nextMappingValues: Record<string, number> = {};
            const nextLiveParamValues = { ...liveParamValuesRef.current };
            const outputsByParam = new Map<Ec2ParamId, typeof mappingOutputs>();
            for (const output of mappingOutputs) {
              nextMappingValues[output.mappingId] = output.value;
              if (!outputsByParam.has(output.paramId)) {
                outputsByParam.set(output.paramId, []);
              }
              outputsByParam.get(output.paramId)?.push(output);
            }

            for (const [paramId, paramOutputs] of outputsByParam.entries()) {
              if (!paramOutputs || paramOutputs.length === 0) {
                continue;
              }

              const firstOutput = paramOutputs[0];
              if (!firstOutput) {
                continue;
              }

              let combinedValue = firstOutput.value;
              for (let outputIndex = 1; outputIndex < paramOutputs.length; outputIndex += 1) {
                const output = paramOutputs[outputIndex];
                if (!output) {
                  continue;
                }
                combinedValue = combineMappedValues(
                  combinedValue,
                  output.value,
                  output.combiner,
                  outputIndex,
                );
              }

              const paramDefinition = getEc2ParamById(paramId);
              const boundedCombinedValue = clamp(
                combinedValue,
                paramDefinition.absoluteRange[0],
                paramDefinition.absoluteRange[1],
              );
              nextLiveParamValues[paramId] = boundedCombinedValue;

              if (outputSettings.protocol !== 'osc') {
                continue;
              }

              const previous = lastParamSendRef.current.get(paramId);
              const changedEnough =
                !previous ||
                Math.abs(previous.value - boundedCombinedValue) >= MAPPING_SEND_EPSILON ||
                detectEnd - previous.sentAtMs >= MAPPING_SEND_KEEPALIVE_MS;
              if (!changedEnough) {
                continue;
              }

              const client = outputClientRef.current;
              if (client) {
                client.sendOscMessage({
                  address: firstOutput.address,
                  args: [{ type: 'f', value: boundedCombinedValue }],
                  rateLimitKey: `pose-param:${paramId}`,
                });
                sendRateRef.current.count += 1;
              }

              lastParamSendRef.current.set(paramId, {
                value: boundedCombinedValue,
                sentAtMs: detectEnd,
              });
            }
            mappingValuesRef.current = nextMappingValues;
            liveParamValuesRef.current = nextLiveParamValues;

            if (poseErrorRef.current) {
              setPoseErrorState(null);
            }
          } catch (error) {
            if (!poseErrorRef.current) {
              setPoseErrorState(
                error instanceof Error
                  ? error.message
                  : 'Pose detection failed for the current frame.',
              );
            }
          }
        }

        const result = poseResultRef.current;
        if (result) {
          drawPoseSkeleton(context, result, sourceWidth, sourceHeight, settings.mirror);
        }

        hudMetricsRef.current.renderFps = updateFps(renderFpsRef.current, nowMs);

        const hudStatus = poseErrorRef.current
          ? `Pose ERROR: ${poseErrorRef.current}`
          : poseReady
            ? 'Pose READY'
            : 'Pose LOADING';
        drawHud(context, hudMetricsRef.current, hudStatus);

        if (nowMs - lastSnapshotRef.current >= 250) {
          setHudSnapshot({ ...hudMetricsRef.current });
          setMappingSnapshot({ ...mappingValuesRef.current });
          setLiveParamSnapshot({ ...liveParamValuesRef.current });
          lastSnapshotRef.current = nowMs;
        }
      } else {
        context.fillStyle = '#090b12';
        context.fillRect(0, 0, canvasElement.width, canvasElement.height);
      }

      frameHandleRef.current = window.requestAnimationFrame(renderFrame);
    };

    frameHandleRef.current = window.requestAnimationFrame(renderFrame);

    return () => {
      disposed = true;
      if (frameHandleRef.current !== null) {
        window.cancelAnimationFrame(frameHandleRef.current);
      }
    };
  }, [
    outputSettings.oscParamPrefix,
    outputSettings.protocol,
    poseReady,
    poseRuntimeConfig.inferenceIntervalMs,
    poseRuntimeConfig.newFrameOnly,
    settings.mirror,
  ]);

  useEffect(() => {
    let disposed = false;
    const startMs = performance.now();
    outputWaveformLastStepMsRef.current = startMs;
    outputWaveformLastDrawMsRef.current = startMs;

    const renderWaveform = (): void => {
      if (disposed) {
        return;
      }

      const nowMs = performance.now();
      const deltaSeconds = Math.max(
        0.001,
        Math.min(0.1, (nowMs - outputWaveformLastStepMsRef.current) / 1000),
      );
      outputWaveformLastStepMsRef.current = nowMs;

      const params = liveParamValuesRef.current;
      const grainActivity = estimateGrainActivity(params);
      const amplitudeNorm = toNormalizedAmplitudeFromDb(params.amplitude);
      const intermittency = clamp01(params.intermittency);
      const outputLevel = amplitudeNorm * (0.2 + grainActivity.density * 0.8) * (1 - intermittency * 0.7);
      const sourceWaveformSamples = sourceWaveformSamplesRef.current;
      const hasWaveformSource = Boolean(sourceWaveformSamples && sourceWaveformSamples.length > 0);
      const waveformSamplesForDisplay = sourceWaveformSamples || EMPTY_WAVEFORM_SAMPLES;

      const scanBeginNorm = wrap01(params.scanBegin);
      const scanRange = clamp(params.scanRange, -1, 1);
      const scanRangeForMotion = Math.max(0.001, Math.abs(scanRange));
      const scanSpeed = clamp(params.scanSpeed, -32, 32);
      const scanSpeedMagnitude = Math.abs(scanSpeed);
      const scanSpeedNorm = Math.min(1, scanSpeedMagnitude / 32);
      const scanVelocityNormPerSecond = 0.02 + scanSpeedNorm * 0.85;
      const localDirection = audioBridgeSettingsRef.current.playheadDirection;
      const localTransportRunning = transportRunningRef.current;

      let simulatedPlayheadNorm = scanBeginNorm;
      if (!localTransportRunning || scanSpeedMagnitude < 0.0001) {
        scanPlayheadProgressRef.current = 0;
        scanRandomJumpAccumulatorRef.current = 0;
        scanRandomJumpPositionRef.current = 0;
      } else if (localDirection === 'random') {
        const jumpsPerSecond = 1 + scanSpeedNorm * 14;
        scanRandomJumpAccumulatorRef.current += jumpsPerSecond * deltaSeconds;
        while (scanRandomJumpAccumulatorRef.current >= 1) {
          scanRandomJumpAccumulatorRef.current -= 1;
          scanRandomJumpPositionRef.current = Math.random();
        }
        simulatedPlayheadNorm = wrap01(
          scanBeginNorm + scanRandomJumpPositionRef.current * scanRangeForMotion,
        );
      } else {
        const progressDelta = (scanVelocityNormPerSecond / Math.max(0.03, scanRangeForMotion)) * deltaSeconds;
        const direction = localDirection === 'reverse' ? -1 : 1;
        scanPlayheadProgressRef.current = wrap01(
          scanPlayheadProgressRef.current + progressDelta * direction,
        );
        simulatedPlayheadNorm = wrap01(
          scanBeginNorm + scanPlayheadProgressRef.current * scanRangeForMotion,
        );
      }
      const engineTelemetry = engineScanTelemetryRef.current;
      const engineTelemetryAgeMs =
        engineScanTelemetryAtMsRef.current > 0
          ? nowMs - engineScanTelemetryAtMsRef.current
          : Number.POSITIVE_INFINITY;
      const hasFreshEngineTelemetry = Boolean(engineTelemetry && engineTelemetryAgeMs <= 1200);
      const scanHeadNorm =
        hasFreshEngineTelemetry && engineTelemetry
          ? wrap01(engineTelemetry.scanHeadNorm)
          : scanBeginNorm;
      const scanRangeForDisplay =
        hasFreshEngineTelemetry && engineTelemetry
          ? clamp(engineTelemetry.scanRangeNorm, 0.001, 1)
          : scanRangeForMotion;
      const playheadNorm =
        hasFreshEngineTelemetry && engineTelemetry
          ? wrap01(engineTelemetry.playheadNorm)
          : simulatedPlayheadNorm;
      const scanSegments = getScanSegments(scanHeadNorm, scanRangeForDisplay);

      const traces = scanGrainTracesRef.current;
      if (hasFreshEngineTelemetry && engineTelemetry) {
        traces.length = 0;
        const sourcePositions = engineTelemetry.activeGrainNormPositions;
        const traceCount = Math.min(1600, sourcePositions.length);
        for (let grainIndex = 0; grainIndex < traceCount; grainIndex += 1) {
          const positionNorm = wrap01(sourcePositions[grainIndex] ?? 0);
          traces.push({
            positionNorm,
            regionIndex: getScanRegionIndex(positionNorm),
            ageSeconds: 0,
            ttlSeconds: 0.22,
            jitter: ((grainIndex * 0.6180339887) % 1 + 1) % 1,
          });
        }
      } else {
        for (const trace of traces) {
          trace.ageSeconds += deltaSeconds;
        }
        let compactWriteIndex = 0;
        for (let readIndex = 0; readIndex < traces.length; readIndex += 1) {
          const trace = traces[readIndex];
          if (!trace || trace.ageSeconds >= trace.ttlSeconds) {
            continue;
          }
          traces[compactWriteIndex] = trace;
          compactWriteIndex += 1;
        }
        traces.length = compactWriteIndex;

        const emissionEstimate = grainActivity.grainsPerSecond * deltaSeconds;
        const emissionCount =
          Math.min(128, Math.floor(emissionEstimate) + (Math.random() < emissionEstimate % 1 ? 1 : 0));
        const asynchronicity = clamp01(params.asynchronicity);
        const streamSpread = clamp01((params.streams - 1) / 19);
        const emissionJitter =
          scanRangeForMotion * (0.015 + asynchronicity * 0.35 + streamSpread * 0.18);
        const traceTtlBaseSeconds = clamp(params.grainDuration / 1000, 0.04, 1.4);

        for (let grainIndex = 0; grainIndex < emissionCount; grainIndex += 1) {
          const positionNorm =
            wrap01(playheadNorm + (Math.random() * 2 - 1) * Math.max(0.002, emissionJitter));
          const regionIndex = getScanRegionIndex(positionNorm);
          traces.push({
            positionNorm,
            regionIndex,
            ageSeconds: 0,
            ttlSeconds: clamp(traceTtlBaseSeconds * (0.65 + Math.random() * 1.35), 0.08, 1.8),
            jitter: Math.random(),
          });
        }

        if (traces.length > 1600) {
          traces.splice(0, traces.length - 1600);
        }
      }

      const regionCounts: ScanRegionTuple = [0, 0, 0, 0];
      const regionEnergy: ScanRegionTuple = [0, 0, 0, 0];
      for (const trace of traces) {
        const regionIndex = trace.regionIndex;
        const life = Math.max(0, 1 - trace.ageSeconds / trace.ttlSeconds);
        regionCounts[regionIndex] += 1;
        regionEnergy[regionIndex] += life;
      }
      const activeGrainCountForTelemetry =
        hasFreshEngineTelemetry && engineTelemetry
          ? Math.max(engineTelemetry.activeGrainCount, traces.length)
          : grainActivity.activeGrains;
      const normalization = hasFreshEngineTelemetry
        ? Math.max(4, activeGrainCountForTelemetry * 0.4)
        : Math.max(8, grainActivity.activeGrains * 0.08);
      const regionLevels: ScanRegionTuple = [
        clamp01(regionEnergy[0] / normalization),
        clamp01(regionEnergy[1] / normalization),
        clamp01(regionEnergy[2] / normalization),
        clamp01(regionEnergy[3] / normalization),
      ];
      const dominantRegion = getDominantScanRegion(regionLevels);

      if (nowMs - scanTelemetryLastUpdateMsRef.current >= 125) {
        setScanTelemetrySnapshot({
          source: hasFreshEngineTelemetry ? 'engine' : 'estimated',
          telemetryAgeMs: hasFreshEngineTelemetry ? Math.max(0, engineTelemetryAgeMs) : 0,
          playheadNorm,
          scanHeadNorm,
          scanRangeNorm: scanRangeForDisplay,
          activeGrainCount: activeGrainCountForTelemetry,
          dominantRegion,
          regionCounts,
          regionLevels,
        });
        scanTelemetryLastUpdateMsRef.current = nowMs;
      }

      if (nowMs - outputWaveformLastDrawMsRef.current >= OUTPUT_WAVEFORM_DRAW_INTERVAL_MS) {
        const waveformCanvas = outputWaveformCanvasRef.current;
        if (waveformCanvas) {
          drawScanDisplayCanvas(
            waveformCanvas,
            waveformSamplesForDisplay,
            hasWaveformSource,
            outputLevel,
            scanSegments,
            scanHeadNorm,
            playheadNorm,
            traces,
            regionLevels,
          );
        }
        outputWaveformLastDrawMsRef.current = nowMs;
      }

      waveformHandleRef.current = window.requestAnimationFrame(renderWaveform);
    };

    waveformHandleRef.current = window.requestAnimationFrame(renderWaveform);

    return () => {
      disposed = true;
      if (waveformHandleRef.current !== null) {
        window.cancelAnimationFrame(waveformHandleRef.current);
      }
    };
  }, []);

  const onCameraChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setSettings((current) => ({ ...current, deviceId: value }));
  };

  const onResolutionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value as ResolutionPreset;
    setSettings((current) => ({ ...current, resolution: value }));
  };

  const onFpsChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value) as TargetFps;
    setSettings((current) => ({ ...current, targetFps: value }));
  };

  const onMirrorChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.checked;
    setSettings((current) => ({ ...current, mirror: value }));
  };

  const onProtocolChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const protocol = event.target.value as OutputProtocol;
    setOutputSettings((current) => ({
      ...current,
      protocol,
    }));
  };

  const onManagedLocalEngineChange = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    setOutputSettings((current) =>
      lockManagedOscTarget({
        ...current,
        managedLocalEngine: enabled,
      }),
    );

    if (enabled) {
      setEngineFeedback('Managed local engine mode enabled. OSC target locked to 127.0.0.1:16447.');
      return;
    }

    setEngineFeedback('Managed local engine mode disabled. Remote OSC target editing is enabled.');
  };

  const onManagedStartupTransportAutostartChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const enabled = event.target.checked;
    setOutputSettings((current) => ({
      ...current,
      managedStartupTransportAutostart: enabled,
    }));

    if (enabled) {
      setEngineFeedback(
        'Startup transport policy enabled: /transport 1 will be sent once after startup gate readiness.',
      );
      return;
    }

    setEngineFeedback('Startup transport policy disabled: no implicit /transport command on startup.');
  };

  const onMidiDeviceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setOutputSettings((current) => ({
      ...current,
      midiDeviceId: value,
    }));
  };

  const onEc2VersionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const version = event.target.value as Ec2Version;
    setOutputSettings((current) => ({
      ...current,
      ec2Version: version,
      ec2ProfileId: getDefaultProfileIdForVersion(version),
    }));
  };

  const onEc2ProfileChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const profileId = event.target.value;
    setOutputSettings((current) => ({
      ...current,
      ec2ProfileId: profileId,
    }));
  };

  const onMasterAmplitudeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextAmplitude = clamp(
      parseFiniteNumber(event.target.value, audioBridgeSettings.masterAmplitudeDb),
      MASTER_AMPLITUDE_MIN_DB,
      MASTER_AMPLITUDE_MAX_DB,
    );
    setAudioBridgeSettings((current) => ({
      ...current,
      masterAmplitudeDb: nextAmplitude,
    }));
    liveParamValuesRef.current = {
      ...liveParamValuesRef.current,
      amplitude: nextAmplitude,
    };
  };

  const onPlayheadDirectionChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const rawDirection = event.target.value.trim();
    const nextDirection = isPlayheadDirectionMode(rawDirection)
      ? rawDirection
      : DEFAULT_AUDIO_BRIDGE_SETTINGS.playheadDirection;

    setAudioBridgeSettings((current) => ({
      ...current,
      playheadDirection: nextDirection,
    }));

    sendOscMessage('/playheadDirection', [{ type: 's', value: nextDirection }]);
    if (outputSettings.protocol !== 'osc') {
      setAudioBridgeFeedback(
        `Selected playhead mode: ${nextDirection}. Switch protocol to OSC to send it to EC2.`,
      );
      return;
    }

    setAudioBridgeFeedback(`Playhead mode set: ${nextDirection}.`);
  };

  const onAudioOutputDeviceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextDeviceId = event.target.value;
    const nextDevice = audioOutputDevices.find((device) => device.id === nextDeviceId);
    setAudioBridgeSettings((current) => ({
      ...current,
      audioOutputDeviceId: nextDeviceId,
      audioOutputDeviceName: nextDevice?.ec2DeviceName || current.audioOutputDeviceName,
    }));
  };

  const onAudioOutputDeviceNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioBridgeSettings((current) => ({
      ...current,
      audioOutputDeviceName: event.target.value,
    }));
  };

  const onApplyAudioOutputDevice = (): void => {
    const requestedNameOverride = audioBridgeSettings.audioOutputDeviceName.trim();
    if (requestedNameOverride) {
      sendOscMessage('/audioDevice', [{ type: 's', value: requestedNameOverride }]);
      if (outputSettings.protocol !== 'osc') {
        setAudioBridgeFeedback(
          `Prepared output device: ${requestedNameOverride}. Switch protocol to OSC to send it to EC2.`,
        );
        return;
      }

      setAudioBridgeFeedback(`Main audio output request sent: ${requestedNameOverride}`);
      return;
    }

    const selectedDeviceId = audioBridgeSettings.audioOutputDeviceId || audioOutputDevices[0]?.id || '';
    const selectedDevice = audioOutputDevices.find(
      (device) => device.id === selectedDeviceId,
    );
    if (!selectedDevice) {
      setAudioBridgeFeedback('Select an audio output device, then apply it.');
      return;
    }

    const hasAnonymousLabel =
      selectedDevice.id !== 'default' && isAnonymousAudioOutputLabel(selectedDevice.ec2DeviceName);
    if (hasAnonymousLabel) {
      setAudioBridgeFeedback(
        'Output labels are hidden in this runtime. Enter the exact EC2 audio device name, or use System Default.',
      );
      return;
    }

    sendOscMessage('/audioDevice', [{ type: 's', value: selectedDevice.ec2DeviceName }]);
    if (outputSettings.protocol !== 'osc') {
      setAudioBridgeFeedback(
        `Selected output device: ${selectedDevice.label}. Switch protocol to OSC to send it to EC2.`,
      );
      return;
    }

    setAudioBridgeFeedback(`Main audio output request sent: ${selectedDevice.label}`);
  };

  const onAudioOutputDeviceNameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    onApplyAudioOutputDevice();
  };

  const selectSoundSourceByIndex = useCallback(
    (index: number, soundSources: string[]): void => {
      const safeIndex = Math.max(1, Math.trunc(index));
      const sourcePath = soundSources[safeIndex - 1] || '';

      setAudioBridgeSettings((current) => ({
        ...current,
        soundFileIndex: safeIndex,
        soundFilePath: sourcePath || current.soundFilePath,
        selectedSoundSourcePath: sourcePath || current.selectedSoundSourcePath,
      }));

      liveParamValuesRef.current = {
        ...liveParamValuesRef.current,
        soundFile: safeIndex,
      };

      sendOscMessage('/SoundFile', [{ type: 'f', value: safeIndex }]);
    },
    [sendOscMessage],
  );

  const loadSoundFilePath = useCallback(
    (rawPath: string): void => {
      const soundFilePath = rawPath.trim();
      if (!soundFilePath) {
        setAudioBridgeFeedback('Provide a sound file path or use the picker.');
        return;
      }

      const nextSoundSources = upsertSoundSourceList(audioBridgeSettings.soundSources, soundFilePath);
      const nextIndex = resolveSoundSourceIndex(nextSoundSources, soundFilePath);
      setAudioBridgeSettings((current) => ({
        ...current,
        soundFilePath,
        soundFileIndex: nextIndex,
        soundSources: nextSoundSources,
        selectedSoundSourcePath: soundFilePath,
      }));

      liveParamValuesRef.current = {
        ...liveParamValuesRef.current,
        soundFile: nextIndex,
      };

      sendOscMessage('/loadSoundFile', [{ type: 's', value: soundFilePath }]);
      sendOscMessage('/SoundFile', [{ type: 'f', value: nextIndex }]);
      if (outputSettings.protocol !== 'osc') {
        setAudioBridgeFeedback(
          `Selected source #${nextIndex}: ${getDisplayNameFromPath(soundFilePath)}. Switch protocol to OSC to send it to EC2.`,
        );
      } else {
        setAudioBridgeFeedback(`Loaded source #${nextIndex}: ${getDisplayNameFromPath(soundFilePath)}`);
      }
    },
    [audioBridgeSettings.soundSources, outputSettings.protocol, sendOscMessage],
  );

  useEffect(() => {
    if (defaultStaticWavAttemptedRef.current) {
      return;
    }

    if (
      audioBridgeSettings.soundSources.length > 0 ||
      audioBridgeSettings.selectedSoundSourcePath.trim().length > 0 ||
      audioBridgeSettings.soundFilePath.trim().length > 0
    ) {
      return;
    }

    const defaultWavResolver = window.granuPose?.dialog?.getDefaultStaticWavPath;
    if (!defaultWavResolver) {
      return;
    }

    defaultStaticWavAttemptedRef.current = true;
    void (async () => {
      try {
        const result = await defaultWavResolver();
        if (!result.ok || typeof result.filePath !== 'string' || result.filePath.trim().length === 0) {
          return;
        }

        loadSoundFilePath(result.filePath);
      } catch {
        // Silent fallback: user can still pick a WAV manually.
      }
    })();
  }, [
    audioBridgeSettings.selectedSoundSourcePath,
    audioBridgeSettings.soundFilePath,
    audioBridgeSettings.soundSources.length,
    loadSoundFilePath,
  ]);

  const onSoundFilePathChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioBridgeSettings((current) => ({
      ...current,
      soundFilePath: event.target.value,
    }));
  };

  const onSoundSourceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const selectedPath = event.target.value;
    if (!selectedPath) {
      return;
    }

    const nextIndex = resolveSoundSourceIndex(audioBridgeSettings.soundSources, selectedPath);
    setAudioBridgeSettings((current) => ({
      ...current,
      selectedSoundSourcePath: selectedPath,
      soundFilePath: selectedPath,
      soundFileIndex: nextIndex,
    }));

    liveParamValuesRef.current = {
      ...liveParamValuesRef.current,
      soundFile: nextIndex,
    };

    sendOscMessage('/SoundFile', [{ type: 'f', value: nextIndex }]);
    setAudioBridgeFeedback(`Selected source #${nextIndex}: ${getDisplayNameFromPath(selectedPath)}`);
  };

  const onSoundFileIndexChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioBridgeSettings((current) => ({
      ...current,
      soundFileIndex: parseNumberInRange(event.target.value, current.soundFileIndex, 1, 9999),
    }));
  };

  const onRecordFileNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioBridgeSettings((current) => ({
      ...current,
      recordFileName: event.target.value,
    }));
  };

  const onOutputFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioBridgeSettings((current) => ({
      ...current,
      outputFolder: event.target.value,
    }));
  };

  const onSelectSoundFile = async (): Promise<void> => {
    const electronDialog = window.granuPose?.dialog;
    if (electronDialog) {
      try {
        const preferredPath =
          audioBridgeSettings.selectedSoundSourcePath || audioBridgeSettings.soundFilePath;
        const defaultPath = getDirectoryFromPath(preferredPath);
        const result = await electronDialog.pickWavFile(
          defaultPath ? { defaultPath } : undefined,
        );
        if (!result.ok) {
          setAudioBridgeFeedback(result.error || 'Failed to open the file picker.');
          return;
        }

        if (!result.canceled && result.filePath) {
          loadSoundFilePath(result.filePath);
        }
      } catch (error) {
        setAudioBridgeFeedback(error instanceof Error ? error.message : 'Failed to open the file picker.');
      }
      return;
    }

    const browserInput = browserWavInputRef.current;
    if (browserInput) {
      browserInput.value = '';
      browserInput.click();
      return;
    }

    setAudioBridgeFeedback('File picker is not available in this runtime.');
  };

  const onApplySoundSourceIndex = (): void => {
    const index = parseNumberInRange(audioBridgeSettings.soundFileIndex, 1, 1, 9999);
    selectSoundSourceByIndex(index, audioBridgeSettings.soundSources);
    setAudioBridgeFeedback(`Selected source index ${index}.`);
  };

  const onBrowserWavSelected = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    const pickedName = selectedFile.name;
    const normalizedPickedName = normalizePathForCompare(pickedName);
    sourceWaveformSamplesRef.current = null;

    setAudioBridgeSettings((current) => {
      const nextSoundSources = upsertSoundSourceList(current.soundSources, pickedName);
      const nextIndex = resolveSoundSourceIndex(nextSoundSources, pickedName);
      return {
        ...current,
        soundFilePath: pickedName,
        selectedSoundSourcePath: pickedName,
        soundSources: nextSoundSources,
        soundFileIndex: nextIndex,
      };
    });

    event.target.value = '';

    try {
      const sourceBuffer = await selectedFile.arrayBuffer();
      const waveformSamples = await cacheWaveformSamplesForSource(pickedName, sourceBuffer);
      if (
        normalizePathForCompare(audioBridgeSettingsRef.current.selectedSoundSourcePath) ===
        normalizedPickedName
      ) {
        sourceWaveformSamplesRef.current = waveformSamples;
      }
    } catch {
      if (
        normalizePathForCompare(audioBridgeSettingsRef.current.selectedSoundSourcePath) ===
        normalizedPickedName
      ) {
        sourceWaveformSamplesRef.current = null;
      }
    }

    if (outputSettings.protocol !== 'osc') {
      setAudioBridgeFeedback(
        `Selected ${pickedName}. Switch protocol to OSC to load into EC2.`,
      );
    } else {
      setAudioBridgeFeedback(
        `Selected ${pickedName} in browser mode. Paste full path or run desktop Electron for direct host file loading.`,
      );
    }
  };

  const onApplyRecordFileName = (): void => {
    const fileName = audioBridgeSettings.recordFileName.trim() || 'pose_take.wav';
    setAudioBridgeSettings((current) => ({
      ...current,
      recordFileName: fileName,
    }));
    sendOscMessage('/fileName', [{ type: 's', value: fileName }]);
  };

  const onApplyOutputFolder = (): void => {
    const folder = audioBridgeSettings.outputFolder.trim();
    if (!folder) {
      setAudioBridgeFeedback('Set an output folder path before applying.');
      return;
    }
    sendOscMessage('/outputFolder', [{ type: 's', value: folder }]);
    setAudioBridgeFeedback(`Output folder applied: ${folder}`);
    void refreshRecordingFiles(false, folder);
  };

  const onBrowseOutputFolder = async (): Promise<void> => {
    const electronDialog = window.granuPose?.dialog;
    if (!electronDialog) {
      return;
    }

    try {
      const result = await electronDialog.pickDirectory();
      if (!result.ok) {
        setAudioBridgeFeedback(result.error || 'Failed to open the folder picker.');
        return;
      }

      if (!result.canceled && result.directoryPath) {
        setAudioBridgeSettings((current) => ({
          ...current,
          outputFolder: result.directoryPath || current.outputFolder,
        }));
        setAudioBridgeFeedback(`Output folder set: ${result.directoryPath}`);
        void refreshRecordingFiles(true, result.directoryPath);
      }
    } catch (error) {
      setAudioBridgeFeedback(
        error instanceof Error ? error.message : 'Failed to open the folder picker.',
      );
    }
  };

  const applyOscTarget = (): void => {
    const nextHost = outputSettings.managedLocalEngine
      ? MANAGED_ENGINE_OSC_HOST
      : oscTargetHostInput.trim() || DEFAULT_OUTPUT_SETTINGS.oscTargetHost;
    const nextPort = outputSettings.managedLocalEngine
      ? MANAGED_ENGINE_OSC_PORT
      : parseNumberInRange(oscTargetPortInput, outputSettings.oscTargetPort, 1, 65535);
    const nextPrefix = oscParamPrefixInput.trim();
    setOutputSettings((current) =>
      lockManagedOscTarget({
        ...current,
        oscTargetHost: nextHost,
        oscTargetPort: nextPort,
        oscParamPrefix: nextPrefix,
      }),
    );
    setOscTargetHostInput(nextHost);
    setOscTargetPortInput(String(nextPort));
    setOscParamPrefixInput(nextPrefix);
  };

  const runEngineCommand = useCallback(
    async (command: 'start' | 'stop' | 'restart'): Promise<void> => {
      const engineApi = window.granuPose?.engine;
      if (!engineApi) {
        setEngineFeedback('Engine control is unavailable in this runtime.');
        return;
      }

      setEngineActionBusy(true);
      try {
        const result =
          command === 'start'
            ? await engineApi.start()
            : command === 'stop'
              ? await engineApi.stop()
              : await engineApi.restart();
        setEngineStatus(result);

        if (result.ok) {
          setEngineFeedback(`Engine ${command} command accepted (${result.status}).`);
        } else {
          setEngineFeedback(result.lastError || `Engine ${command} command failed.`);
        }
      } catch (error) {
        setEngineFeedback(
          error instanceof Error ? error.message : `Engine ${command} command failed.`,
        );
      } finally {
        setEngineActionBusy(false);
      }
    },
    [],
  );

  const onTransportStart = (): void => {
    const selectedDirection = audioBridgeSettings.playheadDirection;
    sendOscMessage('/playheadDirection', [{ type: 's', value: selectedDirection }]);
    sendOscMessage('/transport', [{ type: 'i', value: 1 }]);
    setIsTransportRunning(true);
    setAudioBridgeFeedback(`Audio engine ON (${selectedDirection}).`);
  };

  const onTransportStop = (): void => {
    sendOscMessage('/transport', [{ type: 'i', value: 0 }]);
    setIsTransportRunning(false);
    setAudioBridgeFeedback('Audio engine OFF.');
  };

  const onRecordStart = (): void => {
    onApplyRecordFileName();
    setIsRecording(true);
    sendOscMessage('/record', [{ type: 'i', value: 1 }]);
  };

  const onRecordStop = (): void => {
    setIsRecording(false);
    sendOscMessage('/record', [{ type: 'i', value: 0 }]);
    const outputFolder = audioBridgeSettingsRef.current.outputFolder.trim();
    if (outputFolder) {
      window.setTimeout(() => {
        void refreshRecordingFiles(false, outputFolder);
      }, 400);
    }
  };

  const statusTone = getStatusTone(outputStatus);
  const engineRuntimeStatus = engineStatus?.status ?? null;
  const engineStatusTone = getEngineStatusTone(engineRuntimeStatus);
  const engineStatusLabel = engineRuntimeStatus ?? 'unavailable';
  const managedOscLocked = outputSettings.managedLocalEngine;
  const managedHelloGateActive = managedOscLocked && outputSettings.protocol === 'osc' && hasManagedElectronRuntime;
  const managedHelloWaitRemainingMs =
    managedHelloGateActive &&
    engineStatus?.status === 'running' &&
    !engineHelloForCurrentRun &&
    !managedEngineHelloTimedOut &&
    engineStartedAtMs != null
      ? Math.max(0, MANAGED_ENGINE_HELLO_TIMEOUT_MS - (Date.now() - engineStartedAtMs))
      : 0;
  const managedEngineGateLabel =
    !managedHelloGateActive
      ? 'Startup gate: disabled.'
      : engineStatus?.status !== 'running'
        ? 'Startup gate: waiting for engine runtime.'
        : engineHelloForCurrentRun
          ? 'Startup gate: /ec2/hello received.'
          : managedEngineHelloTimedOut
            ? 'Startup gate: /ec2/hello timeout, continuing with fallback.'
            : `Startup gate: waiting for /ec2/hello (${Math.ceil(managedHelloWaitRemainingMs)} ms).`;
  const hasMidiOutputs = midiDevices.length > 0;
  const versionProfiles = getProfilesForVersion(outputSettings.ec2Version);
  const selectedProfile =
    getProfileById(outputSettings.ec2ProfileId) ||
    getProfileById(getDefaultProfileIdForVersion(outputSettings.ec2Version));
  const capabilityAdvanced = Boolean(selectedProfile?.capabilities.advancedOsc);
  const capabilityLfo = Boolean(selectedProfile?.capabilities.lfoModulation);
  const capabilityMorph = Boolean(selectedProfile?.capabilities.morphTimeOsc);
  const oscControlDisabled = outputSettings.protocol !== 'osc';
  const activeMappingCount = poseMappings.filter(
    (mapping) => mapping.enabled && Boolean(mapping.poseSignalId) && Boolean(mapping.paramId),
  ).length;
  const hasNativeDialog = Boolean(window.granuPose?.dialog);
  const hasAudioOutputDevices = audioOutputDevices.length > 0;
  const hasAudioOutputOverride = audioBridgeSettings.audioOutputDeviceName.trim().length > 0;
  const selectedAudioOutputDeviceId =
    audioBridgeSettings.audioOutputDeviceId || audioOutputDevices[0]?.id || '';
  const grainActivity = estimateGrainActivity(liveParamSnapshot);
  const amplitudeNorm = toNormalizedAmplitudeFromDb(liveParamSnapshot.amplitude);
  const hasEngineScanTelemetry = scanTelemetrySnapshot.source === 'engine';
  const displayActiveGrainCount = hasEngineScanTelemetry
    ? scanTelemetrySnapshot.activeGrainCount
    : grainActivity.activeGrains;
  const displayActiveGrainDensity = clamp01(displayActiveGrainCount / MAX_ACTIVE_GRAINS);
  const performanceTelemetryLabel = hasEngineScanTelemetry
    ? `Live from EC2 telemetry (${scanTelemetrySnapshot.telemetryAgeMs.toFixed(0)} ms old)`
    : 'Estimated from outgoing EC2 controls';
  const dominantScanRegionLabel = SCAN_REGION_LABELS[scanTelemetrySnapshot.dominantRegion];
  const soundSourceOptions = audioBridgeSettings.soundSources;
  const hasSoundSources = soundSourceOptions.length > 0;
  const selectedSourcePath =
    audioBridgeSettings.selectedSoundSourcePath || soundSourceOptions[0] || '';

  return (
    <div className="app-shell">
      <header className="toolbar">
        <h1>Granular Synth Pose Controller</h1>
        <div className="toolbar-grid">
          <label>
            Camera
            <select value={settings.deviceId} onChange={onCameraChange}>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {formatDeviceLabel(device, index)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Resolution
            <select value={settings.resolution} onChange={onResolutionChange}>
              {RESOLUTION_OPTIONS.map((resolution) => (
                <option key={resolution} value={resolution}>
                  {resolution}
                </option>
              ))}
            </select>
          </label>

          <label>
            Target FPS
            <select value={settings.targetFps} onChange={onFpsChange}>
              {FPS_OPTIONS.map((fps) => (
                <option key={fps} value={fps}>
                  {fps}
                </option>
              ))}
            </select>
          </label>

          <label className="checkbox">
            <input type="checkbox" checked={settings.mirror} onChange={onMirrorChange} />
            Mirror
          </label>
        </div>

        <section className="output-panel" aria-label="Output Configuration">
          <div className="output-panel-header">
            <div className={`connection-indicator ${statusTone}`} />
            <span className="output-protocol-label">
              {outputSettings.protocol.toUpperCase()} {outputStatus}
            </span>
            <span className="output-rate">{outputSendRate.toFixed(1)} msgs/sec</span>
          </div>

          <div className="output-grid">
            <label>
              Protocol
              <select value={outputSettings.protocol} onChange={onProtocolChange}>
                <option value="osc">OSC</option>
                <option value="midi">MIDI</option>
              </select>
            </label>

            <label className="checkbox managed-engine-toggle">
              <input
                type="checkbox"
                checked={outputSettings.managedLocalEngine}
                onChange={onManagedLocalEngineChange}
              />
              Managed Local Engine
            </label>

            <label className="checkbox managed-engine-toggle">
              <input
                type="checkbox"
                checked={outputSettings.managedStartupTransportAutostart}
                onChange={onManagedStartupTransportAutostartChange}
                disabled={outputSettings.protocol !== 'osc' || !outputSettings.managedLocalEngine}
              />
              Startup Auto Transport (/transport 1)
            </label>

            <label>
              EC2 Version
              <select value={outputSettings.ec2Version} onChange={onEc2VersionChange}>
                <option value="v1.2">v1.2</option>
                <option value="v1.3+">v1.3+</option>
                <option value="custom">custom</option>
              </select>
            </label>

            <label>
              OSC Profile
              <select value={outputSettings.ec2ProfileId} onChange={onEc2ProfileChange}>
                {versionProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              OSC Target IP
              <input
                type="text"
                value={oscTargetHostInput}
                onChange={(event) => setOscTargetHostInput(event.target.value)}
                disabled={oscControlDisabled || managedOscLocked}
              />
            </label>

            <label>
              OSC Target Port
              <input
                type="number"
                value={oscTargetPortInput}
                onChange={(event) => setOscTargetPortInput(event.target.value)}
                disabled={oscControlDisabled || managedOscLocked}
              />
            </label>

            <label>
              OSC Param Prefix
              <input
                type="text"
                value={oscParamPrefixInput}
                onChange={(event) => setOscParamPrefixInput(event.target.value)}
                placeholder="/ec2"
                disabled={oscControlDisabled}
              />
            </label>

            <label>
              MIDI Device
              <select
                value={outputSettings.midiDeviceId}
                onChange={onMidiDeviceChange}
                disabled={outputSettings.protocol !== 'midi'}
              >
                <option value="">
                  {hasMidiOutputs ? 'Default MIDI Output' : 'No MIDI outputs found'}
                </option>
                {midiDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="apply-button"
              onClick={applyOscTarget}
              disabled={oscControlDisabled}
            >
              Apply OSC Settings
            </button>
          </div>

          {managedOscLocked ? (
            <div className="mapping-note">Managed mode lock active: OSC target fixed to 127.0.0.1:16447.</div>
          ) : (
            <div className="mapping-note">Remote mode active: OSC target is editable.</div>
          )}
          <div className="mapping-note">
            {outputSettings.managedStartupTransportAutostart
              ? 'Startup transport policy: enabled (send /transport 1 once after startup gate readiness).'
              : 'Startup transport policy: disabled (no implicit /transport command on startup).'}
          </div>

          <div className="capability-row">
            <span className={`capability-chip ${capabilityAdvanced ? 'on' : 'off'}`}>Advanced OSC</span>
            <span className={`capability-chip ${capabilityLfo ? 'on' : 'off'}`}>LFO Mod OSC</span>
            <span className={`capability-chip ${capabilityMorph ? 'on' : 'off'}`}>Morph Time OSC</span>
            <span className="profile-note">{selectedProfile?.notes || 'No profile selected.'}</span>
          </div>

          <section className="engine-panel" aria-label="Managed Engine Control">
            <div className="mapping-panel-header">
              <h2>Managed Engine</h2>
              <span className={`bridge-mode ${managedOscLocked ? 'on' : 'off'}`}>
                {managedOscLocked ? 'Standalone Local' : 'Remote Target'}
              </span>
            </div>

            <div className="engine-grid">
              <div className={`engine-status-chip ${engineStatusTone}`}>
                Engine {engineStatusLabel}
                {engineStatus?.pid ? ` (PID ${engineStatus.pid})` : ''}
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void runEngineCommand('start');
                }}
                disabled={engineActionBusy}
              >
                Start
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void runEngineCommand('stop');
                }}
                disabled={engineActionBusy}
              >
                Stop
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void runEngineCommand('restart');
                }}
                disabled={engineActionBusy}
              >
                Restart
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowEngineLogs((current) => !current)}
              >
                {showEngineLogs ? 'Hide Logs' : 'Show Logs'}
              </button>
            </div>

            {managedHelloGateActive ? (
              <div className="mapping-note">{managedEngineGateLabel}</div>
            ) : null}
            {startupAuditTrail.length > 0 ? (
              <div className="startup-audit-trail">
                {startupAuditTrail.slice(-6).map((line, index) => (
                  <div key={`${line}-${index}`}>{line}</div>
                ))}
              </div>
            ) : null}

            {engineFeedback ? <div className="audio-bridge-feedback">{engineFeedback}</div> : null}
            {engineStatus?.lastError ? (
              <div className="audio-bridge-feedback">Engine error: {engineStatus.lastError}</div>
            ) : null}

            {showEngineLogs ? (
              <pre className="engine-log-tail">
                {engineLogLines.length > 0 ? engineLogLines.join('\n') : 'No engine logs yet.'}
              </pre>
            ) : null}
          </section>

          <section className="mapping-panel" aria-label="Pose To E2C Mapping">
            <div className="mapping-panel-header">
              <h2>Pose To E2C Matrix</h2>
              <div className="mapping-panel-actions">
                <span className="mapping-count">{activeMappingCount}/{poseMappings.length} active</span>
                <button type="button" className="secondary-button" onClick={resetPoseMappings}>
                  Reset Mappings
                </button>
              </div>
            </div>

            <div className="mapping-table-wrap">
              <table className="mapping-table">
                <thead>
                  <tr>
                    <th>On</th>
                    <th>Pose Signal</th>
                    <th>E2C Param</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>Range</th>
                    <th>Offset</th>
                    <th>Combiner</th>
                    <th>Curve</th>
                    <th>Deadzone</th>
                    <th>Smoothing</th>
                    <th>Invert</th>
                    <th>Live</th>
                  </tr>
                </thead>
                <tbody>
                  {poseMappings.map((mapping) => {
                    const param = mapping.paramId ? getEc2ParamById(mapping.paramId) : null;
                    const controlStep = param ? getParamControlStep(param) : 0.01;
                    const liveValue = mappingSnapshot[mapping.id];
                    const transforms = normalizePoseMappingTransformChain(mapping.transforms);
                    const mappingAssigned = Boolean(mapping.poseSignalId) && Boolean(mapping.paramId);

                    return (
                      <tr key={mapping.id} className={mapping.enabled && mappingAssigned ? '' : 'disabled'}>
                        <td>
                          <input
                            type="checkbox"
                            checked={mapping.enabled}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, { enabled: event.target.checked });
                            }}
                          />
                        </td>

                        <td>
                          <select
                            value={mapping.poseSignalId ?? UNASSIGNED_MAPPING_OPTION_VALUE}
                            onChange={(event) => {
                              const signalId = event.target.value;
                              if (!signalId) {
                                updatePoseMapping(mapping.id, { poseSignalId: null });
                                return;
                              }
                              if (!isPoseSignalId(signalId)) {
                                return;
                              }
                              updatePoseMapping(mapping.id, { poseSignalId: signalId });
                            }}
                          >
                            <option value={UNASSIGNED_MAPPING_OPTION_VALUE}>None</option>
                            {POSE_SIGNAL_DEFINITIONS.map((signal) => (
                              <option key={signal.id} value={signal.id}>
                                {signal.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          <select
                            value={mapping.paramId ?? UNASSIGNED_MAPPING_OPTION_VALUE}
                            onChange={(event) => {
                              const nextParamId = event.target.value;
                              if (!nextParamId) {
                                updatePoseMapping(mapping.id, { paramId: null });
                                return;
                              }
                              if (!isEc2ParamId(nextParamId) || !isMatrixParamId(nextParamId)) {
                                return;
                              }
                              const nextParam = getEc2ParamById(nextParamId);
                              updatePoseMapping(mapping.id, {
                                paramId: nextParamId,
                                outputMin: nextParam.defaultRange[0],
                                outputMax: nextParam.defaultRange[1],
                              });
                            }}
                          >
                            <option value={UNASSIGNED_MAPPING_OPTION_VALUE}>None</option>
                            {MATRIX_PARAM_IDS.map((paramId) => (
                              <option key={paramId} value={paramId}>
                                {getMatrixParamLabel(paramId)}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          <input
                            type="number"
                            step={controlStep}
                            value={mapping.outputMin}
                            disabled={!param}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                outputMin: parseFiniteNumber(event.target.value, mapping.outputMin),
                              });
                            }}
                          />
                        </td>

                        <td>
                          <input
                            type="number"
                            step={controlStep}
                            value={mapping.outputMax}
                            disabled={!param}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                outputMax: parseFiniteNumber(event.target.value, mapping.outputMax),
                              });
                            }}
                          />
                        </td>

                        <td className="mapping-range-cell">
                          {param ? (
                            <div className="mapping-range-slider">
                              <input
                                type="range"
                                min={param.absoluteRange[0]}
                                max={param.absoluteRange[1]}
                                step={controlStep}
                                value={mapping.outputMin}
                                onChange={(event) => {
                                  updatePoseMapping(mapping.id, {
                                    outputMin: parseFiniteNumber(event.target.value, mapping.outputMin),
                                  });
                                }}
                                aria-label={`${param.label} min range`}
                              />
                              <input
                                type="range"
                                min={param.absoluteRange[0]}
                                max={param.absoluteRange[1]}
                                step={controlStep}
                                value={mapping.outputMax}
                                onChange={(event) => {
                                  updatePoseMapping(mapping.id, {
                                    outputMax: parseFiniteNumber(event.target.value, mapping.outputMax),
                                  });
                                }}
                                aria-label={`${param.label} max range`}
                              />
                            </div>
                          ) : (
                            <span className="mapping-unassigned">Select E2C parameter</span>
                          )}
                        </td>

                        <td className="mapping-offset-cell">
                          <input
                            type="range"
                            min="-1"
                            max="1"
                            step="0.01"
                            value={mapping.offset}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                offset: parseFiniteNumber(event.target.value, mapping.offset),
                              });
                            }}
                          />
                          <span>{mapping.offset.toFixed(2)}</span>
                        </td>

                        <td>
                          <select
                            value={mapping.combiner}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                combiner: normalizePoseMappingCombiner(event.target.value),
                              });
                            }}
                          >
                            {POSE_MAPPING_COMBINER_OPTIONS.map((combiner) => (
                              <option key={combiner} value={combiner}>
                                {formatMappingCombinerLabel(combiner)}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td>
                          <select
                            value={transforms.curve}
                            onChange={(event) => {
                              const curve = event.target.value as PoseMappingCurve;
                              updatePoseMapping(mapping.id, {
                                transforms: {
                                  ...transforms,
                                  curve: POSE_MAPPING_CURVE_OPTIONS.includes(curve)
                                    ? curve
                                    : transforms.curve,
                                },
                              });
                            }}
                          >
                            {POSE_MAPPING_CURVE_OPTIONS.map((curve) => (
                              <option key={curve} value={curve}>
                                {formatMappingCurveLabel(curve)}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="mapping-deadzone-cell">
                          <input
                            type="range"
                            min="0"
                            max="0.45"
                            step="0.01"
                            value={transforms.deadzone}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                transforms: {
                                  ...transforms,
                                  deadzone: clamp(
                                    parseFiniteNumber(event.target.value, transforms.deadzone),
                                    0,
                                    0.45,
                                  ),
                                },
                              });
                            }}
                          />
                          <span>{transforms.deadzone.toFixed(2)}</span>
                        </td>

                        <td className="mapping-smoothing-cell">
                          <input
                            type="range"
                            min="0"
                            max="0.98"
                            step="0.01"
                            value={transforms.smoothing}
                            onChange={(event) => {
                              updatePoseMapping(mapping.id, {
                                transforms: {
                                  ...transforms,
                                  smoothing: clamp(
                                    parseFiniteNumber(event.target.value, transforms.smoothing),
                                    0,
                                    0.98,
                                  ),
                                },
                              });
                            }}
                          />
                          <span>{transforms.smoothing.toFixed(2)}</span>
                        </td>

                        <td>
                          <label className="mapping-invert-toggle">
                            <input
                              type="checkbox"
                              checked={Boolean(transforms.invert)}
                              onChange={(event) => {
                                updatePoseMapping(mapping.id, {
                                  transforms: {
                                    ...transforms,
                                    invert: event.target.checked,
                                  },
                                });
                              }}
                            />
                            <span>{transforms.invert ? 'Yes' : 'No'}</span>
                          </label>
                        </td>

                        <td className="mapping-live-cell">
                          {liveValue == null ? '--' : liveValue.toFixed(3)}
                          {param ? <span className="mapping-unit">{param.unit}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mapping-hint">
              Offset is applied before transforms. Combiner merges multiple rows targeting the same EC2 parameter.
              Curve, deadzone, smoothing, and invert are saved in the mapping preset schema v2.
            </div>
          </section>

          <section className="audio-bridge-panel" aria-label="EC2 Audio Bridge">
            <div className="mapping-panel-header">
              <h2>EC2 Audio Bridge</h2>
              <div className="mapping-panel-actions">
                <span className={`bridge-mode ${oscControlDisabled ? 'off' : 'on'}`}>
                  {oscControlDisabled ? 'Disabled in MIDI mode' : 'OSC Bridge Active'}
                </span>
                <span className={`recording-state-chip ${isTransportRunning ? 'on' : 'off'}`}>
                  {isTransportRunning ? 'Transport Playing' : 'Transport Stopped'}
                </span>
                <span className={`recording-state-chip ${isRecording ? 'on' : 'off'}`}>
                  {isRecording ? 'Recording Active' : 'Recording Idle'}
                </span>
              </div>
            </div>

            <div className="audio-bridge-grid">
              <input
                ref={browserWavInputRef}
                type="file"
                accept=".wav,.wave,audio/wav,audio/x-wav"
                className="hidden-file-input"
                onChange={onBrowserWavSelected}
              />

              <label className="master-amplitude-control">
                Master Amplitude
                <input
                  type="range"
                  min={MASTER_AMPLITUDE_MIN_DB}
                  max={MASTER_AMPLITUDE_MAX_DB}
                  step="0.1"
                  value={audioBridgeSettings.masterAmplitudeDb}
                  onChange={onMasterAmplitudeChange}
                  disabled={oscControlDisabled}
                />
                <span>{audioBridgeSettings.masterAmplitudeDb.toFixed(1)} dB</span>
              </label>

              <label>
                Main Audio Output
                <select
                  value={selectedAudioOutputDeviceId}
                  onChange={onAudioOutputDeviceChange}
                  disabled={!hasAudioOutputDevices}
                >
                  {!hasAudioOutputDevices ? (
                    <option value="">No audio outputs detected</option>
                  ) : null}
                  {audioOutputDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                EC2 Audio Device Name
                <input
                  type="text"
                  value={audioBridgeSettings.audioOutputDeviceName}
                  onChange={onAudioOutputDeviceNameChange}
                  onKeyDown={onAudioOutputDeviceNameKeyDown}
                  placeholder="Optional override (exact EC2 output name)"
                  disabled={oscControlDisabled}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={onApplyAudioOutputDevice}
                disabled={oscControlDisabled || !hasAudioOutputOverride}
              >
                Apply Manual Device Name
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void refreshAudioOutputDevices(true);
                }}
              >
                Refresh Outputs
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void onUnlockAudioOutputLabels();
                }}
              >
                Unlock Output Labels
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={onApplyAudioOutputDevice}
                disabled={oscControlDisabled || (!hasAudioOutputDevices && !hasAudioOutputOverride)}
              >
                Apply Main Output
              </button>

              <label>
                Sound Source (Loaded)
                <select
                  value={selectedSourcePath}
                  onChange={onSoundSourceChange}
                  disabled={oscControlDisabled || !hasSoundSources}
                >
                  {!hasSoundSources ? (
                    <option value="">No loaded sources yet</option>
                  ) : null}
                  {soundSourceOptions.map((sourcePath, index) => (
                    <option key={sourcePath} value={sourcePath}>
                      {index + 1}. {getDisplayNameFromPath(sourcePath)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Sound File Path
                <input
                  type="text"
                  value={audioBridgeSettings.soundFilePath}
                  onChange={onSoundFilePathChange}
                  disabled={oscControlDisabled}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void onSelectSoundFile();
                }}
                disabled={false}
              >
                Select Sound File
              </button>

              <label>
                Sound Source Index
                <input
                  type="number"
                  min="1"
                  value={audioBridgeSettings.soundFileIndex}
                  onChange={onSoundFileIndexChange}
                  disabled={oscControlDisabled}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={onApplySoundSourceIndex}
                disabled={oscControlDisabled}
              >
                Apply Source Index
              </button>

              <label>
                Record File Name
                <input
                  type="text"
                  value={audioBridgeSettings.recordFileName}
                  onChange={onRecordFileNameChange}
                  disabled={oscControlDisabled}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={onApplyRecordFileName}
                disabled={oscControlDisabled}
              >
                Apply File Name
              </button>

              <label>
                Output Folder
                <input
                  type="text"
                  value={audioBridgeSettings.outputFolder}
                  onChange={onOutputFolderChange}
                  disabled={oscControlDisabled}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={onApplyOutputFolder}
                disabled={oscControlDisabled}
              >
                Apply Output Folder
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void onBrowseOutputFolder();
                }}
                disabled={oscControlDisabled || !hasNativeDialog}
              >
                Browse Folder
              </button>

              <label>
                Playhead Direction
                <select
                  value={audioBridgeSettings.playheadDirection}
                  onChange={onPlayheadDirectionChange}
                  disabled={oscControlDisabled}
                >
                  {PLAYHEAD_DIRECTION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={onTransportStart}
                disabled={oscControlDisabled}
              >
                Play (Audio On)
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={onTransportStop}
                disabled={oscControlDisabled}
              >
                Stop (Audio Off)
              </button>

              <button
                type="button"
                className="apply-button start-record"
                onClick={onRecordStart}
                disabled={oscControlDisabled}
              >
                Record Start
              </button>
              <button
                type="button"
                className="apply-button stop-record"
                onClick={onRecordStop}
                disabled={oscControlDisabled}
              >
                Record Stop
              </button>
            </div>

            <div className="recording-library">
              <div className="recording-library-header">
                <h3>Recorded Files</h3>
                <div className="mapping-panel-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void refreshRecordingFiles(true);
                    }}
                    disabled={recordingsBusy}
                  >
                    {recordingsBusy ? 'Refreshing...' : 'Refresh Recordings'}
                  </button>
                </div>
              </div>

              {recordingFiles.length === 0 ? (
                <div className="recording-library-empty">No recordings found for the selected output folder.</div>
              ) : (
                <div className="recording-library-list">
                  {recordingFiles.map((recording) => (
                    <div className="recording-row" key={recording.path}>
                      <div className="recording-row-meta">
                        <strong>{recording.name}</strong>
                        <span>
                          {formatFileSize(recording.sizeBytes)} ·{' '}
                          {recording.modifiedAtMs > 0
                            ? new Date(recording.modifiedAtMs).toLocaleString()
                            : 'unknown time'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          void onDownloadRecording(recording);
                        }}
                        disabled={recordingDownloadPath === recording.path}
                      >
                        {recordingDownloadPath === recording.path ? 'Downloading...' : 'Download'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {audioBridgeFeedback ? <div className="audio-bridge-feedback">{audioBridgeFeedback}</div> : null}
          </section>

          <section className="performance-panel" aria-label="Realtime Performance View">
            <div className="mapping-panel-header">
              <h2>Realtime Performance View</h2>
              <span className="mapping-count">{performanceTelemetryLabel}</span>
            </div>

            <div className="performance-grid">
              <div className="grain-panel">
                <div className="grain-headline">
                  <strong>{displayActiveGrainCount}</strong>
                  <span>
                    / {MAX_ACTIVE_GRAINS} Active Grains ({hasEngineScanTelemetry ? 'engine' : 'estimated'})
                  </span>
                </div>
                <div className="grain-meter">
                  <div
                    className="grain-meter-fill"
                    style={{ width: `${(displayActiveGrainDensity * 100).toFixed(2)}%` }}
                  />
                </div>
                <div className="grain-stats">
                  <div className="grain-stat">
                    <span>Grains/s</span>
                    <strong>{grainActivity.grainsPerSecond.toFixed(1)}</strong>
                  </div>
                  <div className="grain-stat">
                    <span>Amplitude</span>
                    <strong>{liveParamSnapshot.amplitude.toFixed(1)} dB</strong>
                  </div>
                  <div className="grain-stat">
                    <span>Output Level</span>
                    <strong>{Math.round(amplitudeNorm * 100)}%</strong>
                  </div>
                </div>
              </div>

              <div className="waveform-panel">
                <div className="waveform-panel-header">
                  <span>Scan Display</span>
                  <span>
                    {hasEngineScanTelemetry ? 'Engine' : 'Estimated'} | Playhead{' '}
                    {(scanTelemetrySnapshot.playheadNorm * 100).toFixed(1)}% | Dominant{' '}
                    {dominantScanRegionLabel}
                  </span>
                  <span>
                    WAV: {selectedSourcePath ? getDisplayNameFromPath(selectedSourcePath) : 'Not loaded'}
                  </span>
                </div>
                <canvas ref={outputWaveformCanvasRef} className="output-waveform-canvas" />
                <div className="scan-region-grid" aria-label="Grain region activity">
                  {SCAN_REGION_LABELS.map((label, index) => {
                    const regionIndex = index as ScanRegionIndex;
                    const level = scanTelemetrySnapshot.regionLevels[regionIndex];
                    const count = scanTelemetrySnapshot.regionCounts[regionIndex];
                    return (
                      <div
                        key={label}
                        className={`scan-region-chip ${
                          scanTelemetrySnapshot.dominantRegion === regionIndex ? 'active' : ''
                        }`}
                      >
                        <div className="scan-region-headline">
                          <span>{label}</span>
                          <strong>{count}</strong>
                        </div>
                        <div className="scan-region-subline">{SCAN_REGION_RANGE_LABELS[regionIndex]}</div>
                        <div className="scan-region-meter">
                          <div
                            className={`scan-region-meter-fill region-${regionIndex + 1}`}
                            style={{ width: `${(level * 100).toFixed(2)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </section>
      </header>

      <main className="stage">
        <video ref={videoRef} className="hidden-video" playsInline muted />
        <canvas ref={canvasRef} className="stage-canvas" />
      </main>

      <footer className="status-bar">
        <span>Camera: {isActive ? 'active' : 'inactive'}</span>
        <span>Pose: {poseReady ? 'ready' : 'loading'}</span>
        <span>
          Output: {outputSettings.protocol.toUpperCase()} ({outputStatus})
        </span>
        <span>Engine: {engineStatusLabel}</span>
        <span>EC2: {outputSettings.ec2Version}</span>
        <span>Mappings: {activeMappingCount}/{poseMappings.length}</span>
        <span>Send Rate: {outputSendRate.toFixed(1)} msg/s</span>
        <span>Active Grains ({hasEngineScanTelemetry ? 'engine' : 'est'}): {displayActiveGrainCount}</span>
        <span>Render FPS: {hudSnapshot.renderFps.toFixed(1)}</span>
        <span>Pose FPS: {hudSnapshot.poseFps.toFixed(1)}</span>
        <span>
          Pose Delegate: {poseRuntimeConfig.activeDelegate} (pref {poseRuntimeConfig.requestedDelegate})
        </span>
        <span>Inference Cap: {poseRuntimeConfig.inferenceFps} fps</span>
        <span>Confidence: {Math.round(hudSnapshot.confidence * 100)}%</span>
        {cameraError ? <span className="error">Camera error: {cameraError}</span> : null}
        {poseError ? <span className="error">Pose error: {poseError}</span> : null}
      </footer>
    </div>
  );
}

export default App;

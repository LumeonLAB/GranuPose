import type {
  NormalizedLandmark,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import {
  getEc2ParamById,
  type Ec2ParamDefinition,
  type Ec2ParamId,
  type Ec2ScalingMode,
} from '../output/ec2Params';

export type PoseSignalId =
  | 'rightWristY'
  | 'leftWristY'
  | 'rightWristX'
  | 'leftWristX'
  | 'rightElbowY'
  | 'leftElbowY'
  | 'noseY'
  | 'shoulderSpan';
export type PoseSignalSelection = PoseSignalId | null;
export type PoseParamSelectionId = Ec2ParamId | null;

export interface PoseSignalDefinition {
  id: PoseSignalId;
  label: string;
}

interface PoseSignalCalibration {
  observationMin: number;
  observationMax: number;
  responseCurve: number;
}

export type PoseMappingCurve = 'linear' | 'easeIn' | 'easeOut' | 'sCurve';
export type PoseMappingCombiner = 'override' | 'sum' | 'average' | 'min' | 'max' | 'multiply';

export interface PoseMappingTransformChain {
  curve: PoseMappingCurve;
  deadzone: number;
  smoothing: number;
  invert: boolean;
}

export const POSE_MAPPING_CURVE_OPTIONS: ReadonlyArray<PoseMappingCurve> = [
  'linear',
  'easeIn',
  'easeOut',
  'sCurve',
];

export const POSE_MAPPING_COMBINER_OPTIONS: ReadonlyArray<PoseMappingCombiner> = [
  'override',
  'sum',
  'average',
  'min',
  'max',
  'multiply',
];

export const DEFAULT_POSE_MAPPING_TRANSFORMS: Readonly<PoseMappingTransformChain> = {
  curve: 'linear',
  deadzone: 0,
  smoothing: 0.2,
  invert: false,
};

const MAX_MAPPING_DEADZONE = 0.45;
const MAX_MAPPING_SMOOTHING = 0.98;

function isPoseMappingCurve(value: unknown): value is PoseMappingCurve {
  return (
    typeof value === 'string' &&
    (value === 'linear' || value === 'easeIn' || value === 'easeOut' || value === 'sCurve')
  );
}

function isPoseMappingCombiner(value: unknown): value is PoseMappingCombiner {
  return (
    typeof value === 'string' &&
    (value === 'override' ||
      value === 'sum' ||
      value === 'average' ||
      value === 'min' ||
      value === 'max' ||
      value === 'multiply')
  );
}

export function normalizePoseMappingTransformChain(
  value: Partial<PoseMappingTransformChain> | null | undefined,
): PoseMappingTransformChain {
  return {
    curve: isPoseMappingCurve(value?.curve)
      ? value.curve
      : DEFAULT_POSE_MAPPING_TRANSFORMS.curve,
    deadzone: clamp(Number(value?.deadzone ?? DEFAULT_POSE_MAPPING_TRANSFORMS.deadzone), 0, MAX_MAPPING_DEADZONE),
    smoothing: clamp(Number(value?.smoothing ?? DEFAULT_POSE_MAPPING_TRANSFORMS.smoothing), 0, MAX_MAPPING_SMOOTHING),
    invert:
      typeof value?.invert === 'boolean'
        ? value.invert
        : DEFAULT_POSE_MAPPING_TRANSFORMS.invert,
  };
}

export function normalizePoseMappingCombiner(value: unknown): PoseMappingCombiner {
  return isPoseMappingCombiner(value) ? value : 'override';
}

export interface PoseToEc2Mapping {
  id: string;
  enabled: boolean;
  poseSignalId: PoseSignalSelection;
  paramId: PoseParamSelectionId;
  outputMin: number;
  outputMax: number;
  offset: number;
  transforms: PoseMappingTransformChain;
  combiner: PoseMappingCombiner;
}

export interface PoseToEc2MappingOutput {
  mappingId: string;
  poseSignalId: PoseSignalId;
  paramId: Ec2ParamId;
  combiner: PoseMappingCombiner;
  address: string;
  signalValue: number;
  value: number;
}

export interface PoseToEc2MappingEvalOptions {
  oscAddressPrefix?: string;
  smoothingState?: Map<string, number>;
}

export const POSE_SIGNAL_DEFINITIONS: ReadonlyArray<PoseSignalDefinition> = [
  { id: 'rightWristY', label: 'Right Wrist Y' },
  { id: 'leftWristY', label: 'Left Wrist Y' },
  { id: 'rightWristX', label: 'Right Wrist X' },
  { id: 'leftWristX', label: 'Left Wrist X' },
  { id: 'rightElbowY', label: 'Right Elbow Y' },
  { id: 'leftElbowY', label: 'Left Elbow Y' },
  { id: 'noseY', label: 'Nose Y' },
  { id: 'shoulderSpan', label: 'Shoulder Span' },
];

const POSE_SIGNAL_CALIBRATION_BY_ID: Readonly<Record<PoseSignalId, PoseSignalCalibration>> = {
  // Calibrated for typical upper-body camera framing so normal gestures cover
  // a larger share of each mapped EC2 parameter range.
  rightWristY: { observationMin: 0.18, observationMax: 0.88, responseCurve: 0.9 },
  leftWristY: { observationMin: 0.18, observationMax: 0.88, responseCurve: 0.9 },
  rightWristX: { observationMin: 0.12, observationMax: 0.88, responseCurve: 1.0 },
  leftWristX: { observationMin: 0.12, observationMax: 0.88, responseCurve: 1.0 },
  rightElbowY: { observationMin: 0.2, observationMax: 0.82, responseCurve: 0.95 },
  leftElbowY: { observationMin: 0.2, observationMax: 0.82, responseCurve: 0.95 },
  noseY: { observationMin: 0.34, observationMax: 0.74, responseCurve: 0.85 },
  shoulderSpan: { observationMin: 0.22, observationMax: 0.68, responseCurve: 1.05 },
};

const EC2_OSC_ADDRESS_BY_PARAM_ID: Readonly<Record<Ec2ParamId, string>> = {
  grainRate: '/GrainRate',
  asynchronicity: '/Asynchronicity',
  intermittency: '/Intermittency',
  streams: '/Streams',
  playbackRate: '/PlaybackRate',
  filterCenter: '/FilterCenter',
  resonance: '/Resonance',
  soundFile: '/SoundFile',
  scanBegin: '/ScanBegin',
  scanRange: '/ScanRange',
  scanSpeed: '/ScanSpeed',
  grainDuration: '/GrainDuration',
  envelopeShape: '/EnvelopeShape',
  pan: '/Pan',
  amplitude: '/Amplitude',
};

function normalizeOscAddressPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return '';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function applyOscAddressPrefix(address: string, prefix = ''): string {
  const normalizedAddress = address.startsWith('/') ? address : `/${address}`;
  const normalizedPrefix = normalizeOscAddressPrefix(prefix);
  if (!normalizedPrefix) {
    return normalizedAddress;
  }

  return `${normalizedPrefix}${normalizedAddress}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getPoint(
  landmarks: NormalizedLandmark[],
  index: number,
): NormalizedLandmark | null {
  return landmarks[index] || null;
}

function getPointSignal(
  landmarks: NormalizedLandmark[],
  index: number,
  axis: 'x' | 'y',
): number | null {
  const point = getPoint(landmarks, index);
  if (!point) {
    return null;
  }

  if (axis === 'x') {
    return clamp01(point.x);
  }

  return clamp01(1 - point.y);
}

function getShoulderSpanSignal(landmarks: NormalizedLandmark[]): number | null {
  const left = getPoint(landmarks, 11);
  const right = getPoint(landmarks, 12);
  if (!left || !right) {
    return null;
  }

  const distance = Math.hypot(left.x - right.x, left.y - right.y);
  return clamp01(distance * 2.5);
}

function getSignalValue(
  landmarks: NormalizedLandmark[],
  signalId: PoseSignalId,
): number | null {
  switch (signalId) {
    case 'rightWristY':
      return getPointSignal(landmarks, 16, 'y');
    case 'leftWristY':
      return getPointSignal(landmarks, 15, 'y');
    case 'rightWristX':
      return getPointSignal(landmarks, 16, 'x');
    case 'leftWristX':
      return getPointSignal(landmarks, 15, 'x');
    case 'rightElbowY':
      return getPointSignal(landmarks, 14, 'y');
    case 'leftElbowY':
      return getPointSignal(landmarks, 13, 'y');
    case 'noseY':
      return getPointSignal(landmarks, 0, 'y');
    case 'shoulderSpan':
      return getShoulderSpanSignal(landmarks);
    default:
      return null;
  }
}

function calibratePoseSignal(signalId: PoseSignalId, rawSignal: number): number {
  const calibration = POSE_SIGNAL_CALIBRATION_BY_ID[signalId];
  const span = Math.max(0.000001, calibration.observationMax - calibration.observationMin);
  const normalized = clamp01((rawSignal - calibration.observationMin) / span);
  return clamp01(Math.pow(normalized, calibration.responseCurve));
}

function mapUnitToRange(
  unitValue: number,
  min: number,
  max: number,
  scaling: Ec2ScalingMode,
): number {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  const normalized = clamp01(unitValue);

  let mapped = 0;
  if (scaling === 'log' && lower > 0 && upper > 0) {
    mapped = lower * Math.pow(upper / lower, normalized);
  } else {
    mapped = lower + normalized * (upper - lower);
  }

  if (min <= max) {
    return mapped;
  }

  return upper - (mapped - lower);
}

function applyDeadzone(value: number, deadzone: number): number {
  const boundedDeadzone = clamp(deadzone, 0, MAX_MAPPING_DEADZONE);
  if (boundedDeadzone <= 0) {
    return clamp01(value);
  }

  if (value <= boundedDeadzone) {
    return 0;
  }

  if (value >= 1 - boundedDeadzone) {
    return 1;
  }

  const span = 1 - boundedDeadzone * 2;
  if (span <= 0.000001) {
    return value > 0.5 ? 1 : 0;
  }

  return clamp01((value - boundedDeadzone) / span);
}

function applyCurve(value: number, curve: PoseMappingCurve): number {
  const normalized = clamp01(value);
  switch (curve) {
    case 'easeIn':
      return normalized * normalized;
    case 'easeOut':
      return 1 - Math.pow(1 - normalized, 2);
    case 'sCurve':
      return normalized * normalized * (3 - 2 * normalized);
    case 'linear':
    default:
      return normalized;
  }
}

function applySignalTransformChain(
  mapping: PoseToEc2Mapping,
  signalValue: number,
  smoothingState?: Map<string, number>,
): number {
  const transforms = normalizePoseMappingTransformChain(mapping.transforms);
  let nextSignal = clamp01(signalValue);

  if (transforms.invert) {
    nextSignal = 1 - nextSignal;
  }

  nextSignal = applyDeadzone(nextSignal, transforms.deadzone);
  nextSignal = applyCurve(nextSignal, transforms.curve);

  if (!smoothingState) {
    return nextSignal;
  }

  const smoothing = clamp(transforms.smoothing, 0, MAX_MAPPING_SMOOTHING);
  const previousSignal = smoothingState.get(mapping.id);
  const alpha = 1 - smoothing;
  const smoothedSignal =
    typeof previousSignal === 'number'
      ? previousSignal + (nextSignal - previousSignal) * alpha
      : nextSignal;
  smoothingState.set(mapping.id, smoothedSignal);
  return clamp01(smoothedSignal);
}

function makeDefaultMapping(
  id: string,
  poseSignalId: PoseSignalId,
  param: Ec2ParamDefinition,
): PoseToEc2Mapping {
  return {
    id,
    enabled: true,
    poseSignalId,
    paramId: param.id,
    outputMin: param.defaultRange[0],
    outputMax: param.defaultRange[1],
    offset: 0,
    transforms: {
      ...DEFAULT_POSE_MAPPING_TRANSFORMS,
    },
    combiner: 'override',
  };
}

export function getEc2OscAddressForParam(paramId: Ec2ParamId, prefix = ''): string {
  return applyOscAddressPrefix(EC2_OSC_ADDRESS_BY_PARAM_ID[paramId], prefix);
}

export function createDefaultPoseToEc2Mappings(): PoseToEc2Mapping[] {
  const grainRate = getEc2ParamById('grainRate');
  const grainDuration = getEc2ParamById('grainDuration');
  const scanSpeed = getEc2ParamById('scanSpeed');
  const asynchronicity = getEc2ParamById('asynchronicity');
  const intermittency = getEc2ParamById('intermittency');
  const playbackRate = getEc2ParamById('playbackRate');
  const scanBegin = getEc2ParamById('scanBegin');
  const scanRange = getEc2ParamById('scanRange');

  return [
    makeDefaultMapping('map-1', 'rightWristY', grainRate),
    makeDefaultMapping('map-2', 'leftWristY', grainDuration),
    makeDefaultMapping('map-3', 'rightWristX', scanSpeed),
    makeDefaultMapping('map-4', 'leftWristX', asynchronicity),
    makeDefaultMapping('map-5', 'noseY', intermittency),
    makeDefaultMapping('map-6', 'rightElbowY', playbackRate),
    makeDefaultMapping('map-7', 'leftElbowY', scanBegin),
    makeDefaultMapping('map-8', 'shoulderSpan', scanRange),
  ];
}

export function evaluatePoseToEc2Mappings(
  result: PoseLandmarkerResult | null,
  mappings: ReadonlyArray<PoseToEc2Mapping>,
  options: PoseToEc2MappingEvalOptions = {},
): PoseToEc2MappingOutput[] {
  const landmarks = result?.landmarks[0];
  if (!landmarks) {
    return [];
  }

  const outputs: PoseToEc2MappingOutput[] = [];
  for (const mapping of mappings) {
    if (!mapping.enabled) {
      continue;
    }

    const poseSignalId = mapping.poseSignalId;
    const paramId = mapping.paramId;
    if (!poseSignalId || !paramId) {
      continue;
    }

    const signal = getSignalValue(landmarks, poseSignalId);
    if (signal == null) {
      continue;
    }

    const calibratedSignal = calibratePoseSignal(poseSignalId, signal);
    const offsetSignal = clamp01(calibratedSignal + mapping.offset);
    const adjustedSignal = applySignalTransformChain(
      mapping,
      offsetSignal,
      options.smoothingState,
    );
    const param = getEc2ParamById(paramId);
    const boundedMin = clamp(
      mapping.outputMin,
      param.absoluteRange[0],
      param.absoluteRange[1],
    );
    const boundedMax = clamp(
      mapping.outputMax,
      param.absoluteRange[0],
      param.absoluteRange[1],
    );
    const mappedValue = mapUnitToRange(
      adjustedSignal,
      boundedMin,
      boundedMax,
      param.scalingDefault,
    );

    outputs.push({
      mappingId: mapping.id,
      poseSignalId,
      paramId,
      combiner: normalizePoseMappingCombiner(mapping.combiner),
      address: getEc2OscAddressForParam(paramId, options.oscAddressPrefix || ''),
      signalValue: adjustedSignal,
      value: mappedValue,
    });
  }

  return outputs;
}

import paramRegistryDocument from '../../../shared/ec2/params.json';

export const EC2_PARAM_IDS = [
  'grainRate',
  'asynchronicity',
  'intermittency',
  'streams',
  'playbackRate',
  'filterCenter',
  'resonance',
  'soundFile',
  'scanBegin',
  'scanRange',
  'scanSpeed',
  'grainDuration',
  'envelopeShape',
  'pan',
  'amplitude',
] as const;

export type Ec2ParamId = (typeof EC2_PARAM_IDS)[number];
export type Ec2ParamGroup = 'timing' | 'pitchFilter' | 'sourceScanning' | 'amplitudeSpaceTime';
export type Ec2ParamUnit = 'Hz' | 'ms' | 'dB' | 'ratio' | 'index' | 'normalized' | 'count';
export type Ec2ScalingMode = 'linear' | 'log';

export interface Ec2ParamDefinition {
  id: Ec2ParamId;
  label: string;
  group: Ec2ParamGroup;
  unit: Ec2ParamUnit;
  defaultValue: number;
  defaultRange: [number, number];
  absoluteRange: [number, number];
  scalingDefault: Ec2ScalingMode;
  specialCases: Record<string, unknown>;
}

export interface Ec2ParamRegistryDocument {
  schemaVersion: string;
  sampleRateHz: number;
  params: Ec2ParamDefinition[];
}

function validateRegistry(document: Ec2ParamRegistryDocument): void {
  const knownIds = new Set<Ec2ParamId>(EC2_PARAM_IDS);
  const seenIds = new Set<Ec2ParamId>();

  if (document.params.length !== EC2_PARAM_IDS.length) {
    throw new Error(
      `EC2 parameter registry mismatch: expected ${EC2_PARAM_IDS.length}, got ${document.params.length}.`,
    );
  }

  for (const param of document.params) {
    if (!knownIds.has(param.id)) {
      throw new Error(`EC2 parameter registry contains unknown id: ${String(param.id)}`);
    }

    if (seenIds.has(param.id)) {
      throw new Error(`EC2 parameter registry contains duplicate id: ${String(param.id)}`);
    }

    seenIds.add(param.id);
  }

  for (const id of EC2_PARAM_IDS) {
    if (!seenIds.has(id)) {
      throw new Error(`EC2 parameter registry missing id: ${id}`);
    }
  }
}

export const EC2_PARAM_REGISTRY = paramRegistryDocument as Ec2ParamRegistryDocument;
validateRegistry(EC2_PARAM_REGISTRY);

export const EC2_PARAMS = EC2_PARAM_REGISTRY.params;

const EC2_PARAM_MAP: ReadonlyMap<Ec2ParamId, Ec2ParamDefinition> = new Map(
  EC2_PARAMS.map((param) => [param.id, param]),
);
const EC2_PARAM_INDEX_MAP: ReadonlyMap<Ec2ParamId, number> = new Map(
  EC2_PARAMS.map((param, index) => [param.id, index]),
);
const EC2_PARAMS_BY_GROUP: Readonly<Record<Ec2ParamGroup, ReadonlyArray<Ec2ParamDefinition>>> =
  {
    timing: EC2_PARAMS.filter((param) => param.group === 'timing'),
    pitchFilter: EC2_PARAMS.filter((param) => param.group === 'pitchFilter'),
    sourceScanning: EC2_PARAMS.filter((param) => param.group === 'sourceScanning'),
    amplitudeSpaceTime: EC2_PARAMS.filter((param) => param.group === 'amplitudeSpaceTime'),
  };

export function listEc2ParamIds(): ReadonlyArray<Ec2ParamId> {
  return EC2_PARAM_IDS;
}

export function getEc2ParamById(id: Ec2ParamId): Ec2ParamDefinition {
  const found = EC2_PARAM_MAP.get(id);
  if (!found) {
    throw new Error(`EC2 parameter not found: ${id}`);
  }
  return found;
}

export function getEc2ParamIndex(id: Ec2ParamId): number {
  const found = EC2_PARAM_INDEX_MAP.get(id);
  if (found == null) {
    throw new Error(`EC2 parameter index not found: ${id}`);
  }
  return found;
}

export function getEc2ParamsByGroup(group: Ec2ParamGroup): ReadonlyArray<Ec2ParamDefinition> {
  return EC2_PARAMS_BY_GROUP[group];
}

export function isEc2ParamId(value: string): value is Ec2ParamId {
  return EC2_PARAM_IDS.includes(value as Ec2ParamId);
}

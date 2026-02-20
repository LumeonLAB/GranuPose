export type Ec2Version = 'v1.2' | 'v1.3+' | 'custom';
export type Ec2Capability = 'advancedOsc' | 'lfoModulation' | 'morphTimeOsc';

export interface Ec2OscProfile {
  id: string;
  version: Ec2Version;
  name: string;
  notes: string;
  capabilities: Record<Ec2Capability, boolean>;
}

export const EC2_OSC_PROFILES: Ec2OscProfile[] = [
  {
    id: 'ec2-v1.2-manual',
    version: 'v1.2',
    name: 'EC2 v1.2 (Manual Addresses)',
    notes: 'Requires manual OSC address mapping in EC2.',
    capabilities: {
      advancedOsc: false,
      lfoModulation: false,
      morphTimeOsc: false,
    },
  },
  {
    id: 'ec2-v1.3-default',
    version: 'v1.3+',
    name: 'EC2 v1.3+ (Default Addresses)',
    notes: 'Uses default OSC addresses matching parameter names.',
    capabilities: {
      advancedOsc: true,
      lfoModulation: true,
      morphTimeOsc: true,
    },
  },
  {
    id: 'ec2-custom',
    version: 'custom',
    name: 'Custom OSC Profile',
    notes: 'Use when EC2 OSC addresses are customized.',
    capabilities: {
      advancedOsc: true,
      lfoModulation: true,
      morphTimeOsc: true,
    },
  },
];

export function getProfileById(profileId: string): Ec2OscProfile | null {
  return EC2_OSC_PROFILES.find((profile) => profile.id === profileId) || null;
}

export function getDefaultProfileIdForVersion(version: Ec2Version): string {
  const found = EC2_OSC_PROFILES.find((profile) => profile.version === version);
  return found?.id || EC2_OSC_PROFILES[0]?.id || 'ec2-v1.2-manual';
}

export function getProfilesForVersion(version: Ec2Version): Ec2OscProfile[] {
  return EC2_OSC_PROFILES.filter((profile) => profile.version === version);
}

import { useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export type ResolutionPreset = '480p' | '720p' | '1080p';
export type TargetFps = 30 | 60;

export interface CameraSettings {
  deviceId: string;
  mirror: boolean;
  resolution: ResolutionPreset;
  targetFps: TargetFps;
}

interface CameraState {
  devices: MediaDeviceInfo[];
  error: string | null;
  isActive: boolean;
  settings: CameraSettings;
  setSettings: Dispatch<SetStateAction<CameraSettings>>;
  stream: MediaStream | null;
}

const STORAGE_KEY = 'granupose.camera.settings.v1';

const DEFAULT_SETTINGS: CameraSettings = {
  deviceId: '',
  mirror: true,
  resolution: '720p',
  targetFps: 30,
};

const RESOLUTION_CONSTRAINTS: Record<ResolutionPreset, { width: number; height: number }> = {
  '480p': { width: 640, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

function parseStoredSettings(raw: string | null): CameraSettings {
  if (!raw) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CameraSettings>;
    return {
      deviceId: parsed.deviceId ?? DEFAULT_SETTINGS.deviceId,
      mirror: parsed.mirror ?? DEFAULT_SETTINGS.mirror,
      resolution: parsed.resolution ?? DEFAULT_SETTINGS.resolution,
      targetFps: parsed.targetFps ?? DEFAULT_SETTINGS.targetFps,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function listCameraDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

export function useCamera(): CameraState {
  const [settings, setSettings] = useState<CameraSettings>(() =>
    parseStoredSettings(localStorage.getItem(STORAGE_KEY)),
  );
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let mounted = true;

    const refreshDevices = async (): Promise<void> => {
      try {
        const cameraDevices = await listCameraDevices();
        if (!mounted) {
          return;
        }
        setDevices(cameraDevices);

        if (!settings.deviceId && cameraDevices.length > 0) {
          setSettings((current) => ({
            ...current,
            deviceId: cameraDevices[0]?.deviceId ?? '',
          }));
        }
      } catch {
        if (mounted) {
          setError('Failed to enumerate camera devices.');
        }
      }
    };

    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    return () => {
      mounted = false;
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices);
    };
  }, [settings.deviceId]);

  useEffect(() => {
    let active = true;
    let createdStream: MediaStream | null = null;

    const startCamera = async (): Promise<void> => {
      const resolution = RESOLUTION_CONSTRAINTS[settings.resolution];
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: resolution.width },
        height: { ideal: resolution.height },
        frameRate: { ideal: settings.targetFps, max: settings.targetFps },
      };

      if (settings.deviceId) {
        videoConstraints.deviceId = { exact: settings.deviceId };
      }

      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: videoConstraints,
        });

        if (!active) {
          newStream.getTracks().forEach((track) => track.stop());
          return;
        }

        createdStream = newStream;
        setStream((previous) => {
          previous?.getTracks().forEach((track) => track.stop());
          return newStream;
        });
        setIsActive(true);
        setError(null);
      } catch (cameraError) {
        if (!active) {
          return;
        }
        setIsActive(false);
        setError(
          cameraError instanceof Error
            ? cameraError.message
            : 'Could not access camera. Check camera permissions.',
        );
      }
    };

    startCamera();

    return () => {
      active = false;
      createdStream?.getTracks().forEach((track) => track.stop());
    };
  }, [settings.deviceId, settings.resolution, settings.targetFps]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  return useMemo(
    () => ({ devices, stream, settings, setSettings, error, isActive }),
    [devices, stream, settings, error, isActive],
  );
}

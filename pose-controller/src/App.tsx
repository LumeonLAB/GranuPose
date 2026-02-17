import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  createBridgeOutputClientFromEnv,
  type BridgeConnectionStatus,
  type BridgeOutputClient,
} from './modules/output';
import { computeTrackingConfidence, drawPoseSkeleton, getPoseLandmarker } from './modules/pose';
import { drawHud } from './modules/ui';
import { drawVideoFrame, useCamera } from './modules/video';
import type { ResolutionPreset, TargetFps } from './modules/video';
import type { HudMetrics } from './types';

const RESOLUTION_OPTIONS: ResolutionPreset[] = ['480p', '720p', '1080p'];
const FPS_OPTIONS: TargetFps[] = [30, 60];

interface FpsCounter {
  frames: number;
  fps: number;
  lastMs: number;
}

const DEFAULT_HUD_METRICS: HudMetrics = {
  confidence: 0,
  inferenceMs: 0,
  poseFps: 0,
  renderFps: 0,
};

function createFpsCounter(): FpsCounter {
  return {
    frames: 0,
    fps: 0,
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

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameHandleRef = useRef<number | null>(null);
  const bridgeClientRef = useRef<BridgeOutputClient | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const poseResultRef = useRef<PoseLandmarkerResult | null>(null);
  const poseErrorRef = useRef<string | null>(null);
  const renderFpsRef = useRef<FpsCounter>(createFpsCounter());
  const poseFpsRef = useRef<FpsCounter>(createFpsCounter());
  const hudMetricsRef = useRef<HudMetrics>(DEFAULT_HUD_METRICS);
  const lastSnapshotRef = useRef(0);

  const [poseReady, setPoseReady] = useState(false);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeConnectionStatus>('disabled');
  const [hudSnapshot, setHudSnapshot] = useState<HudMetrics>(DEFAULT_HUD_METRICS);

  const { devices, error: cameraError, isActive, settings, setSettings, stream } = useCamera();

  const setPoseErrorState = (value: string | null): void => {
    poseErrorRef.current = value;
    setPoseError(value);
  };

  useEffect(() => {
    const bridgeClient = createBridgeOutputClientFromEnv();
    bridgeClientRef.current = bridgeClient;

    if (!bridgeClient) {
      return undefined;
    }

    const unsubscribe = bridgeClient.subscribeStatus(setBridgeStatus);
    bridgeClient.connect();

    return () => {
      unsubscribe();
      bridgeClient.close();
      bridgeClientRef.current = null;
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
        setPoseReady(true);
        setPoseErrorState(null);
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
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
      return;
    }

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
        if (landmarker) {
          try {
            const detectStart = performance.now();
            const result = landmarker.detectForVideo(videoElement, detectStart);
            const detectEnd = performance.now();

            poseResultRef.current = result;
            hudMetricsRef.current.inferenceMs = detectEnd - detectStart;
            hudMetricsRef.current.poseFps = updateFps(poseFpsRef.current, detectEnd);
            hudMetricsRef.current.confidence = computeTrackingConfidence(result);

            const rightWrist = result.landmarks[0]?.[16];
            if (rightWrist) {
              bridgeClientRef.current?.sendChannel(1, 1 - rightWrist.y);
            }

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

        const now = performance.now();
        hudMetricsRef.current.renderFps = updateFps(renderFpsRef.current, now);

        const hudStatus = poseErrorRef.current
          ? `Pose ERROR: ${poseErrorRef.current}`
          : poseReady
            ? 'Pose READY'
            : 'Pose LOADING';
        drawHud(context, hudMetricsRef.current, hudStatus);

        if (now - lastSnapshotRef.current >= 250) {
          setHudSnapshot({ ...hudMetricsRef.current });
          lastSnapshotRef.current = now;
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
  }, [poseReady, settings.mirror]);

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
      </header>

      <main className="stage">
        <video ref={videoRef} className="hidden-video" playsInline muted />
        <canvas ref={canvasRef} className="stage-canvas" />
      </main>

      <footer className="status-bar">
        <span>Camera: {isActive ? 'active' : 'inactive'}</span>
        <span>Pose: {poseReady ? 'ready' : 'loading'}</span>
        <span>Bridge: {bridgeStatus}</span>
        <span>Render FPS: {hudSnapshot.renderFps.toFixed(1)}</span>
        <span>Pose FPS: {hudSnapshot.poseFps.toFixed(1)}</span>
        <span>Confidence: {Math.round(hudSnapshot.confidence * 100)}%</span>
        {cameraError ? <span className="error">Camera error: {cameraError}</span> : null}
        {poseError ? <span className="error">Pose error: {poseError}</span> : null}
      </footer>
    </div>
  );
}

export default App;

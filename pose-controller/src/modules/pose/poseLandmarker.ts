import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const VISION_WASM_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm';
const MODEL_ASSET_PATH =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

type PoseDelegate = 'GPU' | 'CPU';

interface PoseRuntimeConfig {
  requestedDelegate: PoseDelegate;
  activeDelegate: PoseDelegate;
  inferenceFps: number;
  inferenceIntervalMs: number;
  newFrameOnly: boolean;
}

let poseLandmarkerPromise: Promise<PoseLandmarker> | null = null;
let activeDelegate: PoseDelegate = 'GPU';

const DEFAULT_DELEGATE: PoseDelegate = 'GPU';
const DEFAULT_INFERENCE_FPS = 30;
const MIN_INFERENCE_FPS = 5;
const MAX_INFERENCE_FPS = 120;
const DEFAULT_NEW_FRAME_ONLY = true;

function parseDelegate(rawValue: string | undefined): PoseDelegate {
  if (typeof rawValue !== 'string') {
    return DEFAULT_DELEGATE;
  }

  return rawValue.trim().toUpperCase() === 'CPU' ? 'CPU' : 'GPU';
}

function parseInferenceFps(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_INFERENCE_FPS;
  }

  const rounded = Math.trunc(parsed);
  return Math.max(MIN_INFERENCE_FPS, Math.min(MAX_INFERENCE_FPS, rounded));
}

function parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
  if (rawValue == null) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

const requestedDelegate = parseDelegate(import.meta.env.VITE_POSE_DELEGATE);
const inferenceFps = parseInferenceFps(import.meta.env.VITE_POSE_INFERENCE_FPS);
const inferenceIntervalMs = Math.max(1, Math.floor(1000 / inferenceFps));
const newFrameOnly = parseBoolean(import.meta.env.VITE_POSE_NEW_FRAME_ONLY, DEFAULT_NEW_FRAME_ONLY);

async function createPoseLandmarker(delegate: PoseDelegate): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(VISION_WASM_PATH);

  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_ASSET_PATH,
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
}

async function createPoseLandmarkerWithFallback(): Promise<PoseLandmarker> {
  try {
    activeDelegate = requestedDelegate;
    return await createPoseLandmarker(requestedDelegate);
  } catch (error) {
    if (requestedDelegate === 'GPU') {
      console.warn('[pose] GPU delegate failed, falling back to CPU delegate.', error);
      activeDelegate = 'CPU';
      return createPoseLandmarker('CPU');
    }

    throw error;
  }
}

export function getPoseRuntimeConfig(): PoseRuntimeConfig {
  return {
    requestedDelegate,
    activeDelegate,
    inferenceFps,
    inferenceIntervalMs,
    newFrameOnly,
  };
}

export async function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (!poseLandmarkerPromise) {
    poseLandmarkerPromise = createPoseLandmarkerWithFallback();
    poseLandmarkerPromise.catch(() => {
      poseLandmarkerPromise = null;
    });
  }

  return poseLandmarkerPromise;
}

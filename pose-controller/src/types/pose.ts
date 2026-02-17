import type { PoseLandmarkerResult } from '@mediapipe/tasks-vision';

export type PoseResult = PoseLandmarkerResult | null;

export interface HudMetrics {
  confidence: number;
  inferenceMs: number;
  poseFps: number;
  renderFps: number;
}

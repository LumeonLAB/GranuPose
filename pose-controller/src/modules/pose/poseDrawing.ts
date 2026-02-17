import { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark, PoseLandmarkerResult } from '@mediapipe/tasks-vision';

const HIGH_CONFIDENCE = 0.75;
const MID_CONFIDENCE = 0.5;

type PoseConnection = { start: number; end: number };

function toCanvasX(x: number, width: number, mirror: boolean): number {
  return mirror ? (1 - x) * width : x * width;
}

function confidenceColor(confidence: number): string {
  if (confidence >= HIGH_CONFIDENCE) {
    return '#2ce069';
  }
  if (confidence >= MID_CONFIDENCE) {
    return '#f7d23e';
  }
  return '#f35f5f';
}

function landmarkConfidence(landmark: NormalizedLandmark): number {
  const extendedLandmark = landmark as { presence?: number; visibility?: number };
  return extendedLandmark.visibility ?? extendedLandmark.presence ?? 0;
}

function drawConnection(
  context: CanvasRenderingContext2D,
  start: NormalizedLandmark,
  end: NormalizedLandmark,
  width: number,
  height: number,
  mirror: boolean,
): void {
  const confidence = Math.min(landmarkConfidence(start), landmarkConfidence(end));
  context.strokeStyle = confidenceColor(confidence);
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(toCanvasX(start.x, width, mirror), start.y * height);
  context.lineTo(toCanvasX(end.x, width, mirror), end.y * height);
  context.stroke();
}

function drawPoint(
  context: CanvasRenderingContext2D,
  landmark: NormalizedLandmark,
  width: number,
  height: number,
  mirror: boolean,
): void {
  const confidence = landmarkConfidence(landmark);
  context.fillStyle = confidenceColor(confidence);
  context.beginPath();
  context.arc(toCanvasX(landmark.x, width, mirror), landmark.y * height, 3, 0, Math.PI * 2);
  context.fill();
}

function drawPose(
  context: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  connections: PoseConnection[],
  width: number,
  height: number,
  mirror: boolean,
): void {
  for (const connection of connections) {
    const start = landmarks[connection.start];
    const end = landmarks[connection.end];
    if (!start || !end) {
      continue;
    }
    drawConnection(context, start, end, width, height, mirror);
  }

  for (const landmark of landmarks) {
    drawPoint(context, landmark, width, height, mirror);
  }
}

export function drawPoseSkeleton(
  context: CanvasRenderingContext2D,
  result: PoseLandmarkerResult,
  width: number,
  height: number,
  mirror: boolean,
): void {
  if (result.landmarks.length === 0) {
    return;
  }

  const connections = PoseLandmarker.POSE_CONNECTIONS as PoseConnection[];
  for (const landmarks of result.landmarks) {
    drawPose(context, landmarks, connections, width, height, mirror);
  }
}

export function computeTrackingConfidence(result: PoseLandmarkerResult | null): number {
  if (!result || result.landmarks.length === 0) {
    return 0;
  }

  const firstPose = result.landmarks[0];
  if (!firstPose || firstPose.length === 0) {
    return 0;
  }

  const total = firstPose.reduce((sum, landmark) => sum + landmarkConfidence(landmark), 0);
  return total / firstPose.length;
}

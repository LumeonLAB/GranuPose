import type { HudMetrics } from '../../types';

export function drawHud(
  context: CanvasRenderingContext2D,
  metrics: HudMetrics,
  statusLine: string,
): void {
  const x = 16;
  const y = 16;
  const width = 240;
  const height = 122;

  context.save();
  context.fillStyle = 'rgba(11, 14, 22, 0.65)';
  context.fillRect(x, y, width, height);

  context.fillStyle = '#e7f3ff';
  context.font = '13px Menlo, Consolas, monospace';

  const confidencePercent = Math.round(metrics.confidence * 100);
  const lines = [
    `Render FPS : ${metrics.renderFps.toFixed(1)}`,
    `Pose FPS   : ${metrics.poseFps.toFixed(1)}`,
    `Inference  : ${metrics.inferenceMs.toFixed(1)} ms`,
    `Confidence : ${confidencePercent}%`,
    statusLine,
  ];

  lines.forEach((line, index) => {
    context.fillText(line, x + 12, y + 24 + index * 20);
  });
  context.restore();
}

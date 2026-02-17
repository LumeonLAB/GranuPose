export function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  mirror: boolean,
): void {
  if (mirror) {
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);
    context.restore();
    return;
  }

  context.drawImage(video, 0, 0, width, height);
}

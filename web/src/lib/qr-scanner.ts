import jsQR from "jsqr";

const FRAME_INTERVAL_MS = 160;
const MAX_CANVAS_EDGE = 720;

type BarcodeResult = { rawValue?: string };
type BarcodeDetectorLike = { detect: (source: HTMLVideoElement) => Promise<BarcodeResult[]> };
type BarcodeDetectorConstructor = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

function barcodeDetectorConstructor(): BarcodeDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

async function createNativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Detector = barcodeDetectorConstructor();
  if (!Detector) return null;
  try {
    if (Detector.getSupportedFormats) {
      const supported = await Detector.getSupportedFormats();
      if (!supported.includes("qr_code")) return null;
    }
    return new Detector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

/** Camera QR reader with native detection preferred and an in-memory canvas/jsQR fallback. */
export class QrVideoScanner {
  private generation = 0;
  private active = false;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: number | null = null;

  async start(video: HTMLVideoElement, onFrame: (value: string | null) => void | Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const isCurrent = () => this.active && this.generation === generation;
    this.active = true;
    this.video = video;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!isCurrent()) { stopTracks(stream); return; }
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
      if (!isCurrent()) return;

      let detector = await createNativeDetector();
      if (!isCurrent()) return;
      let canvas: HTMLCanvasElement | null = null;
      let context: CanvasRenderingContext2D | null = null;
      const decodeCanvas = () => {
        if (!isCurrent() || video.videoWidth < 1 || video.videoHeight < 1 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
        if (!canvas) {
          canvas = document.createElement("canvas");
          context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("カメラ画像を読み取れません。");
        }
        const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.width = width;
        canvas.height = height;
        context!.drawImage(video, 0, 0, width, height);
        const image = context!.getImageData(0, 0, width, height);
        return jsQR(image.data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
      };

      const scan = async () => {
        if (!isCurrent()) return;
        try {
          let value: string | null = null;
          if (detector) {
            try { value = (await detector.detect(video))[0]?.rawValue || null; }
            catch {
              // A native detector can advertise QR support and still fail at runtime.
              detector = null;
              value = decodeCanvas();
            }
          } else value = decodeCanvas();
          if (!isCurrent()) return;
          await onFrame(value);
          if (!isCurrent()) return;
        } catch (error) {
          if (isCurrent()) {
            this.stop();
            onError?.(error);
          }
        }
        if (isCurrent()) this.timer = window.setTimeout(() => { void scan(); }, FRAME_INTERVAL_MS);
      };
      void scan();
    } catch (error) {
      if (isCurrent()) {
        this.stop();
        onError?.(error);
      }
    }
  }

  stop() {
    this.generation += 1;
    this.active = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }
}

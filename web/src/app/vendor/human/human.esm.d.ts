/**
 * The few parts of Human 3.3.6 (https://github.com/vladmandic/human, MIT)
 * that the Short Editor's person tracking uses. The library itself is the
 * vendored `human.esm.js` beside this file, TensorFlow.js included, and its
 * models are served from `assets/models/human`. Everything runs on the device.
 */
export type HumanBox = [number, number, number, number];
export interface HumanFace {
  box: HumanBox;
  boxRaw: HumanBox;
  score: number;
  boxScore?: number;
  faceScore?: number;
  /** 468 points, [x, y, z] in input pixels. 13 and 14 are the inner lips. */
  mesh: [number, number, number][];
}
export interface HumanObject {
  label: string;
  score: number;
  box: HumanBox;
  boxRaw: HumanBox;
}
export interface HumanResult {
  face: HumanFace[];
  object: HumanObject[];
  error?: string | null;
}
export class Human {
  constructor(config?: Record<string, unknown>);
  tf: { env(): { set(name: string, value: boolean | number): void } };
  config: Record<string, unknown>;
  load(config?: Record<string, unknown>): Promise<void>;
  detect(input: HTMLCanvasElement | OffscreenCanvas | ImageData, config?: Record<string, unknown>): Promise<HumanResult>;
}
export default Human;

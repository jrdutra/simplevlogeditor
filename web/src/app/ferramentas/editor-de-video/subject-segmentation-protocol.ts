export interface SubjectSegmentationRequest {
  id: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export type SubjectSegmentationResponse =
  | { type: 'done'; id: number; width: number; height: number; alpha: Uint8ClampedArray; coverage: number }
  | { type: 'empty'; id: number }
  | { type: 'error'; id: number; message: string };

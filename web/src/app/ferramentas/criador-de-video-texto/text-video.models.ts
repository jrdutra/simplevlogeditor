import type { AudioCodec, VideoCodec } from 'mediabunny';

/**
 * Types shared by every layer of the Text Video & Image Maker.
 *
 * The centre of gravity is {@link TextScene}: one plain object that describes a
 * frame completely. The preview on screen and the encoder that writes the file
 * both render from it, through the same function, so what the reader watches
 * is what they download rather than an approximation of it.
 */

/** Where the text sits horizontally inside the safe area. */
export type HorizontalAlign = 'left' | 'center' | 'right';

/** Where the block of text sits vertically inside the safe area. */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** How the text arrives on screen. */
export type TextAnimation =
  | 'none'
  | 'fade'
  | 'typewriter'
  | 'rise'
  | 'blur-words'
  | 'mask-zoom'
  | 'scale-up'
  | 'slide-lines'
  | 'word-drop'
  | 'tracking-in'
  | 'line-reveal'
  | 'glitch';

/** What keeps light text readable over a light photograph. */
export type Legibility = 'none' | 'shadow' | 'outline' | 'band';

/** The background, resolved to something drawable. */
export type SceneBackground =
  | { kind: 'color'; color: string }
  | { kind: 'image'; image: CanvasImageSource; width: number; height: number };

/**
 * Everything needed to draw one frame.
 *
 * Sizes that should survive a change of resolution are stored as fractions:
 * the type size and the margin are shares of the frame height, so a design
 * composed at 720p exports identically at 4K.
 */
export interface TextScene {
  width: number;
  height: number;
  background: SceneBackground;

  text: string;
  fontFamily: string;
  /** Type size as a share of the frame height. */
  fontScale: number;
  fontWeight: number;
  color: string;
  /** Extra letter spacing, in ems. */
  letterSpacing: number;
  lineHeight: number;

  align: HorizontalAlign;
  vertical: VerticalAlign;
  /** Safe area kept clear at every edge, as a share of the frame height. */
  margin: number;

  legibility: Legibility;

  animation: TextAnimation;
  /** How long the text takes to finish arriving, in seconds. */
  revealSeconds: number;
  /** How long the finished frame is held afterwards, in seconds. */
  holdSeconds: number;

  fadeIn: boolean;
  fadeOut: boolean;
  fadeSeconds: number;
}

/** Total length of the clip: the reveal, then the hold. */
export function sceneDuration(scene: Pick<TextScene, 'revealSeconds' | 'holdSeconds'>): number {
  return Math.max(0.1, scene.revealSeconds + scene.holdSeconds);
}

/** The instant the still image is taken: the moment the text is complete. */
export function stillTime(scene: Pick<TextScene, 'revealSeconds'>): number {
  return scene.revealSeconds;
}

/** A container the video can be written to. */
export interface VideoFormatOption {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  note: string;
}

/** A file type the still image can be written to. */
export interface ImageFormatOption {
  id: string;
  label: string;
  extension: string;
  mimeType: string;
  /** False for the formats that flatten transparency onto the matte colour. */
  keepsAlpha: boolean;
  note: string;
}

/** Stages reported while rendering, in the order they run. */
export type RenderStage = 'preparing' | 'drawing' | 'audio' | 'muxing' | 'finishing';

export interface RenderProgress {
  stage: RenderStage;
  /** 0..1, or null when the stage genuinely cannot be measured. */
  ratio: number | null;
}

export interface RenderResult {
  blob: Blob;
  fileName: string;
  kind: 'video' | 'image';
  width: number;
  height: number;
  durationSeconds: number;
}

/** Raised when the reader cancels; callers treat it as a normal outcome. */
export class RenderCanceledError extends Error {
  constructor() {
    super('The render was canceled.');
    this.name = 'RenderCanceledError';
  }
}

/** Raised with a message already written for the reader. */
export class RenderError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'RenderError';
  }
}

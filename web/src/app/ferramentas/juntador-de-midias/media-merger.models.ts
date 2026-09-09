/**
 * Types shared by every layer of the Video & Audio Merger.
 *
 * Time is expressed in **seconds** throughout, as a floating point number, and
 * every duration in this file is the duration of the *source* file, never of
 * the output: the output timeline is derived, once, by the merge service.
 */

import type { AudioCodec, VideoCodec } from 'mediabunny';

/** What a probe could establish about one selected file. */
export interface MediaSummary {
  fileName: string;
  fileSize: number;
  /** Container as detected from the bytes, not from the extension. */
  containerName: string;
  /** A still picture is `image`; it has no tracks, but it does have a picture. */
  kind: 'video' | 'audio' | 'image';
  durationSeconds: number;
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  sampleRate: number | null;
  channelCount: number | null;
  /**
   * True when this entry contributes a picture the browser can actually draw.
   *
   * For a still image there is no track to decode, so this says what it means
   * everywhere it is read: there is something to put on screen.
   */
  videoUsable: boolean;
  /** True when the browser can actually decode the sound of this file. */
  audioUsable: boolean;
  /** Set when the file was accepted but something about it needs saying. */
  warning: string | null;
  /**
   * True when this file looks like it was shot as a timelapse.
   *
   * A suspicion, never a fact. Nothing available to a browser settles the
   * question — the signals behind it are an absent soundtrack and whatever the
   * container happens to admit — so everything downstream treats this as
   * something the reader may disagree with, and {@link timelapseReason} exists
   * so they can see what it was concluded from.
   */
  isTimelapse: boolean;
  /** Why that conclusion was reached, in words, for the tag's tooltip. */
  timelapseReason: string | null;
}

/** One entry of the merge queue, in the order the reader arranged it. */
export interface QueuedMedia {
  /** Stable across reordering, so the list can be tracked without index churn. */
  id: string;
  file: File;
  summary: MediaSummary;
  /**
   * Sound attached to a still image, which carries none of its own.
   *
   * Only ever set on an image entry. The image then lasts as long as the
   * reader says, and the sound is trimmed or padded with silence to match —
   * the queue's timing has to come from one place, and that place is the
   * duration on the entry itself.
   */
  attachedAudio: { file: File; summary: MediaSummary } | null;
  /** Ease this clip in from black and silence. */
  fadeIn: boolean;
  /** Ease this clip out to black and silence. */
  fadeOut: boolean;
  /** Object URL for the inline preview, created only when it is opened. */
  previewUrl: string | null;
}

/**
 * One ramp on the output timeline, in seconds.
 *
 * Fades are expressed in *output* time rather than per clip because the two
 * encoders that apply them — one for picture, one for sound — are configured
 * once for the whole merge and only ever see a timestamp. Resolving every fade
 * to the finished timeline up front is what lets both of them agree on where a
 * ramp begins without knowing anything about the queue.
 */
export interface FadeSegment {
  start: number;
  end: number;
  kind: 'in' | 'out';
}

/** A container the merged result can be written to. */
export interface OutputFormatOption {
  id: string;
  /** What the reader sees in the selector. */
  label: string;
  extension: string;
  mimeType: string;
  /** Null for the audio-only containers. Typed against the library so a
   *  mistyped codec in the catalogue fails to compile rather than at runtime. */
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec;
  /** One line explaining the trade-off, shown under the selector. */
  note: string;
}

/** How the picture of every clip is normalised before encoding. */
export type ResolutionPreset = 'auto' | '3840x2160' | '1920x1080' | '1280x720' | '854x480';

export interface MergeSettings {
  videoFormatId: string;
  audioFormatId: string;
  resolution: ResolutionPreset;
  /** Length of each fade, in seconds, before it is clamped to the clip. */
  fadeSeconds: number;
}

/** Stages reported while merging, in the order they run. */
export type MergeStage = 'preparing' | 'encoding' | 'muxing' | 'finishing';

export interface MergeProgress {
  stage: MergeStage;
  /** 0..1, or null when the stage genuinely cannot be measured. */
  ratio: number | null;
  /** Position of the item being read, 1-based, for "clip 3 of 7". */
  itemIndex: number;
  itemCount: number;
  itemName: string;
}

/** The plan the service settled on, shown to the reader before and after. */
export interface MergePlan {
  width: number;
  height: number;
  frameRate: number;
  sampleRate: number;
  channelCount: number;
  totalDuration: number;
  /** Items that contribute no picture and will play over a black screen. */
  audioOnlyCount: number;
  /** Items that contribute no sound and will play over silence. */
  silentCount: number;
  /** Ramps applied across the whole timeline, counting both ends. */
  fadeCount: number;
}

export interface MergeResult {
  /** Null when the file was streamed straight to the location the reader chose. */
  blob: Blob | null;
  fileName: string;
  savedToDisk: boolean;
  kind: 'video' | 'audio';
  plan: MergePlan;
}

/** Raised when the reader cancels; callers treat it as a normal outcome. */
export class MergeCanceledError extends Error {
  constructor() {
    super('The merge was canceled.');
    this.name = 'MergeCanceledError';
  }
}

/** Raised with a message already written for the reader. */
export class MergeError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'MergeError';
  }
}

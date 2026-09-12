/**
 * Versioned messages exchanged between the video editor and an automation host.
 *
 * This module deliberately contains data only. Electron, an MCP server and the
 * Angular component can all depend on it without teaching the timeline about a
 * transport or giving the renderer access to Node.
 */

export const EDITOR_AGENT_API_VERSION = 2;

export interface EditorAgentRequest {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface EditorAgentResponse {
  apiVersion: number;
  projectRevision: number;
  result: unknown;
}

export class EditorAgentError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid_request',
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'EditorAgentError';
  }
}

/** The subset of project settings that is safe to send over JSON. */
export interface EditorAgentProjectPatch {
  aspect?: 'source' | '9:16' | '1:1';
  reframe?: 'fill' | 'fit';
  resolution?: string;
  videoFormatId?: string;
  audioFormatId?: string;
  timelapseTargetSeconds?: number;
  silentCutReplacementThreshold?: number;
  soundFade?: { fadeIn?: boolean; fadeOut?: boolean; seconds?: number };
  loudness?: Record<string, unknown>;
  edits?: Record<string, unknown>;
  defaultTransition?: Record<string, unknown> | null;
  defaultTag?: Record<string, unknown>;
}

export type EditorAgentOperation =
  | { type: 'remove_clip'; clipId: string }
  | { type: 'move_clip'; clipId: string; toIndex: number }
  | { type: 'duplicate_clip'; clipId: string }
  | { type: 'add_text_clip'; atIndex?: number; text: string; durationSeconds?: number; draft?: Record<string, unknown> }
  | { type: 'update_text_clip'; clipId: string; text?: string; durationSeconds?: number; draft?: Record<string, unknown> }
  | { type: 'set_text_background'; clipId: string; path: string | null }
  | { type: 'add_transition'; atIndex: number; settings?: Record<string, unknown> }
  | { type: 'update_transition'; clipId: string; settings: Record<string, unknown> }
  | { type: 'split_clip'; clipId: string; sourceTime: number }
  | { type: 'trim_clip'; clipId: string; inPoint?: number; outPoint?: number }
  | { type: 'clear_trim'; clipId: string }
  | { type: 'set_image_duration'; clipId: string; durationSeconds: number }
  | { type: 'delete_source_range'; clipId: string; start: number; end: number; reason?: string }
  | { type: 'restore_source_ranges'; clipId: string }
  | { type: 'set_detected_range'; clipId: string; rangeIndex: number; enabled: boolean }
  | { type: 'set_speed'; clipId: string; speed: number }
  | { type: 'set_volume'; clipId: string; volumePercent: number }
  | { type: 'set_audio_mode'; clipId: string; mode: 'original' | 'replace' | 'continue' | 'mute' }
  | { type: 'set_clip_edits'; clipId: string; edits: Record<string, unknown> }
  | { type: 'clear_clip_overrides'; clipId: string }
  | { type: 'attach_audio'; clipId?: string; path: string; skipLeadingSilence?: boolean }
  | { type: 'detach_audio'; clipId?: string }
  | { type: 'add_caption'; clipId: string; start: number; text: string; duration?: number }
  | { type: 'update_caption'; clipId: string; captionId: string; caption: Record<string, unknown> }
  | { type: 'remove_caption'; clipId: string; captionId: string }
  | { type: 'set_tag'; clipId: string; tag: Record<string, unknown> }
  | { type: 'remove_tag'; clipId: string }
  | { type: 'add_zoom'; clipId: string; start: number; end: number; scalePercent?: number; rampSeconds?: number; easeOut?: boolean }
  | { type: 'add_push_in'; clipId: string; start: number; end: number; scalePercent?: number; rampSeconds?: number; easeOut?: boolean }
  | { type: 'update_zoom'; clipId: string; zoomId: string; zoom: Record<string, unknown> }
  | { type: 'update_push_in'; clipId: string; pushInId: string; pushIn: Record<string, unknown> }
  | { type: 'remove_zoom'; clipId: string; zoomId: string }
  | { type: 'remove_push_in'; clipId: string; pushInId: string }
  | { type: 'set_project_settings'; settings: EditorAgentProjectPatch };

export interface EditorAgentBatch {
  expectedRevision?: number;
  label?: string;
  dryRun?: boolean;
  operations: EditorAgentOperation[];
}

export interface EditorAgentFrameRequest {
  clipId: string;
  timestamps: number[];
  width?: number;
  quality?: number;
}

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EditorAgentError(`${field} must be a finite number.`, 'invalid_arguments');
  }
  return value;
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EditorAgentError(`${field} must be a non-empty string.`, 'invalid_arguments');
  }
  return value;
}

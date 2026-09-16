/**
 * What the editor tells an agent it can do.
 *
 * Lifted out of the component because it is the one part of the MCP surface
 * that is almost pure data: one object literal, three values read from the
 * editor, and nothing else. Seven kilobytes of it sat in the middle of a file
 * far too large to read, between two methods with nothing to do with it.
 *
 * It is also the file to open when the question is "what does this editor
 * support" — which, inlined in a thirteen-thousand-line component, nobody could
 * answer without a search.
 *
 * The three editor values arrive as a parameter rather than through a reference
 * to the component, so this module knows nothing about Angular and the compiler
 * states the dependency rather than leaving it to be discovered by reading.
 */

import { AUDIO_FORMATS, RESOLUTIONS, VIDEO_FORMATS } from '../juntador-de-midias/media-merger-formats';
import { ANIMATIONS, FONTS, LEGIBILITY_OPTIONS } from '../criador-de-video-texto/text-video-presets';
import { ENGINES as NOISE_ENGINES, STRENGTHS as NOISE_STRENGTHS } from '../supressao-de-ruido/noise-suppression.models';
import { IMAGE_LIMITS, IMAGE_RESTRAINED_ROTATION, IMAGE_STYLES } from './clip-image';
import { TAG_SHAPES, TAG_SPECIALS, shapeIsQr } from './tag-overlay';
import { TRANSITIONS } from './video-transitions';
import { VIDEO_EFFECTS, VIDEO_VISION_CAPABILITIES } from './video-effects';
import {
  ASPECTS,
  CAPTION_ANIMATIONS,
  CAPTION_FONTS,
  CAPTION_LIMITS,
  CAPTION_PRESETS,
  MANUAL_ZOOM_LIMITS,
  REFRAME_FITS
} from './video-editor-defaults';

/**
 * The parts of the answer only the running editor knows.
 *
 * Structurally typed rather than importing the component's own types: this
 * module is a leaf, and a leaf that imported the component would make a cycle
 * out of the one thing that was extracted to avoid reading it.
 */
export interface CapabilityInputs {
  behindSubjectPositions: readonly { id: string }[];
  captionPresetGroups: readonly { id: string; presets: readonly { id: string }[] }[];
  noiseStrengthIds: readonly string[];
}

export function editorCapabilities(editor: CapabilityInputs): unknown {

  return {
    /**
     * Every time in every operation and every reply is measured in original
     * source seconds. The panel can show the reader either clock, but that is a
     * display choice in the fields and never reaches this interface.
     */
    timeSpace: {
      operations: 'source',
      note: 'start, duration, startSeconds and durationSeconds are always original source seconds. get_timeline additionally reports outputStart and outputDuration for reasoning about the assembled result.'
    },
    commands: [
      'get_editor_capabilities', 'get_project', 'list_assets', 'get_timeline', 'add_media', 'open_project', 'save_project', 'set_project_soundtrack', 'finish_editing', 'preview',
      'analyze_silence', 'analyze_noise', 'suppress_noise', 'get_waveform_page', 'transcribe', 'get_frames', 'get_contact_sheet', 'apply_edit_batch', 'undo', 'redo', 'export'
    ],
    operationTypes: [
      'remove_clip', 'move_clip', 'duplicate_clip', 'add_text_clip', 'update_text_clip', 'set_text_background',
      'add_transition', 'update_transition', 'split_clip', 'trim_clip', 'clear_trim', 'set_image_duration',
      'delete_source_range', 'restore_source_ranges', 'set_detected_range', 'set_speed', 'set_volume', 'set_audio_mode', 'set_clip_edits',
      'set_noise_suppression', 'set_video_effect', 'add_video_effect', 'update_video_effect', 'remove_video_effect',
      'clear_clip_overrides', 'attach_audio', 'detach_audio', 'add_caption', 'update_caption', 'remove_caption',
      'add_image', 'update_image', 'remove_image',
      'set_tag', 'remove_tag', 'add_push_in', 'update_push_in', 'remove_push_in',
      'add_zoom', 'update_zoom', 'remove_zoom', 'set_project_settings'
    ],
    pushIn: {
      preferredOperations: ['add_push_in', 'update_push_in', 'remove_push_in'],
      legacyAliases: ['add_zoom', 'update_zoom', 'remove_zoom'],
      timeSpace: 'source',
      scalePercent: MANUAL_ZOOM_LIMITS.scalePercent,
      rampSeconds: MANUAL_ZOOM_LIMITS.rampSeconds,
      durationSeconds: MANUAL_ZOOM_LIMITS.seconds,
      note: 'A push-in ramps from 1x to scalePercent, holds for the selected source interval, and optionally eases back out.'
    },
    tagShapes: [
      ...TAG_SHAPES.map((item) => ({ id: item.id, label: item.label, qr: false })),
      ...TAG_SPECIALS.map((item) => ({ id: item.id, label: item.label, family: item.family, qr: shapeIsQr(item.id) }))
    ],
    transitions: TRANSITIONS.map((item) => ({ id: item.id, label: item.label, description: item.description })),
    textCards: {
      fonts: FONTS.map((item) => item.id),
      animations: ANIMATIONS.map((item) => item.id),
      legibility: LEGIBILITY_OPTIONS.map((item) => item.id),
      align: ['left', 'center', 'right'],
      vertical: ['top', 'middle', 'bottom']
    },
    videoEffects: {
      scope: 'visual-media-container-only',
      timeSpace: 'source',
      operations: {
        wholeContainer: 'set_video_effect',
        timedSections: ['add_video_effect', 'update_video_effect', 'remove_video_effect']
      },
      overlap: 'Timed Video Effect sections in the same container may touch but cannot overlap. An overlapping request fails with video_effect_overlap and reports the free room that is actually available.',
      intensity: { min: 0, max: 1 },
      fadeSeconds: {
        min: 0,
        max: 10,
        appliesTo: ['add_video_effect', 'update_video_effect'],
        note: 'Edge between the untouched video and the effected section. 0 is an abrupt cut. A positive value ramps the effect in and out over that many seconds on each side and is clamped to half the section duration.'
      },
      presets: VIDEO_EFFECTS,
      vision: VIDEO_VISION_CAPABILITIES,
      fallback: 'No person: original image. Model/GPU failure: original preview with notice; export stops with an explicit error.'
    },
    images: {
      scope: 'visual-media-container-only',
      timeSpace: 'source',
      operations: ['add_image', 'update_image', 'remove_image'],
      overlap: 'Placed pictures may overlap each other freely; two of them on screen at once is a normal placement.',
      styles: IMAGE_STYLES.map((item) => ({ id: item.id, label: item.label, description: item.description })),
      /** Width as a share of the frame width. The aspect ratio is always kept. */
      scale: { min: IMAGE_LIMITS.scale.min, max: IMAGE_LIMITS.scale.max, default: IMAGE_LIMITS.scale.default },
      position: {
        min: IMAGE_LIMITS.position.min, max: IMAGE_LIMITS.position.max,
        note: 'positionX and positionY are the centre of the picture, as shares of the finished frame.'
      },
      rotationDegrees: {
        min: IMAGE_LIMITS.rotationDegrees.min,
        max: IMAGE_LIMITS.rotationDegrees.max,
        restraint: IMAGE_RESTRAINED_ROTATION,
        note: `Stay within ±${IMAGE_RESTRAINED_ROTATION} degrees unless the reader asked for a stronger tilt.`
      },
      opacity: { min: IMAGE_LIMITS.opacity.min, max: IMAGE_LIMITS.opacity.max },
      fadeSeconds: {
        min: IMAGE_LIMITS.fadeSeconds.min, max: IMAGE_LIMITS.fadeSeconds.max,
        note: 'Edge of the placement. 0 is a hard cut; above 0 fades the picture in and out and is clamped to half the placement.'
      },
      source: 'An absolute path inside the allowed roots. The picture is decoded in the editor; no picture bytes leave this machine.',
      verification: 'get_frames with composited: true returns the frame as it will be exported, which is the only way to check that a picture lands whole and in the right place.',
      report: 'get_timeline returns each placement with its measured box in frame pixels, fitsInFrame, and covers — the captions and tag this placement is drawn over, which the editor measures rather than leaving to be spotted by eye.'
    },
    captions: {
      presets: CAPTION_PRESETS.map((item) => item.id),
      presetGroups: Object.fromEntries(editor.captionPresetGroups.map((group) => [group.id, group.presets.map((preset) => preset.id)])),
      fonts: CAPTION_FONTS.map((item) => item.value),
      animations: CAPTION_ANIMATIONS.map((item) => item.value),
      styles: ['classic', 'behind-subject'],
      behindSubject: {
        positions: editor.behindSubjectPositions.map((item) => item.id),
        positionCoordinates: 'normalized-frame',
        fontScale: { min: 0.2, max: 0.4 },
        fallback: 'The style remains behind-subject; when no person can be segmented, text is rendered normally in the same position.'
      }
    },
    project: {
      aspects: ASPECTS.map((item) => item.value),
      reframes: REFRAME_FITS.map((item) => item.value),
      resolutions: ['auto', ...RESOLUTIONS.map((item) => item.value)],
      videoFormats: VIDEO_FORMATS.map((item) => item.id),
      audioFormats: AUDIO_FORMATS.map((item) => item.id)
    },
    audio: {
      defaultTarget: 'project',
      note: 'Omit clipId when attaching generally requested music or background audio. Use clipId only for an explicitly named section.'
    },
    noiseSuppression: {
      scope: 'media-clip-only',
      engines: NOISE_ENGINES.map((engine) => ({ id: engine.id, label: engine.label, note: engine.note })),
      strengths: NOISE_STRENGTHS.map((strength, index) => ({
        id: editor.noiseStrengthIds[index], label: strength.label, attenuationDb: strength.attenuationDb, note: strength.note
      })),
      analysisStatuses: ['Low background', 'Probable noise', 'Relevant noise', 'Inconclusive'],
      explicitConsent: 'analyze_noise never enables or applies suppression. Call suppress_noise or set_noise_suppression only when the user explicitly asks to remove noise.'
    },
    semantics: {
      mutable: ['add_media', 'open_project', 'set_project_soundtrack', 'suppress_noise', 'apply_edit_batch', 'undo', 'redo'],
      derivedState: ['analyze_silence', 'analyze_noise'],
      readOnly: ['get_project', 'list_assets', 'get_timeline', 'get_waveform_page', 'transcribe', 'get_frames', 'get_contact_sheet'],
      waveform: 'analyze_silence returns summary metadata by default; use includeWaveform with a bounded page or get_waveform_page.'
    }
  };
}

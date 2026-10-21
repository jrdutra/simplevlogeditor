import { Injectable, inject } from '@angular/core';

import { AGENT_REQUEST_NOT_HANDLED, DesktopService } from '../../shared/desktop/desktop.service';
import { AgentActivityService } from '../../shared/ui/agent-activity.service';
import { EDITOR_AGENT_API_VERSION } from '../editor-de-video/editor-agent-api';

/** The model the window's "Analyze video" uses for captions. */
const CAPTION_MODEL = 'onnx-community/whisper-base_timestamped';
const SMOOTHNESS = ['abrupt', 'slight', 'smooth', 'very'];
const PRESETS = ['Classic', 'Neon', 'Impact', 'Minimal', 'Editorial'];

interface ShortCut { start: number; end: number; cropX?: number; cropTrack?: { t: number; x: number }[]; follow?: unknown }
interface ShortCard { id: string; name: string; ranges: ShortCut[]; settings: { cropX: number }; status: string }
interface ShortState {
  analysisToken: string;
  source: { path: string; name: string; duration: number; hasAudio: boolean } | null;
  selection: ShortCut[];
  draftSettings: { cropX: number };
  shorts: ShortCard[];
}

function failure(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The Short Editor commands that need the window: following a person and
 * transcribing for captions both run in the browser engine on this computer,
 * with the same code as the window's own buttons. The results are stored
 * through the Short Editor in the main process, so the window, the MCP state
 * and the render all see the same session.
 *
 * Registered once by the application shell, so it answers whichever tool tab
 * is open. The heavy modules are loaded only when a command arrives.
 */
@Injectable({ providedIn: 'root' })
export class ShortAgentService {
  private readonly desktop = inject(DesktopService);
  private readonly activity = inject(AgentActivityService);
  private registered = false;
  private readonly controllers = new Map<string, AbortController>();

  register(): void {
    if (this.registered) return;
    this.registered = true;
    this.desktop.registerAgentCancelHandler((id) => this.controllers.get(id)?.abort());
    this.desktop.registerAgentHandler((request) => this.handle(request));
  }

  private async handle(request: unknown): Promise<unknown> {
    if (!request || typeof request !== 'object' || !('name' in request)) return AGENT_REQUEST_NOT_HANDLED;
    const name = String((request as { name: unknown }).name);
    if (name !== 'short_track_person' && name !== 'short_generate_captions') return AGENT_REQUEST_NOT_HANDLED;
    const args = ((request as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>;
    const bridge = typeof window !== 'undefined' ? window.desktop : undefined;
    if (!bridge?.shortCommand) throw failure('The Short Editor commands need the desktop application.', 'unsupported');

    const operationId = String((request as { id?: unknown }).id ?? args['requestId'] ?? '');
    if (!operationId) throw failure('An operation id is required.', 'invalid_arguments');
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    const command = async (name: string, values: Record<string, unknown> = {}) => {
      this.assertActive(controller.signal);
      return bridge.shortCommand!(name, { ...values, _operationId: operationId });
    };

    this.activity.begin();
    this.activity.append('command', name.replaceAll('_', ' '), name, 'INFO');
    try {
      const result = name === 'short_track_person'
        ? await this.trackPerson(command, args, name, controller.signal)
        : await this.generateCaptions(command, args, name, controller.signal);
      this.activity.append('done', `${name.replaceAll('_', ' ')} completed`, name, 'INFO');
      return { apiVersion: EDITOR_AGENT_API_VERSION, projectRevision: 0, result };
    } catch (error) {
      if (controller.signal.aborted) throw failure('Short Editor analysis was cancelled.', 'cancelled');
      this.activity.append('fail', error instanceof Error ? error.message : String(error), name, 'ERROR');
      throw error;
    } finally {
      this.controllers.delete(operationId);
      this.activity.end();
    }
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw failure('Short Editor analysis was cancelled.', 'cancelled');
  }

  /** The loaded source video, as a file the decoders can read in ranges. */
  private async sourceFile(state: ShortState): Promise<File> {
    if (!state.source) throw failure('Import a video into the Short Editor first (short_import_video).', 'invalid_state');
    const [file] = await this.desktop.readAgentFiles([state.source.path]);
    if (!file) throw failure(`The source video could not be read: ${state.source.path}`, 'not_found');
    return file;
  }

  /** Progress in the AI control log, one line per tenth rather than per frame. */
  private progress(module: string, label: string): (share: number) => void {
    let shown = -1;
    return (share: number) => {
      const step = Math.floor(Math.max(0, Math.min(1, share)) * 10);
      if (step <= shown) return;
      shown = step;
      this.activity.append('action', label, module, 'INFO', new Date().toISOString(), step * 10);
    };
  }

  private async trackPerson(
    command: (name: string, args?: Record<string, unknown>) => Promise<any>,
    args: Record<string, unknown>,
    module: string,
    signal: AbortSignal
  ): Promise<unknown> {
    const state = (await command('short_get_state')) as ShortState;
    const id = args['id'] === undefined ? undefined : String(args['id']);
    const short = id === undefined ? null : state.shorts.find((item) => item.id === id) ?? null;
    if (id !== undefined && !short) throw failure('Short not found.', 'not_found');
    if (short?.status === 'rendering') throw failure('Wait for this short to finish rendering.', 'busy');
    const cuts = (short ? short.ranges : state.selection).map((cut) => ({ ...cut }));
    if (!cuts.length) throw failure('There are no cuts to follow. Select cuts or pass the id of a short.', 'invalid_state');

    let indexes = cuts.map((_, index) => index);
    if (args['cutIndex'] !== undefined) {
      const index = Number(args['cutIndex']);
      if (!Number.isInteger(index) || index < 0 || index >= cuts.length) throw failure('Invalid cutIndex (zero-based).', 'invalid_arguments');
      indexes = [index];
    }
    const restX = args['restX'] === undefined ? undefined : Number(args['restX']);
    if (restX !== undefined && !(restX >= 0 && restX <= 1)) throw failure('restX must be between 0 and 1.', 'invalid_arguments');

    const tracker = await import('./person-tracker');
    const follow = { ...tracker.DEFAULT_FOLLOW, ...((args['follow'] ?? {}) as Record<string, unknown>) } as typeof tracker.DEFAULT_FOLLOW;
    const wait = (value: unknown) => Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 5000;
    if (typeof follow.delays !== 'boolean' || !wait(follow.startDelayMs) || !wait(follow.holdDelayMs) || !SMOOTHNESS.includes(follow.smoothness)) {
      throw failure('Invalid follow settings.', 'invalid_arguments');
    }

    const file = await this.sourceFile(state);
    const settings = short ? short.settings : state.draftSettings;
    const report: { cutIndex: number; start: number; end: number; personSeenShare: number; points: number }[] = [];
    for (const index of indexes) {
      this.assertActive(signal);
      const cut = cuts[index];
      const analysis = await tracker.analysePeople(
        file, cut.start, cut.end,
        this.progress(module, `Finding the person in cut ${index + 1} of ${cuts.length}`),
        () => signal.aborted
      );
      this.assertActive(signal);
      const rest = restX ?? cut.cropX ?? settings.cropX ?? 0.5;
      const track = tracker.followPath(analysis, follow, rest);
      const seen = analysis.samples.filter((sample) => sample.faces.length || sample.people.length).length;
      if (track.length) {
        cut.cropTrack = track;
        cut.follow = { ...follow };
      }
      report.push({
        cutIndex: index, start: cut.start, end: cut.end, points: track.length,
        personSeenShare: Math.round((seen / Math.max(1, analysis.samples.length)) * 100) / 100
      });
    }

    this.assertActive(signal);
    const next = short
      ? await command('short_update', { id: short.id, ranges: cuts, _analysisToken: state.analysisToken })
      : await command('short_set_selection', { ranges: cuts, _analysisToken: state.analysisToken });
    return {
      target: short ? { id: short.id, name: short.name } : 'selection',
      follow, cuts: report,
      revision: (next as { revision?: number }).revision,
      nextStep: 'Render again to see the framing. Use short_set_focus to choose the framing yourself where nobody is visible.'
    };
  }

  private async generateCaptions(
    command: (name: string, args?: Record<string, unknown>) => Promise<any>,
    args: Record<string, unknown>,
    module: string,
    signal: AbortSignal
  ): Promise<unknown> {
    const state = (await command('short_get_state')) as ShortState;
    if (!state.source) throw failure('Import a video into the Short Editor first (short_import_video).', 'invalid_state');
    const preset = args['preset'] === undefined ? undefined : String(args['preset']);
    if (preset !== undefined && !PRESETS.includes(preset)) throw failure(`Unknown caption preset. Choose one of ${PRESETS.join(', ')}.`, 'invalid_arguments');
    const enabled = args['enabled'] === undefined ? true : Boolean(args['enabled']);
    const requested = typeof args['language'] === 'string' ? args['language'].trim().toLowerCase() : '';
    const language = requested === 'auto' ? '' : requested;

    if (!state.source.hasAudio) {
      return {
        noAudio: true, wordCount: 0,
        warning: `${state.source.name} has no sound, so there is nothing to caption.`,
        nextStep: 'Use music or another audio for these shorts (settings.audioPath) and leave captions off.'
      };
    }

    const file = await this.sourceFile(state);
    const speech = await import('../transcricao-de-video/speech-recognizer');
    const { alignedCaptionWords } = await import('./short-captions');
    this.assertActive(signal);
    let lastStage = '';
    const announce = (progress: { stage: string; ratio: number | null }) => {
      const share = progress.ratio === null ? null : Math.round(progress.ratio * 100);
      const key = `${progress.stage}|${share === null ? '' : Math.floor(share / 10)}`;
      if (key === lastStage) return;
      lastStage = key;
      this.activity.append('action', `Transcribing for captions · ${progress.stage}`, module, 'INFO', new Date().toISOString(), share);
    };
    const samples = await speech.readSpeechAudio(file, announce, signal);
    this.assertActive(signal);
    const heard = await speech.transcribe(samples, { model: CAPTION_MODEL, language }, announce, signal);
    this.assertActive(signal);
    const words = alignedCaptionWords(heard);

    await command('short_set_selection', {
      _analysisToken: state.analysisToken,
      ranges: state.selection,
      settings: { captions: { enabled: enabled && words.length > 0, words, ...(preset ? { preset } : {}) } }
    });
    const transcript = await command('short_get_transcript', {}) as { segments?: unknown[] };
    return {
      wordCount: words.length,
      language: language || 'auto',
      captionsEnabled: enabled && words.length > 0,
      ...(words.length ? {} : { warning: 'No speech was recognized, so captions were left off.' }),
      timeSpace: 'source',
      segments: transcript.segments ?? []
    };
  }
}

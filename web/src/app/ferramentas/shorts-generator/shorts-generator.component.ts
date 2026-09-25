import { CommonModule, isPlatformBrowser } from '@angular/common';
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, PLATFORM_ID, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { A11yModule } from '@angular/cdk/a11y';
import { MatIconModule } from '@angular/material/icon';
import '../../shared/desktop/desktop.service';
import { ShortBrowserEditor, ShortCommandArgs, cropAtTime } from './short-browser-editor';
import { CropKey, DEFAULT_FOLLOW, FollowOptions, FollowSmoothness, PersonAnalysis, analysePeople, followPath } from './person-tracker';
import { ShortFrames, shortFrames, shortWaveform } from './short-waveform';
import { FrameSource, RangeResize, SilenceWaveformComponent, WaveformLabels, formatDuration } from '../cortador-de-silencio/waveform.component';
import { EditableRange, TimeRange, WaveformData } from '../cortador-de-silencio/silence-cutter.models';
import { PathBackedFile } from '../../shared/desktop/path-backed-file';
import { HelpHintComponent } from '../editor-de-video/help-hint.component';

interface Cut { start: number; end: number; cropX?: number; cropTrack?: CropKey[]; follow?: FollowOptions; }
interface Settings { audioPath: string | null; volume: number; musicVolume?: number; cropX: number; transition: string; transitionSeconds: number; audioFadeOut?: number | null; audioFadeIn?: number | null; }
interface Short { id: string; name: string; ranges: Cut[]; settings: Settings; status: string; progress: number; outputPath?: string; error?: string; }
interface Session {
  source: { path: string; name: string; duration: number; filmstrip: string; waveformImage?: string; hasAudio: boolean } | null;
  selection: Cut[]; draftSettings: Settings; shorts: Short[]; zoom: number; playhead: number; revision: number;
}
/** Where the reader last left the divider between the video and the settings, and the bottom edge of the video. */
const SPLIT_KEY = 'utily.short-editor.split.v1';
const VIDEO_HEIGHT_KEY = 'utily.short-editor.altura-video.v1';
/** The same limits as the Video Editor's two panes. */
const SPLIT_PROJECT_MIN = 320, SPLIT_PREVIEW_MIN = 480, SPLIT_MAX_SHARE = 0.55;
const SPLIT_STEP = 16, SPLIT_STEP_FAST = 64;
const VIDEO_MIN = 160, VIDEO_MAX_SHARE = 0.85;
function readSetting(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function saveSetting(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage refused */ } }
function dropSetting(key: string) { try { localStorage.removeItem(key); } catch { /* storage refused */ } }
/** Written into every saved file, so Open can tell a Short Editor file from anything else. */
const DOCUMENT_APP = 'simplevlogeditor-short-editor';
/** Where the web version keeps the session between visits (the desktop keeps its own on disk). */
const STORAGE_KEY = 'utily.short-editor.project.v1';
/** Settings as saved: the chosen audio also by name, since its path may not travel. */
type SavedSettings = Settings & { audioName?: string | null };
interface SavedShort { name: string; ranges: Cut[]; settings: SavedSettings; }
interface ProjectDocument {
  app: string; kind: 'project'; version: 1; savedAt: string;
  source: { name: string; path?: string; duration: number };
  selection: Cut[]; draftSettings: SavedSettings; shorts: SavedShort[]; zoom: number;
}
interface SettingsDocument { app: string; kind: 'settings'; version: 1; savedAt: string; settings: SavedSettings; }
type ShortDocument = ProjectDocument | SettingsDocument;
function isShortDocument(value: unknown): value is ShortDocument {
  const doc = value as Partial<ShortDocument> | null;
  if (!doc || typeof doc !== 'object' || doc.app !== DOCUMENT_APP) return false;
  if (doc.kind === 'settings') return !!(doc as SettingsDocument).settings && typeof (doc as SettingsDocument).settings === 'object';
  const project = doc as Partial<ProjectDocument>;
  return doc.kind === 'project' && !!project.source && typeof project.source.name === 'string'
    && Array.isArray(project.selection) && Array.isArray(project.shorts) && !!project.draftSettings;
}
const defaults = (): Settings => ({ audioPath: null, volume: 1, musicVolume: 1, cropX: .5, transition: 'cut', transitionSeconds: .3 });

@Component({
  selector: 'app-shorts-generator',
  standalone: true,
  imports: [CommonModule, FormsModule, A11yModule, MatIconModule, SilenceWaveformComponent, HelpHintComponent],
  templateUrl: './shorts-generator.component.html',
  styleUrl: './shorts-generator.component.css'
})
export class ShortsGeneratorComponent implements OnInit, OnDestroy, AfterViewChecked {
  private platform = inject(PLATFORM_ID);
  private changeDetector = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private browserEditor = new ShortBrowserEditor(() => this.browserChanged());
  private browserSource: File | null = null;
  @ViewChild('player') player?: ElementRef<HTMLVideoElement>;
  /** The workspace holding the video and the settings beside it, and the video's own panel. */
  @ViewChild('bancada') bancada?: ElementRef<HTMLElement>;
  @ViewChild('previaSecao') previaSecao?: ElementRef<HTMLElement>;
  splitWidth: number | null = null; videoHeight: number | null = null;
  /** The transport under the video, as in the Video Editor. */
  playerPlaying = false; previewFullscreen = false;
  /** The settings beside the video open or folded, as the Video Editor's project settings. */
  projectOpen = true;
  private readonly fullscreenChanged = () => {
    this.previewFullscreen = !!this.previaSecao && document.fullscreenElement === this.previaSecao.nativeElement;
    this.changeDetector.detectChanges();
  };
  clock(seconds: number) { return formatDuration(seconds); }
  /** A fade length as shown: its own, or the overlap's when none was chosen (the crossfade it always had). */
  fadeOf(settings: Settings, which: 'audioFadeOut' | 'audioFadeIn') { return settings[which] ?? settings.transitionSeconds; }
  fadesOn(settings: Settings) { return this.fadeOf(settings, 'audioFadeOut') > 0 || this.fadeOf(settings, 'audioFadeIn') > 0; }
  /** Tenths of a second, between none and two seconds. */
  tenth(value: unknown) { const number = Number(value); return Number.isFinite(number) ? Math.round(Math.min(2, Math.max(0, number)) * 10) / 10 : 0; }
  fadesSwitched(settings: Settings, on: boolean): Partial<Settings> {
    const length = this.tenth(settings.transitionSeconds) || .3;
    return on ? { audioFadeOut: length, audioFadeIn: length } : { audioFadeOut: 0, audioFadeIn: 0 };
  }
  switchConfigFades(on: boolean) { Object.assign(this.config, this.fadesSwitched(this.config, on)); }
  togglePlayer() {
    const video = this.player?.nativeElement;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }
  scrubPlayer(seconds: number) {
    const video = this.player?.nativeElement;
    if (!video || !Number.isFinite(seconds)) return;
    video.currentTime = seconds; this.cursor = seconds;
  }
  async togglePreviewFullscreen() {
    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      const stage = this.previaSecao?.nativeElement;
      if (!stage?.requestFullscreen) { this.error = 'This browser will not put the video on the whole screen.'; return; }
      await stage.requestFullscreen();
    } catch { this.error = 'The browser would not switch to full screen.'; }
  }
  private layoutPending = true;
  /** A draft-settings change waiting to be sent, so a refresh does not undo what the reader just moved. */
  private draftTimer?: ReturnType<typeof setTimeout>;
  @ViewChild('previewVideo') previewVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('previewAudio') previewAudio?: ElementRef<HTMLAudioElement>;
  state: Session = { source: null, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: 0 };
  busy = false; error = ''; sourceUrl = ''; outputUrls: Record<string, string> = {};
  /** What Save offers, what Open is waiting on, and what it has to say about it. */
  saveChooser = false; notice = '';
  pendingDocument: ShortDocument | null = null; private pendingName = '';
  /** True from the click that opens the file picker until the chosen video is loaded (or the picker is closed empty). */
  importing = false;
  private pickerOpen = false; private pickerTimer?: ReturnType<typeof setTimeout>;
  editingId: string | null = null; title = ''; modal = false; modalId: string | null = null;
  config = defaults(); configName = '';
  cursor = 0;
  /** The stretch whose own settings are open, as an editable copy. */
  cutModal: {
    index: number; start: number; end: number; cropX: number;
    /** Person tracking: on or off, the path it found, the stretch that path covers, and how far an analysis has got. */
    tracking: boolean; track: CropKey[] | null; trackedStart: number; trackedEnd: number; analysing: number | null;
    trackingStage?: 'loading' | 'analysing' | 'fallback';
    /** The follow settings, their balloon, and what the video analysis found (kept so settings redraw the path at once). */
    follow: FollowOptions; followOpen: boolean; analysis: PersonAnalysis | null;
  } | null = null;
  readonly smoothnessLevels: { id: FollowSmoothness; name: string }[] = [
    { id: 'abrupt', name: 'Abrupt' }, { id: 'slight', name: 'Slightly smooth' }, { id: 'smooth', name: 'Smooth' }, { id: 'very', name: 'Very smooth' }
  ];
  /** Analyses already made this session, by video and stretch, so reopening a cut does not look at the video again. */
  private analyses = new Map<string, PersonAnalysis>();
  private followTimer?: ReturnType<typeof setTimeout>;
  /** The video file the tracking reads from (the one the timeline was drawn from). */
  private mediaFile: File | null = null;
  private trackToken = 0;
  cutPlaying = false;
  /** The short preview in the settings dialog: where it is, in seconds of the short, and whether it plays. */
  previewPlaying = false; previewAt = 0; previewAudioUrl = '';
  private previewIndex = 0; private previewFrame = 0;
  private previewAudioFor: string | null = null; private previewAudioObject = false;
  /** The Clear all confirmation is open. */
  clearAllOpen = false;
  framing: { x: number; crop: number; travel: number; pointer: number } | null = null;
  trackShort(_index: number, short: Short) { return short.id; }
  trackCut(index: number) { return index; }
  /** The timeline is the silence cutter's: same waveform, same way of marking and adjusting stretches. */
  waveform: WaveformData | null = null; waveformError = '';
  /** Pictures for the timeline's picture track, one per tile, at the second each tile starts. */
  frameSource?: FrameSource; frameAspect = 16 / 9; private frames?: ShortFrames;
  private waveformToken = 0; private zoomTimer?: ReturnType<typeof setTimeout>;
  private rangeList: EditableRange[] = []; private rangesKey = ''; private rangeIndex = new Map<EditableRange, number>();
  readonly waveformLabels: Partial<WaveformLabels> = {
    legendOutside: 'Not in the short', legendRange: 'Cut in the short', legendSelected: 'Selected',
    hint: 'Left-drag to mark a cut, drag either edge of a cut to adjust it, scroll the mouse wheel to zoom, right-drag or shift-scroll to slide the timeline, use the arrows to pick the previous or next cut. Every cut has a play button (plays it with its short beside it) and an image button (frames it); a picked cut also gets ✕ to remove it. Video and audio are cut together.',
    following: (visible, total) => `Showing ${visible} of ${total}, following the playhead until you scroll elsewhere.`,
    summary: (count, total) => `${count} cut${count === 1 ? '' : 's'} selected across ${total}.`,
    deleteNone: 'Remove the selected cut', deleteRange: (start, end) => `Remove the cut from ${start} to ${end}`,
    surface: 'Timeline. ', zoomOut: 'Zoom out', fit: 'Fit the whole video', zoomIn: 'Zoom in', help: 'How to use the timeline', previousRange: 'Select the previous cut', nextRange: 'Select the next cut'
  };
  readonly tagFor = (range: EditableRange) => String((this.rangeIndex.get(range) ?? -1) + 1);
  /** The square button a picked stretch shows on the timeline: it opens that stretch's framing. */
  /** The buttons every cut carries on the timeline: play it, and frame it. */
  readonly rangeButtons = [{ id: 'remove', icon: 'close', label: 'Remove this cut' }, { id: 'play', icon: 'play_arrow', label: 'Play this cut' }, { id: 'frame', icon: 'image', label: 'Frame this cut vertically' }];
  /** The cut waiting for the reader to confirm its removal. */
  removeCutIndex: number | null = null;
  /**
   * A question asked inside the page rather than with the browser's confirm():
   * in the desktop app a native confirm box leaves the window unable to take
   * typing (the short's name, for one) until it loses and regains the focus.
   */
  confirmation: { title: string; message: string; action: string; answer: (yes: boolean) => void } | null = null;
  private ask(title: string, message: string, action: string) {
    this.confirmation?.answer(false);
    return new Promise<boolean>(resolve => {
      this.confirmation = { title, message, action, answer: yes => { this.confirmation = null; resolve(yes); } };
      if (!this.destroyed) this.changeDetector.detectChanges();
    });
  }
  /** While a cut's preview is open, its play button shows what pressing it will do. */
  readonly rangeButtonState = (id: string, range: EditableRange) => {
    const playback = this.cutPlayback;
    if (id !== 'play' || !playback || this.rangeIndex.get(range) !== playback.index) return null;
    return playback.playing ? { icon: 'pause', label: 'Pause this cut' } : { icon: 'play_arrow', label: 'Play this cut' };
  };
  onRangeButton(event: { id: string; range: EditableRange }) {
    const index = this.rangeIndex.get(event.range);
    if (index === undefined) return;
    if (event.id === 'remove') { this.closeCutPlayback(); this.removeCutIndex = index; }
    else if (event.id === 'frame') { this.closeCutPlayback(); this.openCut(index); }
    // The cut already in the balloon: its button is play and pause for it.
    else if (event.id === 'play') void (this.cutPlayback?.index === index ? this.toggleCutPlayback() : this.playCut(index));
  }

  // ------------------------------------------------ playing one cut, with its short beside it

  @ViewChild(SilenceWaveformComponent) timeline?: SilenceWaveformComponent;
  @ViewChild('timelineWrap') timelineWrap?: ElementRef<HTMLElement>;
  @ViewChild('balloonVideo') balloonVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('cutBalloon') cutBalloon?: ElementRef<HTMLElement>;
  /** A press anywhere outside the preview balloon closes it (a cut's play button then opens its own). */
  @HostListener('document:pointerdown', ['$event'])
  closeBalloonOutside(event: PointerEvent) {
    // The follow settings balloon closes on a press anywhere but itself and its button.
    if (this.cutModal?.followOpen && !(event.target instanceof Element && event.target.closest('.follow-balloon, .follow-config'))) {
      this.cutModal.followOpen = false;
    }
    if (!this.cutPlayback) return;
    const balloon = this.cutBalloon?.nativeElement, target = event.target as Node | null;
    if (balloon && target && balloon.contains(target)) return;
    // The cuts' own buttons decide for themselves: the playing cut's play button pauses it.
    if (target instanceof Element && target.closest('.wf-range-group')) return;
    this.closeCutPlayback();
  }
  cutPlayback: { index: number; start: number; end: number; cropX: number; playing: boolean; progress: number; left: number; top: number; height: number; frameWidth: number; frameHeight: number; side: 'left' | 'right' } | null = null;
  private cutFrame = 0;
  /** Whether the video above was muted before a cut took the sound over, to hand it back as it was. */
  private playerWasMuted: boolean | null = null;
  /** Plays a cut in the video above, from its first frame to its last, with the short's preview beside it. */
  async playCut(index: number) {
    const cut = this.state.selection[index], video = this.player?.nativeElement;
    if (!cut || !video) return;
    this.closeCutPlayback(false);
    this.cutPlayback = { index, start: cut.start, end: cut.end, cropX: this.cropOf(cut, this.state.draftSettings), playing: false, progress: 0, left: 0, top: 0, height: 0, frameWidth: 0, frameHeight: 0, side: 'right' };
    // One sound only: the short beside the cut plays it, the video above goes quiet until the preview closes.
    this.playerWasMuted = video.muted; video.muted = true;
    video.currentTime = cut.start; this.cursor = cut.start;
    this.followCut();
    await this.resumeCut();
  }
  private async resumeCut() {
    const playback = this.cutPlayback, video = this.player?.nativeElement;
    if (!playback || !video) return;
    if (video.currentTime < playback.start - .05 || video.currentTime >= playback.end - .05) video.currentTime = playback.start;
    try { await video.play(); playback.playing = true; } catch { playback.playing = false; }
  }
  async toggleCutPlayback() {
    const playback = this.cutPlayback, video = this.player?.nativeElement;
    if (!playback || !video) return;
    if (!video.paused) { video.pause(); playback.playing = false; }
    else await this.resumeCut();
  }
  closeCutPlayback(pause = true) {
    if (this.cutFrame) cancelAnimationFrame(this.cutFrame);
    this.cutFrame = 0;
    const video = this.player?.nativeElement;
    if (this.cutPlayback && pause) video?.pause();
    if (video && this.playerWasMuted !== null) video.muted = this.playerWasMuted;
    this.playerWasMuted = null;
    this.balloonVideo?.nativeElement.pause();
    this.cutPlayback = null;
    this.timeline?.redraw();
  }
  frameFromBalloon() {
    const index = this.cutPlayback?.index;
    this.closeCutPlayback();
    if (index !== undefined) this.openCut(index);
  }
  /**
   * Once a frame: stops the video at the end of the cut, keeps the muted
   * preview in step with it, and keeps the balloon beside the cut as the
   * timeline moves.
   */
  private followCut() {
    const playback = this.cutPlayback, video = this.player?.nativeElement;
    if (!playback || !video) return;
    const cut = this.state.selection[playback.index];
    if (!cut) { this.closeCutPlayback(); return; }
    // The cut can be trimmed or reframed while it plays.
    playback.start = cut.start; playback.end = cut.end; playback.cropX = this.cropOf(cut, this.state.draftSettings, video.currentTime);
    const time = video.currentTime;
    if (!video.paused && time >= playback.end) { video.pause(); video.currentTime = playback.end; }
    // Played on past the cut, or moved elsewhere by the reader: this is no longer the cut's preview.
    else if (!video.paused && (time < playback.start - .25 || time > playback.end + .25)) { this.closeCutPlayback(false); return; }
    const wasPlaying = playback.playing;
    playback.playing = !video.paused;
    if (wasPlaying !== playback.playing) this.timeline?.redraw();
    playback.progress = Math.max(0, Math.min(1, (video.currentTime - playback.start) / Math.max(.001, playback.end - playback.start)));
    this.cursor = video.currentTime;
    const preview = this.balloonVideo?.nativeElement;
    if (preview) {
      // The sound is the preview's; it follows the video above by speed rather than by jumps, so it never stutters.
      preview.muted = false; preview.volume = video.volume;
      const drift = video.currentTime - preview.currentTime;
      if (Math.abs(drift) > .3 || !playback.playing) { if (Math.abs(drift) > .04) preview.currentTime = video.currentTime; preview.playbackRate = 1; }
      else preview.playbackRate = Math.abs(drift) > .03 ? 1 + Math.max(-.08, Math.min(.08, drift)) : 1;
      if (playback.playing && preview.paused) void preview.play().catch(() => undefined);
      if (!playback.playing && !preview.paused) preview.pause();
    }
    this.placeBalloon(playback);
    this.cutFrame = requestAnimationFrame(() => this.followCut());
  }
  /** Beside the cut: to its right when there is room, otherwise to its left; a little taller than the timeline. */
  private placeBalloon(playback: NonNullable<ShortsGeneratorComponent['cutPlayback']>) {
    const wrap = this.timelineWrap?.nativeElement, range = this.rangeList.find(item => this.rangeIndex.get(item) === playback.index);
    const bounds = range && this.timeline?.rangeClientRect(range);
    if (!wrap || !bounds) return;
    const box = wrap.getBoundingClientRect(), timeline = bounds.bottom - bounds.top;
    // The picture is a short's shape, sized from the timeline (ten per cent taller) and then enlarged a fifth;
    // the balloon wraps it with its title and controls.
    playback.frameHeight = Math.max(72, Math.round((timeline * 1.1 - 92) * 1.2));
    playback.frameWidth = Math.round(playback.frameHeight * 9 / 16);
    playback.height = playback.frameHeight + 92;
    const width = playback.frameWidth + 16;
    playback.top = Math.round(bounds.top - box.top - (playback.height - timeline) / 2);
    const right = Math.min(bounds.right, box.right) - box.left + 12;
    if (right + width <= box.width) { playback.left = right; playback.side = 'right'; }
    else { playback.left = Math.max(0, Math.max(bounds.left, box.left) - box.left - 12 - width); playback.side = 'left'; }
  }
  private timer?: ReturnType<typeof setInterval>; private destroyed = false; private polling = false;
  readonly transitions = [{ id: 'cut', name: 'Straight cut' }, { id: 'fade', name: 'Dissolve' }, { id: 'wipeleft', name: 'Wipe left' }, { id: 'slideright', name: 'Slide right' }];
  get desktop() { return isPlatformBrowser(this.platform) ? window.desktop : undefined; }
  get available() { return isPlatformBrowser(this.platform); }
  get duration() { return this.state.source?.duration || 1; }
  get activeSettings() { return this.state.draftSettings; }
  async ngOnInit() {
    if (this.available) {
      this.restorePersisted();
      document.addEventListener('fullscreenchange', this.fullscreenChanged);
      const split = Number(readSetting(SPLIT_KEY)), height = Number(readSetting(VIDEO_HEIGHT_KEY));
      if (Number.isFinite(split) && split > 0) this.splitWidth = split;
      if (Number.isFinite(height) && height > 0) this.videoHeight = height;
    }
    if (this.desktop?.shortCommand) {
      await this.refresh();
      this.timer = setInterval(() => { if (!this.busy && !this.draftTimer) void this.refresh(); }, 1200);
    }
  }
  ngOnDestroy() {
    this.closeCut();
    this.confirmation?.answer(false);
    this.destroyed = true; if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; const kept = this.projectDocument(); if (kept && !this.desktop?.shortCommand) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)); } catch { /* storage refused */ } } } if (this.available) document.removeEventListener('fullscreenchange', this.fullscreenChanged); this.closeCutPlayback(false); clearTimeout(this.draftTimer); this.stopPreview(); this.releasePreviewAudio(); clearInterval(this.timer); clearTimeout(this.pickerTimer); if (this.available) window.removeEventListener('focus', this.pickerClosed); clearTimeout(this.zoomTimer); this.frames?.dispose();
    this.browserEditor.dispose();
    if (this.browserSource && this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
  }
  async refresh() {
    if (this.polling) return;
    this.polling = true;
    try {
      const next = await this.desktop!.shortCommand!('short_get_state');
      if (!this.busy && !this.draftTimer) await this.accept(next);
    }
    catch (e) { this.error = this.message(e); }
    finally { this.polling = false; if (!this.destroyed) this.changeDetector.detectChanges(); }
  }
  private async accept(next: Session) {
    if (this.destroyed || next.revision < this.state.revision) return;
    const sourceChanged = next.source?.path !== this.state.source?.path || (!this.desktop?.shortCommand && this.browserSource !== this.browserEditor.videoFile);
    const seekChanged = next.playhead !== this.state.playhead;
    this.state = next;
    if (sourceChanged && !next.source) this.resetMedia();
    if (sourceChanged && next.source) {
      this.closeCut(); this.analyses.clear();
      if (this.desktop?.shortCommand) {
        const [descriptor] = await this.desktop.readAgentFiles!([next.source.path]);
        this.sourceUrl = descriptor.url;
        const file = new PathBackedFile(descriptor);
        void this.loadWaveform(file, next.source.duration); void this.loadFrames(file);
      } else {
        if (this.browserSource && this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
        this.browserSource = this.browserEditor.videoFile;
        this.sourceUrl = URL.createObjectURL(this.browserSource!);
        void this.loadWaveform(this.browserSource!, next.source.duration); void this.loadFrames(this.browserSource!);
      }
      this.editingId = null;
      this.layoutPending = true;
    }
    if (seekChanged && this.player) this.player.nativeElement.currentTime = next.playhead;
    for (const s of next.shorts) if (this.desktop?.shortCommand && s.outputPath && !this.outputUrls[s.outputPath]) {
      try { this.outputUrls[s.outputPath] = (await this.desktop!.readAgentFiles!([s.outputPath]))[0].url; } catch { /* A moved output can be rendered again. */ }
    }
    this.schedulePersist();
  }

  // ------------------------------------------------ the web session kept in this browser

  private persistTimer?: ReturnType<typeof setTimeout>;
  /**
   * The web version writes the session to this browser's storage a moment
   * after it changes, so a reload or a closed tab loses nothing but the video
   * file itself, which a page is never allowed to keep. The desktop app keeps
   * its session on disk instead.
   */
  private schedulePersist() {
    if (this.desktop?.shortCommand || !this.available || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      // Nothing loaded yet (a kept project may be waiting for its video): leave what is stored alone.
      const document_ = this.projectDocument();
      if (!document_) return;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(document_)); } catch { /* storage full or refused */ }
    }, 600);
  }
  private forgetPersisted() {
    clearTimeout(this.persistTimer); this.persistTimer = undefined;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage refused */ }
  }
  /** On a new visit: the kept project waits for its video, as an opened project file does. */
  private restorePersisted() {
    if (this.desktop?.shortCommand || !this.available) return;
    let parsed: unknown = null;
    try { parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { parsed = null; }
    if (!isShortDocument(parsed) || parsed.kind !== 'project') return;
    this.pendingDocument = parsed; this.pendingName = 'your last session';
    this.notice = `Your last project (${parsed.shorts.length} short${parsed.shorts.length === 1 ? '' : 's'}) was kept in this browser. Choose its video “${parsed.source.name}” to reopen it.`;
  }
  /**
   * On the web a render runs after its command has returned, so its progress
   * and its finished file arrive here (the desktop gets them by polling). A drag
   * or another command in flight is left alone: that command's own answer
   * carries the latest state.
   */
  private browserChanged() {
    this.outputUrls = this.browserEditor.outputUrls;
    if (this.destroyed || this.desktop?.shortCommand) return;
    if (!this.busy) void this.accept(this.browserEditor.snapshot());
    this.changeDetector.detectChanges();
  }
  private message(e: unknown) { return e instanceof Error ? e.message : String(e); }
  async command(name: string, args: Record<string, unknown> = {}) {
    if (this.busy) return;
    this.busy = true; this.error = '';
    try { await this.accept(await (this.desktop?.shortCommand ? this.desktop.shortCommand(name, args) : this.browserEditor.command(name, args as ShortCommandArgs))); }
    catch (e) { this.error = this.message(e); }
    finally { this.busy = false; if (!this.destroyed) this.changeDetector.detectChanges(); }
  }
  /** The click that opens the file picker: the processing message shows from here on. */
  startImport() {
    if (this.busy || !this.available) return;
    this.importing = true; this.pickerOpen = true; this.error = '';
    window.removeEventListener('focus', this.pickerClosed);
    window.addEventListener('focus', this.pickerClosed);
  }
  /** Closing the picker without a file hides the message again. */
  importCancelled() { this.pickerOpen = false; this.importing = false; this.changeDetector.detectChanges(); }
  /**
   * Fallback for a picker that closes without a `cancel` event: the window gets
   * the focus back, and when no file arrived shortly after, nothing is loading.
   */
  private readonly pickerClosed = () => {
    window.removeEventListener('focus', this.pickerClosed);
    clearTimeout(this.pickerTimer);
    this.pickerTimer = setTimeout(() => { if (this.pickerOpen && !this.destroyed) this.importCancelled(); }, 1000);
  };
  async importFile(event: Event) {
    this.pickerOpen = false;
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    await this.loadVideo(file);
  }
  async dropVideo(event: DragEvent) {
    event.preventDefault();
    await this.loadVideo(event.dataTransfer?.files[0]);
  }
  private async loadVideo(file?: File) {
    if (this.busy || !this.available || !file) { this.importing = false; return; }
    this.importing = true; this.error = '';
    this.changeDetector.detectChanges();
    try {
      // Opening a project already asked before replacing the cards.
      if (this.state.shorts.length && this.pendingDocument?.kind !== 'project'
        && !await this.ask('Load another video?', 'Loading another video removes the shorts in this session. Exported files are kept.', 'Load video')) return;
      await this.importVideo(file);
    } finally { this.importing = false; if (!this.destroyed) this.changeDetector.detectChanges(); }
  }
  private async importVideo(file: File) {
    const path = this.desktop?.pathForFile?.(file);
    try {
      if (this.desktop?.shortCommand) {
        if (!path) throw new Error('The chosen file could not be opened.');
        await this.desktop.rememberFolders!([path]);
        await this.command('short_import_video', { path, replace: true });
      } else await this.command('short_import_video', { file, replace: true });
    }
    catch (e) { this.error = this.message(e); }
    // A project or settings file opened before its video: finish opening it now.
    const pending = this.pendingDocument;
    if (pending && !this.error && this.state.source) {
      this.pendingDocument = null;
      const lead = pending.kind === 'project' && file.name !== pending.source.name ? `This project was made with “${pending.source.name}” and was opened on “${file.name}”. ` : '';
      await this.applyDocument(pending, this.pendingName, lead);
    }
  }

  // ------------------------------------------------ save and open, as in the Video Editor

  openSaveChooser() { this.saveChooser = true; }
  closeSaveChooser() { this.saveChooser = false; }
  /** A copy of the settings that can travel: the chosen audio by path on the desktop, always by name. */
  private portable(settings: Settings): SavedSettings {
    return { ...settings, audioPath: this.desktop?.shortCommand ? settings.audioPath : null, audioName: settings.audioPath ? this.audioLabel(settings) : null };
  }
  /** Writes one JSON document to disk under a dated name. */
  private writeDocument(content: unknown, prefix: string) {
    if (typeof document === 'undefined') return;
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${prefix}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`; anchor.rel = 'noopener';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** The whole session: which video, the cuts, the settings and every short card. Not the media, and not the renders. */
  /** The whole session as a project document, or null with no video loaded. */
  private projectDocument(): ProjectDocument | null {
    const source = this.state.source;
    if (!source) return null;
    return {
      app: DOCUMENT_APP, kind: 'project', version: 1, savedAt: new Date().toISOString(),
      source: { name: source.name, path: this.desktop?.shortCommand ? source.path : undefined, duration: source.duration },
      selection: this.state.selection.map(cut => ({ ...cut })), draftSettings: this.portable(this.state.draftSettings),
      shorts: this.state.shorts.map(short => ({ name: short.name, ranges: short.ranges.map(cut => ({ ...cut })), settings: this.portable(short.settings) })),
      zoom: this.state.zoom
    };
  }
  saveProject() {
    const document_ = this.projectDocument();
    if (!document_) return;
    this.writeDocument(document_, 'short-editor-project');
    this.saveChooser = false; this.error = '';
    this.notice = 'Project saved. It holds the cuts and the shorts, not the video — Open asks for the same video again when it cannot reach it.';
  }
  /** The settings beside the video, and nothing else. */
  saveSettingsOnly() {
    const document_: SettingsDocument = { app: DOCUMENT_APP, kind: 'settings', version: 1, savedAt: new Date().toISOString(), settings: this.portable(this.state.draftSettings) };
    this.writeDocument(document_, 'short-editor-settings');
    this.saveChooser = false; this.error = '';
    this.notice = 'Settings saved. No video, no cuts, no shorts — just the audio and transition settings.';
  }
  /** Opens either file Save writes: a project replaces the session, settings are applied to it. */
  async openDocument(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    if (!file || this.busy) return;
    this.error = ''; this.notice = '';
    let parsed: unknown;
    try { parsed = JSON.parse(await file.text()); }
    catch { this.error = `“${file.name}” could not be read. It may be truncated or not a JSON file.`; return; }
    if (!isShortDocument(parsed)) { this.error = `“${file.name}” is not a Short Editor project or settings file. Choose a file written by Save.`; return; }
    const document_ = parsed;
    if (document_.kind === 'project' && this.state.shorts.length
      && !await this.ask('Open this project?', 'Opening a project replaces the shorts in this session. Exported files are kept.', 'Open project')) return;
    if (document_.kind === 'settings') {
      if (!this.state.source) { this.pendingDocument = document_; this.pendingName = file.name; this.notice = `Settings from “${file.name}” will be applied once a video is loaded.`; return; }
      await this.applyDocument(document_, file.name);
      return;
    }
    await this.openProject(document_, file.name);
  }
  private async openProject(document_: ProjectDocument, fileName: string) {
    const source = document_.source, current = this.state.source;
    const sameVideo = !!current && current.name === source.name && Math.abs(current.duration - source.duration) < .05;
    // The project replaces the session: the video is loaded again, which clears the old cards.
    if (this.desktop?.shortCommand && (source.path || sameVideo)) {
      await this.command('short_import_video', { path: source.path || current!.path, replace: true });
      if (!this.error) { await this.applyDocument(document_, fileName); return; }
      this.error = '';
    } else if (!this.desktop?.shortCommand && sameVideo && this.browserEditor.videoFile) {
      await this.command('short_import_video', { file: this.browserEditor.videoFile, replace: true });
      if (!this.error) { await this.applyDocument(document_, fileName); return; }
      this.error = '';
    }
    // The video cannot be reached from here: the reader chooses it, and the project follows.
    this.pendingDocument = document_; this.pendingName = fileName;
    this.notice = `To open “${fileName}”, choose its video: “${source.name}”.`;
  }
  /** Applies an opened document to the session that is loaded now. */
  private async applyDocument(document_: ShortDocument, fileName: string, lead = '') {
    const missing = new Set<string>();
    if (document_.kind === 'settings') {
      await this.applyDraft(this.restoreSettings(document_.settings, missing), missing);
      if (!this.error) this.notice = lead + `Settings from “${fileName}” applied.` + this.missingNote(missing);
      return;
    }
    for (const short of document_.shorts) {
      const settings = this.restoreSettings(short.settings, missing);
      await this.command('short_create', { name: short.name, ranges: short.ranges, settings });
      if (this.error && settings.audioPath) {
        // The chosen audio is no longer reachable: the short opens with its own sound instead.
        missing.add(this.audioLabel(settings)); this.error = '';
        await this.command('short_create', { name: short.name, ranges: short.ranges, settings: this.withoutAudio(settings) });
      }
      if (this.error) return;
    }
    const draft = this.restoreSettings(document_.draftSettings, missing);
    await this.command('short_set_selection', { ranges: document_.selection, settings: draft });
    if (this.error && draft.audioPath) {
      missing.add(this.audioLabel(draft)); this.error = '';
      await this.command('short_set_selection', { ranges: document_.selection, settings: this.withoutAudio(draft) });
    }
    if (!this.error && document_.zoom >= 1 && document_.zoom <= 20) await this.command('short_set_view', { zoom: document_.zoom });
    if (!this.error) this.notice = lead + `Project “${fileName}” opened.` + this.missingNote(missing);
  }
  private async applyDraft(settings: Settings, missing: Set<string>) {
    await this.setDraft(settings, true);
    if (this.error && settings.audioPath) {
      missing.add(this.audioLabel(settings)); this.error = '';
      await this.setDraft(this.withoutAudio(settings), true);
    }
  }
  /** Settings read from a file: anything missing takes its default, and an audio that did not travel is reported. */
  private restoreSettings(saved: SavedSettings, missing: Set<string>): Settings {
    const { audioName, ...rest } = saved;
    const settings: Settings = { ...defaults(), ...rest };
    if (!settings.audioPath && audioName) { missing.add(audioName); return this.withoutAudio(settings); }
    return settings;
  }
  /** Without its chosen audio a short plays its own sound, so a silenced original is turned back up. */
  private withoutAudio(settings: Settings): Settings {
    return { ...settings, audioPath: null, volume: settings.volume === 0 ? 1 : settings.volume };
  }
  private missingNote(missing: Set<string>) {
    return missing.size ? ` The audio ${[...missing].map(name => `“${name}”`).join(', ')} could not be reached and was left out — choose it again in Settings.` : '';
  }
  cancelPending() { this.pendingDocument = null; this.notice = ''; }
  time(value: number) { return `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`; }
  total(cuts: Cut[]) { return cuts.reduce((n, c) => n + c.end - c.start, 0); }
  label(settings: Settings) { return this.transitions.find(t => t.id === settings.transition)?.name || settings.transition; }
  audioLabel(settings: Settings) { return settings.audioPath?.split(/[\\/]/).pop() || 'Original audio'; }
  percent(time: number) { return 100 * time / this.duration; }
  /** After Clear all (from the button or from an assistant): no video, no timeline, nothing open. */
  private resetMedia() {
    this.waveformToken++;
    this.waveform = null; this.waveformError = '';
    this.frames?.dispose(); this.frames = undefined; this.frameSource = undefined;
    if (this.browserSource && this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
    this.browserSource = null; this.sourceUrl = ''; this.outputUrls = {}; this.mediaFile = null;
    this.editingId = null; this.title = ''; this.cursor = 0;
    this.closeSettings(); this.closeCut(); this.closeCutPlayback(false);
  }
  get hasRendering() { return this.state.shorts.some(s => s.status === 'rendering'); }
  askClearAll() { this.clearAllOpen = true; }
  async clearAll() {
    await this.command('short_clear');
    if (!this.error) {
      this.clearAllOpen = false; this.forgetPersisted();
      this.pendingDocument = null; this.pendingName = ''; this.notice = '';
    }
  }
  private async loadFrames(file: File) {
    this.mediaFile = file;
    this.frames?.dispose(); this.frames = undefined; this.frameSource = undefined;
    const token = this.waveformToken;
    try {
      const frames = await shortFrames(file);
      // Another video arrived while this one was opening.
      if (this.destroyed || token !== this.waveformToken) { frames.dispose(); return; }
      this.frames = frames; this.frameAspect = frames.aspect;
      this.frameSource = (time: number) => frames.frameAt(time);
    } catch { /* The picture track stays plain; the cuts still work. */ }
    finally { if (!this.destroyed) this.changeDetector.detectChanges(); }
  }
  /** Reads every sample of the source so the timeline can be as precise as the silence cutter's. */
  private async loadWaveform(file: File, duration: number) {
    const token = ++this.waveformToken;
    this.waveform = null; this.waveformError = '';
    try {
      const data = await shortWaveform(file, duration, () => token !== this.waveformToken || this.destroyed);
      if (token === this.waveformToken) this.waveform = data;
    } catch (e) {
      if (token !== this.waveformToken) return;
      // Stretches can still be marked on a flat line when the sound cannot be read.
      this.waveformError = `The audio could not be read for the timeline: ${this.message(e)}`;
      this.waveform = { min: new Float32Array(1), max: new Float32Array(1), rms: new Float32Array(1), secondsPerBucket: duration, duration };
    } finally { if (!this.destroyed) this.changeDetector.detectChanges(); }
  }
  /**
   * The selection as the timeline wants it: sorted, and the same objects for as
   * long as the selection does not change, so a picked stretch stays picked
   * while the desktop keeps refreshing the state.
   */
  get timelineRanges(): EditableRange[] {
    const key = JSON.stringify(this.state.selection);
    if (key !== this.rangesKey) {
      this.rangesKey = key; this.rangeIndex = new Map();
      this.rangeList = this.state.selection.map((cut, index) => {
        const range: EditableRange = { start: cut.start, end: cut.end, source: 'manual', enabled: true };
        this.rangeIndex.set(range, index); return range;
      }).sort((left, right) => left.start - right.start);
    }
    return this.rangeList;
  }
  async addRange(range: TimeRange) {
    await this.command('short_set_selection', { ranges: [...this.state.selection.map(c => ({ ...c })), { start: range.start, end: range.end }] });
  }
  async resizeRange(change: RangeResize) {
    const index = this.rangeIndex.get(change.range);
    if (index === undefined) return;
    const cuts = this.state.selection.map(c => ({ ...c })); cuts[index] = { start: change.start, end: change.end };
    await this.command('short_set_selection', { ranges: cuts });
  }
  /** Removing a cut from the timeline (its ✕, or the Delete key) asks first. */
  async removeRange(range: EditableRange) {
    const index = this.rangeIndex.get(range);
    if (index !== undefined) { this.closeCutPlayback(); this.removeCutIndex = index; }
  }
  async confirmRemoveCut() {
    const index = this.removeCutIndex;
    if (index === null) return;
    await this.removeCut(index);
    if (!this.error) this.removeCutIndex = null;
  }
  async seekTo(time: number) {
    this.cursor = time;
    if (this.player) this.player.nativeElement.currentTime = time;
    await this.command('short_set_view', { playhead: time });
  }
  zoomChanged(zoom: number) {
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => void this.command('short_set_view', { zoom: Math.round(zoom * 100) / 100 }), 300);
  }
  async changeCut(index: number, edge: 'start' | 'end', value: number) {
    const cuts = this.state.selection.map(c => ({ ...c })); cuts[index][edge] = Number(value);
    await this.command('short_set_selection', { ranges: cuts });
  }
  async removeCut(index: number) { await this.command('short_set_selection', { ranges: this.state.selection.filter((_, i) => i !== index) }); }
  async moveCut(index: number, delta: number) {
    const cuts = [...this.state.selection], target = index + delta;
    if (target < 0 || target >= cuts.length) return;
    [cuts[index], cuts[target]] = [cuts[target], cuts[index]];
    await this.command('short_set_selection', { ranges: cuts });
  }
  async addCut() {
    const start = Math.min(this.player?.nativeElement.currentTime || 0, this.duration - .1);
    await this.command('short_set_selection', { ranges: [...this.state.selection, { start, end: Math.min(this.duration, start + 5) }] });
  }
  async create() { await this.command('short_create', { name: this.title || undefined }); if (!this.error) { this.title = ''; this.editingId = null; } }
  async edit(short: Short) {
    await this.command('short_set_selection', { ranges: short.ranges, settings: short.settings });
    this.editingId = short.id; this.title = short.name;
    if (this.player) this.player.nativeElement.currentTime = short.ranges[0].start;
  }
  async saveEdit() {
    await this.command('short_update', { id: this.editingId, name: this.title, ranges: this.state.selection, settings: this.state.draftSettings });
    if (!this.error) this.editingId = null;
  }
  /**
   * Where a stretch is framed at `time` (seconds of the source): along the path
   * person tracking found, else its own choice, else the short's.
   */
  cropOf(cut: Cut, settings: Settings, time = cut.start) {
    return cut.cropTrack?.length ? cropAtTime(cut.cropTrack, time) : cut.cropX ?? settings.cropX;
  }
  openCut(index: number) {
    const cut = this.state.selection[index];
    if (!cut) return;
    this.cutPlaying = false; this.cutAt = 0;
    const track = cut.cropTrack?.length ? cut.cropTrack.map(key => ({ ...key })) : null;
    this.cutModal = {
      index, start: cut.start, end: cut.end, cropX: cut.cropX ?? this.state.draftSettings.cropX,
      tracking: !!track, track, trackedStart: cut.start, trackedEnd: cut.end, analysing: null,
      follow: { ...DEFAULT_FOLLOW, ...(cut.follow ?? {}) }, followOpen: false,
      analysis: this.analyses.get(this.analysisKey(cut.start, cut.end)) ?? null
    };
  }
  private analysisKey(start: number, end: number) {
    const file = this.mediaFile;
    return file ? `${file.name}|${file.size}|${start.toFixed(3)}|${end.toFixed(3)}` : '';
  }
  /** A follow setting changed: the path is redrawn from the analysis already made, or the video is analysed again. */
  setFollow(change: Partial<FollowOptions>) {
    const modal = this.cutModal;
    if (!modal) return;
    for (const key of ['startDelayMs', 'holdDelayMs'] as const) {
      if (key in change && !(Number.isFinite(change[key]) && change[key]! >= 0)) return;
      if (key in change) change[key] = Math.min(5000, Math.round(change[key]!));
    }
    modal.follow = { ...modal.follow, ...change };
    if (!modal.tracking) return;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      if (this.cutModal !== modal || !modal.tracking) return;
      if (modal.analysis) modal.track = followPath(modal.analysis, modal.follow, modal.cropX);
      else void this.analyseCut(modal);
      this.changeDetector.detectChanges();
    }, 200);
  }
  closeCut() {
    clearTimeout(this.followTimer);
    this.trackToken++;
    // Angular also destroys this component during server-side prerendering,
    // where browser animation APIs do not exist.
    if (this.available && this.cutPlayFrame) cancelAnimationFrame(this.cutPlayFrame);
    this.cutPlayFrame = 0;
    this.cutModal = null; this.framing = null; this.cutPlaying = false; this.cutAt = 0;
  }
  /** The framing the dialog's picture shows now: following the person, or where it was dragged. */
  get modalCrop() {
    const modal = this.cutModal;
    if (!modal) return .5;
    return modal.tracking && modal.track?.length ? cropAtTime(modal.track, Number(modal.start) + this.cutAt) : modal.cropX;
  }
  get framingLabel() {
    const modal = this.cutModal;
    if (modal?.analysing != null && modal.trackingStage === 'loading') return 'Preparing person tracking…';
    if (modal?.analysing != null && modal.trackingStage === 'fallback') return 'Retrying person tracking…';
    if (modal?.analysing !== null && modal?.analysing !== undefined) return `Finding the person… ${Math.round(modal.analysing * 100)}%`;
    if (modal?.tracking) return 'Following the person';
    const crop = modal?.cropX ?? .5;
    return crop < .02 ? 'Framed left' : crop > .98 ? 'Framed right' : Math.abs(crop - .5) < .02 ? 'Framed center' : `Framed at ${Math.round(crop * 100)}%`;
  }
  /** The "Follow the person" box: on, the video is analysed on this device; off, the framing stands still again. */
  async toggleTracking(on: boolean) {
    const modal = this.cutModal;
    if (!modal) return;
    modal.tracking = on;
    if (!on) { this.trackToken++; modal.analysing = null; return; }
    // Where the frame goes whenever the person is lost is the framing chosen by hand, so the path is redrawn for it.
    if (modal.analysis && modal.track?.length) modal.track = followPath(modal.analysis, modal.follow, modal.cropX);
    if (!modal.track?.length) await this.analyseCut(modal);
  }
  /** Finds the person across the dialog's stretch. Returns false when it could not. */
  private async analyseCut(modal: NonNullable<ShortsGeneratorComponent['cutModal']>): Promise<boolean> {
    const file = this.mediaFile, token = ++this.trackToken;
    const start = Number(modal.start), end = Number(modal.end);
    if (!file) { this.error = 'The video is still being read. Try again in a moment.'; modal.tracking = false; return false; }
    if (!(end - start >= .1)) { this.error = 'Set the cut\'s start and end first.'; modal.tracking = false; return false; }
    this.error = ''; modal.analysing = 0; modal.trackingStage = 'loading';
    const current = () => !this.destroyed && token === this.trackToken && this.cutModal === modal;
    try {
      const analysis = await analysePeople(file, start, end, share => {
        if (!current()) return;
        modal.analysing = share; this.changeDetector.detectChanges();
      }, () => !current(), stage => {
        if (current()) { modal.trackingStage = stage; this.changeDetector.detectChanges(); }
      });
      if (!current()) return false;
      this.analyses.set(this.analysisKey(start, end), analysis);
      modal.analysis = analysis;
      modal.track = followPath(analysis, modal.follow, modal.cropX); modal.trackedStart = start; modal.trackedEnd = end;
      return true;
    } catch (e) {
      if (current()) { this.error = `Person tracking failed: ${this.message(e)}`; modal.tracking = false; }
      return false;
    } finally {
      if (current()) { modal.analysing = null; this.changeDetector.detectChanges(); }
    }
  }
  /** Left-drag the picture sideways inside the 9:16 frame; the frame follows the hand. */
  startFrame(event: PointerEvent, box: HTMLElement, video: HTMLVideoElement) {
    // While it follows a person the framing is the tracker's, not the hand's.
    if (!this.cutModal || this.cutModal.tracking || event.button !== 0) return;
    event.preventDefault(); box.setPointerCapture(event.pointerId); box.focus();
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    this.framing = { x: event.clientX, crop: this.cutModal.cropX, travel: Math.max(1, box.clientHeight * aspect - box.clientWidth), pointer: event.pointerId };
  }
  moveFrame(event: PointerEvent) {
    if (!this.framing || !this.cutModal || event.pointerId !== this.framing.pointer) return;
    this.cutModal.cropX = Math.max(0, Math.min(1, this.framing.crop - (event.clientX - this.framing.x) / this.framing.travel));
  }
  endFrame(event: PointerEvent, box: HTMLElement) {
    if (!this.framing) return;
    if (box.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
    this.framing = null;
  }
  frameKey(event: KeyboardEvent) {
    if (!this.cutModal || this.cutModal.tracking) return;
    const step = event.shiftKey ? .1 : .02;
    if (event.key === 'ArrowLeft') this.cutModal.cropX = Math.max(0, this.cutModal.cropX - step);
    else if (event.key === 'ArrowRight') this.cutModal.cropX = Math.min(1, this.cutModal.cropX + step);
    else if (event.key === 'Home') this.cutModal.cropX = 0;
    else if (event.key === 'End') this.cutModal.cropX = 1;
    else return;
    event.preventDefault();
  }
  /** Plays the stretch inside the frame, over and over, so the framing can be judged while it moves. */
  /** Where the framing preview is, in seconds from the start of the cut. */
  cutAt = 0;
  private cutPlayFrame = 0;
  toggleCutPlay(video: HTMLVideoElement) {
    if (!this.cutModal) return;
    if (this.cutPlaying) { video.pause(); this.cutPlaying = false; return; }
    if (video.currentTime < this.cutModal.start || video.currentTime >= this.cutModal.end - .05) video.currentTime = this.cutModal.start;
    this.cutPlaying = true;
    void video.play().catch(() => { this.cutPlaying = false; });
    // Followed frame by frame, so the bar moves smoothly and playback stops on the cut's last frame.
    cancelAnimationFrame(this.cutPlayFrame);
    const follow = () => {
      const modal = this.cutModal;
      if (!modal) return;
      if (video.currentTime >= modal.end) { video.pause(); video.currentTime = modal.end; this.cutPlaying = false; }
      this.cutAt = Math.max(0, Math.min(modal.end - modal.start, video.currentTime - modal.start));
      if (this.cutPlaying) this.cutPlayFrame = requestAnimationFrame(follow);
    };
    this.cutPlayFrame = requestAnimationFrame(follow);
  }
  seekCut(video: HTMLVideoElement, seconds: number) {
    const modal = this.cutModal;
    if (!modal || !Number.isFinite(seconds)) return;
    this.cutAt = Math.max(0, Math.min(modal.end - modal.start, seconds));
    video.currentTime = modal.start + this.cutAt;
  }
  async saveCut() {
    const modal = this.cutModal;
    if (!modal) return;
    const start = Number(modal.start), end = Number(modal.end);
    // Longer than the stretch that was analysed: the person is looked for again across the new one.
    if (modal.tracking && (!modal.track?.length || start < modal.trackedStart - .05 || end > modal.trackedEnd + .05)) {
      if (!await this.analyseCut(modal) || this.cutModal !== modal) return;
    }
    const cuts = this.state.selection.map(c => ({ ...c }));
    if (!cuts[modal.index]) { this.closeCut(); return; }
    const cut: Cut = { start, end, cropX: Math.round(modal.cropX * 10000) / 10000 };
    if (modal.tracking && modal.track?.length) { cut.cropTrack = modal.track; cut.follow = { ...modal.follow }; }
    cuts[modal.index] = cut;
    await this.command('short_set_selection', { ranges: cuts });
    if (!this.error) this.closeCut();
  }
  openSettings(short?: Short) {
    this.modalId = short?.id || null; this.config = { ...(short?.settings || this.state.draftSettings) };
    // A short saved before the two levels existed: its volume was the replacement's, the original was silent.
    if (this.config.musicVolume === undefined) this.config = this.config.audioPath ? { ...this.config, musicVolume: this.config.volume, volume: 0 } : { ...this.config, musicVolume: 1 };
    this.configName = short?.name || ''; this.modal = true;
    this.previewAt = 0; this.previewIndex = 0;
  }
  closeSettings() {
    this.stopPreview(); this.releasePreviewAudio();
    this.modal = false; this.previewAt = 0; this.previewIndex = 0;
  }
  /** The stretches the preview plays: the short's own, or the current selection for the draft settings. */
  get previewRanges(): Cut[] {
    const short = this.modalId ? this.state.shorts.find(item => item.id === this.modalId) : undefined;
    return short ? short.ranges : this.state.selection;
  }
  get previewTotal() { return this.total(this.previewRanges); }
  get previewStart() { return this.previewRanges.length ? this.previewRanges[0].start : 0; }
  get previewCrop() {
    const ranges = this.previewRanges;
    const cut = ranges[Math.min(this.previewIndex, ranges.length - 1)];
    return cut ? this.cropOf(cut, this.config, this.previewVideo?.nativeElement.currentTime ?? cut.start) : this.config.cropX;
  }
  async togglePreview() {
    const video = this.previewVideo?.nativeElement, ranges = this.previewRanges;
    if (!video || !ranges.length) return;
    if (this.previewPlaying) { this.stopPreview(); return; }
    if (this.previewAt >= this.previewTotal - .05) this.previewAt = 0;
    let before = 0, index = 0;
    while (index < ranges.length - 1 && before + ranges[index].end - ranges[index].start <= this.previewAt) { before += ranges[index].end - ranges[index].start; index++; }
    this.previewIndex = index;
    video.currentTime = ranges[index].start + (this.previewAt - before);
    await this.syncPreviewAudio();
    const audio = this.config.audioPath ? this.previewAudio?.nativeElement : undefined;
    video.muted = false; video.volume = Math.min(1, this.config.volume);
    if (audio) { audio.volume = Math.min(1, this.config.musicVolume ?? 1); audio.currentTime = Number.isFinite(audio.duration) && audio.duration > 0 ? this.previewAt % audio.duration : this.previewAt; }
    this.previewPlaying = true;
    try { await video.play(); if (audio) await audio.play(); }
    catch { this.stopPreview(); return; }
    const tick = () => { if (!this.previewPlaying) return; this.stepPreview(); this.previewFrame = requestAnimationFrame(tick); };
    this.previewFrame = requestAnimationFrame(tick);
  }
  /** Jumps from the end of one stretch to the start of the next, as the short will. */
  private stepPreview() {
    const video = this.previewVideo?.nativeElement, ranges = this.previewRanges, cut = ranges[this.previewIndex];
    if (!video || !cut) { this.stopPreview(); return; }
    if (video.currentTime >= cut.end - .02) {
      if (this.previewIndex + 1 >= ranges.length) { this.stopPreview(); this.previewAt = this.previewTotal; return; }
      this.previewIndex++; video.currentTime = ranges[this.previewIndex].start;
    }
    let before = 0;
    for (let index = 0; index < this.previewIndex; index++) before += ranges[index].end - ranges[index].start;
    this.previewAt = before + Math.max(0, video.currentTime - ranges[this.previewIndex].start);
    video.volume = Math.min(1, this.config.volume);
    if (this.previewAudio) this.previewAudio.nativeElement.volume = Math.min(1, this.config.musicVolume ?? 1);
  }
  stopPreview() {
    this.previewPlaying = false;
    if (this.previewFrame) cancelAnimationFrame(this.previewFrame);
    this.previewFrame = 0;
    this.previewVideo?.nativeElement.pause();
    this.previewAudio?.nativeElement.pause();
  }
  /** Makes the chosen replacement sound playable in the preview. */
  private async syncPreviewAudio() {
    const path = this.config.audioPath;
    if (path === this.previewAudioFor) return;
    this.releasePreviewAudio();
    this.previewAudioFor = path;
    if (!path) return;
    if (this.desktop?.shortCommand) {
      try { this.previewAudioUrl = (await this.desktop.readAgentFiles!([path]))[0].url; } catch { this.previewAudioUrl = ''; }
    } else {
      const file = this.browserEditor.audioFiles.get(path);
      if (file) { this.previewAudioUrl = URL.createObjectURL(file); this.previewAudioObject = true; }
    }
    this.changeDetector.detectChanges();
  }
  private releasePreviewAudio() {
    if (this.previewAudioObject && this.previewAudioUrl) URL.revokeObjectURL(this.previewAudioUrl);
    this.previewAudioUrl = ''; this.previewAudioObject = false; this.previewAudioFor = null;
  }
  useOriginalAudio() {
    this.stopPreview(); this.config.audioPath = null;
    // Back to the original alone: a silenced original would leave the short mute.
    if (this.config.volume === 0) this.config.volume = 1;
  }
  /** Chooses the replacement audio, for a short's dialog (`config`) or for the settings beside the video (`draft`). */
  async chooseAudio(event: Event, target: 'config' | 'draft' = 'config') {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
    if (!file) return;
    const settings = target === 'draft' ? { ...this.state.draftSettings } : this.config;
    const path = this.desktop?.pathForFile?.(file), hadAudio = !!settings.audioPath;
    try {
      if (this.desktop?.shortCommand) {
        if (!path) throw new Error('The chosen audio could not be opened.');
        await this.desktop.rememberFolders!([path]); settings.audioPath = path;
      } else settings.audioPath = await this.browserEditor.addAudio(file);
      // "Replace" starts as a replacement: the original goes silent until its level is raised.
      if (!hadAudio) settings.volume = 0;
      settings.musicVolume ??= 1;
      if (target === 'draft') await this.setDraft(settings, true);
      else this.stopPreview();
      this.changeDetector.detectChanges();
    } catch (e) { this.error = this.message(e); }
  }
  /** Back to the original sound in the settings beside the video. */
  async useOriginalDraftAudio() {
    const settings = this.state.draftSettings;
    await this.setDraft({ audioPath: null, volume: settings.volume === 0 ? 1 : settings.volume }, true);
  }
  /**
   * A change in the settings beside the video: shown at once, sent a moment
   * later so a slider being dragged is one command rather than fifty.
   */
  async setDraft(change: Partial<Settings>, now = false) {
    this.state = { ...this.state, draftSettings: { ...this.state.draftSettings, ...change } };
    clearTimeout(this.draftTimer);
    const send = async (): Promise<void> => {
      // Another command is running: try again in a moment rather than lose the change.
      if (this.busy) { this.draftTimer = setTimeout(() => void send(), 200); return; }
      this.draftTimer = undefined;
      await this.command('short_set_selection', { ranges: this.state.selection, settings: this.state.draftSettings });
    };
    if (now) await send();
    else this.draftTimer = setTimeout(() => void send(), 300);
  }

  // ------------------------------------------------ the two panes, as in the Video Editor

  ngAfterViewChecked() {
    // A remembered width or height is applied once the workspace is in the document.
    if (!this.layoutPending || !this.bancada || !this.previaSecao) return;
    this.layoutPending = false;
    if (this.splitWidth !== null) this.applySplit(this.bancada.nativeElement, this.splitWidth);
    if (this.videoHeight !== null) this.applyVideoHeight(this.previaSecao.nativeElement, this.videoHeight, false);
  }
  private clampSplit(container: HTMLElement, width: number) {
    const total = container.clientWidth;
    const widest = Math.max(SPLIT_PROJECT_MIN, Math.min(total * SPLIT_MAX_SHARE, total - SPLIT_PREVIEW_MIN));
    return Math.round(Math.min(Math.max(width, SPLIT_PROJECT_MIN), widest));
  }
  private applySplit(container: HTMLElement, width: number) {
    const settled = this.clampSplit(container, width);
    this.splitWidth = settled;
    container.style.setProperty('--largura-projeto', `${settled}px`);
    container.querySelector(':scope > .divisor')?.setAttribute('aria-valuenow', String(settled));
  }
  /** Drags the line between the video and the settings; dragging left widens the settings. */
  startSplit(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement, container = this.bancada?.nativeElement;
    const projeto = container?.querySelector<HTMLElement>(':scope > .projeto');
    if (!container || !projeto) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const from = event.clientX, started = projeto.getBoundingClientRect().width;
    const move = (moved: PointerEvent) => this.applySplit(container, started + (from - moved.clientX));
    const stop = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (this.splitWidth !== null) saveSetting(SPLIT_KEY, String(this.splitWidth));
    };
    this.zone.runOutsideAngular(() => { handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop); });
  }
  onSplitKey(event: KeyboardEvent) {
    const container = this.bancada?.nativeElement, projeto = container?.querySelector<HTMLElement>(':scope > .projeto');
    if (!container || !projeto) return;
    const step = event.shiftKey ? SPLIT_STEP_FAST : SPLIT_STEP, width = projeto.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') this.applySplit(container, width + step);
    else if (event.key === 'ArrowRight') this.applySplit(container, width - step);
    else if (event.key === 'Home') { this.resetSplit(); event.preventDefault(); return; }
    else return;
    event.preventDefault();
    if (this.splitWidth !== null) saveSetting(SPLIT_KEY, String(this.splitWidth));
  }
  resetSplit() {
    const container = this.bancada?.nativeElement;
    this.splitWidth = null; dropSetting(SPLIT_KEY);
    if (!container) return;
    container.style.removeProperty('--largura-projeto');
    container.querySelector(':scope > .divisor')?.removeAttribute('aria-valuenow');
  }
  /** The tallest the video may be: no taller than the pane lets it be wide, nor than most of the window. */
  private clampVideoHeight(previa: HTMLElement, height: number, toPicture = true) {
    const video = this.player?.nativeElement, stage = previa.querySelector<HTMLElement>('.previa-palco');
    let widest = Infinity;
    if (toPicture && video?.videoWidth && video.videoHeight && stage) {
      const padding = getComputedStyle(stage);
      const available = stage.clientWidth - parseFloat(padding.paddingLeft || '0') - parseFloat(padding.paddingRight || '0');
      if (available > 0) widest = available * video.videoHeight / video.videoWidth;
    }
    const tallest = Math.max(VIDEO_MIN, Math.min(widest, window.innerHeight * VIDEO_MAX_SHARE));
    return Math.round(Math.min(Math.max(height, VIDEO_MIN), tallest));
  }
  private applyVideoHeight(previa: HTMLElement, height: number, toPicture = true) {
    const settled = this.clampVideoHeight(previa, height, toPicture);
    this.videoHeight = settled;
    previa.style.setProperty('--altura-video', `${settled}px`);
    previa.querySelector(':scope > .divisor-altura')?.setAttribute('aria-valuenow', String(settled));
  }
  /** Drags the bottom edge of the video; dragging down makes it taller. */
  startVideoResize(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement, previa = this.previaSecao?.nativeElement, video = this.player?.nativeElement;
    if (!previa || !video) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const from = event.clientY, started = video.getBoundingClientRect().height;
    const move = (moved: PointerEvent) => this.applyVideoHeight(previa, started + (moved.clientY - from));
    const stop = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (this.videoHeight !== null) saveSetting(VIDEO_HEIGHT_KEY, String(this.videoHeight));
    };
    this.zone.runOutsideAngular(() => { handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop); });
  }
  onVideoResizeKey(event: KeyboardEvent) {
    const previa = this.previaSecao?.nativeElement, video = this.player?.nativeElement;
    if (!previa || !video) return;
    const step = event.shiftKey ? SPLIT_STEP_FAST : SPLIT_STEP, height = video.getBoundingClientRect().height;
    if (event.key === 'ArrowDown') this.applyVideoHeight(previa, height + step);
    else if (event.key === 'ArrowUp') this.applyVideoHeight(previa, height - step);
    else if (event.key === 'Home') { this.resetVideoHeight(); event.preventDefault(); return; }
    else return;
    event.preventDefault();
    if (this.videoHeight !== null) saveSetting(VIDEO_HEIGHT_KEY, String(this.videoHeight));
  }
  resetVideoHeight() {
    const previa = this.previaSecao?.nativeElement;
    this.videoHeight = null; dropSetting(VIDEO_HEIGHT_KEY);
    if (!previa) return;
    previa.style.removeProperty('--altura-video');
    previa.querySelector(':scope > .divisor-altura')?.removeAttribute('aria-valuenow');
  }
  async saveSettings() {
    if (this.modalId) {
      // An empty name keeps the one the short already has.
      const name = this.configName.trim() || undefined;
      await this.command('short_update', { id: this.modalId, settings: this.config, name });
      if (!this.error && this.modalId === this.editingId) {
        if (name) this.title = name;
        await this.command('short_set_selection', { ranges: this.state.selection, settings: this.config });
      }
    }
    else await this.command('short_set_selection', { ranges: this.state.selection, settings: this.config });
    if (!this.error) this.closeSettings();
  }
  async render(short: Short) {
    try {
      if (this.desktop?.shortCommand) { const outputPath = await this.desktop.chooseShortOutput!(short.name); if (outputPath) await this.command('short_render', { id: short.id, outputPath }); }
      else await this.command('short_render', { id: short.id });
    }
    catch (e) { this.error = this.message(e); }
  }
  async remove(short: Short) {
    if (await this.ask('Remove this short?', `The short “${short.name}” leaves this session. Exported files are kept.`, 'Remove short')) {
      await this.command('short_delete', { id: short.id }); if (this.editingId === short.id) this.editingId = null;
    }
  }
}

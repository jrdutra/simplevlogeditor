import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  Output,
  ViewChild,
  inject
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { EditableRange, TimeRange, WaveformData, WaveformMode } from './silence-cutter.models';

/** Colours pulled from the site palette so the waveform belongs to the page. */
const COLOURS = {
  background: 'rgba(3, 14, 30, 0.85)',
  grid: 'rgba(0, 255, 209, 0.12)',
  waveKept: 'rgba(0, 255, 209, 0.75)',
  waveKeptCore: 'rgba(0, 255, 209, 0.95)',
  waveRemoved: 'rgba(182, 37, 255, 0.4)',
  removedFill: 'rgba(182, 37, 255, 0.16)',
  removedHatch: 'rgba(182, 37, 255, 0.55)',
  removedBorder: 'rgba(182, 37, 255, 0.7)',
  // A selected region drops the purple entirely: colour is the only thing that
  // tells the reader which of several neighbouring blocks the delete button
  // belongs to, so it has to be unmistakable.
  selectedFill: 'rgba(255, 170, 0, 0.24)',
  selectedHatch: 'rgba(255, 196, 74, 0.85)',
  selectedBorder: 'rgba(255, 208, 92, 0.95)',
  waveSelected: 'rgba(255, 208, 92, 0.6)',
  draftFill: 'rgba(182, 37, 255, 0.22)',
  draftBorder: 'rgba(244, 251, 255, 0.85)',
  playhead: '#ffea00',
  axis: 'rgba(185, 200, 219, 0.75)',
  midline: 'rgba(244, 251, 255, 0.18)'
} as const;

/** Height reserved at the bottom of the canvas for the time ruler. */
const RULER_HEIGHT = 22;

/** Zoom steps, as a multiple of "the whole file fits the width". */
const MAX_ZOOM = 400;

/** Pointer travel, in CSS pixels, before a press counts as a drag. */
const DRAG_SLOP = 3;

/** Shortest region the reader can draw by hand, in seconds. */
const MIN_MANUAL_RANGE = 0.01;

/** Click tolerance when hitting a very narrow region, in CSS pixels. */
const HIT_SLOP = 3;
const EDGE_HIT_SLOP = 7;

export interface RangeResize {
  range: EditableRange;
  start: number;
  end: number;
}

/**
 * Where the playhead is placed when the view has to chase it, as a share of
 * the visible span. Keeping it near the left edge means the reader sees what is
 * coming rather than what has already played.
 */
const FOLLOW_LEAD = 0.1;

@Component({
  selector: 'app-silence-waveform',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wf-toolbar">
      <div class="wf-legend" role="list">
        <span class="wf-legend-item" role="listitem">
          <span class="wf-swatch wf-swatch-kept" aria-hidden="true"></span> Kept
        </span>
        <span class="wf-legend-item" role="listitem">
          <span class="wf-swatch wf-swatch-removed" aria-hidden="true"></span> Removed (hatched)
        </span>
        <span class="wf-legend-item" role="listitem">
          <span class="wf-swatch wf-swatch-selected" aria-hidden="true"></span> Selected
        </span>
      </div>

      <div class="wf-zoom">
        <button type="button" (click)="zoomBy(1 / 1.8)" [disabled]="zoom <= 1" aria-label="Zoom out">
          <mat-icon aria-hidden="true">zoom_out</mat-icon>
        </button>
        <button type="button" (click)="fit()" [disabled]="zoom === 1" aria-label="Fit the whole file">
          <mat-icon aria-hidden="true">fit_screen</mat-icon>
        </button>
        <button type="button" (click)="zoomBy(1.8)" [disabled]="zoom >= maxZoom" aria-label="Zoom in">
          <mat-icon aria-hidden="true">zoom_in</mat-icon>
        </button>
        <span class="wf-zoom-value">{{ zoomLabel }}</span>
      </div>
    </div>

    <div
      class="wf-surface"
      #surface
      role="slider"
      tabindex="0"
      [attr.aria-label]="'Waveform. ' + summaryLabel"
      [attr.aria-valuemin]="0"
      [attr.aria-valuemax]="duration"
      [attr.aria-valuenow]="currentTime"
      [attr.aria-valuetext]="positionLabel"
      (keydown)="onKeydown($event)">
      <canvas #canvas></canvas>

      <button
        #deleteButton
        type="button"
        class="wf-delete"
        hidden
        [attr.aria-label]="deleteLabel"
        [title]="deleteLabel"
        (click)="deleteSelected()">
        <mat-icon aria-hidden="true">close</mat-icon>
      </button>
    </div>

    <div class="wf-scrollbar" #scroller>
      <div class="wf-spacer" #spacer></div>
    </div>

    <p class="wf-hint">
      Left-drag to mark a new region for removal, drag either edge of a marked region to adjust it, right-drag to slide
      the waveform, or click a region to remove it with the ✕ button.
      @if (zoom > 1) {
        <span> Showing {{ visibleLabel }} of {{ totalLabel }}, following the playhead until you scroll elsewhere.</span>
      }
    </p>
  `,
  styles: [`
    :host { display: block; }

    .wf-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }

    .wf-legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.8rem; color: var(--text-muted); }
    .wf-legend-item { display: inline-flex; align-items: center; gap: 0.4em; }

    .wf-swatch {
      width: 1.1em;
      height: 0.75em;
      border-radius: 2px;
      display: inline-block;
    }

    .wf-swatch-kept { background: rgba(0, 255, 209, 0.85); }

    .wf-swatch-removed {
      border: 1px solid rgba(182, 37, 255, 0.85);
      background:
        repeating-linear-gradient(
          45deg,
          rgba(182, 37, 255, 0.55) 0 2px,
          transparent 2px 4px
        );
    }

    .wf-swatch-selected {
      border: 1px solid rgba(255, 208, 92, 0.95);
      background:
        repeating-linear-gradient(
          45deg,
          rgba(255, 196, 74, 0.85) 0 2px,
          transparent 2px 4px
        );
    }

    .wf-zoom { display: inline-flex; align-items: center; gap: 0.3rem; }

    .wf-zoom button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border: 1px solid var(--line-soft);
      border-radius: 0.5em;
      background: transparent;
      color: var(--text-main);
      cursor: pointer;
    }

    .wf-zoom button:hover:not(:disabled) { border-color: var(--aqua); color: var(--aqua); }
    .wf-zoom button:disabled { opacity: 0.4; cursor: default; }
    .wf-zoom button mat-icon { width: 1.1em; height: 1.1em; font-size: 1.1em; }
    .wf-zoom-value { font-size: 0.78rem; color: var(--text-muted); min-width: 3.2em; text-align: right; }

    .wf-surface {
      position: relative;
      width: 100%;
      height: 190px;
      border: 1px solid var(--line-soft);
      border-radius: 0.75em;
      overflow: hidden;
      cursor: crosshair;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
    }

    .wf-surface.is-panning { cursor: grabbing; }

    .wf-surface:focus-visible { outline: 2px solid var(--aqua); outline-offset: 2px; }
    .wf-surface canvas { display: block; width: 100%; height: 100%; }

    .wf-delete {
      position: absolute;
      top: 8px;
      left: 0;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.75rem;
      height: 1.75rem;
      padding: 0;
      border: 1px solid rgba(255, 208, 92, 0.95);
      border-radius: 50%;
      background: rgba(12, 8, 0, 0.92);
      color: rgb(255, 208, 92);
      cursor: pointer;
      z-index: 2;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
    }

    .wf-delete:hover { background: rgb(255, 208, 92); color: rgb(20, 12, 0); }
    .wf-delete:focus-visible { outline: 2px solid var(--aqua); outline-offset: 2px; }
    .wf-delete mat-icon { width: 1.05rem; height: 1.05rem; font-size: 1.05rem; line-height: 1.05rem; }
    .wf-delete[hidden] { display: none; }

    .wf-scrollbar {
      display: none;
      width: 100%;
      height: 12px;
      overflow-x: auto;
      overflow-y: hidden;
      margin-top: 0.35rem;
    }

    .wf-spacer { height: 1px; }

    .wf-scrollbar::-webkit-scrollbar { height: 10px; }
    .wf-scrollbar::-webkit-scrollbar-track { background: rgba(3, 14, 30, 0.85); border-radius: 6px; }
    .wf-scrollbar::-webkit-scrollbar-thumb {
      background: rgba(0, 255, 209, 0.45);
      border-radius: 6px;
    }
    .wf-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(0, 255, 209, 0.7); }
    .wf-scrollbar { scrollbar-width: thin; scrollbar-color: rgba(0, 255, 209, 0.45) rgba(3, 14, 30, 0.85); }

    .wf-hint { margin: 0.4rem 0 0; font-size: 0.78rem; color: var(--text-muted); }

    @media (max-width: 650px) {
      .wf-surface { height: 150px; }
    }
  `]
})
export class SilenceWaveformComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) waveform!: WaveformData;
  @Input({ required: true }) silenceRanges: readonly EditableRange[] = [];
  @Input() duration = 0;
  @Input() currentTime = 0;
  @Input() mode: WaveformMode = 'canvas2d';

  /** Emitted when the reader picks a position on the timeline. */
  @Output() readonly seek = new EventEmitter<number>();
  /** Emitted when the reader draws a new region to remove. */
  @Output() readonly rangeAdd = new EventEmitter<TimeRange>();
  /** Emitted when the reader deletes a region, automatic or hand-drawn. */
  @Output() readonly rangeRemove = new EventEmitter<EditableRange>();
  @Output() readonly rangeResize = new EventEmitter<RangeResize>();

  @ViewChild('canvas') private canvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('surface') private surfaceRef?: ElementRef<HTMLElement>;
  @ViewChild('scroller') private scrollerRef?: ElementRef<HTMLElement>;
  @ViewChild('spacer') private spacerRef?: ElementRef<HTMLElement>;
  @ViewChild('deleteButton') private deleteButtonRef?: ElementRef<HTMLElement>;

  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  zoom = 1;
  /** Left edge of the visible window, in seconds. */
  private offset = 0;

  /** The region the reader picked, by reference into `silenceRanges`. */
  selected: EditableRange | null = null;

  private context: CanvasRenderingContext2D | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;

  private gesture: 'none' | 'pan' | 'select' | 'resize-start' | 'resize-end' = 'none';
  private gestureMoved = false;
  private dragOrigin = 0;
  private dragOffset = 0;
  private dragStartTime = 0;
  /** Region being drawn right now, painted but not yet committed. */
  private draft: TimeRange | null = null;
  private resizeRange: EditableRange | null = null;
  private resizeDraft: TimeRange | null = null;
  private hoveredEdge: { range: EditableRange; edge: 'start' | 'end' } | null = null;
  /**
   * The last scroll position this component set itself.
   *
   * Used to tell our own scrolling apart from the reader's. A timer would not
   * do: a scroll event is dispatched asynchronously and could easily arrive
   * after the flag was cleared, which would make the view mistake its own
   * movement for a decision by the reader and stop following the playhead.
   */
  private appliedScrollLeft = -1;

  /**
   * Whether the view chases the playhead out of the visible window.
   *
   * On by default and switched off the moment the reader frames somewhere else
   * themselves — dragging the waveform to inspect a cut while the file plays
   * must not be undone half a second later. It switches back on as soon as the
   * playhead is on screen again, so following resumes without a control to
   * find.
   */
  private follow = true;

  readonly maxZoom = MAX_ZOOM;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef?.nativeElement;
    const surface = this.surfaceRef?.nativeElement;
    if (!canvas || !surface || typeof window === 'undefined') return;

    // `desynchronized` lets the browser skip a compositing round trip for a
    // canvas nothing reads back — which is exactly this one.
    this.context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: this.mode === 'accelerated-canvas'
    }) as CanvasRenderingContext2D | null;

    // Drawing and dragging must not schedule change detection on every frame.
    this.zone.runOutsideAngular(() => {
      this.observer = new ResizeObserver(() => {
        this.syncScrollbar();
        this.scheduleDraw();
      });
      this.observer.observe(surface);
      surface.addEventListener('pointerdown', this.onPointerDown);
      surface.addEventListener('pointermove', this.onPointerMove);
      surface.addEventListener('pointerup', this.onPointerUp);
      surface.addEventListener('pointercancel', this.onPointerUp);
      surface.addEventListener('wheel', this.onWheel, { passive: false });
      surface.addEventListener('contextmenu', this.onContextMenu);
      this.scrollerRef?.nativeElement.addEventListener('scroll', this.onScroll, { passive: true });
    });

    this.syncScrollbar();
    this.scheduleDraw();
  }

  ngOnChanges(): void {
    // A new analysis replaces the array, so a selection held by reference has
    // to be dropped rather than left pointing at a region that no longer runs.
    if (this.selected && !this.silenceRanges.includes(this.selected)) {
      this.selected = null;
    }
    this.clampOffset();
    this.followPlayhead();
    this.syncScrollbar();
    this.scheduleDraw();
  }

  ngOnDestroy(): void {
    const surface = this.surfaceRef?.nativeElement;
    this.observer?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.scrollerRef?.nativeElement.removeEventListener('scroll', this.onScroll);
    if (!surface) return;
    surface.removeEventListener('pointerdown', this.onPointerDown);
    surface.removeEventListener('pointermove', this.onPointerMove);
    surface.removeEventListener('pointerup', this.onPointerUp);
    surface.removeEventListener('pointercancel', this.onPointerUp);
    surface.removeEventListener('wheel', this.onWheel);
    surface.removeEventListener('contextmenu', this.onContextMenu);
  }

  // ------------------------------------------------------------------ labels

  get zoomLabel(): string {
    return this.zoom < 10 ? `${this.zoom.toFixed(1)}x` : `${Math.round(this.zoom)}x`;
  }

  get visibleLabel(): string {
    return formatDuration(this.duration / this.zoom);
  }

  get totalLabel(): string {
    return formatDuration(this.duration);
  }

  get positionLabel(): string {
    return formatDuration(this.currentTime);
  }

  get deleteLabel(): string {
    if (!this.selected) return 'Delete the selected region';
    return `Delete the region from ${formatDuration(this.selected.start)} to ${formatDuration(this.selected.end)}`;
  }

  get summaryLabel(): string {
    const removed = this.silenceRanges.length;
    return `${removed} region${removed === 1 ? '' : 's'} marked for removal across ${formatDuration(this.duration)}.`;
  }

  // ------------------------------------------------------------------- zoom

  zoomBy(factor: number): void {
    this.zoomAt(factor, 0.5);
  }

  fit(): void {
    this.zoom = 1;
    this.offset = 0;
    this.follow = true;
    this.syncScrollbar();
    this.scheduleDraw();
  }

  /** Zooms while keeping the time under `anchor` (0..1 of the width) in place. */
  private zoomAt(factor: number, anchor: number): void {
    const visible = this.visibleSpan;
    const anchorTime = this.offset + anchor * visible;
    const next = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor));
    if (next === this.zoom) return;

    this.zoom = next;
    this.offset = anchorTime - anchor * this.visibleSpan;
    this.clampOffset();
    this.reviewFollowing();
    this.syncScrollbar();
    this.scheduleDraw();
  }

  private get visibleSpan(): number {
    return this.duration > 0 ? this.duration / this.zoom : 0;
  }

  private clampOffset(): void {
    const visible = this.visibleSpan;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.duration - visible)));
  }

  /**
   * Keeps the real scrollbar in step with the zoom window.
   *
   * The canvas always paints only what is on screen, so the scrollbar is a
   * separate strip sized to `viewport * zoom`: the browser then gives us a
   * native, keyboard- and trackpad-aware horizontal scrollbar for free, and it
   * appears exactly when the drawing grows wider than its box.
   */
  private syncScrollbar(): void {
    const scroller = this.scrollerRef?.nativeElement;
    const spacer = this.spacerRef?.nativeElement;
    const surface = this.surfaceRef?.nativeElement;
    if (!scroller || !spacer || !surface) return;

    if (this.zoom <= 1 || this.duration <= 0) {
      scroller.style.display = 'none';
      spacer.style.width = '100%';
      return;
    }

    const content = Math.round(surface.clientWidth * this.zoom);
    scroller.style.display = 'block';
    spacer.style.width = `${content}px`;

    const target = Math.round((this.offset / this.duration) * content);
    if (Math.abs(scroller.scrollLeft - target) > 1) {
      scroller.scrollLeft = target;
    }
    this.appliedScrollLeft = scroller.scrollLeft;
  }

  private readonly onScroll = (): void => {
    const scroller = this.scrollerRef?.nativeElement;
    const surface = this.surfaceRef?.nativeElement;
    if (!scroller || !surface || this.duration <= 0) return;

    // Our own scrolling comes back through this handler too; only a position
    // we did not set can have come from the reader.
    if (Math.abs(scroller.scrollLeft - this.appliedScrollLeft) <= 1) return;

    const content = surface.clientWidth * this.zoom;
    if (content <= 0) return;

    this.appliedScrollLeft = scroller.scrollLeft;
    this.offset = (scroller.scrollLeft / content) * this.duration;
    this.clampOffset();
    this.reviewFollowing();
    this.scheduleDraw();
  };

  // -------------------------------------------------------------- following

  /** True when the playhead sits inside the window currently on screen. */
  private get playheadVisible(): boolean {
    return this.currentTime >= this.offset && this.currentTime <= this.offset + this.visibleSpan;
  }

  /**
   * Decides whether to keep following, after the reader moved the view.
   *
   * Framing somewhere the playhead is not means they want to look there;
   * framing somewhere it is means they are back with the playback.
   */
  private reviewFollowing(): void {
    this.follow = this.playheadVisible;
  }

  /**
   * Scrolls to bring the playhead back on screen, after it moved.
   *
   * This is the whole point of the scrollbar existing at a zoom level: a
   * waveform showing four seconds of a two-hour file is useless if the four
   * seconds it shows are not the ones being played.
   */
  private followPlayhead(): void {
    if (this.playheadVisible) {
      // It came back on its own — a seek, or playback catching up with a view
      // the reader had scrolled ahead to. Following resumes from here.
      this.follow = true;
      return;
    }

    if (!this.follow || this.zoom <= 1 || this.duration <= 0) return;

    this.offset = this.currentTime - this.visibleSpan * FOLLOW_LEAD;
    this.clampOffset();
    this.syncScrollbar();
  }

  // ------------------------------------------------------------ interaction

  /** Time under a client X coordinate, clamped to the media. */
  private timeAt(clientX: number): number {
    const surface = this.surfaceRef?.nativeElement;
    if (!surface || this.duration <= 0) return 0;
    const rect = surface.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.max(0, Math.min(this.duration, this.offset + ratio * this.visibleSpan));
  }

  /** The region under a given time, with a small pixel tolerance. */
  private regionAt(time: number, tolerance = 0): EditableRange | null {
    // The list is sorted, so the first region starting past the point ends the
    // search — this runs once per pixel column of every frame.
    for (const range of this.silenceRanges) {
      if (range.start - tolerance > time) break;
      if (time <= range.end + tolerance) return range;
    }
    return null;
  }

  private edgeAt(time: number, tolerance: number): { range: EditableRange; edge: 'start' | 'end' } | null {
    let best: { range: EditableRange; edge: 'start' | 'end'; distance: number } | null = null;
    for (const range of this.silenceRanges) {
      const start = Math.abs(time - range.start);
      const end = Math.abs(time - range.end);
      if (start <= tolerance && (!best || start < best.distance)) best = { range, edge: 'start', distance: start };
      if (end <= tolerance && (!best || end < best.distance)) best = { range, edge: 'end', distance: end };
    }
    return best ? { range: best.range, edge: best.edge } : null;
  }

  private updateEdgeHover(event: PointerEvent): void {
    const surface = this.surfaceRef?.nativeElement;
    if (!surface || this.duration <= 0) return;
    const tolerance = (EDGE_HIT_SLOP / Math.max(1, surface.clientWidth)) * this.visibleSpan;
    const edge = this.edgeAt(this.timeAt(event.clientX), tolerance);
    if (edge?.range === this.hoveredEdge?.range && edge?.edge === this.hoveredEdge?.edge) return;
    this.hoveredEdge = edge;
    surface.style.cursor = edge ? 'ew-resize' : 'crosshair';
    this.scheduleDraw();
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    // The right button pans; the browser menu would swallow the gesture.
    event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    // The delete button lives inside the surface; its clicks are not gestures.
    if ((event.target as Element)?.closest?.('.wf-delete')) return;

    const surface = this.surfaceRef?.nativeElement;
    if (!surface || this.duration <= 0) return;

    // Touch has no second button, so a finger drag pans rather than drawing.
    const pans = event.button === 2 || event.button === 1 || event.pointerType === 'touch';

    const tolerance = (EDGE_HIT_SLOP / Math.max(1, surface.clientWidth)) * this.visibleSpan;
    const edge = !pans && event.button === 0 ? this.edgeAt(this.timeAt(event.clientX), tolerance) : null;

    this.gesture = pans ? 'pan' : edge ? (edge.edge === 'start' ? 'resize-start' : 'resize-end') : 'select';
    this.gestureMoved = false;
    this.dragOrigin = event.clientX;
    this.dragOffset = this.offset;
    this.dragStartTime = this.timeAt(event.clientX);
    this.draft = null;
    this.resizeRange = edge?.range ?? null;
    this.resizeDraft = edge ? { start: edge.range.start, end: edge.range.end } : null;
    if (edge) this.selected = edge.range;

    surface.setPointerCapture?.(event.pointerId);
    if (this.gesture === 'pan') surface.classList.add('is-panning');

    // `preventDefault` stops the browser from starting a text selection, and
    // takes the focus with it — which the keyboard shortcuts need back.
    event.preventDefault();
    surface.focus?.();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.gesture === 'none' || !event.buttons) {
      this.updateEdgeHover(event);
      return;
    }
    const surface = this.surfaceRef?.nativeElement;
    if (!surface) return;

    const delta = event.clientX - this.dragOrigin;
    if (!this.gestureMoved && Math.abs(delta) < DRAG_SLOP) return;
    this.gestureMoved = true;

    if (this.gesture === 'pan') {
      this.offset = this.dragOffset - (delta / Math.max(1, surface.clientWidth)) * this.visibleSpan;
      this.clampOffset();
      this.reviewFollowing();
      this.syncScrollbar();
    } else if (this.gesture === 'select') {
      const now = this.timeAt(event.clientX);
      this.draft = { start: Math.min(this.dragStartTime, now), end: Math.max(this.dragStartTime, now) };
    } else if (this.resizeRange) {
      const now = this.timeAt(event.clientX);
      this.resizeDraft = this.gesture === 'resize-start'
        ? { start: Math.min(now, this.resizeRange.end - MIN_MANUAL_RANGE), end: this.resizeRange.end }
        : { start: this.resizeRange.start, end: Math.max(now, this.resizeRange.start + MIN_MANUAL_RANGE) };
    }

    this.scheduleDraw();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const surface = this.surfaceRef?.nativeElement;
    const gesture = this.gesture;
    const moved = this.gestureMoved;
    const draft = this.draft;
    const resized = this.resizeRange;
    const resizedTo = this.resizeDraft;

    this.gesture = 'none';
    this.gestureMoved = false;
    this.draft = null;
    this.resizeRange = null;
    this.resizeDraft = null;
    surface?.classList.remove('is-panning');
    try {
      // Throws when the capture was already released, as on `pointercancel`.
      surface?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* nothing to release */
    }

    if (gesture === 'none') return;

    if ((gesture === 'resize-start' || gesture === 'resize-end') && resized && resizedTo) {
      this.zone.run(() => this.rangeResize.emit({ range: resized, start: resizedTo.start, end: resizedTo.end }));
      this.scheduleDraw();
      return;
    }

    if (gesture === 'select' && moved && draft && draft.end - draft.start >= MIN_MANUAL_RANGE) {
      this.zone.run(() => this.rangeAdd.emit(draft));
      return;
    }

    if (gesture !== 'select' || moved) {
      this.scheduleDraw();
      return;
    }

    // A plain click: pick the region under the pointer, or seek when there is
    // none — and deselect, so the delete button never floats over nothing.
    const time = this.timeAt(event.clientX);
    const tolerance = (HIT_SLOP / Math.max(1, surface?.clientWidth ?? 1)) * this.visibleSpan;
    const hit = this.regionAt(time, tolerance);

    this.zone.run(() => {
      if (hit) {
        this.selected = this.selected === hit ? null : hit;
      } else {
        this.selected = null;
        this.seek.emit(time);
      }
      this.cdr.markForCheck();
    });

    this.scheduleDraw();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const surface = this.surfaceRef?.nativeElement;
    if (!surface) return;

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      this.zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, anchor);
      this.zone.run(() => this.cdr.markForCheck());
      return;
    }

    // Once zoomed, a horizontal wheel (or shift+wheel) walks the timeline.
    const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
    if (this.zoom > 1 && horizontal) {
      event.preventDefault();
      this.offset += (horizontal / Math.max(1, surface.clientWidth)) * this.visibleSpan;
      this.clampOffset();
      this.reviewFollowing();
      this.syncScrollbar();
      this.scheduleDraw();
    }
  };

  onKeydown(event: KeyboardEvent): void {
    const step = this.visibleSpan / 20;

    if (event.key === 'ArrowRight') {
      this.seek.emit(Math.min(this.duration, this.currentTime + step));
    } else if (event.key === 'ArrowLeft') {
      this.seek.emit(Math.max(0, this.currentTime - step));
    } else if (event.key === '+' || event.key === '=') {
      this.zoomBy(1.8);
    } else if (event.key === '-') {
      this.zoomBy(1 / 1.8);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!this.selected) return;
      this.deleteSelected();
    } else if (event.key === 'Escape') {
      if (!this.selected) return;
      this.selected = null;
      this.scheduleDraw();
    } else {
      return;
    }
    event.preventDefault();
  }

  deleteSelected(): void {
    const range = this.selected;
    if (!range) return;
    this.selected = null;
    this.rangeRemove.emit(range);
    this.scheduleDraw();
  }

  // ---------------------------------------------------------------- drawing

  private scheduleDraw(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    const surface = this.surfaceRef?.nativeElement;
    const context = this.context;
    if (!canvas || !surface || !context || !this.waveform) return;

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(surface.clientWidth * ratio));
    const height = Math.max(1, Math.floor(surface.clientHeight * ratio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const visible = this.visibleSpan;
    const from = this.offset;
    const to = from + visible;
    const waveHeight = height - RULER_HEIGHT * ratio;
    const middle = waveHeight / 2;

    context.fillStyle = COLOURS.background;
    context.fillRect(0, 0, width, height);

    this.drawRemoved(context, width, waveHeight, from, visible);
    this.drawWave(context, width, waveHeight, middle, from, visible);

    context.strokeStyle = COLOURS.midline;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();

    this.drawDraft(context, width, waveHeight, from, visible);
    this.drawRuler(context, width, height, waveHeight, from, to, ratio);
    this.drawPlayhead(context, width, waveHeight, from, visible);
    this.placeDeleteButton(surface.clientWidth, from, visible);
  }

  /**
   * Draws the ranges that will be removed.
   *
   * They are filled *and* hatched: colour alone would leave the single most
   * important piece of information on the page invisible to a reader who
   * cannot distinguish it. The selected one swaps both the fill and the hatch
   * so it reads as picked even in greyscale.
   */
  private drawRemoved(
    context: CanvasRenderingContext2D,
    width: number,
    waveHeight: number,
    from: number,
    visible: number
  ): void {
    context.save();

    for (const range of this.silenceRanges) {
      if (range.end < from || range.start > from + visible) continue;

      const selected = range === this.selected;
      const shown = range === this.resizeRange && this.resizeDraft ? this.resizeDraft : range;
      const left = ((shown.start - from) / visible) * width;
      const right = ((shown.end - from) / visible) * width;
      const boxWidth = Math.max(1, right - left);

      context.fillStyle = selected ? COLOURS.selectedFill : COLOURS.removedFill;
      context.fillRect(left, 0, boxWidth, waveHeight);

      context.save();
      context.beginPath();
      context.rect(left, 0, boxWidth, waveHeight);
      context.clip();
      context.strokeStyle = selected ? COLOURS.selectedHatch : COLOURS.removedHatch;
      context.lineWidth = 1;
      const spacing = 7;
      for (let x = left - waveHeight; x < right + waveHeight; x += spacing) {
        context.beginPath();
        context.moveTo(x, waveHeight);
        context.lineTo(x + waveHeight, 0);
        context.stroke();
      }
      context.restore();

      context.strokeStyle = selected ? COLOURS.selectedBorder : COLOURS.removedBorder;
      context.lineWidth = selected ? 2 : 1;
      context.strokeRect(left + 0.5, 0.5, Math.max(1, boxWidth - 1), waveHeight - 1);

      if (this.hoveredEdge?.range === range || this.resizeRange === range) {
        context.strokeStyle = selected ? COLOURS.selectedBorder : COLOURS.draftBorder;
        context.lineWidth = 3;
        if (this.hoveredEdge?.edge === 'start' || this.gesture === 'resize-start') {
          context.beginPath();
          context.moveTo(left, 0);
          context.lineTo(left, waveHeight);
          context.stroke();
        }
        if (this.hoveredEdge?.edge === 'end' || this.gesture === 'resize-end') {
          context.beginPath();
          context.moveTo(right, 0);
          context.lineTo(right, waveHeight);
          context.stroke();
        }
      }
    }

    context.restore();
  }

  /** The region being drawn right now, so the reader sees what they are cutting. */
  private drawDraft(
    context: CanvasRenderingContext2D,
    width: number,
    waveHeight: number,
    from: number,
    visible: number
  ): void {
    const draft = this.draft;
    if (!draft || visible <= 0) return;

    const left = ((draft.start - from) / visible) * width;
    const right = ((draft.end - from) / visible) * width;

    context.save();
    context.fillStyle = COLOURS.draftFill;
    context.fillRect(left, 0, Math.max(1, right - left), waveHeight);
    context.strokeStyle = COLOURS.draftBorder;
    context.lineWidth = 1;
    context.setLineDash([4, 3]);
    context.strokeRect(left + 0.5, 0.5, Math.max(1, right - left - 1), waveHeight - 1);
    context.restore();
  }

  private drawWave(
    context: CanvasRenderingContext2D,
    width: number,
    waveHeight: number,
    middle: number,
    from: number,
    visible: number
  ): void {
    const { min, max, rms, secondsPerBucket } = this.waveform;
    const buckets = min.length;
    if (!buckets || !secondsPerBucket) return;

    const amplitude = middle * 0.92;

    for (let x = 0; x < width; x++) {
      const timeStart = from + (x / width) * visible;
      const timeEnd = from + ((x + 1) / width) * visible;

      const firstBucket = Math.max(0, Math.floor(timeStart / secondsPerBucket));
      const lastBucket = Math.min(buckets - 1, Math.max(firstBucket, Math.ceil(timeEnd / secondsPerBucket) - 1));

      let low = 0;
      let high = 0;
      let loudness = 0;

      for (let b = firstBucket; b <= lastBucket; b++) {
        if (min[b] < low) low = min[b];
        if (max[b] > high) high = max[b];
        if (rms[b] > loudness) loudness = rms[b];
      }

      const region = this.regionAt(timeStart);
      context.fillStyle = !region
        ? COLOURS.waveKept
        : region === this.selected
          ? COLOURS.waveSelected
          : COLOURS.waveRemoved;

      const top = middle - high * amplitude;
      const bottom = middle - low * amplitude;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));

      if (!region && loudness > 0) {
        context.fillStyle = COLOURS.waveKeptCore;
        const core = loudness * amplitude;
        context.fillRect(x, middle - core, 1, Math.max(1, core * 2));
      }
    }
  }

  /**
   * Parks the round ✕ over the middle of the selected region.
   *
   * Done straight on the element rather than through a binding: this runs on
   * every animation frame of a pan, and change detection has no business
   * there.
   */
  private placeDeleteButton(surfaceWidth: number, from: number, visible: number): void {
    const button = this.deleteButtonRef?.nativeElement;
    if (!button) return;

    const range = this.selected;
    if (!range || visible <= 0) {
      button.hidden = true;
      return;
    }

    const left = ((range.start - from) / visible) * surfaceWidth;
    const right = ((range.end - from) / visible) * surfaceWidth;
    if (right < 0 || left > surfaceWidth) {
      button.hidden = true;
      return;
    }

    const centre = Math.max(18, Math.min(surfaceWidth - 18, (left + right) / 2));
    button.hidden = false;
    button.style.left = `${centre}px`;
  }

  /**
   * Time ruler whose spacing adapts to what is on screen.
   *
   * A two-hour file gets marks every ten minutes; zoom into a phrase and the
   * same ruler counts seconds. The step is picked from a fixed ladder so the
   * labels always land on round numbers.
   */
  private drawRuler(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    waveHeight: number,
    from: number,
    to: number,
    ratio: number
  ): void {
    const visible = to - from;
    if (visible <= 0) return;
    const step = niceStep(visible, Math.max(2, Math.floor(width / (90 * ratio))));

    context.fillStyle = 'rgba(2, 8, 20, 0.9)';
    context.fillRect(0, waveHeight, width, height - waveHeight);

    context.strokeStyle = COLOURS.grid;
    context.fillStyle = COLOURS.axis;
    context.font = `${11 * ratio}px "Segoe UI", system-ui, sans-serif`;
    context.textBaseline = 'middle';
    context.lineWidth = 1;

    const first = Math.ceil(from / step) * step;
    for (let time = first; time <= to; time += step) {
      const x = ((time - from) / visible) * width;

      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, waveHeight);
      context.stroke();

      const label = formatDuration(time);
      const textWidth = context.measureText(label).width;
      const anchored = Math.min(Math.max(x + 4 * ratio, 2), width - textWidth - 2);
      context.fillText(label, anchored, waveHeight + (height - waveHeight) / 2);
    }
  }

  private drawPlayhead(
    context: CanvasRenderingContext2D,
    width: number,
    waveHeight: number,
    from: number,
    visible: number
  ): void {
    if (this.currentTime < from || this.currentTime > from + visible) return;
    const x = ((this.currentTime - from) / visible) * width;

    context.strokeStyle = COLOURS.playhead;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, waveHeight);
    context.stroke();
  }
}

/** `03:07`, or `1:02:44` once the media passes an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;

  const padded = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return hours ? `${hours}:${padded}` : padded;
}

/** Largest round interval that still fits `target` marks into `span` seconds. */
function niceStep(span: number, target: number): number {
  const steps = [
    0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600
  ];
  const ideal = span / target;
  return steps.find((step) => step >= ideal) ?? steps[steps.length - 1];
}

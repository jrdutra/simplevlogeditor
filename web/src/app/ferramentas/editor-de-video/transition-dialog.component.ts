import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  PLATFORM_ID,
  ViewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { PreviewFrame, captureEdgeFrame, textCardStandIn } from './transition-preview';
import { EditorClip, TransitionSettings } from './video-editor.models';
import {
  TRANSITIONS,
  TRANSITION_GROUPS,
  TRANSITION_SECONDS,
  TransitionKind,
  TransitionPainter,
  transitionDefinition,
  usesColour
} from './video-transitions';

/** Size the preview composes at. Small enough to be free, large enough to read. */
const PREVIEW_WIDTH = 480;

/** Seconds the preview holds each end before looping, so the loop is legible. */
const HOLD = 0.5;

/**
 * Choosing how one shot becomes the next.
 *
 * The list of names is the smaller half of this dialog. Twenty-five transitions
 * described in words are twenty-five guesses; the same twenty-five played
 * between the reader's own two shots are a decision. So the preview is not a
 * courtesy here, it is the control — the combobox only exists to change what the
 * player underneath it is showing.
 *
 * The player runs the real painter over two real frames, one grabbed from the
 * end of the outgoing clip and one from the start of the incoming one. It is the
 * same code the encoder runs, so what is on this canvas is what lands in the
 * file, down to the wobble of a brush.
 */
@Component({
  selector: 'app-transition-dialog',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, BodyPortalDirective],
  templateUrl: './transition-dialog.component.html',
  styleUrls: ['./transition-dialog.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TransitionDialogComponent implements OnInit, OnDestroy {
  /** The join being edited. A copy is taken; the original is left alone. */
  @Input({ required: true }) settings!: TransitionSettings;
  /** The shot being left, for the preview. Null draws black on that side. */
  @Input() before: EditorClip | null = null;
  /** The shot being arrived at. */
  @Input() after: EditorClip | null = null;
  @Input() heading = 'How does this shot become the next one?';
  /** Shows the "remove" button. False for the project-wide default. */
  @Input() removable = true;

  @Output() readonly saved = new EventEmitter<TransitionSettings>();
  @Output() readonly removed = new EventEmitter<void>();
  @Output() readonly cancelled = new EventEmitter<void>();

  @ViewChild('stage') stage?: ElementRef<HTMLCanvasElement>;

  readonly groups = TRANSITION_GROUPS;
  readonly limits = TRANSITION_SECONDS;

  kind: TransitionKind = 'dissolve';
  seconds = TRANSITION_SECONDS.default;
  colour = '#0b0f1a';

  loading = true;
  width = PREVIEW_WIDTH;
  height = Math.round((PREVIEW_WIDTH * 9) / 16);

  private readonly painter = new TransitionPainter();
  private outgoing: PreviewFrame | null = null;
  private incoming: PreviewFrame | null = null;
  private raf = 0;
  private startedAt = 0;
  private destroyed = false;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.kind = this.settings.kind;
    this.seconds = this.settings.seconds;
    this.colour = this.settings.colour;

    void this.loadFrames();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.outgoing?.release();
    this.incoming?.release();
  }

  get definition() {
    return transitionDefinition(this.kind);
  }

  get showsColour(): boolean {
    return usesColour(this.kind);
  }

  /** How many animations there are, for the line under the list. */
  get count(): number {
    return TRANSITIONS.length;
  }

  onKind(value: string): void {
    this.kind = value as TransitionKind;
    this.restart();
  }

  onSeconds(value: string | number): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.seconds = Math.min(this.limits.max, Math.max(this.limits.min, parsed));
    this.restart();
  }

  onColour(value: string): void {
    this.colour = value;
    this.restart();
  }

  apply(): void {
    this.saved.emit({ kind: this.kind, seconds: this.seconds, colour: this.colour });
  }

  remove(): void {
    this.removed.emit();
  }

  close(): void {
    this.cancelled.emit();
  }

  /** Plays the animation again from the top, without waiting for the loop. */
  restart(): void {
    this.startedAt = 0;
    this.cdr.markForCheck();
  }

  // ---------------------------------------------------------------- private --

  private async loadFrames(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    const [outgoing, incoming] = await Promise.all([
      this.before ? captureEdgeFrame(this.before, 'out') : Promise.resolve(null),
      this.after ? captureEdgeFrame(this.after, 'in') : Promise.resolve(null)
    ]);

    if (this.destroyed) {
      outgoing?.release();
      incoming?.release();
      return;
    }

    this.outgoing = outgoing ?? (this.before ? textCardStandIn(this.before, this.width, this.height) : null);
    this.incoming = incoming ?? (this.after ? textCardStandIn(this.after, this.width, this.height) : null);

    // The shape of the frames decides the shape of the stage, so a portrait
    // project is previewed portrait rather than letterboxed into a widescreen
    // box that belongs to no project on the timeline.
    const shape = this.outgoing ?? this.incoming;
    if (shape && shape.width > 0 && shape.height > 0) {
      this.height = Math.max(2, Math.round((this.width * shape.height) / shape.width));
    }

    this.loading = false;
    this.cdr.detectChanges();
    this.play();
  }

  private play(): void {
    const canvas = this.stage?.nativeElement;
    if (!canvas) return;

    canvas.width = this.width;
    canvas.height = this.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    // Outside Angular: this runs on every animation frame for as long as the
    // dialog is open, and a change-detection pass per frame would cost more than
    // the whole animation does.
    this.zone.runOutsideAngular(() => {
      const step = (now: number) => {
        if (this.destroyed) return;

        if (!this.startedAt) this.startedAt = now;
        const cycle = this.seconds + HOLD * 2;
        const elapsed = ((now - this.startedAt) / 1000) % cycle;
        // Held at each end so the eye has somewhere to start and finish; the
        // middle is the transition itself, at the length the reader chose.
        const progress = Math.min(1, Math.max(0, (elapsed - HOLD) / this.seconds));

        this.painter.draw(context, this.kind, {
          outgoing: this.frameSource(this.outgoing),
          incoming: this.frameSource(this.incoming),
          width: this.width,
          height: this.height,
          progress,
          colour: this.colour
        });

        this.raf = requestAnimationFrame(step);
      };

      this.raf = requestAnimationFrame(step);
    });
  }

  private frameSource(frame: PreviewFrame | null) {
    if (!frame) return null;

    return {
      draw: (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) =>
        context.drawImage(frame.image, x, y, width, height),
      width: frame.width,
      height: frame.height
    };
  }
}

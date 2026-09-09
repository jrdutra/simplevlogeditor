/**
 * Where a clip's animated tag is designed.
 *
 * The whole dialog is one argument: a tag is a thing you *look* at, so the
 * settings sit beside a real frame of the reader's own clip with the tag playing
 * over it, on a loop, at the position they picked. Nothing here is described in
 * words that could be shown instead — the nine positions are a grid drawn on the
 * picture, the animation is the animation, and the only text is the labels on
 * the controls.
 *
 * The preview draws through {@link drawTag}, the same function the encoder uses,
 * for the same reason every other overlay in this tool does: a preview that has
 * its own idea of the picture is a decoration.
 */

import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Inject, Input, NgZone, OnDestroy, OnInit, Output, PLATFORM_ID, ViewChild } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { EditorClip } from './video-editor.models';
import { PreviewFrame, captureEdgeFrame, textCardStandIn } from './transition-preview';
import { drawTag } from './tag-renderer';
import { qrTagError } from './tag-qrcode';
import {
  ClipTag,
  DEFAULT_TAG,
  TAG_ANIMS,
  TAG_EXITS,
  TAG_FINISHES,
  TAG_FONTS,
  TAG_LIMITS,
  TAG_POSITIONS,
  TAG_POSITION_LABELS,
  TAG_SHAPES,
  TAG_SPECIAL_FAMILIES,
  TAG_TEXT_ANIMS,
  TagAnim,
  TagAnimGroup,
  TagExit,
  TagExitGroup,
  TagFinish,
  TagPosition,
  TagShape,
  TagSpecialDefinition,
  TagTextAnim,
  TagTextAnimGroup,
  clampTag,
  clampTagNumber,
  holdFromText,
  specialShape,
  shapeIsQr,
  specialsOf,
  tagHold,
  textAnimIsSelfPainting
} from './tag-overlay';

/** A pause at each end of the loop, so the reader sees the tag at rest too. */
const REST = 0.7;

interface Group<T> {
  group: string;
  items: readonly T[];
}

function groupBy<T extends { group: G }, G extends string>(
  items: readonly T[],
  order: readonly G[]
): Group<T>[] {
  return order.map((group) => ({ group, items: items.filter((item) => item.group === group) }));
}

@Component({
  selector: 'app-tag-dialog',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, BodyPortalDirective],
  templateUrl: './tag-dialog.component.html',
  styleUrls: ['./tag-dialog.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TagDialogComponent implements OnInit, OnDestroy {
  @Input({ required: true }) tag!: ClipTag;
  /** The clip the tag belongs to, so the preview can show a frame of it. */
  @Input() clip: EditorClip | null = null;
  @Input() heading = 'What does this tag look like?';
  /**
   * False for the project's template, which always exists.
   *
   * There is no "no template": it is what a new tag is made from, and a project
   * without one would leave the first badge with nothing to start from.
   */
  @Input() removable = true;

  @Output() readonly saved = new EventEmitter<ClipTag>();
  @Output() readonly removed = new EventEmitter<void>();
  @Output() readonly cancelled = new EventEmitter<void>();

  @ViewChild('stage') stage?: ElementRef<HTMLCanvasElement>;

  /** The tag being designed. A copy: cancelling has to leave the clip alone. */
  draft!: ClipTag;

  loading = true;
  width = 16;
  height = 9;

  readonly shapes = TAG_SHAPES;
  readonly finishes = TAG_FINISHES;
  readonly fonts = TAG_FONTS;
  readonly limits = TAG_LIMITS;
  readonly positions = TAG_POSITIONS;
  readonly positionLabels = TAG_POSITION_LABELS;

  readonly animGroups = groupBy<{ id: TagAnim; label: string; group: TagAnimGroup }, TagAnimGroup>(
    TAG_ANIMS, ['Entrance', 'Emphasis', '3D']
  );
  readonly exitGroups = groupBy<{ id: TagExit; label: string; group: TagExitGroup }, TagExitGroup>(
    TAG_EXITS, ['Simple', 'Movement', '3D']
  );
  readonly textGroups = groupBy<{ id: TagTextAnim; label: string; group: TagTextAnimGroup }, TagTextAnimGroup>(
    TAG_TEXT_ANIMS, ['Letter by letter', 'Whole line', 'Relief']
  );

  /** The finished designs, under the heading each one belongs to. */
  readonly specialGroups: Group<TagSpecialDefinition>[] = TAG_SPECIAL_FAMILIES.map((group) => ({
    group,
    items: specialsOf(group)
  }));

  private frame: PreviewFrame | null = null;
  private raf = 0;
  private startedAt = 0;
  private destroyed = false;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.draft = clampTag({ ...this.tag });
    void this.loadFrame();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.frame?.release();
    this.frame = null;
  }

  /* ------------------------------------------------------------- settings */

  /**
   * One change to the draft.
   *
   * Everything funnels through here so the clamp and the restart happen once
   * rather than in thirty handlers, and so the preview always shows a tag the
   * painter would accept.
   */
  patch(change: Partial<ClipTag>): void {
    this.draft = clampTag({ ...this.draft, ...change });
    this.restart();
  }

  onNumber(key: keyof ClipTag & string, value: string): void {
    const parsed = Number(value);
    this.patch({ [key]: clampTagNumber(key, parsed) } as Partial<ClipTag>);
  }

  /** Puts the text back in the middle of the tag, which is where it starts. */
  centreText(): void {
    this.patch({ textX: 0, textY: 0 });
  }

  onText(value: string): void {
    this.patch({ text: value });
  }

  onHold(value: string): void {
    // Typing in the field is the reader taking the number over; the automatic
    // one never comes back on its own after that.
    this.patch({ holdSeconds: clampTagNumber('holdSeconds', Number(value)), holdAuto: false });
  }

  onHoldAuto(auto: boolean): void {
    this.patch(auto ? { holdAuto: true, holdSeconds: holdFromText(this.draft.text) } : { holdAuto: false });
  }

  choose(position: TagPosition): void {
    this.patch({ position });
  }

  /**
   * Picking a shape, which for a finished design is picking a whole look.
   *
   * The design was drawn with a type size, a weight, a letter spacing, an ink
   * and a text animation of its own, and those are as much the design as its
   * colours are. Adopting them on the way in is what makes choosing one feel
   * like choosing the thing that was shown, rather than choosing a silhouette
   * and then having to guess the rest of it back.
   */
  onShape(value: string): void {
    const design = specialShape(value as TagShape);
    if (!design) {
      // Coming back the other way, the ink is the one thing worth undoing: a
      // design that wrote in its own dark colour would leave a built badge
      // writing in it too, on a face that was never meant to carry it.
      const wasSpecial = this.isSpecial;
      this.patch(wasSpecial
        ? { shape: value as TagShape, textColor: DEFAULT_TAG.textColor }
        : { shape: value as TagShape });
      return;
    }

    this.patch({
      shape: design.id,
      textColor: design.ink,
      weight: design.weight,
      tracking: design.tracking,
      textAnim: design.textAnim,
      fontScale: TAG_LIMITS['fontScale'].default
    });
  }

  /** The design behind the current shape, or nothing for a built badge. */
  get special(): TagSpecialDefinition | null {
    return specialShape(this.draft.shape);
  }

  get isSpecial(): boolean {
    return this.special !== null;
  }

  get isQr(): boolean {
    return shapeIsQr(this.draft.shape);
  }

  get qrError(): string | null {
    return this.isQr ? qrTagError(this.draft.qrText ?? '') : null;
  }

  /**
   * True when the tag leaves by itself, which decides whether a hold is a
   * number worth asking for. A finished design always does — its departure is
   * part of the drawing.
   */
  get endsOnItsOwn(): boolean {
    return this.isSpecial || this.draft.exit !== 'none';
  }

  get hold(): number {
    return tagHold(this.draft);
  }

  get textColourIgnored(): boolean {
    return textAnimIsSelfPainting(this.draft.textAnim);
  }

  /** Seconds one loop of the preview lasts. */
  get cycle(): number {
    const design = this.special;
    if (design) return REST + design.enter + this.hold + design.leave + REST;

    const tail = this.draft.exit === 'none' ? 1.4 : this.draft.exitSeconds;
    return REST + this.draft.animSeconds + this.hold + tail + REST;
  }

  /* -------------------------------------------------------------- outcome */

  apply(): void {
    if (this.qrError) return;
    this.saved.emit(clampTag(this.draft));
  }

  remove(): void {
    this.removed.emit();
  }

  close(): void {
    this.cancelled.emit();
  }

  /**
   * A tag nobody would have designed on purpose.
   *
   * Worth having for the same reason the studio has it: the catalogue is far
   * too large to work through a control at a time, and a random draw is how
   * most people find the two or three combinations they would never have
   * clicked on. The text and the timing are left alone — those are the
   * reader's, and rerolling them would be a different tool.
   */
  shuffle(): void {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
    const palette = ['#d32f2f', '#b8501f', '#1f6f5c', '#2f4f8f', '#8c2f5a', '#12181f', '#a8741a', '#5b3fa8', '#0d7a6f'];

    this.patch({
      color: pick(palette),
      shape: pick(this.shapes).id,
      finish: pick(this.finishes).id,
      position: pick(this.positions),
      anim: pick(TAG_ANIMS).id,
      textAnim: pick(TAG_TEXT_ANIMS).id,
      depth: Math.floor(Math.random() * 20)
    });
  }

  restart(): void {
    this.startedAt = 0;
    this.cdr.markForCheck();
  }

  /* -------------------------------------------------------------- preview */

  private async loadFrame(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      this.loading = false;
      return;
    }

    const clip = this.clip;
    if (clip) {
      this.frame = (await captureEdgeFrame(clip, 'in')) ?? textCardStandIn(clip, 1280, 720);
    }

    if (this.destroyed) {
      this.frame?.release();
      this.frame = null;
      return;
    }

    // The preview takes the shape of the clip's own picture when there is one,
    // because where a tag sits in a 9:16 frame is a different decision from
    // where it sits in a 16:9 one, and showing the wrong shape would move the
    // corners.
    if (this.frame && this.frame.width > 0 && this.frame.height > 0) {
      this.width = this.frame.width;
      this.height = this.frame.height;
    }

    this.loading = false;
    this.cdr.detectChanges();
    this.play();
  }

  private play(): void {
    const canvas = this.stage?.nativeElement;
    if (!canvas) return;

    // A fixed drawing size rather than the element's: the tag is measured in
    // shares of the frame height, so any height gives the same picture, and a
    // constant one keeps a dialog being resized from re-allocating the surface.
    const height = 480;
    const width = Math.round((height * this.width) / this.height);
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    // Outside Angular: a change detection pass per frame would cost more than
    // the animation itself, and nothing on screen depends on it.
    this.zone.runOutsideAngular(() => {
      const step = (now: number) => {
        if (this.destroyed) return;
        if (!this.startedAt) this.startedAt = now;

        const elapsed = ((now - this.startedAt) / 1000) % this.cycle;
        this.paint(context, width, height, elapsed - REST);
        this.raf = requestAnimationFrame(step);
      };

      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(step);
    });
  }

  private paint(context: CanvasRenderingContext2D, width: number, height: number, elapsed: number): void {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = 'none';
    context.fillStyle = '#05070c';
    context.fillRect(0, 0, width, height);

    const frame = this.frame;
    if (frame) {
      context.drawImage(frame.image, 0, 0, width, height);
    } else {
      // No picture to read — an audio-only clip, a file not handed back yet.
      // Mid grey rather than black, because a tag is judged against footage and
      // black flatters a light tag and hides a dark one.
      context.fillStyle = '#2a3140';
      context.fillRect(0, 0, width, height);
    }

    drawTag(context, this.draft, width, height, elapsed);
  }
}

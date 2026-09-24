import { Directive, ElementRef, Inject, OnDestroy, OnInit, Optional, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ToolVisibilityService } from './tool-visibility.service';

/**
 * Moves its host element to the end of `<body>` for as long as it exists.
 *
 * A modal is the one thing on a page that must be above everything else, and
 * `z-index` alone cannot promise that: a positioned ancestor with a `z-index`
 * of its own opens a stacking context, and every number inside it is then
 * compared with its siblings rather than with the page. The site's card
 * (`.mat-mdc-card-content { position: relative; z-index: 1 }`) is exactly such
 * an ancestor, which is why a dialog written with `z-index: 1200` was still
 * drawn underneath a menu bar sitting at 1000.
 *
 * Moving the node out of that subtree is the fix, and it is the same reason the
 * article export dialog attaches itself to `document.body`. Angular keeps
 * managing the element — bindings, events and change detection all continue to
 * work — because only its position in the DOM changes, not its place in the
 * view.
 */
@Directive({
  selector: '[appBodyPortal]',
  standalone: true
})
export class BodyPortalDirective implements OnInit, OnDestroy {
  private unregister?: () => void;
  constructor(
    private readonly host: ElementRef<HTMLElement>,
    @Inject(PLATFORM_ID) private readonly platformId: object,
    @Optional() private readonly visibility: ToolVisibilityService | null
  ) {}

  ngOnInit(): void {
    // Nothing to move while prerendering, and no `document` to move it into.
    if (!isPlatformBrowser(this.platformId)) return;
    document.body.appendChild(this.host.nativeElement);
    this.unregister = this.visibility?.register(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.unregister?.();
    // Angular removes the node through its real parent, so this is belt and
    // braces rather than a requirement — but a modal left behind by a missed
    // teardown would cover the whole page, and that is not a failure worth
    // risking to save three lines.
    this.host.nativeElement.remove();
  }
}

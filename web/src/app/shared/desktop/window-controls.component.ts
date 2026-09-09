import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DesktopService } from './desktop.service';

/**
 * The three lights, made to work.
 *
 * The site has always drawn a red, a yellow and a green disc at the right end
 * of its bar, because a page that looks like a window should have them. Inside
 * the desktop shell they are the window's actual buttons, in the order they are
 * ordered on a Mac — close, minimize, zoom — with the glyphs kept dark until
 * the pointer is over the group, which is how they behave there too.
 *
 * They are buttons and not clickable spans: this is the only way to close the
 * application, and it has to be reachable by keyboard, named for a screen
 * reader and focusable like anything else.
 */
@Component({
  selector: 'app-window-controls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lights no-drag" role="group" aria-label="Window">
      <button
        type="button"
        class="light light--close"
        title="Close"
        aria-label="Close window"
        (click)="desktop.close()">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.2 3.2 8.8 8.8M8.8 3.2 3.2 8.8" />
        </svg>
      </button>

      <button
        type="button"
        class="light light--minimize"
        title="Minimize"
        aria-label="Minimize window"
        (click)="desktop.minimize()">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.8 6h6.4" />
        </svg>
      </button>

      <button
        type="button"
        class="light light--zoom"
        [title]="desktop.maximized() ? 'Restore' : 'Maximize'"
        [attr.aria-label]="desktop.maximized() ? 'Restore window' : 'Maximize window'"
        [attr.aria-pressed]="desktop.maximized()"
        (click)="desktop.toggleMaximize()">
        @if (desktop.maximized()) {
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.2 2.4h2.4v2.4M4.8 9.6H2.4V7.2" />
          </svg>
        } @else {
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3h6v6H3z" />
          </svg>
        }
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        flex: none;
      }

      .lights {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }

      /* Same 14px disc the decorative version draws, so nothing moves when the
         site is opened in the shell instead of a tab. */
      .light {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        cursor: default;
        -webkit-app-region: no-drag;
        app-region: no-drag;
        transition: filter 120ms ease;
      }

      .light:hover {
        filter: brightness(1.12);
      }

      .light:active {
        filter: brightness(0.82);
      }

      .light:focus-visible {
        outline: 2px solid var(--neon-bright, #e88bff);
        outline-offset: 2px;
      }

      .light--close {
        background: radial-gradient(circle at 35% 25%, #ffaaa5, #ff5f57 62%, #c72f29);
        box-shadow: 0 0 8px rgba(255, 95, 87, 0.34), inset 0 1px 1px #ffd2cf;
      }

      .light--minimize {
        background: radial-gradient(circle at 35% 25%, #ffe39a, #febc2e 62%, #c58713);
        box-shadow: 0 0 8px rgba(254, 188, 46, 0.3), inset 0 1px 1px #fff0c4;
      }

      .light--zoom {
        background: radial-gradient(circle at 35% 25%, #8bea99, #28c840 62%, #168b2a);
        box-shadow: 0 0 8px rgba(40, 200, 64, 0.3), inset 0 1px 1px #c5f8cc;
      }

      /* The glyph belongs to the group, not to the button: hovering any one of
         the three reveals all three, which is what tells you they are controls
         and not decoration. */
      .light svg {
        width: 9px;
        height: 9px;
        opacity: 0;
        transition: opacity 110ms ease;
      }

      .light path {
        fill: none;
        stroke: rgba(30, 12, 6, 0.72);
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .lights:hover .light svg,
      .light:focus-visible svg {
        opacity: 1;
      }

      @media (prefers-reduced-motion: reduce) {
        .light,
        .light svg {
          transition: none;
        }
      }
    `
  ]
})
export class WindowControlsComponent {
  constructor(readonly desktop: DesktopService) {}
}

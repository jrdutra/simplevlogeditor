import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HelpPanelComponent } from './help-panel.component';

/**
 * Who made this, and where the code is.
 *
 * Mounted beside the privacy notice rather than on any page, for the same
 * reason: it says the same thing everywhere. Both are hidden inside the desktop
 * application, where the reader already has the thing these links would take
 * them to.
 */
@Component({
  selector: 'app-about-panel',
  standalone: true,
  imports: [HelpPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-help-panel kind="about" label="About">
      <div class="instrucoes">
        <section class="seo-intro">
          <h2>SimpleVlogEditor</h2>
          <p>A video editor that runs entirely on your own machine — in this page, or in the
            desktop application — and that an AI client can drive through a local MCP server.
            It is open source.</p>
        </section>

        <h2>The code</h2>
        <p>Everything described in these pages is in the repository: the editor, the desktop
          shell, the MCP server and the two AI plugins.</p>
        <p>
          <a class="sobre-link sobre-link--github" href="https://github.com/jrdutra"
            target="_blank" rel="noopener noreferrer">
            <span class="sobre-link__mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="18" height="18"><path fill="currentColor" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>
            </span>
            <span>
              <strong>github.com/jrdutra</strong>
              <em>Source, issues and releases</em>
            </span>
          </a>
        </p>

        <h2>The author</h2>
        <p>João Ricardo Dutra.</p>
        <p>
          <a class="sobre-link sobre-link--linkedin" href="https://www.linkedin.com/in/joao-ricardo-dutra/"
            target="_blank" rel="noopener noreferrer">
            <span class="sobre-link__mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="18" height="18"><path fill="currentColor" d="M3.4 1.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM1.9 6h3v8.7h-3V6Zm5 0h2.87v1.19h.04c.4-.72 1.38-1.48 2.84-1.48 3.04 0 3.6 1.9 3.6 4.38v4.61h-3v-4.09c0-.97-.02-2.23-1.41-2.23-1.41 0-1.63 1.06-1.63 2.16v4.16h-3V6Z"/></svg>
            </span>
            <span>
              <strong>linkedin.com/in/joao-ricardo-dutra</strong>
              <em>Professional profile</em>
            </span>
          </a>
        </p>
      </div>
    </app-help-panel>
  `
})
export class AboutPanelComponent {}

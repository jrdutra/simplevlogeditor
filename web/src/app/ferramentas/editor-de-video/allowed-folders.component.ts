import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';

import { DesktopService, MissingRoot, RootSource } from '../../shared/desktop/desktop.service';

/**
 * The folders the editor may use, and the one place it asks for another.
 *
 * Two jobs, one component, because they are the same subject seen from two
 * sides: the list is what the user already allowed, and the request is how one
 * more gets added. Keeping them together means the user who is asked for a
 * folder can see, in the same window, everything they have allowed so far.
 *
 * Nothing here grants anything. The native folder picker does, in the
 * application process; this only explains what is being asked for and why.
 */
@Component({
  selector: 'app-allowed-folders',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './allowed-folders.component.css',
  template: `
    @if (request) {
      <div class="pastas-fundo" role="presentation">
        <section class="pastas-modal" role="dialog" aria-modal="true" aria-labelledby="pastas-titulo">
          <header>
            <strong id="pastas-titulo">{{ asking }} wants to use a folder</strong>
            <p>
              To {{ request.reason || 'read this file' }}, the editor needs access to
              <code>{{ request.folder }}</code>.
            </p>
            <p class="pastas-arquivo">{{ request.path }}</p>
          </header>

          <fieldset class="pastas-escopo">
            <legend>What to allow</legend>
            <label>
              <input type="radio" name="escopo" value="exact" [checked]="scope() === 'exact'"
                (change)="scope.set('exact')">
              <span>
                <strong>Only this folder</strong>
                <em>{{ request.folder }}</em>
              </span>
            </label>
            <label>
              <input type="radio" name="escopo" value="wider" [checked]="scope() === 'wider'"
                (change)="scope.set('wider')">
              <span>
                <strong>A folder above it, which I will choose</strong>
                <em>Useful when the media is spread across subfolders — your whole Videos folder, say.</em>
              </span>
            </label>
          </fieldset>

          @if (error()) {
            <p class="pastas-erro" role="alert">{{ error() }}</p>
          }

          <footer>
            <button type="button" class="pastas-secundario" (click)="deny()" [disabled]="busy()">Don't allow</button>
            <button type="button" class="pastas-primario" (click)="allow()" [disabled]="busy()">
              {{ busy() ? 'Waiting for your choice…' : 'Allow…' }}
            </button>
          </footer>
          <p class="pastas-nota">
            Choosing "Allow…" opens your system's folder picker. What you pick there is what gets
            allowed — the editor cannot widen it afterwards.
          </p>
        </section>
      </div>
    }

    @if (showList) {
      <section class="pastas-lista">
        <header>
          <div>
            <strong>Allowed folders</strong>
            <span>
              The editor can read media from these and write exports into them — from this window and
              from an AI client alike. Nothing outside them is reachable.
            </span>
          </div>
          <button type="button" class="pastas-primario" (click)="add()" [disabled]="busy()">Add folder…</button>
        </header>

        @if (state().overridden) {
          <p class="pastas-aviso">
            SVE_MCP_ROOTS is set in this environment, so the default media folders stand down and
            that list is in force. Folders you allow here still apply.
          </p>
        }

        @if (!state().entries.length) {
          <p class="pastas-vazio">No folder is allowed yet. Add one, or open a file — choosing it allows its folder.</p>
        }

        <ul>
          @for (entry of state().entries; track entry.path) {
            <li>
              <span class="pastas-caminho" [title]="entry.path">{{ entry.path }}</span>
              <span class="pastas-origem" [class]="'origem-' + entry.source">{{ originLabel(entry.source) }}</span>
              <button type="button" class="pastas-remover" (click)="remove(entry.path)"
                [attr.aria-label]="'Remove ' + entry.path">Remove</button>
            </li>
          }
        </ul>

        @if (state().refusedByPolicy.length) {
          <p class="pastas-aviso">
            Refused as system locations, whatever asked for them: {{ state().refusedByPolicy.join('; ') }}
          </p>
        }
      </section>
    }
  `
})
export class AllowedFoldersComponent {
  private readonly desktop = inject(DesktopService);

  /** The pending request, or null when only the list is on screen. */
  @Input() request: (MissingRoot & { reason?: string }) | null = null;
  /** Which client is asking, for the dialog's first line. */
  @Input() asking = 'The editor';
  @Input() showList = true;

  /** The folder that was allowed, or null when the user declined. */
  @Output() readonly resolved = new EventEmitter<string | null>();

  readonly state = this.desktop.roots;
  readonly scope = signal<'exact' | 'wider'>('exact');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  originLabel(source: RootSource): string {
    return source === 'consent' ? 'you allowed'
      : source === 'defaults' ? 'default'
        : source === 'env' ? 'SVE_MCP_ROOTS'
          : 'AI client session';
  }

  async allow(): Promise<void> {
    if (!this.request || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      // Either way the native picker decides. "Only this folder" merely opens
      // it already positioned there; the user can still move somewhere else,
      // and wherever they land is checked against what was asked for.
      const result = await this.desktop.requestRootConsent({
        path: this.request.path,
        folder: this.scope() === 'exact' ? this.request.folder : this.parentOf(this.request.folder)
      });
      if (!result) { this.resolved.emit(null); return; }
      if (result.granted) { this.resolved.emit(result.granted); return; }
      if (result.code === 'path_consent_denied') { this.resolved.emit(null); return; }
      this.error.set(result.message || 'That folder could not be allowed.');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  deny(): void {
    this.resolved.emit(null);
  }

  async add(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try { await this.desktop.addRoot(); }
    finally { this.busy.set(false); }
  }

  async remove(folder: string): Promise<void> {
    await this.desktop.removeRoot(folder);
  }

  private parentOf(folder: string): string {
    const separator = folder.includes('\\') ? '\\' : '/';
    const at = folder.lastIndexOf(separator);
    return at > 0 ? folder.slice(0, at) : folder;
  }
}

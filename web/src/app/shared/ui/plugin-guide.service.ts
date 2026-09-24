import { Injectable, signal } from '@angular/core';

export type PluginGuideClient = 'codex' | 'claude';

/** Shared state for the installation guide opened from any page. */
@Injectable({ providedIn: 'root' })
export class PluginGuideService {
  readonly client = signal<PluginGuideClient | null>(null);
  readonly repositoryCopied = signal(false);

  open(client: PluginGuideClient): void {
    this.repositoryCopied.set(false);
    this.client.set(client);
  }

  close(): void {
    this.client.set(null);
    this.repositoryCopied.set(false);
  }

  setRepositoryCopied(copied: boolean): void {
    this.repositoryCopied.set(copied);
  }
}

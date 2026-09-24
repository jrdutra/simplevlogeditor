import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { AgentSystemEvent, DesktopService } from '../desktop/desktop.service';

export type AgentActivityKind = 'command' | 'action' | 'done' | 'fail';
export type AgentActivityLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface AgentActivityLine {
  seq: number;
  timestamp: string;
  level: AgentActivityLevel;
  module: string;
  kind: AgentActivityKind;
  text: string;
  percent: number | null;
}

@Injectable({ providedIn: 'root' })
export class AgentActivityService {
  private readonly desktop = inject(DesktopService);
  private readonly linesValue = signal<readonly AgentActivityLine[]>([]);
  private readonly openValue = signal(true);
  private readonly dismissedValue = signal(false);
  private readonly activeOperations = signal(0);
  private readonly suspended = signal(false);
  readonly diagnostic = signal<{ incidentId: string; summary: string; fullText: string; retryable: boolean } | null>(null);
  private retryAction: (() => Promise<void>) | null = null;
  private seq = 0;

  readonly lines = computed(() => this.linesValue());
  readonly open = computed(() => this.openValue() && !this.suspended());
  readonly dismissed = computed(() => this.dismissedValue());
  readonly working = computed(() => this.activeOperations() > 0);

  constructor() {
    const destroy = inject(DestroyRef);
    destroy.onDestroy(this.desktop.onAgentSystemEvent((entry) => this.fromSystem(entry)));
    destroy.onDestroy(this.desktop.onAgentConnected(() => {
      this.dismissedValue.set(false);
      this.openValue.set(true);
    }));
  }

  begin(): void {
    this.activeOperations.update((count) => count + 1);
  }

  suspendForStylePicker(open: boolean): void { this.suspended.set(open); }

  setDiagnostic(value: { incidentId: string; summary: string; fullText: string; retryable: boolean }, retry: () => Promise<void>): void {
    this.diagnostic.set(value);
    this.retryAction = retry;
  }

  async retry(): Promise<void> {
    if (!this.working() && this.diagnostic()?.retryable) await this.retryAction?.();
  }

  end(): void {
    this.activeOperations.update((count) => Math.max(0, count - 1));
  }

  append(
    kind: AgentActivityKind,
    text: string,
    module = 'Editor',
    level: AgentActivityLevel = kind === 'fail' ? 'ERROR' : 'INFO',
    timestamp = new Date().toISOString(),
    percent: number | null = null
  ): void {
    const next: AgentActivityLine = {
      seq: this.seq++,
      timestamp: this.formatTimestamp(timestamp),
      level,
      module,
      kind,
      text,
      percent: percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, Math.round(percent)))
    };
    this.linesValue.update((lines) => [...lines.slice(-499), next]);
  }

  show(): void { this.dismissedValue.set(false); this.openValue.set(true); }
  minimize(): void { this.dismissedValue.set(false); this.openValue.set(false); }
  dismiss(): void { this.dismissedValue.set(true); this.openValue.set(false); }
  clear(): void { if (!this.working()) this.linesValue.set([]); }

  setView(view: 'open' | 'minimized' | 'hidden'): { view: string } {
    if (view === 'open') this.show();
    else if (view === 'minimized') this.minimize();
    else this.dismiss();
    return { view };
  }

  private fromSystem(entry: AgentSystemEvent): void {
    const kind: AgentActivityKind = entry.level === 'ERROR' ? 'fail' : entry.level === 'WARN' ? 'action' : 'done';
    this.append(kind, entry.message, entry.module || 'MCP bridge', entry.level, entry.timestamp);
  }

  private formatTimestamp(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    const part = (number: number, width = 2) => String(number).padStart(width, '0');
    return `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}.${part(date.getMilliseconds(), 3)}`;
  }
}

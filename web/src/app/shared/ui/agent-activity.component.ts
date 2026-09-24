import { AfterViewChecked, Component, ElementRef, ViewChild, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { DesktopService } from '../desktop/desktop.service';
import { AgentActivityKind, AgentActivityService } from './agent-activity.service';

@Component({
  selector: 'app-agent-activity',
  standalone: true,
  imports: [MatIconModule, MatProgressBarModule],
  templateUrl: './agent-activity.component.html',
  styleUrl: './agent-activity.component.css'
})
export class AgentActivityComponent implements AfterViewChecked {
  @ViewChild('console') private console?: ElementRef<HTMLDivElement>;
  /** The sequence number of the last line scrolled to; -1 so the very first line (seq 0) counts. */
  private lastCount = -1;
  private following = true;
  readonly diagnosticMessage = signal('');

  constructor(readonly desktop: DesktopService, readonly activity: AgentActivityService) {}

  get controller(): { label: string; icon: string; theme: string } {
    const id = this.desktop.agentControl().controller;
    if (id === 'claude-code') return { label: 'Claude Code', icon: '/assets/icons/claude-mark.svg', theme: 'agent-activity--claude' };
    return { label: id === 'chatgpt' ? 'ChatGPT' : id === 'codex' ? 'Codex' : 'AI client', icon: '/assets/icons/codex-mark.svg', theme: 'agent-activity--codex' };
  }

  ngAfterViewChecked(): void {
    const count = this.activity.lines().at(-1)?.seq ?? -1;
    if (count === this.lastCount) return;
    this.lastCount = count;
    const console = this.console?.nativeElement;
    if (console && this.following) console.scrollTop = console.scrollHeight;
  }

  onScroll(): void {
    const node = this.console?.nativeElement;
    if (node) this.following = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  async copyDiagnostic(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.activity.diagnostic()?.fullText ?? '');
      this.diagnosticMessage.set('Diagnostic copied.');
    } catch { this.diagnosticMessage.set('Could not copy. Use Save diagnostic.'); }
  }

  saveDiagnostic(): void {
    const diagnostic = this.activity.diagnostic();
    if (!diagnostic) return;
    const url = URL.createObjectURL(new Blob([diagnostic.fullText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `simplevlogeditor-diagnostic-${diagnostic.incidentId}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  mark(kind: AgentActivityKind): string {
    return kind === 'command' ? '$' : kind === 'action' ? '>' : kind === 'done' ? '*' : 'x';
  }
}

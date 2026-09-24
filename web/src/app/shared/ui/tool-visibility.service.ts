import { Injectable } from '@angular/core';

/** Scoped to a retained tool, including its dialogs portalled outside the outlet. */
@Injectable()
export class ToolVisibilityService {
  private active = true;
  private readonly hosts = new Map<HTMLElement, string>();
  register(host: HTMLElement): () => void {
    this.hosts.set(host, host.style.display);
    if (!this.active) host.style.display = 'none';
    return () => this.hosts.delete(host);
  }
  setActive(active: boolean): void {
    this.active = active;
    for (const [host, display] of this.hosts) host.style.display = active ? display : 'none';
  }
}

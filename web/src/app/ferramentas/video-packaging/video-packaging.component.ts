import { Component, computed, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

import { DesktopService } from '../../shared/desktop/desktop.service';
import { PluginGuideService } from '../../shared/ui/plugin-guide.service';
import { ThumbnailResult, VideoPackagingService } from './video-packaging.service';

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
}

@Component({
  selector: 'app-video-packaging',
  standalone: true,
  imports: [MatIconModule, RouterLink],
  templateUrl: './video-packaging.component.html',
  styleUrl: '../under-construction-tool.css'
})
export class VideoPackagingComponent {
  readonly copiedItem = signal<string | null>(null);
  readonly savingThumbnail = signal<number | null>(null);
  /** Said on the page when copying or saving fails, instead of failing silently. */
  readonly actionError = signal<string | null>(null);

  readonly thumbnailOptions = this.content.options;
  readonly videoDescription = this.content.description;
  readonly hasDescription = this.content.hasDescription;
  readonly videoTags = this.content.tagsText;
  /**
   * The working layout is for a connected assistant — and for a package that
   * one already delivered. Hiding real covers because the session has since
   * closed would be the tool losing the reader's work in front of them.
   */
  readonly showBuilder = computed(() => this.desktop.agentControl().active || this.content.hasContent());

  constructor(
    readonly desktop: DesktopService,
    readonly pluginGuide: PluginGuideService,
    readonly content: VideoPackagingService
  ) {}

  get coverActionLabel(): string {
    return this.desktop.isDesktop ? 'Save cover' : 'Download cover';
  }

  // ------------------------------------------------------------- the tag style

  /**
   * Off: every run uses the saved style. On: the assistant opens the picker
   * before it draws anything. The choice is remembered across restarts.
   */
  chooseStyle(): void {
    this.content.openStylePicker();
  }

  // ------------------------------------------------------------ the deliverables

  async copyText(text: string, item: string): Promise<void> {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // The old mechanism answers whether it worked; that answer is the only
      // thing allowed to say "Copied".
      const field = document.createElement('textarea');
      field.value = text;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      field.remove();
    }

    if (!copied) {
      this.actionError.set('Could not copy to the clipboard. Select the text and copy it by hand.');
      return;
    }
    this.actionError.set(null);
    this.copiedItem.set(item);
    window.setTimeout(() => {
      if (this.copiedItem() === item) this.copiedItem.set(null);
    }, 1800);
  }

  async saveThumbnail(option: ThumbnailResult): Promise<void> {
    if (!option.image || this.savingThumbnail() !== null) return;
    this.savingThumbnail.set(option.id);

    try {
      this.actionError.set(null);
      const blob = option.image;
      if (!blob.size) throw new Error('This cover has no image data. Ask the assistant to deliver it again.');
      const extension = this.extensionFor(blob.type);
      const fileName = `video-cover-${option.id}.${extension}`;

      if (this.desktop.isDesktop && await this.saveWithDesktopPicker(blob, fileName, extension)) return;
      this.download(blob, fileName);
    } catch (error) {
      this.actionError.set(`Cover ${option.id} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.savingThumbnail.set(null);
    }
  }

  private async saveWithDesktopPicker(blob: Blob, fileName: string, extension: string): Promise<boolean> {
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
    if (typeof picker !== 'function') return false;

    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: 'Cover image', accept: { [blob.type || 'image/png']: [`.${extension}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return true;
      throw error;
    }
  }

  private download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private extensionFor(mimeType: string): string {
    if (mimeType.includes('jpeg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('gif')) return 'gif';
    return 'png';
  }
}

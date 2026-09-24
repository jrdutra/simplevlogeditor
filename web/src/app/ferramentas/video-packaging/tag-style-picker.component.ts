import { Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { CUSTOM_TAG_STYLE_ID, VideoPackagingService } from './video-packaging.service';

/**
 * Choosing the lettering the covers will copy.
 *
 * It is rendered once, by the application shell, so it can appear over the
 * editor and over the tool alike — a packaging run waits on this answer, and
 * where the reader happens to be standing should not decide whether they are
 * asked.
 */
@Component({
  selector: 'app-tag-style-picker',
  standalone: true,
  imports: [MatIconModule, BodyPortalDirective],
  templateUrl: './tag-style-picker.component.html',
  styleUrl: './tag-style-picker.component.css'
})
export class TagStylePickerComponent {
  readonly customId = CUSTOM_TAG_STYLE_ID;
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor(readonly packaging: VideoPackagingService) {}

  get waiting(): boolean {
    return this.packaging.pickerReason() === 'agent';
  }

  get askEveryTime(): boolean {
    return this.packaging.styleMode() === 'ask';
  }

  toggleAsk(checked: boolean): void {
    this.packaging.setStyleMode(checked ? 'ask' : 'default');
  }

  choose(id: string): void {
    this.error.set(null);
    try {
      this.packaging.chooseStyle(id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'That style could not be used.');
    }
  }

  close(): void {
    this.packaging.cancelStylePicker();
  }

  /** The reader's own sheet, kept by the application until they replace it. */
  async load(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.packaging.setCustomStyleFile(file);
      this.packaging.chooseStyle(CUSTOM_TAG_STYLE_ID);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'That image could not be used.');
    } finally {
      this.busy.set(false);
    }
  }

  async removeCustom(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.packaging.removeCustomStyle();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Your style could not be removed.');
    } finally {
      this.busy.set(false);
    }
  }
}

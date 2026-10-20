import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, ViewChild, signal } from '@angular/core';
import { DesktopService, DesktopUpdateNotice } from './desktop.service';

@Component({
  selector: 'app-update-notice',
  standalone: true,
  templateUrl: './update-notice.component.html',
  styleUrl: './update-notice.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UpdateNoticeComponent implements AfterViewInit, OnDestroy {
  @ViewChild('dialog', { static: true }) private dialog!: ElementRef<HTMLDialogElement>;
  readonly notice = signal<DesktopUpdateNotice | null>(null);
  readonly opening = signal(false);
  readonly error = signal('');
  private destroyed = false;

  constructor(private readonly desktop: DesktopService, private readonly zone: NgZone,
    private readonly changeDetector: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    if (!this.desktop.isDesktop) return;
    void this.desktop.getUpdateNotice().then(notice => {
      if (!notice || this.destroyed) return;
      this.zone.run(() => {
        this.notice.set(notice);
        this.changeDetector.detectChanges();
        // The native dialog contains keyboard focus and restores it on close.
        this.dialog.nativeElement.showModal();
      });
    }).catch(() => {});
  }

  dismiss(event?: Event): void {
    event?.preventDefault();
    this.dialog.nativeElement.close();
    this.notice.set(null);
    void this.desktop.dismissUpdateNotice();
  }

  async openDownload(): Promise<void> {
    if (this.opening()) return;
    this.opening.set(true);
    this.error.set('');
    try {
      if (!await this.desktop.openUpdatePage()) throw new Error('Download page unavailable');
      if (!this.destroyed) this.zone.run(() => this.dismiss());
    } catch {
      if (!this.destroyed) this.zone.run(() => this.error.set('Could not open the download page. Please try again.'));
    } finally {
      if (!this.destroyed) this.zone.run(() => this.opening.set(false));
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.dialog.nativeElement.close();
  }
}

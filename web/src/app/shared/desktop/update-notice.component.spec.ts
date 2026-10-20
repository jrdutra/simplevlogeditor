import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DesktopService } from './desktop.service';
import { UpdateNoticeComponent } from './update-notice.component';

describe('desktop update notice', () => {
  let fixture: ComponentFixture<UpdateNoticeComponent>;
  let desktop: { isDesktop: boolean; getUpdateNotice: jasmine.Spy; dismissUpdateNotice: jasmine.Spy; openUpdatePage: jasmine.Spy };
  beforeEach(async () => {
    desktop = {
      isDesktop: true,
      getUpdateNotice: jasmine.createSpy().and.resolveTo({ installed: '2.1.1', published: '2.1.2', updateUrl: 'https://simplevlogeditor.com/' }),
      dismissUpdateNotice: jasmine.createSpy().and.resolveTo(),
      openUpdatePage: jasmine.createSpy().and.resolveTo(true)
    };
    await TestBed.configureTestingModule({ imports: [UpdateNoticeComponent], providers: [{ provide: DesktopService, useValue: desktop }] }).compileComponents();
    fixture = TestBed.createComponent(UpdateNoticeComponent);
  });
  async function render(): Promise<HTMLDialogElement> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('dialog');
  }

  it('shows both versions in a modal and lets Later dismiss it', async () => {
    const dialog = await render();
    expect(dialog.open).toBeTrue();
    expect(dialog.textContent).toContain('v2.1.1');
    expect(dialog.textContent).toContain('v2.1.2');
    (dialog.querySelector('.update-modal__later') as HTMLButtonElement).click();
    expect(dialog.open).toBeFalse();
    expect(desktop.dismissUpdateNotice).toHaveBeenCalledTimes(1);
  });
  it('supports Escape without opening the download page', async () => {
    const dialog = await render();
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(dialog.open).toBeFalse();
    expect(desktop.dismissUpdateNotice).toHaveBeenCalledTimes(1);
    expect(desktop.openUpdatePage).not.toHaveBeenCalled();
  });
  it('opens the download page only on request and closes the notice', async () => {
    const dialog = await render();
    expect(desktop.openUpdatePage).not.toHaveBeenCalled();
    await fixture.componentInstance.openDownload();
    expect(desktop.openUpdatePage).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBeFalse();
  });
  it('keeps the modal available when opening the browser fails', async () => {
    desktop.openUpdatePage.and.rejectWith(new Error('offline'));
    const dialog = await render();
    await fixture.componentInstance.openDownload();
    fixture.detectChanges();
    expect(dialog.open).toBeTrue();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Please try again');
    expect(desktop.dismissUpdateNotice).not.toHaveBeenCalled();
  });
  it('stays hidden when the installed version is current or the check is unavailable', async () => {
    desktop.getUpdateNotice.and.resolveTo(null);
    expect((await render()).open).toBeFalse();
  });
  it('does not check for desktop updates in a web browser', async () => {
    desktop.isDesktop = false;
    expect((await render()).open).toBeFalse();
    expect(desktop.getUpdateNotice).not.toHaveBeenCalled();
  });
  it('ignores a version response arriving after the component was destroyed', async () => {
    let resolve!: (notice: unknown) => void;
    desktop.getUpdateNotice.and.returnValue(new Promise(done => resolve = done));
    fixture.detectChanges();
    fixture.destroy();
    resolve({ installed: '2.1.1', published: '2.1.2' });
    await Promise.resolve();
    expect(fixture.componentInstance.notice()).toBeNull();
  });
});

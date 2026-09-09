import { ChangeDetectorRef } from '@angular/core';
import { DataService } from '../../data.service';
import { TranscricaoDeVideoComponent } from './transcricao-de-video.component';

describe('transcript review', () => {
  let component: TranscricaoDeVideoComponent;
  beforeEach(() => {
    component = new TranscricaoDeVideoComponent({ setTituloAplicacao: () => {} } as unknown as DataService,
      { markForCheck: () => {} } as ChangeDetectorRef, 'browser' as unknown as object);
    component.mediaDuration = 10;
    component.cues = [{ start: 0, end: 2, text: 'Incorrect name' }, { start: 3, end: 5, text: 'Next caption' }];
  });
  it('preserves manual corrections when reshaping and exporting', () => {
    component.editCue(0, 'text', 'Correct name');
    component.onShape('lineLength', '20');
    expect(component.preview).toContain('Correct name');
    expect(component.preview).not.toContain('Incorrect');
  });
  it('rejects overlapping times and times outside the recording', () => {
    component.editCue(0, 'end', '4');
    expect(component.cues[0].end).toBe(2);
    component.editCue(1, 'end', '11');
    expect(component.cues[1].end).toBe(5);
  });
  it('edits the correct caption on subsequent pages', () => {
    component.cues = Array.from({ length: 51 }, (_, index) => ({ start: index, end: index + 0.5, text: `Caption ${index}` }));
    component.page = 1;
    component.editCue(0, 'text', 'Last caption');
    expect(component.cues[50].text).toBe('Last caption');
    expect(component.cues[0].text).toBe('Caption 0');
  });
  it('keeps minimum and maximum duration controls consistent', () => {
    component.onShape('maxSeconds', '2');
    component.onShape('minSeconds', '4');
    expect(component.shape.maxSeconds).toBe(4);
  });
  it('prevents edits while partial recognition is updating captions', () => {
    component.working = true;
    component.editCue(0, 'text', 'Lost edit');
    expect(component.cues[0].text).toBe('Incorrect name');
  });
});

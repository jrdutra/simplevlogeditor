import { EditorDeVideoComponent } from '../editor-de-video/editor-de-video.component';
import { DesktopService } from '../../shared/desktop/desktop.service';
import { VideoPackagingService } from './video-packaging.service';

describe('deterministic cover background preparation', () => {
  async function fixture() {
    const source = document.createElement('canvas');
    source.width = 160; source.height = 90;
    const context = source.getContext('2d')!;
    context.fillStyle = 'rgb(40,40,40)'; context.fillRect(0, 0, 160, 90);
    const blob = await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/png'));
    const file = new File([blob], 'frame.png', { type: 'image/png' });
    const written: Uint8Array[] = [];
    let fingerprint = 'edit-a';
    const desktop = { readAgentFiles: async () => [file], ensureAgentFolder: async () => {} };
    const packaging = new VideoPackagingService(desktop as unknown as DesktopService);
    packaging.registerEditFingerprint(() => fingerprint);
    packaging.recordFrames([{ path: 'C:\\frames\\frame.png', clipId: 'a', timestamp: 10,
      width: 160, height: 90, outputTime: 8, composited: true, editFingerprint: 'edit-a' }]);
    const editor: any = Object.create(EditorDeVideoComponent.prototype);
    Object.assign(editor, { packaging, desktop, ensurePackagingFolder: async () => 'C:\\packaging',
      writePackagingFile: async (_folder: string, _name: string, bytes: Uint8Array) => {
        written.push(bytes); return 'C:\\backgrounds\\frame-colour.png';
      } });
    return { editor, packaging, written, file, changeEdit: () => fingerprint = 'edit-b' };
  }

  it('writes a decodable corrected PNG with the original geometry and records its provenance', async () => {
    const { editor, packaging, written, file } = await fixture();
    const original = new Uint8Array(await file.arrayBuffer());
    const result = await editor.agentPreparePackagingBackground({ sourceFramePath: 'c:/frames/frame.png' }, new AbortController().signal);
    expect(result.sourceTimestamp).toBe(8);
    expect(result.sourceFramePath).toBe('c:/frames/frame.png');
    expect(written.length).toBe(1);
    const bitmap = await createImageBitmap(new Blob([written[0]], { type: 'image/png' }));
    try {
      expect([bitmap.width, bitmap.height]).toEqual([160, 90]);
      const output = document.createElement('canvas'); output.width = 160; output.height = 90;
      const context = output.getContext('2d')!; context.drawImage(bitmap, 0, 0);
      const pixel = context.getImageData(80, 45, 1, 1).data;
      expect(pixel[0]).toBeGreaterThan(40);
      expect(pixel[0]).toBe(pixel[1]); expect(pixel[1]).toBe(pixel[2]);
      expect(pixel[3]).toBe(255);
    } finally { bitmap.close(); }
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(original);
    expect(packaging.currentFrames()[0].preparedBackground?.path).toBe(result.path);
  });

  it('does not write a background after cancellation or an edit change during reading', async () => {
    const { editor, written, changeEdit } = await fixture();
    const controller = new AbortController(); controller.abort();
    await expectAsync(editor.agentPreparePackagingBackground({ sourceFramePath: 'C:\\frames\\frame.png' }, controller.signal)).toBeRejected();
    expect(written.length).toBe(0);
    const read = editor.desktop.readAgentFiles;
    editor.desktop.readAgentFiles = async () => { changeEdit(); return read(); };
    await expectAsync(editor.agentPreparePackagingBackground({ sourceFramePath: 'C:\\frames\\frame.png' }, new AbortController().signal)).toBeRejected();
    expect(written.length).toBe(0);
  });

  it('gives replaced custom lettering with the same name a different reference path', async () => {
    let style: any = { source: 'custom', id: 'custom', name: 'my-style.png', blob: new Blob(['first']), description: '' };
    const editor: any = Object.create(EditorDeVideoComponent.prototype);
    Object.assign(editor, {
      packaging: { ensureStyleChosen: async () => style, tagStyle: () => style,
        tagStyleBytes: async () => style.blob, rememberTagStylePath: () => {}, styleMode: () => 'default', styles: [] },
      desktop: { ensureAgentFolder: async () => {} }, ensurePackagingFolder: async () => 'C:\\packaging',
      writePackagingFile: async (folder: string, name: string) => `${folder}/${name}`
    });
    const first = await editor.agentPackagingTagStyle();
    style = { ...style, blob: new Blob(['replacement']) };
    const second = await editor.agentPackagingTagStyle();
    expect(first.id).toBe(second.id);
    expect(first.path).not.toBe(second.path);
    expect((await editor.agentPackagingTagStyle()).path).toBe(second.path);
  });
});

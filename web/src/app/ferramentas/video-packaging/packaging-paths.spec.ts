import {
  bytesFromDataUrl,
  extensionForMime,
  folderOf,
  joinPath,
  nameOf,
  packagingFolderFor,
  safeStem,
  samePath,
  stampOf
} from './packaging-paths';

describe('packaging paths', () => {
  it('keeps a Windows path a Windows path', () => {
    expect(packagingFolderFor('C:\\Users\\jo\\Videos\\trip\\day-1.mp4'))
      .toBe('C:\\Users\\jo\\Videos\\trip\\video-packaging');
    expect(joinPath('C:\\Users\\jo\\Videos\\trip\\video-packaging', 'frames'))
      .toBe('C:\\Users\\jo\\Videos\\trip\\video-packaging\\frames');
  });

  it('keeps a POSIX path a POSIX path', () => {
    expect(packagingFolderFor('/home/jo/videos/trip/day-1.mp4'))
      .toBe('/home/jo/videos/trip/video-packaging');
    expect(joinPath('/home/jo/videos/trip/video-packaging', 'covers', 'a.png'))
      .toBe('/home/jo/videos/trip/video-packaging/covers/a.png');
  });

  it('splits a path either way round', () => {
    expect(folderOf('C:\\a\\b\\c.mp4')).toBe('C:\\a\\b');
    expect(folderOf('/a/b/c.mp4')).toBe('/a/b');
    expect(nameOf('C:\\a\\b\\c.mp4')).toBe('c.mp4');
    expect(nameOf('/a/b/c.mp4')).toBe('c.mp4');
    expect(nameOf('c.mp4')).toBe('c.mp4');
  });

  it('keeps the root for a file that sits at the root', () => {
    expect(folderOf('C:\\clip.mp4')).toBe('C:\\');
    expect(folderOf('/clip.mp4')).toBe('/');
    expect(folderOf('clip.mp4')).toBe('.');
    expect(packagingFolderFor('C:\\clip.mp4')).toBe('C:\\video-packaging');
    expect(packagingFolderFor('/clip.mp4')).toBe('/video-packaging');
  });

  it('treats two spellings of one Windows file as the same file', () => {
    expect(samePath('C:\\Videos\\Frames\\a.jpg', 'c:/videos/frames/a.jpg')).toBeTrue();
    expect(samePath('C:\\Videos\\a.jpg', 'C:\\Videos\\b.jpg')).toBeFalse();
    expect(samePath('/home/jo/A.jpg', '/home/jo/a.jpg')).toBeFalse();
    expect(samePath('/home/jo//a.jpg', '/home/jo/a.jpg')).toBeTrue();
  });

  it('builds a file name a filesystem will take', () => {
    expect(safeStem('Dia 1: a chegada!  ')).toBe('Dia-1-a-chegada');
    expect(safeStem('Ação na praia')).toBe('Acao-na-praia');
    expect(safeStem('***')).toBe('video');
    expect(safeStem('***', 'tag-style')).toBe('tag-style');
    expect(safeStem('a'.repeat(120)).length).toBe(60);
  });

  it('never produces a name Windows reserves for a device', () => {
    expect(safeStem('CON')).toBe('CON-video');
    expect(safeStem('nul')).toBe('nul-video');
    expect(safeStem('com1')).toBe('com1-video');
    expect(safeStem('lpt9.backup')).toBe('lpt9.backup-video');
    expect(safeStem('console')).toBe('console');
  });

  it('stamps a timestamp so the files sort', () => {
    expect(stampOf(0)).toBe('00m00s000');
    expect(stampOf(7.4)).toBe('00m07s400');
    expect(stampOf(125.25)).toBe('02m05s250');
  });

  it('rounds before it splits, so a fraction never spills into four digits', () => {
    expect(stampOf(7.9996)).toBe('00m08s000');
    expect(stampOf(59.9999)).toBe('01m00s000');
    expect(stampOf(-3)).toBe('00m00s000');
  });

  it('names the file after what was actually encoded', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/gif')).toBe('gif');
    expect(extensionForMime('image/png')).toBe('png');
  });

  it('reads the bytes behind a data URL', () => {
    const { bytes, mimeType } = bytesFromDataUrl('data:image/png;base64,QUJD');
    expect(mimeType).toBe('image/png');
    expect(Array.from(bytes)).toEqual([65, 66, 67]);
  });

  it('keeps non-Latin text whole in a percent-encoded data URL', () => {
    const { bytes, mimeType } = bytesFromDataUrl('data:text/plain,a%20ção');
    expect(mimeType).toBe('text/plain');
    expect(new TextDecoder().decode(bytes)).toBe('a ção');
    expect(Array.from(bytesFromDataUrl('data:,%FF%00').bytes)).toEqual([255, 0]);
  });

  it('refuses anything that is not a data URL', () => {
    expect(() => bytesFromDataUrl('https://example.com/a.png')).toThrow();
  });
});

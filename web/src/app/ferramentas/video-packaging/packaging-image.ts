/** Read lazy Electron Files into real bytes and reject images the browser cannot decode. */
export async function readPackagingImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const fail = (message: string) => Object.assign(new Error(message), { code: 'invalid_arguments' });
  if (file.size > 30 * 1024 * 1024) throw fail(`${file.name} exceeds the 30 MB image limit.`);
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const mime = types[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? file.type;
  if (!Object.values(types).includes(mime)) throw fail(`${file.name} must be a PNG, JPEG, WebP or GIF image.`);
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 30 * 1024 * 1024) throw fail(`${file.name} is empty or exceeds the image limit.`);
  const blob = new Blob([bytes], { type: mime });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw fail(`${file.name} could not be decoded as an image.`); }
  try { return { blob, width: bitmap.width, height: bitmap.height }; }
  finally { bitmap.close(); }
}

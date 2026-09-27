/**
 * Turn whatever the picker handed over into a small, plain JPEG.
 *
 * Two reasons this happens in the browser before the upload:
 *
 *   1. A phone photo carries where it was taken. EXIF holds GPS, the device
 *      name, the date and often the file's own idea of who shot it — which is
 *      precisely the identifying detail FR-2.6 keeps out of a profile. Redrawing
 *      the pixels onto a canvas and re-encoding is what strips it: the output
 *      has no metadata block left to read.
 *   2. A 12 MB original is not needed to show a face on a card. Resizing here
 *      means the API stores hundreds of kilobytes per student instead.
 *
 * `imageOrientation: 'from-image'` applies the EXIF rotation while drawing, so
 * the picture still lands the right way up after the tag itself is gone.
 */

const MAX_EDGE = 1200;
const QUALITY = 0.82;

export async function encodePhoto(file) {
  if (!file) throw new Error('Choose a photo file first.');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('That file is not a photo this browser can read. A JPEG, PNG or WebP will work.');
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  // A JPEG has no alpha, so a transparent PNG is flattened on white rather than
  // on the black a fresh canvas defaults to.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('This browser could not convert that image. Try a different photo.');
  return blob;
}

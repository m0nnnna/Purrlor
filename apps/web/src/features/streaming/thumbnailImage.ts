import { coverRect } from './streamDashboard';

export const THUMBNAIL_WIDTH = 640;
export const THUMBNAIL_HEIGHT = 360;

/** A picked image as the 640×360 JPEG the server keeps (cropped to fill, under its 300 KB). */
export async function imageToThumbnail(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const { sx, sy, sWidth, sHeight } = coverRect(bitmap.width, bitmap.height, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    canvas.getContext('2d')?.drawImage(bitmap, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= 300 * 1024) return blob;
    }
    throw new Error('That picture is too detailed to use as a thumbnail.');
  } finally {
    bitmap.close();
  }
}

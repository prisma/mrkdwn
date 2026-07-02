/** Client side of the image pipeline: raw-body upload, server returns the
 * stable /api/images/{id} URL (bytes in S3, record in Postgres). */

export interface UploadedImage {
  id: string;
  url: string;
  width: number;
  height: number;
}

export async function uploadImage(blob: Blob): Promise<UploadedImage | null> {
  try {
    const res = await fetch("/api/images", {
      method: "POST",
      headers: { "content-type": blob.type || "image/png" },
      body: blob,
    });
    if (!res.ok) return null;
    return (await res.json()) as UploadedImage;
  } catch {
    return null;
  }
}

/** The first image in a paste/drop payload, if any. */
export function imageFromDataTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

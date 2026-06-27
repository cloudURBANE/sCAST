import { Router } from "express";
import { getImageObjectStorage, readLocalImageObject } from "../services/imageObjectStorage";

const router = Router();

function contentTypeForKey(storagePath: string): string {
  if (storagePath.endsWith(".webp")) return "image/webp";
  if (storagePath.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

router.get(/^\/image-objects\/(.+)$/, async (req, res) => {
  const storagePath = req.params[0];
  if (!storagePath) {
    res.status(404).json({ error: "Image object not found" });
    return;
  }

  // Read through the configured provider via authenticated access so a
  // same-origin /api/image-objects/... URL serves the durable hosted object in
  // production (where the local .image-cache/ filesystem is ephemeral). Fall back
  // to a direct local read so dev and local-storage deploys keep working.
  try {
    const { buffer, contentType } = await getImageObjectStorage().getObjectBytes(storagePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(buffer);
    return;
  } catch {
    /* fall through to local read */
  }

  try {
    const buffer = await readLocalImageObject(storagePath);
    res.setHeader("Content-Type", contentTypeForKey(storagePath));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(buffer);
  } catch {
    res.status(404).json({ error: "Image object not found" });
  }
});

export default router;

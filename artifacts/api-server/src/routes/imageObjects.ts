import { Router } from "express";
import { readLocalImageObject } from "../services/imageObjectStorage";

const router = Router();

router.get(/^\/image-objects\/(.+)$/, async (req, res) => {
  const storagePath = req.params[0];
  if (!storagePath) {
    res.status(404).json({ error: "Image object not found" });
    return;
  }

  try {
    const buffer = await readLocalImageObject(storagePath);
    const contentType = storagePath.endsWith(".webp")
      ? "image/webp"
      : storagePath.endsWith(".png")
        ? "image/png"
        : "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.end(buffer);
  } catch {
    res.status(404).json({ error: "Image object not found" });
  }
});

export default router;

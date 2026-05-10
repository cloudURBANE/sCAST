import { z } from "zod";

export const ScentFactProfileSchema = z.object({
  brand: z.string().optional().default(""),
  name: z.string().min(1),
  top_notes: z.array(z.string()).default([]),
  heart_notes: z.array(z.string()).default([]),
  base_notes: z.array(z.string()).default([]),
  accords: z.array(z.string()).default([]),
  confidence_score: z.number().min(0).max(1).default(0.5),
  source_urls: z.array(z.string().url()).default([]),
});

export type ParsedScentFactProfile = z.infer<typeof ScentFactProfileSchema>;

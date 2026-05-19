import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scentRouter from "./scent";
import authRouter from "./auth";
import oauthRouter from "./oauth";
import wardrobeRouter from "./wardrobe";
import shareRouter from "./share";
import fragrancesRouter from "./fragrances";
import imageProxyRouter from "./imageProxy";
import imageObjectsRouter from "./imageObjects";
import debugRouter from "./debug";
import scentFactsRouter from "./scentFacts";
import enrichmentRouter from "./enrichment";
import usageRouter from "./usage";

const router: IRouter = Router();

function isWardrobeAuditDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ENABLE_WARDROBE_AUDIT_DEBUG?.trim().toLowerCase() === "true"
  );
}

router.use(healthRouter);
router.use(scentRouter);
router.use(authRouter);
router.use(oauthRouter);
router.use(wardrobeRouter);
router.use(shareRouter);
router.use(fragrancesRouter);
router.use(imageProxyRouter);
router.use(imageObjectsRouter);
if (isWardrobeAuditDebugEnabled()) {
  router.use(debugRouter);
}
router.use(scentFactsRouter);
router.use(enrichmentRouter);
router.use(usageRouter);

export default router;

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
import scentFactsRouter from "./scentFacts";
import enrichmentRouter from "./enrichment";
import usageRouter from "./usage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scentRouter);
router.use(authRouter);
router.use(oauthRouter);
router.use(wardrobeRouter);
router.use(shareRouter);
router.use(fragrancesRouter);
router.use(imageProxyRouter);
router.use(imageObjectsRouter);
router.use(scentFactsRouter);
router.use(enrichmentRouter);
router.use(usageRouter);

export default router;

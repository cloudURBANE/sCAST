import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scentRouter from "./scent";
import authRouter from "./auth";
import oauthRouter from "./oauth";
import wardrobeRouter from "./wardrobe";
import shareRouter from "./share";
import imageProxyRouter from "./imageProxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scentRouter);
router.use(authRouter);
router.use(oauthRouter);
router.use(wardrobeRouter);
router.use(shareRouter);
router.use(imageProxyRouter);

export default router;

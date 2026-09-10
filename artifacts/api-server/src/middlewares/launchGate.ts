import type { Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { requireAuth, type AuthRequest } from "./auth";
import { getTenantId } from "./tenant";
import {
  allowance,
  costFeature,
  hasPaidAccess,
  nonnegativeInteger,
  reservationCost,
} from "../services/launchPolicy.ts";
import { reserveUsage } from "../services/launchUsageCore.ts";

export async function launchGate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  const feature = costFeature(req.method, req.path);
  if (!feature) return next();
  if (process.env.LAUNCH_SPENDING_STOP === "true") {
    res.setHeader("X-ScentBeam-Usage-Control", "enforced");
    res
      .status(503)
      .json({
        error: "New recommendations and image requests are temporarily paused.",
        code: "service_paused",
      });
    return;
  }
  if (process.env.LAUNCH_LIMITS_ENABLED !== "true") return next();
  res.setHeader("X-ScentBeam-Usage-Control", "enforced");
  await requireAuth(req, res, () => {});
  if (!req.user) return;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const tenant = getTenantId(req);
    const { rows } = await c.query(
      "SELECT status,access_until FROM billing_accounts WHERE user_id=$1 AND tenant_id=$2",
      [req.user!.id, tenant],
    );
    const paid = rows[0] && hasPaidAccess(rows[0].status, rows[0].access_until);
    const result = await reserveUsage(c, {
      scope: `${tenant}:${req.user!.id}`,
      feature,
      limit: allowance(feature, !!paid),
      cost: reservationCost(feature),
      globalLimit: nonnegativeInteger(
        process.env.LAUNCH_MONTHLY_RESERVE_MICROUSD,
        0,
      ),
    });
    await c.query("COMMIT");
    if (result !== "ok") {
      res
        .status(result === "service_budget" ? 503 : 429)
        .json({
          code: result,
          error:
            result === "service_budget"
              ? "New requests are temporarily paused. Your collection remains available."
              : "Your monthly allowance for this feature has been used. View Billing for your plan.",
        });
      return;
    }
    // Reservations remain charged on failure: provider work may already have
    // happened. This is deliberately a request budget, not an invoice total.
    next();
  } catch (err) {
    await c.query("ROLLBACK");
    next(err); // fail closed; never run the paid provider when accounting fails
  } finally {
    c.release();
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./pgliteHarness.ts";
import { reserveUsage } from "../services/launchUsageCore.ts";
import { applyBillingEvent } from "../services/billingEventCore.ts";

test("real migrated SQL reserves globally across accounts and enforces exact limits", async () => {
  const h = await createTestDb();
  const c = {
    query: async (sql: string, values?: unknown[]) => ({
      rows: await h.query(sql, values),
    }),
  };
  const input = {
    scope: "tenant-a:user-a",
    feature: "ai",
    limit: 2,
    cost: 25,
    globalLimit: 75,
  };
  async function reserve(options = input) {
    await h.query("BEGIN");
    try {
      const result = await reserveUsage(c, options);
      await h.query("COMMIT");
      return result;
    } catch (e) {
      await h.query("ROLLBACK");
      throw e;
    }
  }
  try {
    assert.equal(await reserve(), "ok");
    assert.equal(await reserve(), "ok");
    assert.equal(await reserve(), "monthly_allowance");
    assert.equal(await reserve({ ...input, scope: "tenant-b:user-b" }), "ok");
    assert.equal(
      await reserve({ ...input, scope: "tenant-b:user-b" }),
      "service_budget",
    );
    const rows = await h.query(
      "SELECT calls,reserved_microusd FROM launch_usage WHERE scope='global'",
    );
    assert.deepEqual(rows[0], { calls: 3, reserved_microusd: 75 });
    await h.query("BEGIN");
    await reserveUsage(c, { ...input, scope: "rollback", globalLimit: 100 });
    await h.query("ROLLBACK");
    assert.equal(
      (await h.query("SELECT * FROM launch_usage WHERE scope='rollback'"))
        .length,
      0,
    );
    // Old usage cannot consume the current month's allowance.
    await h.query("UPDATE launch_usage SET month='2000-01'");
    assert.equal(await reserve(), "ok");
  } finally {
    await h.close();
  }
});

test("real webhook processor handles duplicates, provider failure and stale delivery", async () => {
  const h = await createTestDb();
  const c = {
    query: async (sql: string, values?: unknown[]) => ({
      rows: await h.query(sql, values),
    }),
  };
  try {
    const [{ id: tenant }] = await h.query(
      "INSERT INTO tenants(name,slug) VALUES ('launch','launch') RETURNING id",
    );
    const [{ id: user }] = await h.query(
      "INSERT INTO users(tenant_id,email) VALUES ($1,'pilot@example.test') RETURNING id",
      [tenant],
    );
    await h.query(
      "INSERT INTO billing_accounts(user_id,tenant_id,customer_id) VALUES ($1,$2,'cus_test')",
      [user, tenant],
    );
    let reads = 0;
    let status = "active";
    const load = async () => {
      reads++;
      return {
        status,
        subscriptionId: "sub_test",
        accessUntil: new Date("2030-01-01"),
      };
    };
    const apply = async (id: string, loader = load) => {
      await h.query("BEGIN");
      try {
        await applyBillingEvent(c, id, "cus_test", loader);
        await h.query("COMMIT");
      } catch (e) {
        await h.query("ROLLBACK");
        throw e;
      }
    };
    await assert.rejects(
      apply("evt_paid", async () => {
        throw new Error("provider unavailable");
      }),
    );
    assert.equal((await h.query("SELECT * FROM billing_events")).length, 0);
    await apply("evt_paid");
    await apply("evt_paid");
    assert.equal(reads, 1);
    status = "canceled";
    await apply("evt_cancel");
    // An older, previously undelivered event reads current provider state.
    await apply("evt_old");
    assert.equal(
      (await h.query("SELECT status FROM billing_accounts"))[0].status,
      "canceled",
    );
    assert.equal((await h.query("SELECT * FROM billing_events")).length, 3);
  } finally {
    await h.close();
  }
});

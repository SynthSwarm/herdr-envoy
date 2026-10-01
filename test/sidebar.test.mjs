import assert from "node:assert/strict";
import { test } from "node:test";
import { queueDisplay } from "../dist/sidebar.js";

test("sidebar publishes bounded queue metadata, refreshes its lease and clears only Envoy tokens", async (t) => {
  const calls = [];
  const display = queueDisplay(async (...args) => { calls.push(args); return { stdout: "{}" }; });
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const first = { jobId: "a".repeat(32), createdAt: 1000, directory: "/projects/tid\u001b", coordinatorPane: "w1:p1", existing: { delivered: true }, task: "secret task" };
  const second = { jobId: "b".repeat(32), createdAt: 2000, existing: {} };
  await display("w2:p1", "ses_a", "idle", []);
  assert.equal(calls.length, 0);
  await display("w2:p1", "ses_a", "idle", [first, second]);
  const [program, args, options] = calls[0];
  assert.equal(program, "herdr");
  assert.ok(args.includes("envoy_queue=Req 1 active 1 queued"));
  assert.ok(args.includes("envoy_request=aaaaaaaa from tid "));
  assert.ok(args.includes("envoy_wait=Awaiting handback"));
  assert.ok(args.includes("envoy_since=1970-01-01T00:00:01.000Z"));
  assert.equal(args[args.indexOf("--ttl-ms") + 1], "30000");
  assert.equal(options.timeout, 5000);
  assert.doesNotMatch(JSON.stringify(args), /secret task|report_agent|--title|--display-agent/);
  await display("w2:p1", "ses_a", "idle", [first, second]);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(10_000);
  await display("w2:p1", "ses_a", "idle", [first, second]);
  assert.equal(calls.length, 2);
  await display("w2:p1", "ses_a", "idle", []);
  assert.ok(calls[2][1].includes("--clear-token"));
  assert.ok(!calls[2][1].includes("--clear-title"));
});

test("sidebar distinguishes unconfirmed submission from idle wait and retries display failures", async () => {
  const calls = [];
  const display = queueDisplay(async (_program, args) => { calls.push(args); if (calls.length === 1) throw new Error("offline"); return {}; });
  const job = { jobId: "c".repeat(32), createdAt: 0, existing: { attemptedAt: 123 } };
  await display("p", "s", "idle", [job]);
  await display("p", "s", "idle", [job]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("envoy_wait=Delivery unconfirmed"));
  job.existing = {};
  await display("p", "s", "working", [job]);
  assert.ok(calls[2].includes("envoy_wait=Waiting for idle"));
  await display("p", "s", "idle", [job]);
  assert.ok(calls[3].includes("envoy_wait=Checking delivery"));
  job.existing = { delivered: true };
  await display("p", "s", "idle", [job]);
  assert.ok(calls[4].includes("envoy_wait=Request outstanding"));
});

import assert from "assert/strict";
import test from "node:test";
import { checkRunnerHealth } from "./runnerHealth";

test("runner health returns known compiler checks", async () => {
  const runners = await checkRunnerHealth(3000);
  const ids = runners.map((runner) => runner.id).sort();

  assert.deepEqual(ids, ["c", "cpp", "java", "kotlin", "python"]);

  for (const runner of runners) {
    assert.equal(typeof runner.label, "string");
    assert.equal(typeof runner.command, "string");
    assert.equal(Array.isArray(runner.args), true);
    assert.equal(typeof runner.available, "boolean");
    assert.equal(typeof runner.output, "string");
    assert.equal(typeof runner.error, "string");
    assert.equal(typeof runner.timedOut, "boolean");
  }
});

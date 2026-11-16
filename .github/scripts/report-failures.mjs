// Turns failing tests in a captured `npm test` log into GitHub annotations,
// so the reason a run failed shows on the pull request page (and through the
// public API) without opening the full log.
//
//   node .github/scripts/report-failures.mjs test-output.log
import fs from "node:fs";

const MAX_ANNOTATIONS = 10;
const MAX_MESSAGE_LENGTH = 3000;

/** Escape text for a workflow command value. */
function escapeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text) {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** Failing tests in `node --test` (TAP) output: "not ok N - name" plus details. */
export function findTapFailures(lines) {
  const failures = [];

  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)not ok \d+ - (.*)$/.exec(lines[index]);

    if (!match) continue;

    const indent = match[1].length;
    const details = [];

    // The details are a YAML block indented under the test, ending at "...".
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next];

      if (/^\s*\.\.\.\s*$/.test(line)) break;
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;

      details.push(line.slice(indent));
    }

    // A failing suite repeats its failing subtests; keep the innermost ones.
    const isSuiteSummary = details.some((line) => /subtestsFailed|test failed/.test(line));

    if (!isSuiteSummary) {
      failures.push({ title: match[2].trim(), message: details.join("\n").trim() });
    }
  }

  return failures;
}

/** Failing tests in Vitest output and TypeScript compile errors. */
export function findOtherFailures(lines) {
  const failures = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const vitest = /^\s*(?:FAIL|×|✗)\s+(.*)$/.exec(line);

    if (vitest) {
      failures.push({
        title: vitest[1].trim(),
        message: lines.slice(index + 1, index + 25).join("\n").trim(),
      });
      continue;
    }

    if (/error TS\d+:/.test(line)) {
      failures.push({ title: "TypeScript error", message: line.trim() });
    }
  }

  return failures;
}

function main() {
  const logPath = process.argv[2];

  if (!logPath || !fs.existsSync(logPath)) {
    console.log("::warning::No test log found to summarise.");
    return;
  }

  // Strip colour codes so patterns match and annotations stay readable.
  const lines = fs
    .readFileSync(logPath, "utf8")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/);
  const failures = [...findTapFailures(lines), ...findOtherFailures(lines)];

  if (failures.length === 0) {
    // Nothing recognisable: show the end of the log instead.
    const tail = lines.slice(-40).join("\n").trim();

    console.log(`::error title=Tests failed (last lines of output)::${escapeData(tail.slice(-MAX_MESSAGE_LENGTH))}`);
    return;
  }

  for (const failure of failures.slice(0, MAX_ANNOTATIONS)) {
    console.log(
      `::error title=${escapeProperty(`Failing test: ${failure.title}`.slice(0, 200))}::${escapeData(
        (failure.message || "(no details in the log)").slice(0, MAX_MESSAGE_LENGTH)
      )}`
    );
  }

  if (failures.length > MAX_ANNOTATIONS) {
    console.log(`::warning::${failures.length - MAX_ANNOTATIONS} more failing test(s) not shown.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

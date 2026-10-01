#!/usr/bin/env node

import { formatResult, runCli } from "../src/cli.mjs";

try {
  const { result, format } = await runCli(process.argv.slice(2));
  process.stdout.write(formatResult(result, format));
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
  })}\n`);
  process.exitCode = 1;
}

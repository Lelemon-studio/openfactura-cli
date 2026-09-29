#!/usr/bin/env node
import { run } from "./cli.ts";

const codigo = await run(process.argv.slice(2), process.env, {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
});
process.exitCode = codigo;

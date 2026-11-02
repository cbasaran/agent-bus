#!/usr/bin/env bun
import { runCli } from "./index";

const code = await runCli(process.argv.slice(2));
if (code !== 0) {
  process.exit(code);
}

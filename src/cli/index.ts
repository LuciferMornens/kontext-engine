import { Command } from "commander";
import { createRequire } from "node:module";
import { registerInitCommand } from "./commands/init.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSymbolsCommand } from "./commands/symbols.js";
import { registerDepsCommand } from "./commands/deps.js";
import { registerChunkCommand } from "./commands/chunk.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerAuthCommand } from "./commands/auth.js";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

const program = new Command();

program
  .name("ctx")
  .description("Kontext — Context engine for AI coding agents")
  .version(packageJson.version ?? "0.0.0")
  .option("--verbose", "Enable verbose/debug output");

registerInitCommand(program);
registerQueryCommand(program);
registerAskCommand(program);
registerUpdateCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerSymbolsCommand(program);
registerDepsCommand(program);
registerChunkCommand(program);
registerConfigCommand(program);
registerAuthCommand(program);

program.parse();

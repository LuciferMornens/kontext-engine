import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerFindCommand } from "./commands/find.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSymbolsCommand } from "./commands/symbols.js";
import { registerDepsCommand } from "./commands/deps.js";
import { registerChunkCommand } from "./commands/chunk.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerAuthCommand } from "./commands/auth.js";

const program = new Command();

program
  .name("ctx")
  .description("Kontext — Context engine for AI coding agents")
  .version("0.1.0")
  .option("--verbose", "Enable verbose/debug output");

registerInitCommand(program);
registerQueryCommand(program);
registerAskCommand(program);
registerFindCommand(program);
registerUpdateCommand(program);
registerWatchCommand(program);
registerStatusCommand(program);
registerSymbolsCommand(program);
registerDepsCommand(program);
registerChunkCommand(program);
registerConfigCommand(program);
registerAuthCommand(program);

program.parse();

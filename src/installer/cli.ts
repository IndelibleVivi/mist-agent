import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InstallerController } from "./controller.ts";
import { FileMemoryLibrary } from "./memory-library.ts";
import { PiInteractiveLogin } from "./pi-login.ts";
import { InquirerPromptPort } from "./prompt-port.ts";
import { runInstaller } from "./run.ts";
import { InstallerStateStore } from "./state-store.ts";

interface CliArguments {
  residentId?: string;
  dataDir: string;
  piCommand: string;
}

function valueAfter(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseInstallerArguments(args: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    dataDir: process.env.MIST_DATA_DIR ?? join(homedir(), ".mist"),
    piCommand: "pi",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--resident":
        parsed.residentId = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--data-dir":
        parsed.dataDir = valueAfter(args, index, argument);
        index += 1;
        break;
      case "--pi-command":
        parsed.piCommand = valueAfter(args, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`unknown installer argument: ${argument ?? ""}`);
    }
  }
  return parsed;
}

/** shell 里能原样粘贴的一个参数：只含安全字符就不加引号，否则单引号包起来。 */
function shellWord(value: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 装完的下一步命令，总是带上这次的 --data-dir：resident 自己会先吃 MIST_DATA_DIR、再回落
 * ~/.mist，哪怕这次装的就是 ~/.mist，环境变量指着别处也会进错安装。
 */
export function residentCommand(dataDir: string): string {
  return `npm run resident -- --data-dir ${shellWord(resolve(dataDir))}`;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const cli = parseInstallerArguments(args);
  const prompt = new InquirerPromptPort();
  const residentId =
    cli.residentId ??
    (await prompt.input({
      message: "Resident ID",
      default: "resident-1",
    }));
  const dataDir = resolve(cli.dataDir);
  const store = new InstallerStateStore(dataDir);
  const controller = new InstallerController(store);
  const result = await runInstaller({
    residentId,
    dataDir,
    store,
    controller,
    prompt,
    oauth: new PiInteractiveLogin({ command: cli.piCommand }),
    memoryLibraries: new FileMemoryLibrary(),
  });
  if (result.status === "committed") {
    prompt.info(`Setup saved as ${result.receipt.snapshotId}.`);
    prompt.info(
      `Next: run \`${residentCommand(dataDir)}\`. The first start asks for a persona file and a model, lets the resident accept or decline the persona itself, then opens the chat.`,
    );
  } else if (result.status === "paused") {
    prompt.info("Setup paused. Run the same command to continue.");
  } else if (result.status === "dependency-pending") {
    prompt.info(
      `Setup is not active. The draft is waiting for ${result.dependencies.join(" and ")}.`,
    );
  } else {
    prompt.info("Current setup kept unchanged.");
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    if (error instanceof Error && error.name === "ExitPromptError") {
      process.stdout.write("\nSetup paused. Run the same command to continue.\n");
      process.exitCode = 130;
      return;
    }
    const message = error instanceof Error ? error.message : "unknown installer failure";
    process.stderr.write(`Setup failed: ${message}\n`);
    process.exitCode = 1;
  });
}

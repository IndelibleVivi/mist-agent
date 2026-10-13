import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialType } from "../src/installer/contracts.ts";
import { InstallerController } from "../src/installer/controller.ts";
import { InstallerStateStore } from "../src/installer/state-store.ts";
import { assembleResidentRuntime } from "../src/resident-runtime/assembly.ts";
import type { ModelCompletionRequest, ModelTransport } from "../src/resident-runtime/channels.ts";
import { CredentialStore } from "../src/resident-runtime/credentials.ts";
import {
  ATTESTATION_QUESTION,
  type OnboardingOptions,
  parseAttestation,
  residentFromInstall,
} from "../src/resident-runtime/onboarding.ts";
import type { ResidentRuntime } from "../src/resident-runtime/runtime.ts";

const cliPath = fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url));
const PERSONA = "TEST-PERSONA：你叫雾灯，是 mist 测试里的假住户。";
const KEY = "TEST-INSTALL-KEY-0001";
const MODEL = "openrouter/test-vendor/test-model";

const directories: string[] = [];
const runtimes: ResidentRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-onboarding-"));
  directories.push(directory);
  return directory;
}

/** 走真实安装器控制器提交一份安装：主通道 pi，凭证按参数。 */
function install(
  dataDir: string,
  options: { secret?: string; type?: CredentialType; discard?: boolean } = {},
): void {
  const type = options.type ?? "api_key";
  const issuerId = type === "api_key" ? "mist-installer-api-key" : "pi";
  const controller = new InstallerController(new InstallerStateStore(dataDir));
  controller.start("resident-1", options.discard === true ? "discard" : "resume");
  controller.saveCredentials([
    {
      credential: {
        ref: { id: "main-key", type, issuerId },
        label: "main",
        providerId: type === "api_key" ? "openrouter" : "codex",
        status: "incomplete",
      },
      secret: options.secret ?? KEY,
    },
  ]);
  controller.saveBindings([
    {
      residentId: "resident-1",
      lane: "primary",
      adapterId: "pi",
      credentialRef: { id: "main-key", type, issuerId },
    },
  ]);
  controller.saveFrontend({ kind: "external", integration: "mist-session-api" });
  controller.saveMemory({ kind: "existing", path: dataDir });
  controller.commit();
}

function personaFile(dataDir: string, content = PERSONA): string {
  const path = join(dataDir, "persona.md");
  writeFileSync(path, content);
  return path;
}

/** 录下每次请求，按顺序吐出预设回答（每个回答拆成两段增量）。 */
class ScriptedTransport implements ModelTransport {
  readonly requests: ModelCompletionRequest[] = [];
  readonly #replies: string[];
  constructor(replies: string[]) {
    this.#replies = [...replies];
  }
  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    this.requests.push(structuredClone(request));
    const reply = this.#replies.shift() ?? "（没有预设回答）";
    const middle = Math.ceil(reply.length / 2);
    yield reply.slice(0, middle);
    yield reply.slice(middle);
  }
}

interface Harness {
  dataDir: string;
  runtime: ResidentRuntime;
  transport: ScriptedTransport;
  questions: string[];
  said: string[];
  run(
    overrides?: Partial<OnboardingOptions>,
    answers?: string[],
  ): ReturnType<typeof residentFromInstall>;
}

function harness(replies: string[], dataDir = freshDirectory()): Harness {
  const transport = new ScriptedTransport(replies);
  const runtime = assembleResidentRuntime({ dataDir, transport });
  runtimes.push(runtime);
  const questions: string[] = [];
  const said: string[] = [];
  return {
    dataDir,
    runtime,
    transport,
    questions,
    said,
    run(overrides = {}, answers = []) {
      const queue = [...answers];
      return residentFromInstall({
        runtime,
        credentials: new CredentialStore(join(dataDir, "credentials")),
        install: new InstallerStateStore(dataDir),
        transport,
        ask: async (question) => {
          questions.push(question);
          return queue.shift() ?? null;
        },
        say: (text) => said.push(text),
        ...overrides,
      });
    },
  };
}

describe("parseAttestation", () => {
  it("reads only an exact 认 or 不认 on the first non-empty line", () => {
    expect(parseAttestation("认\n我喜欢这份人格。")).toBe("accepted");
    expect(parseAttestation("\n  **认。**  \n理由")).toBe("accepted");
    expect(parseAttestation("「不认」\n不像我")).toBe("rejected");
    expect(parseAttestation("不认")).toBe("rejected");
    expect(parseAttestation("我认")).toBe("undecided");
    expect(parseAttestation("认 但是有条件")).toBe("undecided");
    expect(parseAttestation("我还在想")).toBe("undecided");
    expect(parseAttestation("")).toBe("undecided");
  });
});

describe("residentFromInstall", () => {
  it("activates the resident only on its own 认, then provisions the install key", async () => {
    const h = harness(["认\n这份人格像我。"]);
    install(h.dataDir);

    const result = await h.run({ personaPath: personaFile(h.dataDir) }, [MODEL]);

    expect(result).toEqual({ ok: true, residentId: "resident-1", model: MODEL });
    expect(h.transport.requests).toHaveLength(1);
    const [request] = h.transport.requests;
    const candidate = h.runtime.latestCandidateFor("resident-1");
    expect(candidate?.state).toBe("active");
    expect(request?.residentId).toBe(candidate?.candidateId);
    expect(request?.bootPack.identity).toBe(PERSONA);
    expect(request?.text).toBe(ATTESTATION_QUESTION);
    expect(request?.history).toEqual([]);
    expect(request?.model).toBe(MODEL);
    expect(request?.credentialSecret).toBe(KEY);

    const active = h.runtime.requireActiveResident("resident-1");
    expect(active.ok && active.value.persona).toBe(PERSONA);
    const credentials = new CredentialStore(join(h.dataDir, "credentials"));
    const record = credentials.find("resident-1");
    expect(record?.model).toBe(MODEL);
    expect(record?.credentialKind).toBe("api-key");
    expect(record?.claudeSubscription).toBe(false);
    expect(credentials.readSecret(record?.credentialRef ?? "")).toBe(KEY);

    // 自认那一轮发生在住户成立之前：不进一窗流；密钥不进任何旁白。
    expect(h.runtime.readStream({ residentId: "resident-1" })).toMatchObject({
      ok: false,
      error: { code: "stream-not-found" },
    });
    expect(h.said.join("\n")).toContain("这份人格像我");
    expect(h.said.join("\n")).not.toContain(KEY);
  });

  it("keeps the candidate inactive when the first line is not a clear answer, and asks again next start", async () => {
    const h = harness(["我愿意认下它。\n大概吧。", "认\n想好了。"]);
    install(h.dataDir);

    const unclear = await h.run({}, [personaFile(h.dataDir), MODEL]);

    expect(unclear).toMatchObject({ ok: false, code: "attestation-undecided" });
    const pending = h.runtime.latestCandidateFor("resident-1");
    expect(pending?.state).toBe("inactive");
    expect(h.runtime.requireActiveResident(pending?.candidateId ?? "")).toEqual({
      ok: false,
      reason: "candidate-pending",
    });
    expect(new CredentialStore(join(h.dataDir, "credentials")).find("resident-1")).toBeNull();

    const pendingId = pending?.candidateId;
    h.questions.length = 0;
    const second = await h.run({}, [MODEL]);

    expect(second).toEqual({ ok: true, residentId: "resident-1", model: MODEL });
    // 人格稿还在：第二次只问模型，同一份候选被认下。
    expect(h.questions).toHaveLength(1);
    expect(h.runtime.latestCandidateFor("resident-1")?.candidateId).toBe(pendingId);
  });

  it("records the resident's refusal and asks for a new persona on the next start", async () => {
    const h = harness(["不认\n这不像我。", "认\n这份可以。"]);
    install(h.dataDir);

    const refused = await h.run({ personaPath: personaFile(h.dataDir), model: MODEL });

    expect(refused).toMatchObject({ ok: false, code: "candidate-rejected" });
    const first = h.runtime.latestCandidateFor("resident-1");
    expect(first?.state).toBe("rejected");
    expect(h.runtime.requireActiveResident("resident-1")).toMatchObject({ ok: false });

    const second = await h.run(
      { personaPath: personaFile(h.dataDir, "TEST-PERSONA-2：换一份。"), model: MODEL },
      [],
    );

    expect(second).toMatchObject({ ok: true, residentId: "resident-1" });
    const latest = h.runtime.latestCandidateFor("resident-1");
    expect(latest?.candidateId).not.toBe(first?.candidateId);
    expect(latest?.persona).toBe("TEST-PERSONA-2：换一份。");
    expect(h.said.join("\n")).toContain("上一份人格稿住户没有认");
  });

  it("does nothing before setup has been saved", async () => {
    const h = harness([]);

    const result = await h.run({ personaPath: personaFile(h.dataDir), model: MODEL });

    expect(result).toMatchObject({ ok: false, code: "install-missing" });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.runtime.latestCandidateFor("resident-1")).toBeNull();
  });

  it("refuses a primary channel that is not an API key before handing over any persona", async () => {
    const h = harness([]);
    install(h.dataDir, { type: "codex_oauth" });

    const result = await h.run({ personaPath: personaFile(h.dataDir), model: MODEL });

    expect(result).toMatchObject({ ok: false, code: "channel-unsupported" });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.runtime.latestCandidateFor("resident-1")).toBeNull();
  });

  it("refuses a model pi cannot route with an API key without calling the model", async () => {
    const h = harness(["认"]);
    install(h.dataDir);

    const bare = await h.run({ personaPath: personaFile(h.dataDir), model: "test-model" });
    const unknown = await h.run({ model: "no-such-provider/test-model" });

    expect(bare).toMatchObject({ ok: false, code: "model-unsupported" });
    expect(unknown).toMatchObject({ ok: false, code: "model-unsupported" });
    expect(h.transport.requests).toHaveLength(0);
    expect(h.runtime.latestCandidateFor("resident-1")?.state).toBe("inactive");
  });

  it("refuses an empty persona file and a missing answer without creating a candidate", async () => {
    const h = harness([]);
    install(h.dataDir);

    const empty = await h.run({ personaPath: personaFile(h.dataDir, "  \n"), model: MODEL });
    const missing = await h.run({ model: MODEL }, []);

    expect(empty).toMatchObject({ ok: false, code: "persona-invalid" });
    expect(missing).toMatchObject({ ok: false, code: "persona-missing" });
    expect(h.runtime.latestCandidateFor("resident-1")).toBeNull();
    expect(h.transport.requests).toHaveLength(0);
  });

  it("re-provisions with the same model when setup saved a new key, and switches model only on request", async () => {
    const h = harness(["认"]);
    install(h.dataDir);
    await h.run({ personaPath: personaFile(h.dataDir), model: MODEL });
    const credentials = new CredentialStore(join(h.dataDir, "credentials"));

    const unchanged = await h.run({}, []);
    expect(unchanged).toEqual({ ok: true, residentId: "resident-1", model: MODEL });

    install(h.dataDir, { secret: "TEST-INSTALL-KEY-0002" });
    const rekeyed = await h.run({}, []);
    expect(rekeyed).toEqual({ ok: true, residentId: "resident-1", model: MODEL });
    const record = credentials.find("resident-1");
    expect(credentials.readSecret(record?.credentialRef ?? "")).toBe("TEST-INSTALL-KEY-0002");

    const switched = await h.run({ model: "kimi-coding/kimi-for-coding" }, []);
    expect(switched).toEqual({
      ok: true,
      residentId: "resident-1",
      model: "kimi-coding/kimi-for-coding",
    });
    expect(credentials.find("resident-1")?.model).toBe("kimi-coding/kimi-for-coding");
    // 住户成立之后不再问认不认、不再调模型。
    expect(h.transport.requests).toHaveLength(1);
    expect(h.said.join("\n")).not.toContain("TEST-INSTALL-KEY");
  });
});

describe("npm run resident from the install", () => {
  it("explains that setup comes first when nothing is installed", async () => {
    const dataDir = freshDirectory();
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "--data-dir", dataDir], {
      env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(code).toBe(1);
    expect(stderr).toContain("install-missing");
    expect(stderr).toContain("npm run setup");
  });
});

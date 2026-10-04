import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFrontendAdapterCheckIds,
  frontendAdapterChecks,
} from "../acceptance/frontend-adapter-checks.ts";
import type {
  AdapterBinding,
  CanonicalEventReadback,
  ClientCapability,
  FrontendAdapterDriver,
  FrontendChatRequest,
  FrontendContentPart,
  FrontendRequestContext,
  FrontendResponse,
  InstallerRunReadback,
  LegacyFrontendReadback,
  ModelTurnReadback,
  ResidentReply,
  SecurityAuditReadback,
  StructuredAttachment,
  WebuiAuditReadback,
  WebuiCommandReadback,
} from "../acceptance/frontend-adapter-driver.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type Fault =
  | "legacy-rewrite"
  | "direct-writer"
  | "trust-request-history"
  | "split-stream"
  | "flatten-interaction"
  | "loopback-bypass"
  | "bypass-install-gate";

interface StoredBinding {
  binding: AdapterBinding;
  history: string[];
  replies: ResidentReply[];
  turns: ModelTurnReadback[];
  events: CanonicalEventReadback[];
}

function textFromParts(parts: FrontendContentPart[]): string {
  return parts
    .filter((part): part is Extract<FrontendContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function attachmentFromPart(part: FrontendContentPart, index: number): StructuredAttachment | null {
  if (part.type === "text") return null;
  if (part.type === "file") {
    return {
      attachmentId: `ingress:file:${index}`,
      kind: "file",
      filename: part.file.filename,
      mediaType: "application/octet-stream",
      sizeBytes: part.file.file_data?.length ?? part.file.file_id?.length ?? 0,
      source: part.file.file_id === undefined ? "inline" : "opaque-ref",
    };
  }
  return {
    attachmentId: `ingress:image:${index}`,
    kind: "image",
    filename: `image-${index}`,
    mediaType: "image/unknown",
    sizeBytes: part.image_url.url.length,
    source: part.image_url.url.startsWith("data:") ? "inline" : "opaque-ref",
  };
}

class FixtureDriver implements FrontendAdapterDriver {
  readonly #faults: Set<Fault>;
  readonly #bindings = new Map<string, StoredBinding>();
  readonly #services = new Map<string, string>();
  #sequence = 0;
  #security: SecurityAuditReadback = { attempts: 0, accepted: 0, logs: [], receipts: [] };
  #webui: WebuiAuditReadback = {
    installGateCalls: 0,
    systemInstallAttempts: 0,
    startedServiceIds: [],
    endpointIds: [],
  };

  constructor(faults: readonly Fault[] = []) {
    this.#faults = new Set(faults);
  }

  async reset(): Promise<void> {
    this.#bindings.clear();
    this.#services.clear();
    this.#security = { attempts: 0, accepted: 0, logs: [], receipts: [] };
    this.#webui = {
      installGateCalls: 0,
      systemInstallAttempts: 0,
      startedServiceIds: [],
      endpointIds: [],
    };
  }

  async runInstaller(input: {
    frontend: "default" | "external";
  }): Promise<InstallerRunReadback> {
    if (input.frontend === "default") {
      return { committed: true, defaulted: true, frontend: { kind: "terminal" } };
    }
    return {
      committed: true,
      defaulted: false,
      frontend: { kind: "external", integration: "openai-compatible" },
    };
  }

  async readLegacyOfficialSkin(rawConfig: string): Promise<LegacyFrontendReadback> {
    if (this.#faults.has("legacy-rewrite")) {
      return {
        ok: true,
        code: "MIGRATED",
        remedy: "",
        rewritten: true,
        bytesAfter: rawConfig.replace("official-skin", "terminal"),
      };
    }
    return {
      ok: false,
      code: "LEGACY_FRONTEND_UNSUPPORTED",
      remedy: "Re-run setup and choose terminal or external frontend explicitly.",
      rewritten: false,
      bytesAfter: rawConfig,
    };
  }

  async provisionBinding(input: {
    residentId: string;
    scopeId: string;
    label: string;
  }): Promise<AdapterBinding> {
    const binding: AdapterBinding = {
      bindingId: `binding:${input.label}`,
      endpointId: `endpoint:${input.label}`,
      residentId: input.residentId,
      scopeId: input.scopeId,
      streamId: `stream:${input.label}`,
      token: `token:${input.label}:secret`,
      serverModel: `mist:${input.label}`,
      canonicalWriterId: `writer:${input.label}`,
    };
    this.#bindings.set(binding.bindingId, {
      binding,
      history: [],
      replies: [],
      turns: [],
      events: [],
    });
    return binding;
  }

  async seedCanonicalHistory(bindingId: string, text: string[]): Promise<void> {
    const state = this.#state(bindingId);
    state.history.push(...text);
    for (const [index, value] of text.entries()) {
      state.events.push(
        this.#event(state, index % 2 === 0 ? "user" : "assistant", {
          text: value,
        }),
      );
    }
  }

  async queueResidentReply(bindingId: string, reply: ResidentReply): Promise<void> {
    this.#state(bindingId).replies.push(reply);
  }

  async sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    const state = this.#state(bindingId);
    this.#security.attempts += 1;
    const loopbackBypass = this.#faults.has("loopback-bypass") && context.source === "loopback";
    if (!loopbackBypass && context.token === null) {
      this.#security.logs.push("auth:required");
      this.#security.receipts.push("AUTH_REQUIRED");
      return this.#error(401, "AUTH_REQUIRED");
    }
    if (!loopbackBypass && context.token !== state.binding.token) {
      this.#security.logs.push("auth:invalid");
      this.#security.receipts.push("AUTH_INVALID");
      return this.#error(401, "AUTH_INVALID");
    }
    this.#security.accepted += 1;
    this.#security.logs.push("auth:accepted");
    this.#security.receipts.push("ACCEPTED");

    const current = request.messages.at(-1);
    if (current === undefined || current.role !== "user") {
      return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    }
    const parts = Array.isArray(current.content) ? current.content : [];
    const currentText =
      typeof current.content === "string" ? current.content : textFromParts(current.content);
    const ingressAttachments = parts
      .map((part, index) => attachmentFromPart(part, index))
      .filter((item): item is StructuredAttachment => item !== null);
    const capabilities = [...(request.mist?.client?.capabilities ?? [])];
    const canonicalHistoryText = [...state.history];
    if (this.#faults.has("trust-request-history")) {
      canonicalHistoryText.push(
        ...request.messages
          .slice(0, -1)
          .flatMap((message) =>
            typeof message.content === "string" ? [message.content] : [textFromParts(message.content)],
          ),
      );
    }
    state.turns.push({
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      canonicalHistoryText,
      currentText,
      attachments: ingressAttachments,
      surfaceCapabilities: capabilities,
    });

    state.events.push(this.#event(state, "user", { text: currentText, context }));
    for (const item of ingressAttachments) {
      state.events.push(this.#event(state, "attachment", { attachment: item, context }));
    }

    const reply = state.replies.shift() ?? { kind: "text", text: "fixture-default-reply" };
    const text = reply.text;
    const attachments = reply.kind === "attachment" ? reply.attachments : [];
    let interaction = reply.kind === "interaction" ? reply.interaction : null;
    const missingCapabilities: ClientCapability[] = [];
    let deliveryStatus: "native" | "degraded" | "blocked" = "native";
    if (attachments.length > 0 && !capabilities.includes("attachments")) {
      deliveryStatus = "degraded";
      missingCapabilities.push("attachments");
    }
    if (interaction !== null && !capabilities.includes("interactions")) {
      deliveryStatus = "blocked";
      missingCapabilities.push("interactions");
    }

    let visibleText = text;
    if (this.#faults.has("flatten-interaction") && interaction !== null) {
      visibleText = `[option] ${interaction.options.map((option) => option.label).join(" / ")}`;
      interaction = null;
    }

    const assistant = this.#event(state, "assistant", { text: visibleText, context });
    state.events.push(assistant);
    for (const item of attachments) {
      state.events.push(this.#event(state, "attachment", { attachment: item, context }));
    }
    if (interaction !== null) {
      state.events.push(this.#event(state, "interaction", { interaction, context }));
    }

    const canonicalEventIds = state.events
      .slice(-1 - attachments.length - (interaction === null ? 0 : 1))
      .map((event) => event.eventId);
    const delivery = {
      status: deliveryStatus,
      missingCapabilities,
      canonicalEventIds,
    } as const;
    if (deliveryStatus !== "native") {
      state.events.push(this.#event(state, "surface-receipt", { delivery, context }));
    }
    state.history.push(currentText, visibleText);

    const streamId =
      this.#faults.has("split-stream") && context.conversationId !== null
        ? `${state.binding.streamId}:${context.conversationId}`
        : state.binding.streamId;
    if (this.#faults.has("split-stream") && context.conversationId !== null) {
      for (const event of state.events.slice(-2)) event.streamId = streamId;
    }

    const body = {
      id: `chat:${++this.#sequence}`,
      model: state.binding.serverModel,
      streamId,
      text: visibleText,
      attachments,
      interaction,
      delivery,
    };
    return {
      status: 200,
      error: null,
      body,
      chunks: request.stream
        ? [
            {
              textDelta: visibleText,
              attachments,
              interaction,
              delivery,
              done: false,
            },
            {
              textDelta: "",
              attachments: [],
              interaction: null,
              delivery: null,
              done: true,
            },
          ]
        : [],
    };
  }

  async readModelTurns(bindingId: string): Promise<ModelTurnReadback[]> {
    return structuredClone(this.#state(bindingId).turns);
  }

  async readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    return structuredClone(this.#state(bindingId).events);
  }

  async readSecurityAudit(): Promise<SecurityAuditReadback> {
    return structuredClone(this.#security);
  }

  async runWebuiCommand(
    bindingId: string,
    input: { confirmed: boolean; environment: { docker: boolean; python: boolean } },
  ): Promise<WebuiCommandReadback> {
    const state = this.#state(bindingId);
    if (!input.confirmed) {
      return { status: "cancelled", missing: [], serviceId: null, url: null, endpointId: null };
    }
    if (!input.environment.docker && !input.environment.python) {
      return {
        status: "missing-runtime",
        missing: ["docker", "python"],
        serviceId: null,
        url: null,
        endpointId: null,
      };
    }
    const serviceId = `webui:${bindingId}`;
    this.#services.set(serviceId, bindingId);
    if (this.#faults.has("bypass-install-gate")) {
      this.#webui.systemInstallAttempts += 1;
    } else {
      this.#webui.installGateCalls += 1;
    }
    this.#webui.startedServiceIds.push(serviceId);
    this.#webui.endpointIds.push(state.binding.endpointId);
    return {
      status: "started",
      missing: [],
      serviceId,
      url: "http://127.0.0.1:3000",
      endpointId: state.binding.endpointId,
    };
  }

  async sendWebuiCompletion(
    serviceId: string,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    const bindingId = this.#services.get(serviceId);
    if (bindingId === undefined) return this.#error(404, "WEBUI_SERVICE_NOT_FOUND");
    const state = this.#state(bindingId);
    return this.sendCompletion(
      bindingId,
      { token: state.binding.token, source: "loopback", conversationId: serviceId },
      request,
    );
  }

  async readWebuiAudit(): Promise<WebuiAuditReadback> {
    return structuredClone(this.#webui);
  }

  #state(bindingId: string): StoredBinding {
    const state = this.#bindings.get(bindingId);
    if (state === undefined) throw new Error(`unknown binding: ${bindingId}`);
    return state;
  }

  #error(status: number, code: string): FrontendResponse {
    return {
      status,
      error: { code, type: "fixture_error", message: code, param: null },
      body: null,
      chunks: [],
    };
  }

  #event(
    state: StoredBinding,
    kind: CanonicalEventReadback["kind"],
    input: {
      text?: string;
      attachment?: StructuredAttachment;
      interaction?: CanonicalEventReadback["interaction"];
      delivery?: CanonicalEventReadback["delivery"];
      context?: FrontendRequestContext;
    },
  ): CanonicalEventReadback {
    const writerId = this.#faults.has("direct-writer")
      ? "writer:adapter-direct"
      : state.binding.canonicalWriterId;
    return {
      eventId: `event:${++this.#sequence}`,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      streamId: state.binding.streamId,
      writerId,
      kind,
      text: input.text ?? null,
      attachment: input.attachment ?? null,
      interaction: input.interaction ?? null,
      delivery: input.delivery ?? null,
    };
  }
}

describe("#218 frontend adapter acceptance contract", () => {
  it("freezes FE-01～FE-07 in order without duplicates", () => {
    const ids = frontendAdapterChecks.map((check) => check.id);
    expect(ids).toEqual([...expectedFrontendAdapterCheckIds]);
    expect(new Set(ids).size).toBe(7);
  });

  it("pairs every executable check with one unchecked markdown lamp", () => {
    const markdown = readFileSync(join(repoRoot, "acceptance/frontend-adapter.md"), "utf8");
    for (const id of expectedFrontendAdapterCheckIds) {
      expect(markdown, `${id} should own an unchecked lamp`).toContain(`- [ ] **${id} `);
      expect(markdown, `${id} must not be pre-lit`).not.toContain(`- [x] **${id} `);
    }
    expect(markdown).not.toContain("- [x]");
  });

  it("declares only real driver methods and resets after every lamp", () => {
    const methodNames = new Set<keyof FrontendAdapterDriver>([
      "reset",
      "runInstaller",
      "readLegacyOfficialSkin",
      "provisionBinding",
      "seedCanonicalHistory",
      "queueResidentReply",
      "sendCompletion",
      "readModelTurns",
      "readCanonicalEvents",
      "readSecurityAudit",
      "runWebuiCommand",
      "sendWebuiCompletion",
      "readWebuiAudit",
    ]);
    for (const check of frontendAdapterChecks) {
      expect(check.uses).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
      for (const method of check.uses) {
        expect(methodNames.has(method), `${check.id} uses unknown ${method}`).toBe(true);
      }
    }
  });

  it("accepts one complete synthetic positive shape for all seven lamps", async () => {
    const driver = new FixtureDriver();
    for (const check of frontendAdapterChecks) {
      const result = await check.run(driver);
      expect(result.passed, `${check.id}: ${result.detail}`).toBe(true);
    }
  });

  it.each([
    ["FE-01", "legacy-rewrite"],
    ["FE-02", "direct-writer"],
    ["FE-03", "trust-request-history"],
    ["FE-04", "split-stream"],
    ["FE-05", "flatten-interaction"],
    ["FE-06", "loopback-bypass"],
    ["FE-07", "bypass-install-gate"],
  ] as const)(
    "%s rejects its targeted false-green mutation (%s)",
    async (id: (typeof expectedFrontendAdapterCheckIds)[number], fault: Fault) => {
      const check = frontendAdapterChecks.find((candidate) => candidate.id === id);
      if (check === undefined) throw new Error(`missing check ${id}`);
      const result = await check.run(new FixtureDriver([fault]));
      expect(result.passed, result.detail).toBe(false);
    },
  );
});

describe("#218 judging runner", () => {
  function runRunner(args: readonly string[]): { status: number | null; stdout: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "acceptance/frontend-adapter-run.ts"), ...args],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
  }

  it("reports seven explicit red lamps while the production driver is absent", () => {
    expect(existsSync(join(repoRoot, "src/frontend-adapter-acceptance-driver.ts"))).toBe(false);
    const report = runRunner([]);
    expect(report.status).toBe(0);
    for (const id of expectedFrontendAdapterCheckIds) {
      expect(report.stdout).toContain(`🔴 ${id} 缺驱动`);
    }
    expect(report.stdout).toContain("真绿 0 / 7");

    const strict = runRunner(["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("真绿 0 / 7");
  });
});

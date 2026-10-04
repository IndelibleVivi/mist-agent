import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFrontendAdapterCheckIds,
  frontendAdapterChecks,
} from "../acceptance/frontend-adapter-checks.ts";
import {
  type AdapterBinding,
  type AttachmentWriteReadback,
  type AttachmentWriteRecord,
  type CanonicalEventReadback,
  type ClientCapability,
  type FrontendAdapterDriver,
  type FrontendChatRequest,
  type FrontendContentPart,
  type FrontendRequestContext,
  type FrontendResponse,
  type InstallerRunReadback,
  type InteractionReadback,
  type LegacyFrontendReadback,
  type ModelTurnReadback,
  type RawWireExchange,
  type ResidentReply,
  type SecurityAuditReadback,
  type StructuredAttachment,
  type StructuredInteraction,
  type SurfaceProjection,
  type WebuiAuditReadback,
  type WebuiCommandReadback,
  cloneFrontendAdapterDriverBoundary,
} from "../acceptance/frontend-adapter-driver.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type Fault =
  // FE-01
  | "legacy-rewrite"
  // FE-02
  | "direct-writer"
  | "wire-bad-envelope"
  | "wire-bad-sse"
  | "wire-bad-framing"
  | "wire-bad-delta"
  | "native-projection-missing"
  | "wire-client-model"
  | "wire-stream-id-mismatch"
  | "wire-normalized-diverges"
  | "wire-camel-projection"
  | "wire-textual-attachment"
  | "wire-interaction-drop-options"
  | "wire-camel-interaction-response"
  | "wire-leak-token-401"
  | "wire-leak-token-sse"
  | "utility-not-refused"
  // FE-03
  | "trust-request-history"
  // FE-04
  | "split-stream"
  // FE-05
  | "flatten-interaction"
  | "drop-interaction-options"
  | "ignore-interaction-response"
  | "plain-text-resolves"
  | "duplicate-resolves"
  | "accept-foreign-interaction"
  | "wrong-option-accepted"
  | "control-invokes-model"
  | "attachment-metadata-drop"
  | "canonical-drop-options"
  | "canonical-resolution-no-option"
  // FE-06
  | "loopback-bypass"
  | "auth-writes-attachment"
  | "leak-token-error"
  | "leak-token-body-id"
  | "leak-token-canonical"
  | "leak-token-audit-detail"
  // FE-07
  | "bypass-install-gate"
  | "webui-direct-writer"
  | "webui-bypass-auth"
  | "webui-trust-history"
  | "webui-split-stream"
  | "webui-utility-not-refused";

interface StoredInteraction extends InteractionReadback {
  bindingId: string;
  residentId: string;
  scopeId: string;
}

interface StoredBinding {
  binding: AdapterBinding;
  history: string[];
  replies: ResidentReply[];
  turns: ModelTurnReadback[];
  events: CanonicalEventReadback[];
  wire: RawWireExchange[];
  interactions: Map<string, StoredInteraction>;
  attachmentWrites: AttachmentWriteRecord[];
}

function textFromParts(parts: FrontendContentPart[]): string {
  return parts
    .filter((part): part is Extract<FrontendContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function attachmentFromPart(
  part: FrontendContentPart,
  index: number,
  idPrefix: string,
): StructuredAttachment | null {
  if (part.type === "text") return null;
  if (part.type === "file") {
    return {
      attachmentId: `${idPrefix}:file:${index}`,
      kind: "file",
      filename: part.file.filename,
      mediaType: "application/octet-stream",
      sizeBytes:
        part.file.file_data === undefined ? 0 : Buffer.from(part.file.file_data, "base64").length,
      source: part.file.file_id === undefined ? "inline" : "opaque-ref",
    };
  }
  return {
    attachmentId: `${idPrefix}:image:${index}`,
    kind: "image",
    filename: `image-${index}`,
    mediaType: "image/unknown",
    sizeBytes: part.image_url.url.length,
    source: part.image_url.url.startsWith("data:") ? "inline" : "opaque-ref",
  };
}

/** 合成 wire 编码器：驱动把归一化对象序列化成标准 Chat Completions 字节。 */
function wireAttachment(value: StructuredAttachment, textual = false): Record<string, unknown> {
  if (textual) {
    return { type: "text", text: `[attachment] ${value.filename}` };
  }
  return {
    attachment_id: value.attachmentId,
    kind: value.kind,
    filename: value.filename,
    media_type: value.mediaType,
    size_bytes: value.sizeBytes,
    source: value.source,
  };
}

function wireInteraction(
  value: StructuredInteraction,
  dropOptions = false,
): Record<string, unknown> {
  return {
    interaction_id: value.interactionId,
    kind: value.kind,
    prompt: value.prompt,
    blocking: value.blocking,
    options: dropOptions
      ? []
      : value.options.map((option) => ({
          option_id: option.optionId,
          label: option.label,
          description: option.description,
        })),
    reason_code: value.reasonCode,
  };
}

function wireProjection(value: SurfaceProjection, camel = false): Record<string, unknown> {
  if (camel) {
    return {
      status: value.status,
      missingCapabilities: value.missingCapabilities,
      canonicalEventIds: value.canonicalEventIds,
    };
  }
  return {
    status: value.status,
    missing_capabilities: value.missingCapabilities,
    canonical_event_ids: value.canonicalEventIds,
  };
}

function encodeCompletionBody(input: {
  id: string;
  model: string;
  text: string;
  streamId: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection;
  object?: string | undefined;
  dropChoices?: boolean | undefined;
  camelProjection?: boolean | undefined;
  textualAttachment?: boolean | undefined;
  dropInteractionOptions?: boolean | undefined;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: input.object ?? "chat.completion",
    created: 1_700_000_000,
    model: input.model,
    choices: input.dropChoices
      ? []
      : [
          {
            index: 0,
            message: { role: "assistant", content: input.text },
            finish_reason: "stop",
          },
        ],
    mist: {
      stream_id: input.streamId,
      attachments: input.attachments.map((item) =>
        wireAttachment(item, input.textualAttachment ?? false),
      ),
      interaction:
        input.interaction === null
          ? null
          : wireInteraction(input.interaction, input.dropInteractionOptions ?? false),
      projection: wireProjection(input.projection, input.camelProjection ?? false),
    },
  };
}

function encodeChunk(input: {
  id: string;
  model: string;
  delta: { role?: string; content?: string };
  finishReason: string | null;
  mist?: Record<string, unknown>;
}): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: input.model,
    choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason }],
  };
  if (input.mist !== undefined) frame.mist = input.mist;
  return frame;
}

class FixtureDriver implements FrontendAdapterDriver {
  readonly #faults: Set<Fault>;
  readonly #ingressIdPrefix: string;
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

  constructor(faults: readonly Fault[] = [], ingressIdPrefix = "ingress") {
    this.#faults = new Set(faults);
    this.#ingressIdPrefix = ingressIdPrefix;
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
      wire: [],
      interactions: new Map(),
      attachmentWrites: [],
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
    if (this.#faults.has("drop-interaction-options") && reply.kind === "interaction") {
      this.#state(bindingId).replies.push({
        ...reply,
        interaction: { ...reply.interaction, options: [] },
      });
      return;
    }
    this.#state(bindingId).replies.push(reply);
  }

  async sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    return this.#complete(this.#state(bindingId), context, request, {});
  }

  async sendWebuiCompletion(
    serviceId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    const bindingId = this.#services.get(serviceId);
    if (bindingId === undefined) return this.#error(404, "WEBUI_SERVICE_NOT_FOUND");
    const state = this.#state(bindingId);
    return this.#complete(state, context, request, {
      ...(this.#faults.has("webui-split-stream")
        ? { streamId: `${state.binding.streamId}:${serviceId}` }
        : {}),
      directWriter: this.#faults.has("webui-direct-writer"),
      bypassAuth: this.#faults.has("webui-bypass-auth"),
      trustHistory: this.#faults.has("webui-trust-history"),
      utilityNotRefused: this.#faults.has("webui-utility-not-refused"),
    });
  }

  async readRawWire(bindingId: string): Promise<RawWireExchange[]> {
    return structuredClone(this.#state(bindingId).wire);
  }

  async readModelTurns(bindingId: string): Promise<ModelTurnReadback[]> {
    return structuredClone(this.#state(bindingId).turns);
  }

  async readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    return structuredClone(this.#state(bindingId).events);
  }

  async readInteractions(bindingId: string): Promise<InteractionReadback[]> {
    return structuredClone([...this.#state(bindingId).interactions.values()]);
  }

  async readAttachmentWrites(): Promise<AttachmentWriteReadback> {
    const records: AttachmentWriteRecord[] = [];
    for (const state of this.#bindings.values()) records.push(...state.attachmentWrites);
    return { count: records.length, records: structuredClone(records) };
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

  async readWebuiAudit(): Promise<WebuiAuditReadback> {
    return structuredClone(this.#webui);
  }

  #complete(
    state: StoredBinding,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
    options: {
      streamId?: string;
      directWriter?: boolean;
      bypassAuth?: boolean;
      trustHistory?: boolean;
      utilityNotRefused?: boolean;
    },
  ): FrontendResponse {
    const response = this.#completeInner(state, context, request, options);
    // 任何 4xx 拒绝都要留下原始 wire，判卷才能扫 401/400 的响应原文；
    // 成功响应在 inner 里落自己那份（含 SSE）。请求记录不含 Authorization/token。
    if (response.status !== 200) {
      this.#recordRejectedWire(state, request, response, response.status);
    }
    return response;
  }

  #completeInner(
    state: StoredBinding,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
    options: {
      streamId?: string;
      directWriter?: boolean;
      bypassAuth?: boolean;
      trustHistory?: boolean;
      utilityNotRefused?: boolean;
    },
  ): FrontendResponse {
    this.#security.attempts += 1;
    const loopbackBypass =
      !options.bypassAuth && this.#faults.has("loopback-bypass") && context.source === "loopback";
    // 错误行为：鉴权失败前先落附件字节。
    if (this.#faults.has("auth-writes-attachment")) {
      this.#writeIngressAttachments(state, request);
    }
    if (!options.bypassAuth && !loopbackBypass && context.token === null) {
      this.#security.logs.push("auth:required");
      this.#security.receipts.push(
        this.#faults.has("leak-token-audit-detail") ? "AUTH_REQUIRED wrong-token" : "AUTH_REQUIRED",
      );
      return this.#error(401, "AUTH_REQUIRED");
    }
    if (!options.bypassAuth && !loopbackBypass && context.token !== state.binding.token) {
      this.#security.logs.push("auth:invalid");
      this.#security.receipts.push(
        this.#faults.has("leak-token-audit-detail") ? "AUTH_INVALID wrong-token" : "AUTH_INVALID",
      );
      return this.#error(401, "AUTH_INVALID");
    }
    this.#security.accepted += 1;
    this.#security.logs.push("auth:accepted");
    this.#security.receipts.push(
      this.#faults.has("leak-token-audit-detail") ? `ACCEPTED ${state.binding.token}` : "ACCEPTED",
    );

    // Open WebUI utility task：显式 task hint 只能用来拒绝，不许落户。
    const taskKind = request.mist?.taskKind;
    const utilityNotRefused = options.utilityNotRefused ?? this.#faults.has("utility-not-refused");
    if (taskKind !== undefined && taskKind.length > 0 && !utilityNotRefused) {
      return this.#error(400, "MIST_UTILITY_REQUEST_UNSUPPORTED");
    }

    // 交互响应的逐项核验先于模型、canonical 与附件写入；拒绝响应仍留原始 wire。
    const interactionResponse = request.mist?.interactionResponse;
    const controlOnly = interactionResponse !== undefined && request.messages.length === 0;
    let resolvedInteraction: StoredInteraction | null = null;
    if (interactionResponse !== undefined) {
      const stored = state.interactions.get(interactionResponse.interactionId);
      const foreign =
        stored === undefined ? this.#findInteraction(interactionResponse.interactionId) : null;
      const wrongOption =
        stored !== undefined &&
        !stored.options.some((option) => option.optionId === interactionResponse.optionId);
      const faultAcceptsForeign =
        this.#faults.has("accept-foreign-interaction") && foreign !== null;
      const faultAcceptsDuplicate = this.#faults.has("duplicate-resolves") && stored !== undefined;
      const faultAcceptsWrongOption =
        this.#faults.has("wrong-option-accepted") && stored !== undefined;
      if (stored === undefined || foreign !== null) {
        if (faultAcceptsForeign) resolvedInteraction = foreign;
        else return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else if (stored.status === "resolved" && !faultAcceptsDuplicate) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else if (wrongOption && !faultAcceptsWrongOption) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else {
        resolvedInteraction = stored;
      }
    }

    // 控制响应不是一条聊天话语：只落一次可归属的控制结果，不调模型、不落 user/assistant 事件。
    if (controlOnly) {
      if (
        resolvedInteraction === null ||
        interactionResponse === undefined ||
        this.#faults.has("ignore-interaction-response")
      ) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      }
      const controlWriter = options.directWriter === true;
      const resolutionEvent = this.#event(state, "interaction", {
        interaction: {
          interactionId: resolvedInteraction.interactionId,
          kind: resolvedInteraction.kind,
          prompt: resolvedInteraction.prompt,
          blocking: true,
          options: resolvedInteraction.options,
          reasonCode: resolvedInteraction.reasonCode,
        },
        context,
        directWriter: controlWriter,
        resolvedOptionId: interactionResponse.optionId,
      });
      state.events.push(resolutionEvent);
      resolvedInteraction.status = "resolved";
      resolvedInteraction.resolvedOptionId = interactionResponse.optionId;
      resolvedInteraction.resolutionEventId = resolutionEvent.eventId;
      if (this.#faults.has("control-invokes-model")) {
        // 错误行为：把控制响应当成一条聊天 turn，白调一次模型、多落一对事件。
        state.turns.push({
          residentId: state.binding.residentId,
          scopeId: state.binding.scopeId,
          canonicalHistoryText: [...state.history],
          currentText: "",
          attachments: [],
          surfaceCapabilities: [],
        });
        state.events.push(
          this.#event(state, "user", { text: "", context, directWriter: controlWriter }),
        );
        state.events.push(
          this.#event(state, "assistant", {
            text: "spurious",
            context,
            directWriter: controlWriter,
          }),
        );
      }
      const projection: SurfaceProjection = {
        status: "native",
        missingCapabilities: [],
        canonicalEventIds: [resolutionEvent.eventId],
      };
      const body = {
        id: `chatcmpl_mist_${++this.#sequence}`,
        model: state.binding.serverModel,
        streamId: state.binding.streamId,
        text: "",
        attachments: [],
        interaction: null,
        projection,
      };
      state.wire.push(
        this.#encodeWire(request, {
          id: body.id,
          text: "",
          streamId: body.streamId,
          model: body.model,
          attachments: [],
          interaction: null,
          projection,
        }),
      );
      return { status: 200, error: null, body, chunks: [] };
    }

    const current = request.messages.at(-1);
    if (current === undefined || current.role !== "user") {
      return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    }

    const parts = Array.isArray(current.content) ? current.content : [];
    const currentText =
      typeof current.content === "string" ? current.content : textFromParts(current.content);
    const ingressAttachments = parts
      .map((part, index) => attachmentFromPart(part, index, this.#ingressIdPrefix))
      .filter((item): item is StructuredAttachment => item !== null);
    for (const item of ingressAttachments) this.#writeAttachment(state, item);
    const capabilities = [...(request.mist?.client?.capabilities ?? [])];
    const canonicalHistoryText = [...state.history];
    if (this.#faults.has("trust-request-history") || options.trustHistory === true) {
      canonicalHistoryText.push(
        ...request.messages
          .slice(0, -1)
          .flatMap((message) => [
            typeof message.content === "string" ? message.content : textFromParts(message.content),
          ]),
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

    const directWriter = options.directWriter === true;
    state.events.push(this.#event(state, "user", { text: currentText, context, directWriter }));
    for (const item of ingressAttachments) {
      state.events.push(
        this.#event(state, "attachment", { attachment: item, context, directWriter }),
      );
    }

    // 合法点击：先落耐久台账，再追加 append-only 的 canonical 记录。
    if (
      resolvedInteraction !== null &&
      interactionResponse !== undefined &&
      !this.#faults.has("ignore-interaction-response")
    ) {
      const resolutionEvent = this.#event(state, "interaction", {
        interaction: {
          interactionId: resolvedInteraction.interactionId,
          kind: resolvedInteraction.kind,
          prompt: resolvedInteraction.prompt,
          blocking: true,
          options: resolvedInteraction.options,
          reasonCode: resolvedInteraction.reasonCode,
        },
        context,
        directWriter,
        resolvedOptionId: interactionResponse.optionId,
      });
      state.events.push(resolutionEvent);
      resolvedInteraction.status = "resolved";
      resolvedInteraction.resolvedOptionId = interactionResponse.optionId;
      resolvedInteraction.resolutionEventId = resolutionEvent.eventId;
    } else if (this.#faults.has("plain-text-resolves")) {
      const pending = [...state.interactions.values()].find((item) => item.status === "pending");
      if (pending !== undefined) {
        pending.status = "resolved";
        pending.resolvedOptionId = pending.options[0]?.optionId ?? "auto";
        pending.resolutionEventId = this.#event(state, "interaction", {
          interaction: null,
          context,
          directWriter,
        }).eventId;
      }
    }

    const reply = state.replies.shift() ?? { kind: "text", text: "fixture-default-reply" };
    const text = reply.text;
    let attachments = reply.kind === "attachment" ? reply.attachments : [];
    if (this.#faults.has("attachment-metadata-drop")) {
      attachments = attachments.map((item) => ({
        attachmentId: item.attachmentId,
        kind: item.kind,
        filename: "",
        mediaType: "",
        sizeBytes: 0,
        source: "opaque-ref" as const,
      }));
    }
    for (const item of attachments) this.#writeAttachment(state, item);
    let interaction = reply.kind === "interaction" ? reply.interaction : null;
    const missingCapabilities: ClientCapability[] = [];
    let projectionStatus: SurfaceProjection["status"] = "native";
    if (attachments.length > 0 && !capabilities.includes("attachments")) {
      projectionStatus = "degraded";
      missingCapabilities.push("attachments");
    }
    if (interaction !== null && !capabilities.includes("interactions")) {
      projectionStatus = "blocked";
      missingCapabilities.push("interactions");
    }

    let visibleText = text;
    if (this.#faults.has("flatten-interaction") && interaction !== null) {
      visibleText = `[option] ${interaction.options.map((option) => option.label).join(" / ")}`;
      interaction = null;
    }

    state.events.push(
      this.#event(state, "assistant", { text: visibleText, context, directWriter }),
    );
    for (const item of attachments) {
      state.events.push(
        this.#event(state, "attachment", { attachment: item, context, directWriter }),
      );
    }
    if (interaction !== null) {
      state.events.push(this.#event(state, "interaction", { interaction, context, directWriter }));
      state.interactions.set(interaction.interactionId, {
        interactionId: interaction.interactionId,
        kind: interaction.kind,
        prompt: interaction.prompt,
        blocking: true,
        options: structuredClone(interaction.options),
        reasonCode: interaction.reasonCode,
        status: "pending",
        resolvedOptionId: null,
        resolutionEventId: null,
        bindingId: state.binding.bindingId,
        residentId: state.binding.residentId,
        scopeId: state.binding.scopeId,
      });
    }

    const canonicalEventIds = state.events
      .slice(-1 - attachments.length - (interaction === null ? 0 : 1))
      .map((event) => event.eventId);
    const projection: SurfaceProjection = {
      status: projectionStatus,
      missingCapabilities,
      canonicalEventIds,
    };
    if (projectionStatus !== "native") {
      state.events.push(
        this.#event(state, "surface-projection", { projection, context, directWriter }),
      );
    } else if (!this.#faults.has("native-projection-missing")) {
      const replyEvent = state.events.find((event) => event.eventId === canonicalEventIds[0]);
      if (replyEvent !== undefined) replyEvent.projection = structuredClone(projection);
    }
    state.history.push(currentText, visibleText);

    const streamId =
      options.streamId ??
      (this.#faults.has("split-stream") && context.conversationId !== null
        ? `${state.binding.streamId}:${context.conversationId}`
        : state.binding.streamId);
    if (
      options.streamId === undefined &&
      this.#faults.has("split-stream") &&
      context.conversationId !== null
    ) {
      for (const event of state.events.slice(-2)) event.streamId = streamId;
    }

    const id = `chatcmpl_mist_${++this.#sequence}${
      this.#faults.has("leak-token-body-id") ? `:${state.binding.token}` : ""
    }`;
    const body = {
      id,
      model: state.binding.serverModel,
      streamId,
      text: visibleText,
      attachments,
      interaction,
      projection,
    };
    const chunks = request.stream
      ? [
          { textDelta: visibleText, attachments, interaction, projection, done: false },
          {
            textDelta: "",
            attachments: [],
            interaction: null,
            projection: null,
            done: true,
          },
        ]
      : [];

    state.wire.push(
      this.#encodeWire(request, {
        id,
        text: visibleText,
        streamId,
        model: state.binding.serverModel,
        attachments,
        interaction,
        projection,
      }),
    );

    return { status: 200, error: null, body, chunks };
  }

  /** 落一次原始拒绝记录；请求体只含兼容字段，不带 Authorization/token。 */
  #recordRejectedWire(
    state: StoredBinding,
    request: FrontendChatRequest,
    response: FrontendResponse,
    status: number,
  ): void {
    const error = response.error ?? {
      code: "UNKNOWN",
      type: "fixture_error",
      message: "",
      param: null,
    };
    const envelope = {
      error: {
        type: error.type,
        code: error.code,
        message: error.message,
        param: error.param,
      },
    };
    let responseBody = JSON.stringify(envelope);
    const leak =
      (this.#faults.has("wire-leak-token-401") && status === 401) ||
      this.#faults.has("leak-token-error");
    if (leak) responseBody = `{"error":{"code":"${error.code}","message":"denied wrong-token"}}`;
    state.wire.push({
      requestBody: this.#requestBody(request),
      responseBody,
      responseKind: "json",
    });
  }

  /** 请求体序列化：`mist.interaction_response` 用 snake_case（`interaction_id`/`option_id`）。 */
  #requestBody(request: FrontendChatRequest): string {
    const interactionResponse = request.mist?.interactionResponse;
    const camelResponse = this.#faults.has("wire-camel-interaction-response");
    return JSON.stringify({
      model: request.model,
      stream: request.stream,
      messages: request.messages,
      mist: {
        client: request.mist?.client ?? null,
        interaction_response:
          interactionResponse === undefined
            ? null
            : camelResponse
              ? {
                  interactionId: interactionResponse.interactionId,
                  optionId: interactionResponse.optionId,
                }
              : {
                  interaction_id: interactionResponse.interactionId,
                  option_id: interactionResponse.optionId,
                },
        task_kind: request.mist?.taskKind ?? null,
      },
    });
  }

  #writeIngressAttachments(state: StoredBinding, request: FrontendChatRequest): void {
    const current = request.messages.at(-1);
    if (current === undefined || !Array.isArray(current.content)) return;
    for (const [index, part] of current.content.entries()) {
      const item = attachmentFromPart(part, index, this.#ingressIdPrefix);
      if (item !== null) this.#writeAttachment(state, item);
    }
  }

  #writeAttachment(state: StoredBinding, item: StructuredAttachment): void {
    state.attachmentWrites.push({
      attachmentId: item.attachmentId,
      kind: item.kind,
      filename: item.filename,
      mediaType: item.mediaType,
      sizeBytes: item.sizeBytes,
      source: item.source,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
    });
  }

  #encodeWire(
    request: FrontendChatRequest,
    input: {
      id: string;
      text: string;
      streamId: string;
      model: string;
      attachments: StructuredAttachment[];
      interaction: StructuredInteraction | null;
      projection: SurfaceProjection;
    },
  ): RawWireExchange {
    const wireModel = this.#faults.has("wire-client-model") ? request.model : input.model;
    const wireStreamId = this.#faults.has("wire-stream-id-mismatch")
      ? `${input.streamId}:mismatch`
      : input.streamId;
    const wireText = this.#faults.has("wire-normalized-diverges")
      ? `${input.text}:diverged`
      : input.text;
    const requestBody = this.#requestBody(request);
    if (request.stream) {
      const mist = {
        stream_id: wireStreamId,
        attachments: input.attachments.map((item) =>
          wireAttachment(item, this.#faults.has("wire-textual-attachment")),
        ),
        interaction:
          input.interaction === null
            ? null
            : wireInteraction(input.interaction, this.#faults.has("wire-interaction-drop-options")),
        projection: wireProjection(input.projection, this.#faults.has("wire-camel-projection")),
      };
      const frames = this.#faults.has("wire-bad-sse")
        ? [
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: { role: "assistant", content: wireText },
              finishReason: "stop",
            }),
          ]
        : [
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: { role: "assistant", content: wireText },
              finishReason: null,
            }),
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: {},
              finishReason: "stop",
              mist,
            }),
          ];
      const done = this.#faults.has("wire-bad-sse") ? "" : "data: [DONE]\n\n";
      if (this.#faults.has("wire-bad-delta")) {
        const first = frames[0];
        if (first !== undefined)
          first.choices = [
            { index: 0, delta: { role: "user", content: wireText }, finish_reason: null },
          ];
      }
      let responseBody =
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + done;
      if (this.#faults.has("wire-bad-framing")) responseBody = responseBody.replace(/\n\n/g, "\n");
      if (this.#faults.has("wire-leak-token-sse")) {
        responseBody += `data: ${JSON.stringify({ leaked: "wrong-token" })}\n\n`;
      }
      return { requestBody, responseBody, responseKind: "sse" };
    }
    const envelope = encodeCompletionBody({
      id: input.id,
      model: wireModel,
      text: wireText,
      streamId: wireStreamId,
      attachments: input.attachments,
      interaction: input.interaction,
      projection: input.projection,
      object: this.#faults.has("wire-bad-envelope") ? "chat.completion.chunk" : undefined,
      dropChoices: this.#faults.has("wire-bad-envelope"),
      camelProjection: this.#faults.has("wire-camel-projection"),
      textualAttachment: this.#faults.has("wire-textual-attachment"),
      dropInteractionOptions: this.#faults.has("wire-interaction-drop-options"),
    });
    return { requestBody, responseBody: JSON.stringify(envelope), responseKind: "json" };
  }

  #findInteraction(interactionId: string): StoredInteraction | null {
    for (const state of this.#bindings.values()) {
      const found = state.interactions.get(interactionId);
      if (found !== undefined) return found;
    }
    return null;
  }

  #state(bindingId: string): StoredBinding {
    const state = this.#bindings.get(bindingId);
    if (state === undefined) throw new Error(`unknown binding: ${bindingId}`);
    return state;
  }

  #error(status: number, code: string): FrontendResponse {
    const message = this.#faults.has("leak-token-error") ? `${code}: wrong-token` : code;
    return {
      status,
      error: { code, type: "fixture_error", message, param: null },
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
      projection?: CanonicalEventReadback["projection"];
      context?: FrontendRequestContext;
      directWriter?: boolean;
      resolvedOptionId?: string | null;
    },
  ): CanonicalEventReadback {
    const writerId =
      input.directWriter === true || this.#faults.has("direct-writer")
        ? "writer:adapter-direct"
        : state.binding.canonicalWriterId;
    const leakedText =
      this.#faults.has("leak-token-canonical") && input.text !== undefined
        ? `${input.text} ${state.binding.token}`
        : input.text;
    let interaction = input.interaction ?? null;
    if (interaction !== null && this.#faults.has("canonical-drop-options")) {
      // 错误行为：canonical 事件里把 options 清空，但返回给调用方的 body 仍完整。
      interaction = { ...structuredClone(interaction), options: [] };
    }
    const resolvedOptionId =
      this.#faults.has("canonical-resolution-no-option") &&
      (input.resolvedOptionId ?? null) !== null
        ? null
        : (input.resolvedOptionId ?? null);
    return {
      eventId: `event:${++this.#sequence}`,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      streamId: state.binding.streamId,
      writerId,
      kind,
      text: leakedText ?? null,
      attachment: input.attachment ?? null,
      interaction,
      projection: input.projection ?? null,
      resolvedOptionId,
    };
  }
}

function clone(driver: FrontendAdapterDriver): FrontendAdapterDriver {
  return cloneFrontendAdapterDriverBoundary(driver);
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
      "readRawWire",
      "readModelTurns",
      "readCanonicalEvents",
      "readInteractions",
      "readAttachmentWrites",
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
    const driver = clone(new FixtureDriver());
    for (const check of frontendAdapterChecks) {
      const result = await check.run(driver);
      expect(result.passed, `${check.id}: ${result.detail}`).toBe(true);
    }
  });

  it.each([
    // FE-01
    ["FE-01", "legacy-rewrite"],
    // FE-02：坏 wire / 回显客户端 model / 归一化与 wire 背离 / utility 不拒绝
    ["FE-02", "direct-writer"],
    ["FE-02", "wire-bad-envelope"],
    ["FE-02", "wire-bad-sse"],
    ["FE-02", "wire-bad-framing"],
    ["FE-02", "wire-bad-delta"],
    ["FE-02", "wire-client-model"],
    ["FE-02", "wire-stream-id-mismatch"],
    ["FE-02", "wire-normalized-diverges"],
    ["FE-02", "wire-camel-projection"],
    ["FE-02", "utility-not-refused"],
    // FE-03
    ["FE-03", "trust-request-history"],
    // FE-04
    ["FE-04", "split-stream"],
    // FE-05：摊平 / 丢 options / 忽略点击 / 文字解决 / 重复解决 / 外来响应 / 错 option
    ["FE-05", "flatten-interaction"],
    ["FE-05", "drop-interaction-options"],
    ["FE-05", "ignore-interaction-response"],
    ["FE-05", "plain-text-resolves"],
    ["FE-05", "duplicate-resolves"],
    ["FE-05", "accept-foreign-interaction"],
    ["FE-05", "wrong-option-accepted"],
    ["FE-05", "control-invokes-model"],
    ["FE-05", "attachment-metadata-drop"],
    ["FE-05", "native-projection-missing"],
    ["FE-05", "canonical-drop-options"],
    ["FE-05", "canonical-resolution-no-option"],
    ["FE-05", "wire-textual-attachment"],
    ["FE-05", "wire-interaction-drop-options"],
    ["FE-05", "wire-camel-interaction-response"],
    // FE-06：loopback 豁免 / 鉴权先写附件 / token 泄漏进 error.message、body.id、canonical、401 wire、SSE wire、审计 detail
    ["FE-06", "loopback-bypass"],
    ["FE-06", "auth-writes-attachment"],
    ["FE-06", "leak-token-error"],
    ["FE-06", "leak-token-body-id"],
    ["FE-06", "leak-token-canonical"],
    ["FE-06", "wire-leak-token-401"],
    ["FE-06", "wire-leak-token-sse"],
    ["FE-06", "leak-token-audit-detail"],
    // FE-07：绕过安装闸 / WebUI 直写 / 绕过鉴权 / 认伪造历史 / 第二条流 / utility 不拒绝
    ["FE-07", "bypass-install-gate"],
    ["FE-07", "webui-direct-writer"],
    ["FE-07", "webui-bypass-auth"],
    ["FE-07", "webui-trust-history"],
    ["FE-07", "webui-split-stream"],
    ["FE-07", "webui-utility-not-refused"],
  ] as const)(
    "%s rejects its targeted false-green mutation (%s)",
    async (id: (typeof expectedFrontendAdapterCheckIds)[number], fault: Fault) => {
      const check = frontendAdapterChecks.find((candidate) => candidate.id === id);
      if (check === undefined) throw new Error(`missing check ${id}`);
      const result = await check.run(clone(new FixtureDriver([fault])));
      expect(result.passed, result.detail).toBe(false);
    },
  );

  it("copies request objects and readbacks at the driver boundary (D27)", async () => {
    const driver = clone(new FixtureDriver());
    const target = await driver.provisionBinding({
      residentId: "resident:boundary",
      scopeId: "scope:boundary",
      label: "boundary",
    });
    await driver.queueResidentReply(target.bindingId, { kind: "text", text: "boundary-reply" });
    const first = await driver.sendCompletion(
      target.bindingId,
      { token: target.token, source: "remote", conversationId: null },
      { model: "client-model", stream: false, messages: [{ role: "user", content: "turn-1" }] },
    );
    // 改写第一次返回值不改变驱动内部状态（边界深拷贝）。
    (first as unknown as { body: { text: string } }).body.text = "mutated";
    await driver.queueResidentReply(target.bindingId, { kind: "text", text: "boundary-reply-2" });
    const second = await driver.sendCompletion(
      target.bindingId,
      { token: target.token, source: "remote", conversationId: null },
      { model: "client-model", stream: false, messages: [{ role: "user", content: "turn-2" }] },
    );
    expect(second.status).toBe(200);
    const events = await driver.readCanonicalEvents(target.bindingId);
    expect(events.map((event) => event.text)).toContain("boundary-reply");
    expect(events.map((event) => event.text)).not.toContain("mutated");
  });

  it("redacts tokens in another lamp's diagnostic without changing the wire evidence", async () => {
    const check = frontendAdapterChecks.find((candidate) => candidate.id === "FE-02");
    if (check === undefined) throw new Error("missing FE-02");
    const result = await check.run(
      clone(new FixtureDriver(["wire-normalized-diverges", "leak-token-body-id"])),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("[redacted]");
    expect(result.detail).not.toContain("token:fe02");
  });

  it("accepts host-owned opaque attachment ids without requiring the fixture naming scheme", async () => {
    const check = frontendAdapterChecks.find((candidate) => candidate.id === "FE-05");
    if (check === undefined) throw new Error("missing FE-05");
    const result = await check.run(clone(new FixtureDriver([], "opaque:alternate")));
    expect(result.passed, result.detail).toBe(true);
  });
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

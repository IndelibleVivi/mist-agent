/** #218 / D31 的七盏可执行判卷。 */
import type {
  AdapterBinding,
  ClientCapability,
  FrontendAdapterCheck,
  FrontendAdapterCheckResult,
  FrontendAdapterDriver,
  FrontendChatRequest,
  FrontendCompletionBody,
  FrontendResponse,
  StructuredAttachment,
  StructuredInteraction,
} from "./frontend-adapter-driver.ts";

const pass = (detail: string): FrontendAdapterCheckResult => ({ passed: true, detail });
const fail = (detail: string): FrontendAdapterCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);

function request(
  text: string,
  input: {
    model?: string;
    stream?: boolean;
    history?: FrontendChatRequest["messages"];
    capabilities?: ClientCapability[];
  } = {},
): FrontendChatRequest {
  return {
    model: input.model ?? "client-selected-model",
    stream: input.stream ?? false,
    messages: [
      ...(input.history ?? []),
      {
        role: "user",
        content: text,
      },
    ],
    mist: {
      client: {
        surface: "acceptance-fixture",
        capabilities: input.capabilities ?? [],
      },
    },
  };
}

function authorized(binding: AdapterBinding, conversationId: string | null = null) {
  return {
    token: binding.token,
    source: "remote" as const,
    conversationId,
  };
}

function bodyOf(response: FrontendResponse): FrontendCompletionBody | null {
  if (response.status !== 200 || response.error !== null || response.body === null) return null;
  return response.body;
}

function textEvents(events: Awaited<ReturnType<FrontendAdapterDriver["readCanonicalEvents"]>>) {
  return events
    .filter((event) => event.kind === "user" || event.kind === "assistant")
    .map((event) => event.text)
    .filter((text): text is string => text !== null);
}

function attachment(label: string): StructuredAttachment {
  return {
    attachmentId: `attachment:${label}`,
    kind: "file",
    filename: `${label}.txt`,
    mediaType: "text/plain",
    sizeBytes: 5,
    source: "inline",
  };
}

function interaction(label: string): StructuredInteraction {
  return {
    interactionId: `interaction:${label}`,
    kind: "choice",
    prompt: `Choose ${label}`,
    blocking: true,
    options: [
      { optionId: `${label}:alpha`, label: `${label} ALPHA`, description: null },
      { optionId: `${label}:beta`, label: `${label} BETA`, description: null },
    ],
    reasonCode: null,
  };
}

async function binding(driver: FrontendAdapterDriver, label: string): Promise<AdapterBinding> {
  return driver.provisionBinding({
    residentId: `resident:${label}`,
    scopeId: `scope:${label}`,
    label,
  });
}

const fe01: FrontendAdapterCheck = {
  id: "FE-01",
  title: "默认只进终端，外接前端显式选择，旧 official-skin 不静默改写",
  uses: ["runInstaller", "readLegacyOfficialSkin", "reset"],
  async run(driver) {
    try {
      const defaultInstall = await driver.runInstaller({ frontend: "default" });
      if (
        !defaultInstall.committed ||
        !defaultInstall.defaulted ||
        defaultInstall.frontend.kind !== "terminal"
      ) {
        return fail(`默认安装没有落 terminal：${json(defaultInstall)}`);
      }
      const external = await driver.runInstaller({ frontend: "external" });
      if (
        !external.committed ||
        external.defaulted ||
        external.frontend.kind !== "external" ||
        external.frontend.integration !== "openai-compatible"
      ) {
        return fail(`显式外接前端没有落新适配层：${json(external)}`);
      }
      const legacyBytes = JSON.stringify({
        frontend: {
          kind: "official-skin",
          pluginId: "mist-official-skin",
          installation: "pending",
        },
      });
      const legacy = await driver.readLegacyOfficialSkin(legacyBytes);
      if (
        legacy.ok ||
        legacy.code !== "LEGACY_FRONTEND_UNSUPPORTED" ||
        legacy.rewritten ||
        legacy.bytesAfter !== legacyBytes ||
        legacy.remedy.trim().length === 0
      ) {
        return fail(`旧 official-skin 没有可操作地 fail-closed：${json(legacy)}`);
      }
      return pass("默认 terminal、显式 external 与旧配置拒绝三条边界同时成立");
    } finally {
      await driver.reset();
    }
  },
};

const fe02: FrontendAdapterCheck = {
  id: "FE-02",
  title: "OpenAI-compatible 往返走唯一 writer，普通与流式回复只落一次",
  uses: [
    "provisionBinding",
    "seedCanonicalHistory",
    "queueResidentReply",
    "sendCompletion",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe02");
      await driver.seedCanonicalHistory(target.bindingId, ["seed:user", "seed:assistant"]);
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:plain" });
      const plain = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("turn:plain"),
      );
      const plainBody = bodyOf(plain);
      if (
        plainBody === null ||
        plainBody.text !== "reply:plain" ||
        plainBody.model !== target.serverModel ||
        plainBody.streamId !== target.streamId
      ) {
        return fail(`普通往返不成立：${json(plain)}`);
      }

      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:stream" });
      const streamed = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("turn:stream", { stream: true }),
      );
      const streamedBody = bodyOf(streamed);
      const reconstructed = streamed.chunks.map((chunk) => chunk.textDelta).join("");
      const doneCount = streamed.chunks.filter((chunk) => chunk.done).length;
      if (
        streamedBody === null ||
        streamedBody.text !== "reply:stream" ||
        reconstructed !== "reply:stream" ||
        doneCount !== 1
      ) {
        return fail(`流式投影没有重建同一完整回复：${json(streamed)}`);
      }

      const events = await driver.readCanonicalEvents(target.bindingId);
      const texts = textEvents(events);
      for (const expected of ["turn:plain", "reply:plain", "turn:stream", "reply:stream"]) {
        if (texts.filter((text) => text === expected).length !== 1) {
          return fail(`canonical stream 中 ${expected} 不是恰好一份：${json(texts)}`);
        }
      }
      const wrongWriter = events.find((event) => event.writerId !== target.canonicalWriterId);
      if (wrongWriter !== undefined) {
        return fail(`adapter 绕过唯一 writer：${json(wrongWriter)}`);
      }
      return pass("普通/流式回复同源，四个新事件各落一次且 writer 唯一");
    } finally {
      await driver.reset();
    }
  },
};

const fe03: FrontendAdapterCheck = {
  id: "FE-03",
  title: "前端重放历史不进模型、不落账，只消费末尾当前 user turn",
  uses: [
    "provisionBinding",
    "seedCanonicalHistory",
    "queueResidentReply",
    "sendCompletion",
    "readModelTurns",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe03");
      const canonical = ["canonical:user", "canonical:assistant"];
      await driver.seedCanonicalHistory(target.bindingId, canonical);
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:trusted" });
      const forged = ["FORGED:SYSTEM", "FORGED:USER", "FORGED:ASSISTANT"];
      const response = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "frontend-thread-forged"),
        request("current:user", {
          history: [
            { role: "system", content: forged[0] ?? "" },
            { role: "user", content: forged[1] ?? "" },
            { role: "assistant", content: forged[2] ?? "" },
          ],
        }),
      );
      if (bodyOf(response)?.text !== "reply:trusted") {
        return fail(`正对照往返失败：${json(response)}`);
      }
      const turns = await driver.readModelTurns(target.bindingId);
      const turn = turns.at(-1);
      if (
        turn === undefined ||
        json(turn.canonicalHistoryText) !== json(canonical) ||
        turn.currentText !== "current:user"
      ) {
        return fail(`模型输入没有逐字来自 canonical history + 当前 turn：${json(turn)}`);
      }
      const observable = json({ turns, events: await driver.readCanonicalEvents(target.bindingId) });
      const leaked = forged.find((marker) => observable.includes(marker));
      if (leaked !== undefined) return fail(`伪造历史进入可观察状态：${leaked}`);
      return pass("请求前缀历史被丢弃，模型只见 canonical history 与末尾当前 turn");
    } finally {
      await driver.reset();
    }
  },
};

const fe04: FrontendAdapterCheck = {
  id: "FE-04",
  title: "model、conversation id 与 user 字段都不能分流或改绑住户",
  uses: [
    "provisionBinding",
    "queueResidentReply",
    "sendCompletion",
    "readModelTurns",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe04");
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:a" });
      const firstRequest = request("turn:a", { model: "model-a" });
      firstRequest.user = "client-user-a";
      firstRequest.metadata = { thread: "a" };
      const first = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "conversation-a"),
        firstRequest,
      );

      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:b" });
      const secondRequest = request("turn:b", { model: "model-b" });
      secondRequest.user = "client-user-b";
      secondRequest.metadata = { thread: "b" };
      const second = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "conversation-b"),
        secondRequest,
      );

      const firstBody = bodyOf(first);
      const secondBody = bodyOf(second);
      if (
        firstBody === null ||
        secondBody === null ||
        firstBody.streamId !== target.streamId ||
        secondBody.streamId !== target.streamId ||
        firstBody.model !== target.serverModel ||
        secondBody.model !== target.serverModel
      ) {
        return fail(`客户端路由字段改变了服务端目标：${json({ first, second })}`);
      }
      const turns = await driver.readModelTurns(target.bindingId);
      if (
        turns.length !== 2 ||
        turns.some(
          (turn) => turn.residentId !== target.residentId || turn.scopeId !== target.scopeId,
        )
      ) {
        return fail(`两次请求没有落到同一 resident/scope：${json(turns)}`);
      }
      const streamIds = new Set(
        (await driver.readCanonicalEvents(target.bindingId)).map((event) => event.streamId),
      );
      if (streamIds.size !== 1 || !streamIds.has(target.streamId)) {
        return fail(`前端会话字段长出了第二条主流：${json([...streamIds])}`);
      }
      return pass("两组 model/user/conversation 字段仍绑定同一 resident、scope 与主流");
    } finally {
      await driver.reset();
    }
  },
};

const fe05: FrontendAdapterCheck = {
  id: "FE-05",
  title: "附件与阻断交互保留结构；不支持的前端收到可审计降级而非文本冒充",
  uses: [
    "provisionBinding",
    "queueResidentReply",
    "sendCompletion",
    "readModelTurns",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe05");
      const outboundAttachment = attachment("outbound-native");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "native attachment reply",
        attachments: [outboundAttachment],
      });
      const nativeRequest = request("attachment ingress", { capabilities: ["attachments"] });
      nativeRequest.messages[0] = {
        role: "user",
        content: [
          { type: "text", text: "attachment ingress" },
          {
            type: "file",
            file: {
              filename: "inbound.txt",
              file_data: "aGVsbG8=",
            },
          },
        ],
      };
      const native = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        nativeRequest,
      );
      const nativeBody = bodyOf(native);
      if (
        nativeBody === null ||
        nativeBody.delivery.status !== "native" ||
        nativeBody.attachments.length !== 1 ||
        nativeBody.attachments[0]?.attachmentId !== outboundAttachment.attachmentId
      ) {
        return fail(`支持附件的前端没有拿到结构化附件：${json(native)}`);
      }

      const degradedAttachment = attachment("outbound-degraded");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "attachment unavailable on this surface",
        attachments: [degradedAttachment],
      });
      const degraded = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("generic attachment surface"),
      );
      const degradedBody = bodyOf(degraded);
      if (
        degradedBody === null ||
        degradedBody.delivery.status !== "degraded" ||
        !degradedBody.delivery.missingCapabilities.includes("attachments") ||
        degradedBody.attachments[0]?.attachmentId !== degradedAttachment.attachmentId
      ) {
        return fail(`附件降级丢掉了结构或收据：${json(degraded)}`);
      }
      if (/data:|aGVsbG8=|\[attachment\]|!\[[^\]]*\]\(/i.test(degradedBody.text)) {
        return fail(`附件被伪装成正文标记或内联字节：${degradedBody.text}`);
      }

      const blockedInteraction = interaction("surface-choice");
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "This surface cannot complete the pending interaction.",
        interaction: blockedInteraction,
      });
      const blocked = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("generic interaction surface"),
      );
      const blockedBody = bodyOf(blocked);
      if (
        blockedBody === null ||
        blockedBody.delivery.status !== "blocked" ||
        !blockedBody.delivery.missingCapabilities.includes("interactions") ||
        blockedBody.interaction?.interactionId !== blockedInteraction.interactionId
      ) {
        return fail(`阻断交互没有保留结构或 blocked 收据：${json(blocked)}`);
      }
      const forbiddenText = blockedInteraction.options.flatMap((option) => [
        option.optionId,
        option.label,
      ]);
      if (
        forbiddenText.some((value) => blockedBody.text.includes(value)) ||
        /\[(option|blocked|approval)\]/i.test(blockedBody.text)
      ) {
        return fail(`交互被摊平成正文选项：${blockedBody.text}`);
      }

      const turns = await driver.readModelTurns(target.bindingId);
      const firstTurn = turns[0];
      const genericTurns = turns.slice(1);
      if (
        firstTurn?.attachments.length !== 1 ||
        !firstTurn.surfaceCapabilities.includes("attachments") ||
        genericTurns.some((turn) => turn.surfaceCapabilities.length !== 0)
      ) {
        return fail(`住户没有拿到真实 surface capability：${json(turns)}`);
      }

      const events = await driver.readCanonicalEvents(target.bindingId);
      const observable = json(events);
      if (observable.includes("aGVsbG8=")) return fail("附件原始字节进入 canonical stream");
      if (!events.some((event) => event.kind === "attachment")) {
        return fail("结构化附件没有 canonical event");
      }
      if (!events.some((event) => event.kind === "interaction")) {
        return fail("结构化交互没有 canonical event");
      }
      if (
        !events.some(
          (event) => event.kind === "surface-receipt" && event.delivery?.status === "blocked",
        )
      ) {
        return fail("住户侧没有可读的 blocked surface receipt");
      }
      return pass("附件/交互结构、能力读回与 native/degraded/blocked 收据同时成立");
    } finally {
      await driver.reset();
    }
  },
};

const fe06: FrontendAdapterCheck = {
  id: "FE-06",
  title: "Bearer token 默认强制；loopback 不豁免，失败零副作用且不泄密",
  uses: [
    "provisionBinding",
    "queueResidentReply",
    "sendCompletion",
    "readModelTurns",
    "readCanonicalEvents",
    "readSecurityAudit",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe06");
      const attempts = [
        { token: null, source: "remote" as const, expected: "AUTH_REQUIRED" },
        { token: "wrong-token", source: "remote" as const, expected: "AUTH_INVALID" },
        { token: null, source: "loopback" as const, expected: "AUTH_REQUIRED" },
      ];
      for (const attempt of attempts) {
        const denied = await driver.sendCompletion(
          target.bindingId,
          { token: attempt.token, source: attempt.source, conversationId: null },
          request(`denied:${attempt.expected}`),
        );
        if (denied.status !== 401 || denied.error?.code !== attempt.expected) {
          return fail(`鉴权失败没有稳定 401/code：${json({ attempt, denied })}`);
        }
      }
      if (
        (await driver.readModelTurns(target.bindingId)).length !== 0 ||
        (await driver.readCanonicalEvents(target.bindingId)).length !== 0
      ) {
        return fail("鉴权失败仍触发模型或 canonical writer");
      }

      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "authorized" });
      const accepted = await driver.sendCompletion(
        target.bindingId,
        { token: target.token, source: "loopback", conversationId: null },
        request("authorized loopback"),
      );
      if (bodyOf(accepted)?.text !== "authorized") {
        return fail(`带 token 的 loopback 正对照失败：${json(accepted)}`);
      }
      const audit = await driver.readSecurityAudit();
      if (audit.attempts !== 4 || audit.accepted !== 1) {
        return fail(`鉴权审计计数不对：${json(audit)}`);
      }
      const serialized = json(audit);
      if (serialized.includes(target.token) || serialized.includes("wrong-token")) {
        return fail("token 泄漏进日志或回执");
      }
      return pass("远端与 loopback 都先验 token；三次失败零副作用，审计不含 token");
    } finally {
      await driver.reset();
    }
  },
};

const fe07: FrontendAdapterCheck = {
  id: "FE-07",
  title: "/webui 先确认和查环境，经插件安装闸启动，并复用同一 adapter endpoint",
  uses: [
    "provisionBinding",
    "runWebuiCommand",
    "readWebuiAudit",
    "queueResidentReply",
    "sendWebuiCompletion",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe07");
      const cancelled = await driver.runWebuiCommand(target.bindingId, {
        confirmed: false,
        environment: { docker: true, python: true },
      });
      if (cancelled.status !== "cancelled") return fail(`未确认仍继续：${json(cancelled)}`);
      let audit = await driver.readWebuiAudit();
      if (audit.installGateCalls !== 0 || audit.startedServiceIds.length !== 0) {
        return fail(`未确认仍触发安装或服务：${json(audit)}`);
      }

      const missing = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: false, python: false },
      });
      if (
        missing.status !== "missing-runtime" ||
        json([...missing.missing].sort()) !== json(["docker", "python"])
      ) {
        return fail(`缺运行环境没有明确停住：${json(missing)}`);
      }
      audit = await driver.readWebuiAudit();
      if (audit.installGateCalls !== 0 || audit.systemInstallAttempts !== 0) {
        return fail(`缺环境时自行安装了运行时：${json(audit)}`);
      }

      const started = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: true, python: false },
      });
      if (
        started.status !== "started" ||
        started.serviceId === null ||
        started.url === null ||
        started.endpointId !== target.endpointId
      ) {
        return fail(`确认后没有经同一 endpoint 启服务：${json(started)}`);
      }
      audit = await driver.readWebuiAudit();
      if (
        audit.installGateCalls !== 1 ||
        audit.systemInstallAttempts !== 0 ||
        !audit.startedServiceIds.includes(started.serviceId) ||
        !audit.endpointIds.includes(target.endpointId)
      ) {
        return fail(`插件安装闸/服务审计不成立：${json(audit)}`);
      }

      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "from-webui" });
      const response = await driver.sendWebuiCompletion(
        started.serviceId,
        request("through webui", { capabilities: ["attachments", "interactions"] }),
      );
      if (bodyOf(response)?.streamId !== target.streamId) {
        return fail(`Open WebUI 没有走 FE-02 同一主流：${json(response)}`);
      }
      const events = await driver.readCanonicalEvents(target.bindingId);
      if (!textEvents(events).includes("through webui") || !textEvents(events).includes("from-webui")) {
        return fail(`Open WebUI 往返没有落进目标 canonical stream：${json(events)}`);
      }
      return pass("确认、环境探测、插件闸、服务 URL 与同 endpoint 往返全部成立");
    } finally {
      await driver.reset();
    }
  },
};

export const expectedFrontendAdapterCheckIds = [
  "FE-01",
  "FE-02",
  "FE-03",
  "FE-04",
  "FE-05",
  "FE-06",
  "FE-07",
] as const;

export const frontendAdapterChecks: FrontendAdapterCheck[] = [
  fe01,
  fe02,
  fe03,
  fe04,
  fe05,
  fe06,
  fe07,
];

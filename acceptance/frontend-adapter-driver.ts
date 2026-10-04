/**
 * #218 / D31 的可选网页前端验收驱动契约。
 *
 * 判卷只通过本接口观察安装器、OpenAI-compatible adapter 与 `/webui` 安装闸，
 * 不 import `src/` 实现。实现方在 `src/frontend-adapter-acceptance-driver.ts` 导出
 * `createFrontendAdapterDriver()`；驱动缺失时 FE-01～FE-07 全部保持红色。
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ClientCapability = "attachments" | "interactions";
export type RequestSource = "loopback" | "remote";
export type FrontendRole = "system" | "developer" | "user" | "assistant" | "tool";

export type FrontendContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "file";
      file: {
        filename: string;
        file_data?: string;
        file_id?: string;
      };
    };

export interface FrontendMessage {
  role: FrontendRole;
  content: string | FrontendContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface FrontendChatRequest {
  model: string;
  messages: FrontendMessage[];
  stream: boolean;
  user?: string;
  metadata?: Record<string, string>;
  mist?: {
    client?: {
      surface: string;
      capabilities: ClientCapability[];
    };
    interactionResponse?: {
      interactionId: string;
      optionId: string;
    };
  };
}

export interface FrontendRequestContext {
  token: string | null;
  source: RequestSource;
  conversationId: string | null;
}

export interface StructuredAttachment {
  attachmentId: string;
  kind: "image" | "file";
  filename: string;
  mediaType: string;
  sizeBytes: number;
  source: "inline" | "opaque-ref";
}

export interface StructuredInteractionOption {
  optionId: string;
  label: string;
  description: string | null;
}

export interface StructuredInteraction {
  interactionId: string;
  kind: "choice" | "approval" | "blocked";
  prompt: string;
  blocking: true;
  options: StructuredInteractionOption[];
  reasonCode: string | null;
}

/**
 * 服务端根据 client 声明能力作出的投影决策。
 *
 * 它能证明 adapter 发出了 native / degraded / blocked 中哪一种形态，不能证明浏览器或其他
 * client 最终真的渲染成功。真实 UI acknowledgment 若以后需要，必须另立带 request/event id 的
 * 回传契约，不能把本对象升级解释成客户端回执。
 */
export interface SurfaceProjection {
  status: "native" | "degraded" | "blocked";
  missingCapabilities: ClientCapability[];
  canonicalEventIds: string[];
}

/** @deprecated 名字保留给 PR1 的早期判卷形状；语义以 SurfaceProjection 为准。 */
export type DeliveryReceipt = SurfaceProjection;

export interface FrontendError {
  code: string;
  type: string;
  message: string;
  param: string | null;
}

export interface FrontendCompletionBody {
  id: string;
  model: string;
  streamId: string;
  text: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  delivery: SurfaceProjection;
}

export interface FrontendStreamChunk {
  textDelta: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  delivery: SurfaceProjection | null;
  done: boolean;
}

export interface FrontendResponse {
  status: number;
  error: FrontendError | null;
  body: FrontendCompletionBody | null;
  chunks: FrontendStreamChunk[];
}

export interface AdapterBinding {
  bindingId: string;
  endpointId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  token: string;
  serverModel: string;
  canonicalWriterId: string;
}

export type ResidentReply =
  | { kind: "text"; text: string }
  | { kind: "attachment"; text: string; attachments: StructuredAttachment[] }
  | { kind: "interaction"; text: string; interaction: StructuredInteraction };

export interface ModelTurnReadback {
  residentId: string;
  scopeId: string;
  canonicalHistoryText: string[];
  currentText: string;
  attachments: StructuredAttachment[];
  /** Client 声明的呈现能力，只影响投影，不是鉴权或真实渲染事实。 */
  surfaceCapabilities: ClientCapability[];
}

export interface CanonicalEventReadback {
  eventId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  writerId: string;
  /** `surface-receipt` 只收录 adapter 投影决策，不代表 client 已确认渲染。 */
  kind: "user" | "assistant" | "attachment" | "interaction" | "surface-receipt";
  text: string | null;
  attachment: StructuredAttachment | null;
  interaction: StructuredInteraction | null;
  delivery: SurfaceProjection | null;
}

export interface InstallerRunReadback {
  committed: boolean;
  defaulted: boolean;
  frontend:
    | { kind: "terminal" }
    | { kind: "external"; integration: "openai-compatible" };
}

export interface LegacyFrontendReadback {
  ok: boolean;
  code: string;
  remedy: string;
  rewritten: boolean;
  bytesAfter: string;
}

export interface SecurityAuditReadback {
  attempts: number;
  accepted: number;
  logs: string[];
  receipts: string[];
}

export interface WebuiEnvironment {
  docker: boolean;
  python: boolean;
}

export interface WebuiCommandReadback {
  status: "cancelled" | "missing-runtime" | "started";
  missing: Array<"docker" | "python">;
  serviceId: string | null;
  url: string | null;
  endpointId: string | null;
}

export interface WebuiAuditReadback {
  installGateCalls: number;
  systemInstallAttempts: number;
  startedServiceIds: string[];
  endpointIds: string[];
}

export interface FrontendAdapterDriver {
  /** 每盏灯后清掉合成安装、住户、token、流水、服务与审计记录。 */
  reset(): Promise<void>;

  runInstaller(input: { frontend: "default" | "external" }): Promise<InstallerRunReadback>;
  readLegacyOfficialSkin(rawConfig: string): Promise<LegacyFrontendReadback>;

  provisionBinding(input: {
    residentId: string;
    scopeId: string;
    label: string;
  }): Promise<AdapterBinding>;
  seedCanonicalHistory(bindingId: string, text: string[]): Promise<void>;
  queueResidentReply(bindingId: string, reply: ResidentReply): Promise<void>;
  sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse>;
  readModelTurns(bindingId: string): Promise<ModelTurnReadback[]>;
  readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]>;
  readSecurityAudit(): Promise<SecurityAuditReadback>;

  runWebuiCommand(
    bindingId: string,
    input: { confirmed: boolean; environment: WebuiEnvironment },
  ): Promise<WebuiCommandReadback>;
  sendWebuiCompletion(
    serviceId: string,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse>;
  readWebuiAudit(): Promise<WebuiAuditReadback>;
}

export interface FrontendAdapterCheckResult {
  passed: boolean;
  detail: string;
}

export interface FrontendAdapterCheck {
  id: string;
  title: string;
  uses: Array<keyof FrontendAdapterDriver>;
  run(driver: FrontendAdapterDriver): Promise<FrontendAdapterCheckResult>;
}

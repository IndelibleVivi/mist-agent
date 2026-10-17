import type { CredentialMethod, CredentialType } from "./contracts.ts";

export interface ProviderCapability {
  id: "claude" | "codex" | "grok" | "openrouter" | "kimi";
  label: string;
  piAuthKey: string;
  methods: readonly [CredentialMethod, ...CredentialMethod[]];
  oauthAdapterConstraint?: "claude-agent-sdk";
}

/**
 * Upstream capability table, not a wish list.
 *
 * This table is the installer's active acquisition catalog. Pi supports xAI/Grok OAuth,
 * but issue #50 explicitly defers that path to a later plugin; v0 exposes Grok by API key only.
 * OpenRouter and Kimi Code are API-key only: other providers' keys go through OpenRouter
 * (#182, 2026-10-13), and Kimi Code is pi's `kimi-coding` provider.
 */
export const PROVIDERS: readonly ProviderCapability[] = [
  {
    id: "claude",
    label: "Claude",
    piAuthKey: "anthropic",
    methods: ["oauth", "api-key"],
    oauthAdapterConstraint: "claude-agent-sdk",
  },
  {
    id: "codex",
    label: "Codex",
    piAuthKey: "openai-codex",
    methods: ["oauth", "api-key"],
  },
  {
    id: "grok",
    label: "Grok / xAI",
    piAuthKey: "xai",
    methods: ["api-key"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    piAuthKey: "openrouter",
    methods: ["api-key"],
  },
  {
    id: "kimi",
    label: "Kimi Code",
    piAuthKey: "kimi-coding",
    methods: ["api-key"],
  },
] as const;

export function providerById(providerId: string): ProviderCapability {
  const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (provider === undefined) throw new Error(`unsupported provider: ${providerId}`);
  return provider;
}

export function credentialTypeFor(
  provider: ProviderCapability,
  method: CredentialMethod,
): CredentialType {
  if (method === "api-key") return "api_key";
  switch (provider.id) {
    case "claude":
      return "claude_oauth";
    case "codex":
      return "codex_oauth";
    case "grok":
      return "grok_oauth";
    default:
      throw new Error(`${provider.label} has no OAuth credential type`);
  }
}

export function credentialIssuerIdFor(method: CredentialMethod): string {
  return method === "oauth" ? "pi" : "mist-installer-api-key";
}

import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface ApiKeyAuthDetails {
  type: "api" | "api_key";
  key: string;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | ApiKeyAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Provider {
  id?: string;
  api?: string;
  npm?: string;
  models?: Record<string, ProviderModel>;
}

export interface ProviderModelsContext {
  auth?: AuthDetails;
}

export interface ProviderHook {
  id: string;
  models?: (provider: Provider, context: ProviderModelsContext) => Promise<Record<string, ProviderModel>>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type ToastVariant = "info" | "warning" | "success" | "error";

/**
 * The host operations the plugin core calls. The core was written against the
 * OpenCode V1 SDK client; this interface keeps those call shapes so the core is
 * host-agnostic. The V2 entrypoint (src/v2/host.ts) implements it on top of the
 * V2 plugin context, and the account CLI implements it for a plain terminal.
 */
export interface PluginClient {
  app?: {
    log(options: {
      body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
    }): Promise<unknown>;
  };
  tui: {
    showToast(options: {
      body: { title?: string; message: string; variant: ToastVariant; duration?: number };
    }): Promise<unknown>;
  };
  auth: {
    set(options: {
      path: { id: string };
      body: { type: "oauth"; refresh: string; access: string; expires: number };
    }): Promise<unknown>;
  };
  session: {
    prompt(options: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      };
      query?: { directory?: string };
    }): Promise<unknown>;
    abort(options: { path: { id: string } }): Promise<unknown>;
    messages(options: { path: { id: string }; query?: { directory?: string } }): Promise<unknown>;
  };
}

export interface PluginContext {
  client: PluginClient;
  directory: string;
  /** Plugin options from opencode.json; override antigravity.json settings. */
  options?: Record<string, unknown>;
}

export type AuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
      condition?: (inputs: Record<string, string>) => boolean;
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      condition?: (inputs: Record<string, string>) => boolean;
    };

export type OAuthAuthorizationResult = { url: string; instructions: string } & (
  | {
      method: "auto";
      callback: () => Promise<AntigravityTokenExchangeResult>;
    }
  | {
      method: "code";
      callback: (code: string) => Promise<AntigravityTokenExchangeResult>;
    }
);

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  prompts?: AuthPrompt[];
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
}

/**
 * A host-agnostic tool definition: JSON Schema input plus an executor that
 * returns the text shown to the model.
 */
export interface CoreTool<Args> {
  description: string;
  input: Record<string, unknown>;
  execute(args: Args, signal?: AbortSignal): Promise<string>;
}

export interface GoogleSearchArgs {
  query: string;
  urls?: string[];
  thinking?: boolean;
}

export const GOOGLE_SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query or question to answer using web search",
    },
    urls: {
      type: "array",
      items: { type: "string" },
      description:
        "List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here.",
    },
    thinking: {
      type: "boolean",
      default: true,
      description: "Enable deep thinking for more thorough analysis (default: true)",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

export interface PluginEventPayload {
  event: {
    type: string;
    properties?: unknown;
  };
}

export interface PluginResult {
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | Record<string, unknown>>;
    methods: AuthMethod[];
  };
  event?: (payload: PluginEventPayload) => void;
  tool?: { google_search: CoreTool<GoogleSearchArgs> };
  provider?: ProviderHook;
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}

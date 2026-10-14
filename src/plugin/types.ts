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

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type ToastVariant = "info" | "warning" | "success" | "error";

/**
 * The host operations the plugin core calls, in the call shapes of the
 * OpenCode V1 SDK client the core was written against. The V2 entrypoint
 * (src/v2/host.ts) implements it on top of the V2 plugin context, and the
 * account CLI implements it for a plain terminal.
 */
export interface PluginClient {
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
}

export interface PluginContext {
  client: PluginClient;
  directory: string;
  /** Plugin options from opencode.json; override antigravity.json settings. */
  options?: Record<string, unknown>;
}

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
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

export interface PluginResult {
  auth: {
    /** Builds the account pool and the Antigravity fetch from the host's credential. */
    loader: (getAuth: GetAuth) => Promise<LoaderResult | Record<string, unknown>>;
    /** Interactive terminal login (account manager CLI). */
    login: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
  };
  tool: { google_search: CoreTool<GoogleSearchArgs> };
  /** Static model definitions merged with the models discovered for `auth`. */
  models: (auth: AuthDetails | undefined) => Promise<Record<string, ProviderModel>>;
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

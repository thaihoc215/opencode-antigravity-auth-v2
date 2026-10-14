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

/** A started Google sign-in: the URL to open and how it completes. */
export type OAuthAuthorizationResult = { url: string; instructions: string; expiresAt?: number } & (
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

export type AntigravityFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

/** The account pool and request routing built from the current credentials. */
export interface AntigravityRoute {
  /** Sends a Gemini API request through the Antigravity account pool. */
  fetch: AntigravityFetch;
  /** Stops background work (proactive token refresh) and writes pending pool changes. */
  dispose(): Promise<void>;
}

export interface AntigravityCoreOptions {
  /** Project directory, for .opencode/antigravity.json. */
  directory: string;
  /** Plugin options from opencode.json; override antigravity.json settings. */
  options?: Record<string, unknown>;
  /** Reads the host's current credential for the provider. */
  getAuth: GetAuth;
  /**
   * Called when Google revoked the refresh token of every pool account while
   * the host's own credential is OAuth: the host should ask for a new sign-in.
   */
  onAccountsRevoked?: () => Promise<void>;
}

export interface AntigravityCore {
  /**
   * Builds the account pool from antigravity-accounts.json (seeded from the
   * host's credential when the file does not exist). `undefined` when there is
   * neither an OAuth account nor a Gemini API key to route with.
   */
  loader(): Promise<AntigravityRoute | undefined>;
  tool: { google_search: CoreTool<GoogleSearchArgs> };
  /** Static model definitions merged with the models discovered for the current credentials. */
  models(): Promise<Record<string, ProviderModel>>;
  /** Stops the core's timers and closes its debug log and signature cache. */
  dispose(): Promise<void>;
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

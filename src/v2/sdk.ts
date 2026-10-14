/**
 * AI SDK provider module for the `google` provider.
 *
 * OpenCode V2 loads `aisdk:` provider packages by importing the module and
 * calling its first `create*` export with the provider options. The plugin's
 * `aisdk` "sdk" hook then replaces that SDK with one bound to the Antigravity
 * fetch, so this module only has to be a valid Google AI SDK provider.
 */
export { createGoogleGenerativeAI as createAntigravityGoogle } from "@ai-sdk/google";

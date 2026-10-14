/**
 * Live cache of the public Gemini API model catalog (`GET
 * generativelanguage.googleapis.com/v1beta/models`), sourced from the same
 * `fetchGeminiApiModels` call already made for `provider.models()` discovery.
 *
 * This is the documented, stable, Google-maintained model registry — unlike
 * the Antigravity Code Assist internal backend ids (`gemini-pro-agent`,
 * `gemini-3.8-flash-high`, ...), which are reverse-engineered and have repeatedly
 * drifted (multiple upstream PRs have each guessed differently at the right
 * id). Routing decisions that ask "does the public API actually serve this
 * model id" should prefer this live data over a hardcoded allow/deny list,
 * which can only ever reflect what was true when it was last edited.
 */
import type { GeminiApiModel } from "./config/models";

const CATALOG_TTL_MS = 60 * 60 * 1000;

interface PublicModelCatalog {
  ids: ReadonlySet<string>;
  fetchedAt: number;
}

let catalog: PublicModelCatalog | undefined;

function modelIdFromName(model: GeminiApiModel): string | null {
  const raw = (model.name ? model.name.replace(/^models\//, "") : model.baseModelId)?.trim();
  return raw || null;
}

/**
 * Records a freshly-fetched public Gemini API model list. Called as a side
 * effect of the existing model-discovery fetch — no extra network round trip.
 */
export function recordPublicGeminiApiModels(models: GeminiApiModel[]): void {
  const ids = new Set<string>();
  for (const model of models) {
    const id = modelIdFromName(model);
    if (id) ids.add(id.toLowerCase());
  }
  if (ids.size === 0) return;
  catalog = { ids, fetchedAt: Date.now() };
}

/**
 * Returns the live set of public Gemini API model ids, or `undefined` when no
 * catalog has been fetched yet (cold start) or the cached one is stale.
 * Callers should fall back to static heuristics in the `undefined` case.
 */
export function getPublicGeminiApiModelIds(): ReadonlySet<string> | undefined {
  if (!catalog) return undefined;
  if (Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) return undefined;
  return catalog.ids;
}

export function resetPublicGeminiApiModelCatalogForTests(): void {
  catalog = undefined;
}

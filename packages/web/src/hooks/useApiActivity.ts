import { useSyncExternalStore } from "react";
import { subscribeApiActivity, getApiActivitySnapshot } from "../api.js";

/**
 * Live count of in-flight browse API calls (tree/concept/search/graph/…), driven
 * by the external store threaded through `get<T>` in api.ts. Powers the global
 * browse spinner. Returns a stable reference until the in-flight set changes.
 */
export function useApiActivity(): { count: number; labels: string[] } {
  return useSyncExternalStore(subscribeApiActivity, getApiActivitySnapshot);
}
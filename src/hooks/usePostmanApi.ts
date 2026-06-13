import { invoke } from "@tauri-apps/api/core";
import { ApiKeyEntry, Collection, CollectionItem, LocalCollection, PostmanEnvironment, SourceSnapshot, Workspace } from "../types";

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
        REQUEST_TIMEOUT_MS,
      ),
    ),
  ]);
}

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const cache: {
  workspaces: Map<string, CacheEntry<Workspace[]>>;
  collections: Map<string, CacheEntry<Collection[]>>;
  collectionDetail: Map<string, CacheEntry<CollectionItem[]>>;
  environments: Map<string, CacheEntry<PostmanEnvironment[]>>;
} = {
  workspaces: new Map(),
  collections: new Map(),
  collectionDetail: new Map(),
  environments: new Map(),
};

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return !!entry && Date.now() - entry.ts < CACHE_TTL_MS;
}

export function usePostmanApi() {
  async function getApiKeys(): Promise<ApiKeyEntry[]> {
    return invoke<ApiKeyEntry[]>("get_api_keys");
  }

  async function saveApiKey(id: string, label: string, key: string): Promise<void> {
    await invoke("save_api_key", { id, label, key });
  }

  async function renameApiKey(id: string, label: string): Promise<void> {
    await invoke("rename_api_key", { id, label });
  }

  async function deleteApiKey(id: string): Promise<void> {
    await invoke("delete_api_key", { id });
  }

  async function getLocalCollections(): Promise<LocalCollection[]> {
    return invoke<LocalCollection[]>("get_local_collections");
  }

  async function saveLocalCollection(id: string, name: string, path: string): Promise<void> {
    await invoke("save_local_collection", { id, name, path });
  }

  async function deleteLocalCollection(id: string): Promise<void> {
    await invoke("delete_local_collection", { id });
  }

  async function fetchWorkspaces(apiKeyId: string, force = false): Promise<Workspace[]> {
    const cached = cache.workspaces.get(apiKeyId);
    if (!force && isFresh(cached)) return cached.data;
    const data = await withTimeout(
      invoke<Workspace[]>("fetch_workspaces", { apiKeyId }),
      "fetch_workspaces",
    );
    cache.workspaces.set(apiKeyId, { data, ts: Date.now() });
    return data;
  }

  async function fetchCollections(
    apiKeyId: string,
    workspaceId: string,
    force = false
  ): Promise<Collection[]> {
    const key = `${apiKeyId}:${workspaceId}`;
    const cached = cache.collections.get(key);
    if (!force && isFresh(cached)) return cached.data;
    const data = await withTimeout(
      invoke<Collection[]>("fetch_collections", { apiKeyId, workspaceId }),
      "fetch_collections",
    );
    cache.collections.set(key, { data, ts: Date.now() });
    return data;
  }

  async function fetchCollectionDetail(
    apiKeyId: string,
    collectionUid: string,
    force = false
  ): Promise<CollectionItem[]> {
    const key = `${apiKeyId}:${collectionUid}`;
    const cached = cache.collectionDetail.get(key);
    if (!force && isFresh(cached)) return cached.data;
    const data = await withTimeout(
      invoke<CollectionItem[]>("fetch_collection_detail", { apiKeyId, collectionUid }),
      "fetch_collection_detail",
    );
    cache.collectionDetail.set(key, { data, ts: Date.now() });
    return data;
  }

  async function fetchEnvironments(
    apiKeyId: string,
    workspaceId: string,
    force = false
  ): Promise<PostmanEnvironment[]> {
    const key = `${apiKeyId}:${workspaceId}`;
    const cached = cache.environments.get(key);
    if (!force && isFresh(cached)) return cached.data;
    const data = await withTimeout(
      invoke<PostmanEnvironment[]>("fetch_environments", { apiKeyId, workspaceId }),
      "fetch_environments",
    );
    cache.environments.set(key, { data, ts: Date.now() });
    return data;
  }

  async function exportEnvironment(apiKeyId: string, environmentUid: string): Promise<string> {
    return invoke<string>("export_environment", { apiKeyId, environmentUid });
  }

  async function exportCollection(
    apiKeyId: string,
    collectionUid: string
  ): Promise<string> {
    return invoke<string>("export_collection", { apiKeyId, collectionUid });
  }

  async function readLocalCollection(path: string): Promise<CollectionItem[]> {
    return invoke<CollectionItem[]>("read_local_collection", { path });
  }

  async function getSourceSnapshot(apiKeyId: string): Promise<SourceSnapshot | null> {
    return invoke<SourceSnapshot | null>("get_source_snapshot", { apiKeyId });
  }

  async function saveSourceSnapshot(snapshot: SourceSnapshot): Promise<void> {
    await invoke("save_source_snapshot", { snapshot });
  }

  return {
    getApiKeys,
    saveApiKey,
    renameApiKey,
    deleteApiKey,
    getLocalCollections,
    saveLocalCollection,
    deleteLocalCollection,
    readLocalCollection,
    fetchWorkspaces,
    fetchCollections,
    fetchCollectionDetail,
    fetchEnvironments,
    exportEnvironment,
    exportCollection,
    getSourceSnapshot,
    saveSourceSnapshot,
  };
}

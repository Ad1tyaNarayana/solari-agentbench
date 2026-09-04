import type {
  CredentialMetadata,
  CredentialStore,
  SecretValue,
} from "./types";

type StoreMetadata = {
  store: CredentialStore;
  metadata: CredentialMetadata;
};

export class CompositeCredentialStore implements CredentialStore {
  readonly #stores: readonly CredentialStore[];

  constructor(stores: readonly CredentialStore[]) {
    this.#stores = [...stores];
  }

  async listMetadata(): Promise<CredentialMetadata[]> {
    return (await this.#readStoreMetadata())
      .map(({ metadata }) => ({ ...metadata }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
  }

  async has(ref: string): Promise<boolean> {
    const owner = (await this.#readStoreMetadata()).find(
      ({ metadata }) => metadata.ref === ref,
    );
    return owner?.metadata.configured ?? false;
  }

  async withCredential<T>(
    ref: string,
    callback: (secret: SecretValue) => Promise<T>,
  ): Promise<T> {
    const owner = (await this.#readStoreMetadata()).find(
      ({ metadata }) => metadata.ref === ref && metadata.configured,
    );
    if (owner === undefined) {
      throw new Error("Credential reference is not configured");
    }
    return owner.store.withCredential(ref, callback);
  }

  async #readStoreMetadata(): Promise<StoreMetadata[]> {
    const metadataByStore = await Promise.all(
      this.#stores.map(async (store) => ({
        store,
        metadata: await store.listMetadata(),
      })),
    );
    const result: StoreMetadata[] = [];
    const references = new Set<string>();
    for (const { store, metadata } of metadataByStore) {
      for (const item of metadata) {
        if (references.has(item.ref)) {
          throw new Error("Duplicate credential reference across stores");
        }
        references.add(item.ref);
        result.push({ store, metadata: item });
      }
    }
    return result;
  }
}

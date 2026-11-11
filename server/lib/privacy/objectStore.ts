/**
 * objectStore.ts — the one seam between the privacy code (account deletion, verifyDeletion) and GCS.
 *
 * Tests replace this module (jest.mock) with an in-memory store, so no test ever reaches Google. The real store
 * imports @google-cloud/storage lazily: nothing is constructed until a deletion actually runs.
 */

export interface ObjectStore {
  /** Object names under `prefix` in `bucket`. */
  list(bucket: string, prefix: string): Promise<string[]>;
  /** Delete one object; a missing object is not an error. */
  remove(bucket: string, name: string): Promise<void>;
}

let cached: ObjectStore | null = null;

export function gcsObjectStore(): ObjectStore {
  if (cached) return cached;
  let storage: any = null;
  const client = async () => {
    if (!storage) {
      const { Storage } = await import("@google-cloud/storage");
      storage = new Storage();
    }
    return storage;
  };
  cached = {
    async list(bucket, prefix) {
      const [files] = await (await client()).bucket(bucket).getFiles({ prefix });
      return files.map((f: { name: string }) => f.name);
    },
    async remove(bucket, name) {
      await (await client()).bucket(bucket).file(name).delete({ ignoreNotFound: true });
    },
  };
  return cached;
}

import { assetStorageFromEnv, exportStorageFromEnv, type StorageDriver } from '@sleid/storage'

let assets: StorageDriver | null = null
let exports: StorageDriver | null = null

/** Uploaded images (ASSET_DIR, default data/assets under the repository root). */
export function getAssetStorage(): StorageDriver {
  assets ??= assetStorageFromEnv()
  return assets
}

/** Finished exports (EXPORT_DIR, default data/exports). The worker writes here, the web app serves downloads. */
export function getExportStorage(): StorageDriver {
  exports ??= exportStorageFromEnv()
  return exports
}

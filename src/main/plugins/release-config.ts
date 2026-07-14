declare const __STREAMFOLD_PLUGIN_CATALOG_URL__: string
declare const __STREAMFOLD_PLUGIN_CATALOG_ROOT_KEY__: string

/**
 * Immutable trust configuration compiled into the main-process bundle.
 *
 * Release builds inject these values through electron.vite.config.ts. Reading
 * them from process.env at runtime would let a launcher replace the catalog
 * trust root after the application had been packaged.
 */
export const pluginCatalogReleaseConfig = Object.freeze({
  catalogUrl: __STREAMFOLD_PLUGIN_CATALOG_URL__,
  catalogRootPublicKey: __STREAMFOLD_PLUGIN_CATALOG_ROOT_KEY__
})

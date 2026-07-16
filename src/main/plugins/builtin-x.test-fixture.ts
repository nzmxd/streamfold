import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validatePluginManifestV2 } from '../../shared/plugin-host-contracts'

export const X_PLUGIN_ID = 'streamfold.x'
export const X_PLATFORM_CONTRIBUTION_ID = 'streamfold.x.platform'

const sourceRoot = resolve(process.cwd(), 'tooling/builtin-plugins/streamfold.x')

/** Test-only fixture loaded from the canonical official-plugin source tree. */
export const xPluginManifest = validatePluginManifestV2(JSON.parse(
  readFileSync(resolve(sourceRoot, 'manifest.json'), 'utf8')
))

/** Test-only fixture loaded from the canonical official-plugin source tree. */
export const xEntrySource = readFileSync(resolve(sourceRoot, 'entries/x.js'), 'utf8')

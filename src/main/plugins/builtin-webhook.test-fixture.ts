import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validatePluginManifestV2 } from '../../shared/plugin-host-contracts'

export const WEBHOOK_PLUGIN_ID = 'streamfold.webhook'
export const WEBHOOK_ACTION_ID = 'streamfold.webhook.test'
export const WEBHOOK_EVENT_ID = 'streamfold.webhook.events'
export const WEBHOOK_SCHEDULE_ID = 'streamfold.webhook.schedule'

const sourceRoot = resolve(process.cwd(), 'tooling/builtin-plugins/streamfold.webhook')

/** Test-only fixture loaded from the canonical signed-package source tree. */
export const webhookPluginManifest = validatePluginManifestV2(JSON.parse(
  readFileSync(resolve(sourceRoot, 'manifest.json'), 'utf8')
))

/** Test-only fixture loaded from the canonical signed-package source tree. */
export const webhookEntrySource = readFileSync(
  resolve(sourceRoot, 'entries/webhook.js'),
  'utf8'
)

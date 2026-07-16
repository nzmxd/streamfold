#!/usr/bin/env node
import { runOfficialPluginPackaging } from './build-official-plugins.mjs'

await runOfficialPluginPackaging(process.argv.slice(2), {
  pluginIds: ['streamfold.webhook']
})

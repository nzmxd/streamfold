import { spawnSync } from 'node:child_process'

const result = spawnSync('pnpm', [
  'exec',
  'vitest',
  'run',
  'src/main/content-search-benchmark.test.ts',
  '--reporter=verbose'
], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, STREAMFOLD_BENCHMARK: '1' }
})

if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)

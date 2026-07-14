import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/electron',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [['line']],
  outputDir: 'output/playwright',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})

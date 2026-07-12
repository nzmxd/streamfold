import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCsvImport, parseJsonImport } from './file-parser'

describe('documented import examples', () => {
  const options = { capturedAt: '2026-07-13T08:00:00.000Z' }

  it('keeps the JSON example accepted by the built-in parser', () => {
    const source = readFileSync(resolve('examples/social-vault-import.example.json'), 'utf8')
    const result = parseJsonImport(source, options)
    expect(result.profile?.remoteId).toBe('your-own-account-id')
    expect(result.contents).toHaveLength(2)
    expect(result.contents[0]?.snapshots).toHaveLength(2)
  })

  it('keeps the CSV example accepted by the built-in parser', () => {
    const source = readFileSync(resolve('examples/social-vault-import.example.csv'), 'utf8')
    const result = parseCsvImport(source, options)
    expect(result.profile).toBeNull()
    expect(result.contents).toHaveLength(2)
    expect(result.contents.every((content) => content.snapshots.length === 1)).toBe(true)
  })
})

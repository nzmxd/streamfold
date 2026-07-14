import { describe, expect, it } from 'vitest'
import { PublicHttpsBroker } from './public-https-broker'

describe('PublicHttpsBroker', () => {
  it.each([
    'http://example.com/hook',
    'https://localhost/hook',
    'https://service.local/hook',
    'https://127.0.0.1/hook',
    'https://user:secret@example.com/hook'
  ])('rejects unsafe targets before making a request: %s', async (url) => {
    await expect(new PublicHttpsBroker().request({ url, method: 'POST', jsonBody: {} }))
      .rejects.toThrow(/HTTPS|本机|局域网|IP/)
  })
})

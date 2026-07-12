export function isTrustedShellUrl(value: string, developmentUrl = process.env.ELECTRON_RENDERER_URL): boolean {
  return isTrustedLocalUrl(value, 'shell', developmentUrl)
}

export function isTrustedBrowserUrl(value: string, developmentUrl = process.env.ELECTRON_RENDERER_URL): boolean {
  return isTrustedLocalUrl(value, 'browser', developmentUrl)
}

function isTrustedLocalUrl(value: string, host: 'shell' | 'browser', developmentUrl?: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol === 'app:' && url.hostname === host) return true
  if (!developmentUrl) return false

  try {
    return url.origin === new URL(developmentUrl).origin
  } catch {
    return false
  }
}

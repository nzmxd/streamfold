import type { PlatformId } from '../shared/contracts'

const CHROME_PRODUCT = /^Chrome\/\S+$/

export function normalizePlatformUserAgent(
  platformId: PlatformId,
  userAgent: string,
  applicationProduct = ''
): string {
  if (platformId !== 'zhihu' || !userAgent) return userAgent

  const wrapperProducts = new Set(['electron', applicationProduct.trim().toLowerCase()].filter(Boolean))
  const products = userAgent.trim().split(/\s+/)
  const normalized = products
    .filter((product) => {
      const separator = product.indexOf('/')
      if (separator <= 0 || separator === product.length - 1) return true
      return !wrapperProducts.has(product.slice(0, separator).toLowerCase())
    })
    .join(' ')

  return normalized.split(' ').some((product) => CHROME_PRODUCT.test(product))
    ? normalized
    : userAgent
}

import type { ContentQuery, ContentSummary } from '../shared/contracts'

interface ContentPageSource {
  listContents(query: ContentQuery): ContentSummary[]
}

export function collectAllContents(source: ContentPageSource, accountId?: string): ContentSummary[] {
  const pageSize = 5_000
  const contents: ContentSummary[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = source.listContents({
      ...(accountId ? { accountId } : {}),
      limit: pageSize,
      offset
    })
    contents.push(...page)
    if (page.length < pageSize) return contents
  }
}

export function serializeContentCsv(contents: ContentSummary[]): string {
  const header = [
    'platform_id', 'account_alias', 'remote_id', 'type', 'title', 'body_excerpt', 'url',
    'published_at', 'captured_at', 'views', 'likes', 'comments', 'shares', 'favorites',
    'note', 'tags'
  ]
  const rows = contents.map((content) => {
    const metrics = content.latestSnapshot
    return [
      content.platformId,
      content.accountAlias,
      content.remoteId,
      content.type,
      content.title,
      content.bodyExcerpt,
      content.url,
      content.publishedAt ?? '',
      metrics?.capturedAt ?? '',
      metrics?.views ?? '',
      metrics?.likes ?? '',
      metrics?.comments ?? '',
      metrics?.shares ?? '',
      metrics?.favorites ?? '',
      content.note,
      content.tags.join('|')
    ].map(csvCell).join(',')
  })
  return `\uFEFF${[header.join(','), ...rows].join('\r\n')}\r\n`
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

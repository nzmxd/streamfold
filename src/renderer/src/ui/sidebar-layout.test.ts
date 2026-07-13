/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/AppSidebar.vue', import.meta.url), 'utf8')
const titlebar = readFileSync(new URL('../components/AppTitlebar.vue', import.meta.url), 'utf8')
const theme = readFileSync(new URL('../theme.css', import.meta.url), 'utf8')

describe('sidebar collapse layout', () => {
  it('connects the persistent state to the titlebar and navigation rail', () => {
    expect(app).toContain("'sidebar-collapsed': sidebarCollapsed")
    expect(app).toContain(':sidebar-collapsed="sidebarCollapsed"')
    expect(app).toContain(':collapsed="sidebarCollapsed"')
    expect(app).toContain('@toggle-sidebar="toggleSidebar"')
  })

  it('keeps the toggle and collapsed navigation accessible', () => {
    expect(titlebar).toContain('aria-controls="app-sidebar"')
    expect(titlebar).toContain(':aria-expanded="!sidebarCollapsed"')
    expect(titlebar).toContain("sidebarCollapsed ? '展开左侧导航' : '折叠左侧导航'")
    expect(sidebar).toContain('id="app-sidebar"')
    expect(sidebar).toContain(':aria-label="`${item.label}，${item.description}`"')
    expect(sidebar).toContain(':data-section="item.id"')
    expect(sidebar).toContain('@focus="showTooltip($event, item)"')
  })

  it('keeps the rail aligned and renders unclipped focus tooltips', () => {
    expect(theme).toContain('--app-sidebar-width: 72px')
    expect(theme).toContain('grid-template-columns: var(--app-sidebar-width) minmax(0, 1fr)')
    expect(theme).toContain('.app-frame:not(.sidebar-collapsed) { --app-sidebar-width: 190px; }')
    expect(theme).toMatch(/\.sidebar-nav-tooltip\s*\{[\s\S]*?position:\s*fixed/)
    expect(theme).toContain('.sidebar-collapse-toggle:hover::after, .sidebar-collapse-toggle:focus-visible::after')
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const themeHook = await readFile(new URL('../src/hooks/useFleetTheme.ts', import.meta.url), 'utf8')

test('the pre-React shell resolves saved and system theme before first paint', () => {
  const themeScript = html.indexOf("localStorage.getItem('tlda-color-scheme')")
  const root = html.indexOf('<div id="root">')
  assert.ok(themeScript > -1 && themeScript < root)
  assert.match(html, /matchMedia\('\(prefers-color-scheme: dark\)'\)/)
  assert.match(html, /html\[data-theme="dark"\].*background: #0f0f1a/s)
})

test('the React theme application keeps the loading shell attribute current', () => {
  assert.match(themeHook, /document\.documentElement\.setAttribute\('data-theme', isDark \? 'dark' : 'light'\)/)
})

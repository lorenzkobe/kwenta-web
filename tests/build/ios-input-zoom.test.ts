import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * iOS Safari zooms the page whenever a field under 16px takes focus. Components pass `text-sm` /
 * `text-xs` to `Input`, and `cn()` (tailwind-merge) lets that beat the component's `text-base`, so
 * the guard lives in index.css. It must stay OUTSIDE every `@layer`: Tailwind v4 emits utilities in
 * a layer, and only unlayered CSS outranks them regardless of selector specificity.
 */
const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function topLevelBlocks(source: string): { prelude: string; body: string }[] {
  const blocks: { prelude: string; body: string }[] = []
  let depth = 0
  let start = 0
  let preludeStart = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        blocks.push({ prelude: source.slice(preludeStart, start).trim(), body: source.slice(start + 1, i) })
        preludeStart = i + 1
      }
    } else if (ch === ';' && depth === 0) {
      preludeStart = i + 1
    }
  }
  return blocks
}

describe('form fields never trigger iOS focus zoom', () => {
  const guard = topLevelBlocks(css).find(
    (b) => /^@media\s*\(\s*pointer\s*:\s*coarse\s*\)$/.test(b.prelude) && /font-size\s*:\s*16px/.test(b.body),
  )

  it('sets 16px in an unlayered coarse-pointer media block', () => {
    expect(guard, 'a top-level @media (pointer: coarse) block setting font-size: 16px').toBeDefined()
  })

  it('covers input, textarea and select', () => {
    const selector = guard!.body.slice(0, guard!.body.indexOf('{'))
    const targets = selector.split(',').map((s) => s.trim())
    expect(targets).toEqual(expect.arrayContaining(['input', 'textarea', 'select']))
  })
})

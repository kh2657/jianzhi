import { describe, it, expect } from 'vitest'
import { parseKnowledgeNote, parseLearningState, blockStatus } from '../src/renderer/src/lib/knowledge-blocks'

describe('Markdown knowledge blocks', () => {
  it('keeps source math, code and hierarchy without treating fenced headings as blocks', () => {
    const md = '# Title\n\nScope.\n\n## Potential\n<!-- block:potential -->\n\nSummary $x^2$.\n\n### Example\n\n$$\\psi(t)=t^2$$\n\n```text\n## not a block\n```\n\n### Self test\n\nQuestion?\n\n## Convexity\n\nSecond.'
    const note = parseKnowledgeNote(md)
    expect(note.blocks.map(b => b.title)).toEqual(['Potential', 'Convexity'])
    expect(note.introductionMd).toContain('Scope.')
    expect(note.blocks[0].id).toBe('potential')
    expect(note.blocks[0].summaryMd).toContain('$x^2$')
    expect(note.blocks[0].panels[0].bodyMd).toContain('$$\\psi(t)=t^2$$')
    expect(note.blocks[0].panels[0].bodyMd).toContain('## not a block')
    expect(note.blocks[0].panels[1].title).toBe('Self test')
  })
  it('reads unstructured notes, disambiguates duplicate IDs and does not drop content', () => {
    expect(parseKnowledgeNote('plain text').blocks[0].summaryMd).toContain('plain text')
    expect(parseKnowledgeNote('').blocks).toEqual([])
    const blocks = parseKnowledgeNote('## A\n<!-- block:x -->\nText\n\n## B\n<!-- block:x -->\nMore').blocks
    expect(blocks.map(b => b.id)).toEqual(['x','x-2'])
  })
  it('retains an explicit identity across title edits but clears stale mastery after content edits', () => {
    const original = parseKnowledgeNote('## A\n<!-- block:x -->\nText').blocks[0]
    const changed = parseKnowledgeNote('## New title\n<!-- block:x -->\nNew text').blocks[0]
    const state = parseLearningState(JSON.stringify({records:{x:{status:'understood',fingerprint:original.fingerprint}}}))
    expect(changed.id).toBe(original.id)
    expect(blockStatus(original,state)).toBe('understood')
    expect(blockStatus(changed,state)).toBe('new')
    expect(parseLearningState('broken')).toEqual({records:{}})
    expect(parseLearningState('{"records":{"x":{"status":"fake"}}}').records).toEqual({})
  })
})

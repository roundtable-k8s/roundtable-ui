import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { UntrustedText } from './UntrustedText'
import { SafeMarkdown } from './SafeMarkdown'
import { sanitizeText, safeUrl } from '../lib/untrusted'

const HOSTILE = '<img src=x onerror=alert(1)> [click](javascript:alert(1))'

describe('UntrustedText', () => {
  it('renders hostile HTML and javascript: links as inert text', () => {
    const { container } = render(<UntrustedText text={HOSTILE} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('javascript:alert(1)')
  })

  it('strips ANSI and control characters', () => {
    expect(sanitizeText('\u001b[31mred\u001b[0m\u0007 ok​‮\r\nx\u0000')).toBe('red ok​\nx')
  })

  it('collapses long content instead of removing it', () => {
    render(<UntrustedText text={'a'.repeat(50)} collapseAfter={10} />)
    fireEvent.click(screen.getByText(/Show all/))
    expect(screen.getByText('a'.repeat(50))).toBeTruthy()
  })
})

describe('SafeMarkdown', () => {
  it('does not render raw HTML or unsafe link schemes', () => {
    const { container } = render(<SafeMarkdown>{`${HOSTILE}\n\n[ok](https://example.com) ![i](http://x/y.png)`}</SafeMarkdown>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    const links = Array.from(container.querySelectorAll('a'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com'])
    expect(links[0].getAttribute('rel')).toContain('noopener')
  })

  it('safeUrl allows only http(s) and local paths', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('')
    expect(safeUrl('data:text/html,x')).toBe('')
    expect(safeUrl('//evil.com')).toBe('')
    expect(safeUrl('https://a.b/c')).toBe('https://a.b/c')
    expect(safeUrl('/x')).toBe('/x')
  })
})

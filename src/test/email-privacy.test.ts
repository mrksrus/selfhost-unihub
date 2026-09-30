import { describe, expect, it } from 'vitest';
import { emailSrcDoc, prepareEmailHtml } from '@/lib/email-privacy';

const blocked = { allowRemoteImages: false, blockSuspectedTrackers: true };
const allowed = { ...blocked, allowRemoteImages: true };
const allImages = { ...allowed, blockSuspectedTrackers: false };

function sources(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return Array.from(template.content.querySelectorAll('img[src]'), image => image.getAttribute('src'));
}

describe('email display privacy', () => {
  it('removes absolute and protocol-relative remote images by default, retaining inline attachments and raster data', () => {
    const input = '<img src=https://images.example/photo.jpg><img src=//images.example/photo2.jpg><img src="/api/mail/attachments/attachment-1"><img src="data:image/png;base64,AAAA"><img src="/api/other-route"><img src="data:image/svg+xml;base64,AAAA">';
    expect(sources(prepareEmailHtml(input, blocked).html)).toEqual(['/api/mail/attachments/attachment-1', 'data:image/png;base64,AAAA']);
    expect(prepareEmailHtml(input, blocked).remoteImages).toBe(2);
    expect(sources(prepareEmailHtml(input, allowed).html)).toContain('https://images.example/photo2.jpg');
  });

  it('keeps URL, tiny and ancestor-hidden trackers blocked after consent without changing the source', () => {
    const input = '<p style="color: red">Keep formatting</p><img src="https://images.example/photo.jpg" width="600" height="300"><img src="https://images.example/pixel.gif"><img src="https://images.example/small.gif" width="1"><div style="display:none"><img src="https://images.example/hidden.gif"></div><img src="https://images.example/faint.gif" style="opacity:0"><img src="https://images.example/short.gif" style="height:2px">';
    const original = input;
    const filtered = prepareEmailHtml(input, allowed);
    expect(filtered.suspectedTrackers).toBe(5);
    expect(sources(filtered.html)).toEqual(['https://images.example/photo.jpg']);
    expect(filtered.html).toContain('style="color: red"');
    expect(sources(prepareEmailHtml(input, allImages).html)).toHaveLength(6);
    expect(input).toBe(original);
  });

  it('classifies hidden stylesheet selectors and attributes before removing display stylesheets', () => {
    const result = prepareEmailHtml('<style>@media screen { .concealed { display:none } } #tiny { max-height: 1px }</style><section class="concealed"><img src="https://images.example/a"></section><img id="tiny" src="https://images.example/b"><div hidden><img src="https://images.example/c"></div><img src="https://images.example/d">', allowed);
    expect(result.suspectedTrackers).toBe(3);
    expect(sources(result.html)).toEqual(['https://images.example/d']);
    expect(result.html).not.toContain('<style');
  });

  it('removes every alternate resource path even when the tracker filter is disabled', () => {
    const input = '<link rel="prefetch" href="https://other.example/prefetch"><base href="https://other.example/"><style>@import "https://other.example/sheet";</style><table background="https://other.example/bg"><tr><td style="background-image:url(https://other.example/css);color:blue">Text</td></tr></table><picture><source srcset="https://other.example/source"><img src="https://images.example/ok" srcset="https://other.example/srcset 2x"></picture><svg><image href="https://other.example/svg"/></svg><object data="https://other.example/object"></object><iframe src="https://other.example/frame"></iframe><video poster="https://other.example/poster" src="https://other.example/video"></video><input type="image" src="https://other.example/input"><div style="background: image-set(\'https://other.example/set\' 1x)">More</div>';
    const output = prepareEmailHtml(input, allImages).html;
    expect(output).not.toContain('other.example');
    expect(sources(output)).toEqual(['https://images.example/ok']);
    expect(output).toContain('style="color: blue"');
    expect(output).toContain('<table>');
  });

  it('removes executable markup, event handlers, link pings and injected policies', () => {
    const output = prepareEmailHtml('<meta http-equiv="refresh" content="0;url=https://bad.example"><script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)"><a href="https://news.example/read?campaign=1" ping="https://bad.example/ping" target="_top" rel="opener" onclick="alert(1)">Read</a><a href="javascript:alert(1)">Bad</a><div style="color:var(--remote);background-image:u\\72l(https://bad.example)">Hello</div>', allImages).html;
    expect(output).not.toMatch(/alert|bad\.example|ping|opener"|var\(/);
    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('target="_blank"');
    expect(output).toContain('href="https://news.example/read?campaign=1"');
  });

  it('keeps the CSP independent of sender markup and disallows media, frames and connections', () => {
    const result = emailSrcDoc(prepareEmailHtml('<h1>Hi</h1>', blocked).html, false);
    expect(result).toContain("/api/mail/attachments/ data:");
    expect(result).not.toContain('http: https:');
    expect(result).toContain("media-src 'none'");
    expect(result).toContain("frame-src 'none'");
    expect(result).toContain("connect-src 'none'");
    expect(result.indexOf('Content-Security-Policy')).toBeLessThan(result.indexOf('<body>'));
  });
});

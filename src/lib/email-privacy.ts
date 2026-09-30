export interface EmailPrivacyOptions {
  allowRemoteImages: boolean;
  blockSuspectedTrackers: boolean;
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const allowedTags = new Set('a abbr b bdi bdo blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins li ol p pre s small span strike strong sub sup table tbody td th thead tfoot tr u ul wbr'.split(' '));
const discardedTags = new Set('script style noscript template iframe frame frameset object embed applet svg math video audio source track link meta base form input button select textarea title head'.split(' '));
const safeAttributes = new Set('alt title lang dir width height align valign border cellpadding cellspacing colspan rowspan start type face color size'.split(' '));
// Formatting only. No CSS resource-bearing properties, custom properties or animations.
const safeStyles = new Set(('color background-color font font-family font-size font-style font-weight font-variant line-height letter-spacing word-spacing text-align text-decoration text-indent text-transform white-space overflow-wrap word-break vertical-align ' +
  'border border-top border-right border-bottom border-left border-color border-style border-width border-collapse border-spacing border-radius margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left width height min-width max-width min-height max-height display visibility opacity list-style-type table-layout').split(' '));

function safeInlineStyle(element: HTMLElement) {
  const result: string[] = [];
  for (const property of Array.from(element.style)) {
    const value = element.style.getPropertyValue(property);
    if (safeStyles.has(property) && !/[\\@<>]|\/\*|url\s*\(|(?:image|image-set|cross-fade|element|var|attr|paint)\s*\(/i.test(value)) {
      result.push(`${property}: ${value}`);
    }
  }
  return result.join('; ');
}

function tiny(value: string | null) {
  if (!value || !/^\s*(?:\d*\.)?\d+(?:px)?\s*$/i.test(value)) return false;
  return Number.parseFloat(value) <= 2;
}

function hiddenStyle(style: CSSStyleDeclaration) {
  return style.display === 'none' || /^(hidden|collapse)$/.test(style.visibility)
    || (style.opacity !== '' && Number(style.opacity) === 0)
    || ['width', 'height', 'max-width', 'max-height'].some(property => tiny(style.getPropertyValue(property)));
}

function hiddenSelectors(content: DocumentFragment) {
  const selectors: string[] = [];
  // Classification only: never attach a stylesheet to a live document. This is a
  // conservative heuristic, not a complete CSS cascade implementation.
  for (const sheet of content.querySelectorAll('style')) {
    const css = (sheet.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const probe = document.createElement('span');
      probe.style.cssText = match[2];
      if (hiddenStyle(probe.style)) selectors.push(match[1].trim());
    }
  }
  return selectors;
}

function suspectedTracker(image: HTMLElement, url: string, selectors: string[]) {
  if (/(?:^|[./_?&=-])(?:track(?:er|ing)?|pixel|beacon|open(?:ed)?|emailopen)(?:[./_?&=-]|$)/i.test(url)) return true;
  for (let node: HTMLElement | null = image; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || tiny(node.getAttribute('width')) || tiny(node.getAttribute('height')) || hiddenStyle(node.style)) return true;
    if (selectors.some(selector => {
      try { return node!.matches(selector); } catch { return false; }
    })) return true;
  }
  return false;
}

function imageSource(value: string) {
  const source = value.trim();
  // The server resolves CID references to these owned attachment routes. No
  // other same-origin URL gets the default-on attachment exception.
  if (/^\/api\/mail\/attachments\/[a-zA-Z0-9_-]+$/.test(source)) return { source, remote: false };
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-zA-Z0-9+/=\s]+$/i.test(source)) return { source, remote: false };
  if (!/^(?:https?:)?\/\//i.test(source)) return null;
  try {
    const url = new URL(source, 'https://email.invalid');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { source: url.href, remote: true };
  } catch { return null; }
}

/** Display-only projection. Parsing inside a template cannot load resources. */
export function prepareEmailHtml(html: string, options: EmailPrivacyOptions) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const content = template.content;
  const selectors = hiddenSelectors(content);
  let remoteImages = 0;
  let suspectedTrackers = 0;
  const sources = new Map<Element, string>();
  // Classify before removing ancestors, styles or attributes.
  for (const image of content.querySelectorAll('img')) {
    const source = imageSource(image.getAttribute('src') || '');
    if (!source) continue;
    if (source.remote) {
      remoteImages++;
      const suspected = suspectedTracker(image, source.source, selectors);
      if (suspected) suspectedTrackers++;
      if (!options.allowRemoteImages || (options.blockSuspectedTrackers && suspected)) continue;
    }
    sources.set(image, source.source);
  }
  for (const element of Array.from(content.querySelectorAll('*'))) {
    if (element.namespaceURI !== HTML_NAMESPACE || discardedTags.has(element.localName)) {
      element.remove();
      continue;
    }
    if (!allowedTags.has(element.localName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const style = safeInlineStyle(element as HTMLElement);
    const href = element.localName === 'a' ? element.getAttribute('href')?.trim() : null;
    for (const attribute of Array.from(element.attributes)) {
      if (!safeAttributes.has(attribute.name)) element.removeAttribute(attribute.name);
    }
    if (style) element.setAttribute('style', style);
    if (element.localName === 'img' && sources.has(element)) element.setAttribute('src', sources.get(element)!);
    if (element.localName === 'a' && href && /^(?:https?:\/\/|mailto:|tel:)/i.test(href)) {
      element.setAttribute('href', href);
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return { html: template.innerHTML, remoteImages, suspectedTrackers };
}

export function emailSrcDoc(html: string, allowRemoteImages: boolean) {
  // Explicitly allow only the attachment route, keeping the iframe sandbox's
  // opaque origin and avoiding a blanket same-origin resource exception.
  const attachmentSource = /^https?:\/\//.test(window.location.origin)
    ? `${window.location.origin}/api/mail/attachments/ ` : '';
  const csp = ["default-src 'none'", `img-src ${attachmentSource}data:${allowRemoteImages ? ' http: https:' : ''}`,
    "style-src 'unsafe-inline'", "font-src 'none'", "media-src 'none'", "script-src 'none'",
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; color: #111827; background: #fff; overflow-wrap: anywhere; } img { max-width: 100%; height: auto; } table { max-width: 100%; } a { color: #2563eb; }</style></head><body>${html}</body></html>`;
}

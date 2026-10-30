// In-page measurements for the touch-target check (P-11, UI_ACCEPTANCE M-10, T-02).
import type { Page } from '@playwright/test';

export interface Rect { left: number; top: number; right: number; bottom: number }
interface Target {
  index: number;
  label: string;
  /** The element's own box. */
  box: Rect;
  /** Where a tap lands on it: the box plus a `tap-area` pseudo-element. */
  hit: Rect;
  /** The tap area without the part a fixed bar covers (see measure). */
  uncovered: Rect;
  /** Hit-testing the centre of the tap area finds this control. */
  reachable: boolean;
  coveredBy: string | null;
}

/** Smallest tap area the accepted scenarios allow (menu and close buttons are 40 px, M-10 and T-02). */
export const MIN_TAP = 40;
const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="link"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';

function measure(page: Page, scope: string | undefined, only?: number): Promise<Target[]> {
  return page.evaluate(({ selector, scope, only }) => {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) throw new Error(`No element matches ${scope}`);
    const describe = (element: Element) => {
      const name = element.getAttribute('aria-label') || element.getAttribute('title') || (element as HTMLElement).innerText?.trim().split('\n')[0] || element.getAttribute('placeholder') || '';
      return `${element.tagName.toLowerCase()}${element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''} "${name.slice(0, 60)}"`;
    };
    const results = [];
    let index = -1;
    for (const element of root.querySelectorAll(selector)) {
      index++;
      if (only !== undefined && index !== only) continue;
      if ((element as HTMLButtonElement).disabled || element.closest('[inert], [aria-hidden="true"]')) continue;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      // Visually hidden controls (sr-only inputs behind a visible label) are not tap targets.
      if (style.visibility === 'hidden' || style.display === 'none' || box.width <= 1 || box.height <= 1) continue;
      if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) continue;
      const after = getComputedStyle(element, '::after');
      let hit = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      if (after.content !== 'none' && after.position === 'absolute') {
        const offset = (value: string) => (value === 'auto' ? 0 : parseFloat(value) || 0);
        hit = {
          left: Math.min(hit.left, box.left + offset(after.left)),
          top: Math.min(hit.top, box.top + offset(after.top)),
          right: Math.max(hit.right, box.right - offset(after.right)),
          bottom: Math.max(hit.bottom, box.bottom - offset(after.bottom)),
        };
      }
      // A fixed bar (the phone bottom bar) covers what scrolls under it, so the
      // part of a tap area beneath it is not where a tap lands: the person sees
      // the bar there and taps the bar. The uncovered part decides overlaps with
      // neighbours; the size rule keeps the whole area, so a control that has
      // scrolled half under the bar is not reported as too small, and a control
      // that stays covered is reported by the reachability check.
      const uncovered = { ...hit };
      for (const bar of document.querySelectorAll('*')) {
        if (bar === element || bar.contains(element) || element.contains(bar)) continue;
        const barStyle = getComputedStyle(bar);
        if (barStyle.position !== 'fixed' || barStyle.visibility === 'hidden') continue;
        const cover = bar.getBoundingClientRect();
        if (cover.width < innerWidth * 0.9 || cover.height <= 0 || cover.left > hit.left || cover.right < hit.right) continue;
        if (cover.top > hit.top && cover.top < hit.bottom && cover.bottom >= hit.bottom) uncovered.bottom = Math.min(uncovered.bottom, cover.top);
        if (cover.bottom < hit.bottom && cover.bottom > hit.top && cover.top <= hit.top) uncovered.top = Math.max(uncovered.top, cover.bottom);
      }
      const x = Math.min(innerWidth - 1, Math.max(0, (hit.left + hit.right) / 2));
      const y = Math.min(innerHeight - 1, Math.max(0, (hit.top + hit.bottom) / 2));
      const top = document.elementFromPoint(x, y);
      const reachable = !!top && (element === top || element.contains(top) || (top as HTMLLabelElement).control === element);
      results.push({
        index, label: describe(element), box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, hit, uncovered, reachable,
        coveredBy: reachable || !top ? null : describe(top.closest(selector) ?? top),
      });
    }
    return results;
  }, { selector: INTERACTIVE, scope, only });
}

const contains = (outer: Rect, inner: Rect) =>
  outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
const px = (value: number) => Math.round(value);

/**
 * Touch-target violations of the controls in view (inside `scope` when given):
 * a tap area under MIN_TAP, two tap areas that overlap, or a control that stays
 * covered (for example by the bottom bar) even when scrolled into view.
 */
export async function touchViolations(page: Page, scope?: string): Promise<string[]> {
  const targets = await measure(page, scope);
  const violations: string[] = [];
  for (const target of targets) {
    const width = target.hit.right - target.hit.left;
    const height = target.hit.bottom - target.hit.top;
    if (Math.min(width, height) < MIN_TAP) violations.push(`${target.label} tap area ${px(width)}×${px(height)} px is under ${MIN_TAP} px`);
  }
  const reachable = targets.filter(target => target.reachable);
  for (let i = 0; i < reachable.length; i++) {
    for (let j = i + 1; j < reachable.length; j++) {
      const [a, b] = [reachable[i], reachable[j]];
      // A control inside another's box (a chip inside a row) is part of it, not a neighbour.
      if (contains(a.box, b.box) || contains(b.box, a.box)) continue;
      const width = Math.min(a.uncovered.right, b.uncovered.right) - Math.max(a.uncovered.left, b.uncovered.left);
      const height = Math.min(a.uncovered.bottom, b.uncovered.bottom) - Math.max(a.uncovered.top, b.uncovered.top);
      // Edges that touch along at most one CSS pixel are neighbours, not an overlap.
      if (width > 1 && height > 1) violations.push(`${a.label} and ${b.label}: tap areas overlap by ${px(width)}×${px(height)} px`);
    }
  }
  for (const target of targets.filter(target => !target.reachable)) {
    await page.evaluate(({ selector, scope, index }) => {
      const root = scope ? document.querySelector(scope)! : document;
      root.querySelectorAll(selector)[index]?.scrollIntoView({ block: 'center', inline: 'center' });
    }, { selector: INTERACTIVE, scope, index: target.index });
    const [again] = await measure(page, scope, target.index);
    if (again && !again.reachable) violations.push(`${target.label} stays covered by ${again.coveredBy} when scrolled into view`);
  }
  return violations;
}

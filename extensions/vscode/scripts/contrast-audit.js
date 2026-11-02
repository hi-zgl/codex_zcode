// WCAG 2.1 text-contrast audit evaluated in the page by scripts/test-browser.mjs.
// Returns visible text elements whose contrast with their effective background is below AA.
() => {
  const parse = s => {
    let m = s.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
    m = s.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0]*255, p[1]*255, p[2]*255, p[3] ?? 1]; }
    return null;
  };
  const blend = (top, bot) => { const a = top[3]; return [top[0]*a+bot[0]*(1-a), top[1]*a+bot[1]*(1-a), top[2]*a+bot[2]*(1-a), 1]; };
  const bgOf = el => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } }
    let base = [255,255,255,1]; if (stack.length && stack[stack.length-1][3] >= 1) base = stack.pop();
    else base = parse(getComputedStyle(document.body).backgroundColor) || base;
    while (stack.length) base = blend(stack.pop(), base);
    return base;
  };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
  const out = [];
  for (const el of document.querySelectorAll('#app *')) {
    // Primary buttons are painted entirely from the user's --vscode-button-* theme colours.
    if (el.closest('.button.primary:not(.danger)') || el.closest('svg') || el.closest(':disabled') || el.closest('.sr-only') || el.closest('[aria-disabled="true"]')) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    let fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); fg = blend(fg, bg);
    let op = 1; for (let n = el; n; n = n.parentElement) op *= +getComputedStyle(n).opacity; if (op < 1) fg = blend([...fg.slice(0,3), op], bg);
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700; const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < need) out.push({ text: el.textContent.trim().slice(0, 30), cls: `${el.tagName}.${el.className}`.slice(0, 60), ratio: +ratio.toFixed(2), fg: cs.color, size });
  }
  return out;
}

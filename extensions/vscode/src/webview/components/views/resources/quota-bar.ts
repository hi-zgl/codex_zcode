import { el } from '../../dom.js';

/**
 * Options for rendering the 3-color precision quota progress bar.
 */
export interface QuotaBarOptions {
  /** Percentage of quota used (0 to 100). */
  percentageUsed: number;
  /** Explicit remaining percentage; defaults to (100 - percentageUsed). */
  remainingPercentage?: number;
  /** Custom label override for the centered percentage text. */
  labelOverride?: string;
  /** Whether to render the compact mini variant (height: 17px). */
  compact?: boolean;
  /** Optional custom class names. */
  className?: string;
  /** Accessibility title or description. */
  ariaLabel?: string;
}

/**
 * Computes the 3-color safety tier theme based on usage percentage:
 * - < 70%: normal (Mint Green)
 * - >= 70% and < 90%: warn (Amber Warning)
 * - >= 90%: danger (Alert Red Danger)
 */
export function computeBarTheme(percentageUsed: number): 'normal' | 'warn' | 'danger' {
  if (percentageUsed >= 90) {
    return 'danger';
  }
  if (percentageUsed >= 70) {
    return 'warn';
  }
  return 'normal';
}

/**
 * Dynamic text contrast inversion algorithm:
 * When remaining quota is >= 58%, the text sits primarily over the colored fill,
 * requiring dark, high-contrast text (.in-fill). Otherwise, light muted text is used.
 */
export function shouldInFill(remainingPercentage: number): boolean {
  return remainingPercentage >= 58;
}

/**
 * Formats a numeric percentage with tabular figures formatting.
 * Omits trailing decimal zeros (e.g., 20% instead of 20.0%).
 */
export function formatPercentage(value: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const text = clamped.toFixed(1).replace(/\.0$/, '');
  return `${text}%`;
}

/**
 * Renders a precision 3-color gradient progress bar (.qbar) aligned with
 * zcode-switch visual standards and tabular numeric stability.
 *
 * Structure:
 * <div class="qbar [warn|danger] [mini]" role="progressbar">
 *   <div class="qbar-fill [warn|danger]" style="width: X%"></div>
 *   <span class="qbar-pct [in-fill]">X%</span>
 * </div>
 */
export function renderQuotaBar(options: QuotaBarOptions): HTMLElement {
  const {
    percentageUsed,
    remainingPercentage,
    labelOverride,
    compact = false,
    className = '',
    ariaLabel
  } = options;

  const used = Math.max(0, Math.min(100, Number.isFinite(percentageUsed) ? percentageUsed : 0));
  const remaining = remainingPercentage !== undefined
    ? Math.max(0, Math.min(100, Number.isFinite(remainingPercentage) ? remainingPercentage : 0))
    : Math.max(0, 100 - used);

  const theme = computeBarTheme(used);
  const themeClass = theme === 'normal' ? '' : theme;
  const miniClass = compact ? 'mini' : '';

  const barClasses = ['qbar', themeClass, miniClass, className].filter(Boolean).join(' ');
  const bar = el('div', barClasses);

  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuenow', String(Math.round(used)));
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');

  const defaultLabel = `${formatPercentage(remaining)} 剩余`;
  const displayText = labelOverride ?? defaultLabel;
  bar.setAttribute('aria-label', ariaLabel ?? displayText);

  // Fill indicator showing remaining quota (or used quota based on remaining)
  const fillClasses = ['qbar-fill', themeClass].filter(Boolean).join(' ');
  const fill = el('div', fillClasses);
  fill.style.width = `${remaining.toFixed(1)}%`;

  // Percentage text with dynamic contrast class
  const inFill = shouldInFill(remaining);
  const pctClasses = ['qbar-pct', inFill ? 'in-fill' : ''].filter(Boolean).join(' ');
  const pct = el('span', pctClasses, displayText);

  bar.append(fill, pct);
  return bar;
}

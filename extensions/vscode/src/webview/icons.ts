export type IconName =
  | 'check'
  | 'check-circle'
  | 'alert'
  | 'alert-circle'
  | 'info'
  | 'x-circle'
  | 'shield'
  | 'shield-check'
  | 'cpu'
  | 'branch'
  | 'clock'
  | 'refresh'
  | 'search'
  | 'zap'
  | 'inbox'
  | 'arrow-left'
  | 'arrow-right'
  | 'dot'
  | 'pulse-dot'
  | 'external-link'
  | 'file-plus'
  | 'file-diff'
  | 'file-minus'
  | 'git-commit'
  | 'terminal'
  | 'list-tree'
  | 'list-ordered';

export interface IconOptions {
  readonly size?: number;
  readonly className?: string;
  readonly ariaHidden?: boolean;
}

const ICONS: Readonly<Record<IconName, string>> = {
  check: '<path d="M13.5 4.5L6.5 11.5L2.5 7.5"/>',
  'check-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M5.5 8L7.2 9.7L10.8 6.2"/>',
  alert: '<path d="M8 2.2L14.2 13H1.8L8 2.2Z"/><path d="M8 6.5V9"/><circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>',
  'alert-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M8 5V8.5"/><circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.5V11"/><circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none"/>',
  'x-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5"/>',
  shield: '<path d="M8 1.5L13.5 3.5V7.5C13.5 11 11 13.5 8 14.5C5 13.5 2.5 11 2.5 7.5V3.5L8 1.5Z"/>',
  'shield-check': '<path d="M8 1.5L13.5 3.5V7.5C13.5 11 11 13.5 8 14.5C5 13.5 2.5 11 2.5 7.5V3.5L8 1.5Z"/><path d="M5.8 7.8L7.2 9.2L10.2 6.2"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6 1.5V4M10 1.5V4M6 12V14.5M10 12V14.5M1.5 6H4M1.5 10H4M12 6H14.5M12 10H14.5"/>',
  branch: '<circle cx="4.5" cy="4.5" r="1.75"/><circle cx="11.5" cy="4.5" r="1.75"/><circle cx="4.5" cy="11.5" r="1.75"/><path d="M4.5 6.25V9.75M11.5 6.25C11.5 8 8 9.5 4.5 9.75"/>',
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8L10.5 9.5"/>',
  refresh: '<path d="M2.5 8A5.5 5.5 0 0 1 12.3 4.2L13.5 3M13.5 8A5.5 5.5 0 0 1 3.7 11.8L2.5 13"/><path d="M13.5 3V6.5H10M2.5 13V9.5H6"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2L13.8 13.8"/>',
  zap: '<path d="M8.8 1.5L2.8 9.2H7.6L7.2 14.5L13.2 6.8H8.4L8.8 1.5Z"/>',
  inbox: '<path d="M2.5 3.5H13.5V10H10.5C10.5 11.4 9.4 12.5 8 12.5C6.6 12.5 5.5 11.4 5.5 10H2.5V3.5Z"/><path d="M2.5 7.5H5.5M10.5 7.5H13.5"/>',
  'arrow-left': '<path d="M13.5 8H2.5M6.5 4L2.5 8L6.5 12"/>',
  'arrow-right': '<path d="M2.5 8H13.5M9.5 4L13.5 8L9.5 12"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  'pulse-dot': '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="6" opacity="0.4"/>',
  'external-link': '<path d="M10 2.5H13.5V6M6.5 9.5L13.5 2.5M11.5 8V12.5C11.5 13.1 11 13.5 10.5 13.5H3.5C2.9 13.5 2.5 13.1 2.5 12.5V5.5C2.5 4.9 2.9 4.5 3.5 4.5H8"/>',
  'file-plus': '<path d="M9.5 2H4.5C3.9 2 3.5 2.4 3.5 3V13C3.5 13.6 3.9 14 4.5 14H11.5C12.1 14 12.5 13.6 12.5 13V5L9.5 2Z"/><path d="M9.5 2V5H12.5M8 7.5V11.5M6 9.5H10"/>',
  'file-diff': '<path d="M9.5 2H4.5C3.9 2 3.5 2.4 3.5 3V13C3.5 13.6 3.9 14 4.5 14H11.5C12.1 14 12.5 13.6 12.5 13V5L9.5 2Z"/><path d="M9.5 2V5H12.5M8 6.5V9.5M6.5 8H9.5M6.5 11.5H9.5"/>',
  'file-minus': '<path d="M9.5 2H4.5C3.9 2 3.5 2.4 3.5 3V13C3.5 13.6 3.9 14 4.5 14H11.5C12.1 14 12.5 13.6 12.5 13V5L9.5 2Z"/><path d="M9.5 2V5H12.5M6 9.5H10"/>',
  'git-commit': '<circle cx="8" cy="8" r="2.75"/><path d="M1.5 8H5.25M10.75 8H14.5"/>',
  terminal: '<path d="M3 5L6.5 8.5L3 12M8 12H13"/>',
  'list-tree': '<path d="M3 4H13M6.5 8H13M6.5 12H13M3 4V12M3 8H5M3 12H5"/>',
  'list-ordered': '<path d="M2.5 3.5H4V7M2 7H4.5M7 4H13.5M7 8H13.5M7 12H13.5M2 10.5C2 9.5 4.5 9.5 4.5 11C4.5 12.5 2 13 2 13H4.5"/>'
};

export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const size = options.size ?? 14;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `v-icon v-icon-${name}${options.className ? ` ${options.className}` : ''}`);
  svg.setAttribute('aria-hidden', options.ariaHidden === false ? 'false' : 'true');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

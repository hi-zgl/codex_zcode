import type { LocalState } from '../state.js';
import type { IconName } from '../icons.js';

export type Action = (name: string, data?: Record<string, string>) => void;
export interface RenderContext {
  readonly state: LocalState;
  readonly action: Action;
}

export type Child = Node | string | null | undefined | false;
export type Children = readonly (Child | readonly Child[])[];

export interface ButtonOptions {
  readonly primary?: boolean;
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  readonly reason?: string | null;
  readonly busy?: boolean;
  readonly className?: string;
  readonly icon?: SVGElement;
  /** Destructive action: first activation arms an inline confirmation instead of acting. */
  readonly confirm?: ConfirmOptions;
}

export interface ConfirmOptions {
  readonly prompt: string;
  readonly confirmLabel: string;
}

export interface EmptyOptions {
  readonly action?: HTMLElement;
  readonly icon?: IconName;
  readonly card?: boolean;
  readonly tone?: 'default' | 'success' | 'attention' | 'info';
  readonly hint?: string;
}

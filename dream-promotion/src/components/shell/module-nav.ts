import type { ComponentType } from 'react';

/**
 * The shape of a module of Dream opened as an app of its own (ModuleShell, 2.52): its menu groups, the phone's bottom
 * bar and its "+" actions. Pure — no React rendering here, so the rules are tested directly (tests/module-shell.test.ts).
 */
export interface ModuleLink { href: string; label: string; Icon: ComponentType<any> }
/** a group with one link is shown as that link; with more, it opens and closes (one group open at a time) */
export interface ModuleGroup { id: string; label: string; Icon: ComponentType<any>; links: ModuleLink[] }
export interface ModuleAction { id: string; label: string; href: string; Icon: ComponentType<any>; hint?: string }
export interface ModuleConfig {
  id: string;
  name: string;
  /** a class from globals.css that sets --module / --module-soft / --module-ink / --module-line, in both themes */
  theme: string;
  home: string;
  Icon: ComponentType<any>;
  groups: ModuleGroup[];
  /** the phone's bottom bar; the menu button is always added after them */
  tabs: ModuleLink[];
  actions: ModuleAction[];
}

const norm = (p: string) => p.replace(/\/+$/, '') || '/';
/** the page a link points to is the one on screen (the query of the link does not matter) */
export const isActiveLink = (path: string, href: string) => norm(path) === norm(href.split('?')[0]);
/** the group of the page on screen (it is the one opened in the menu); null when the page is in no group */
export const groupOfPath = (groups: ModuleGroup[], path: string) =>
  groups.find((g) => g.links.some((l) => isActiveLink(path, l.href)))?.id ?? null;
/** one group open at a time: tapping the open one closes it, tapping another opens it instead */
export const toggleGroup = (open: string | null, id: string) => (open === id ? null : id);

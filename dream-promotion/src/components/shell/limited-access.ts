/**
 * A member who is not 'full' sees only their screens (the database and the server refuse the rest anyway):
 *   register — "קופאי/ת": the register only (2.50)
 *   calendar — "יומן ולידים" (2.109, migration 20261028006000): the appointments calendar and the leads only
 * Every other address of the app takes them to their home.
 */
export type Access = 'full' | 'register' | 'calendar';
export const accessOf = (v: unknown): Access => (v === 'register' || v === 'calendar' ? v : 'full');

export const LIMITED_SCREENS: Record<Exclude<Access, 'full'>, string[]> = {
  register: ['/register'],
  calendar: ['/appointments', '/leads'],
};
export const limitedHome = (a: Exclude<Access, 'full'>) => LIMITED_SCREENS[a][0];

/** a screen of theirs (or one under it, as /leads/departments)? */
export const limitedAllows = (a: Access, path: string) =>
  a === 'full' || LIMITED_SCREENS[a].some((s) => path === s || path.startsWith(`${s}/`));

/** where to send them from this address, or null to stay */
export const limitedTarget = (a: Access, path: string): string | null =>
  a === 'full' || limitedAllows(a, path) ? null : limitedHome(a);

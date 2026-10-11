'use client';
import { create } from 'zustand';
import { isCloudConfigured, supabase } from '@/lib/supabase/client';
import { FAV_KEY, parseFavorites, toggleFavorite } from './favorites';

/**
 * The person's favorites (favorites.ts): read once an app open from their account (the server's copy — the same on every device),
 * changed at once on the screen and saved to the account (supabase.auth.updateUser → user_metadata.dp_favorites). Without accounts
 * (a local build) — kept on this device. A save that fails puts the list back and says so.
 */
interface FavoritesStore {
  list: string[];
  loaded: boolean;
  /** what the last star said, when it could not do it (shown at the top of the favorites for a few seconds) */
  message: string | null;
  load: () => Promise<void>;
  /** null when saved; else what to say ("the list is full", "not saved") */
  toggle: (href: string) => Promise<string | null>;
}
const LOCAL = 'dp-favorites';
const readLocal = () => { try { return parseFavorites(JSON.parse(localStorage.getItem(LOCAL) ?? '[]')); } catch { return []; } };
const writeLocal = (list: string[]) => { try { localStorage.setItem(LOCAL, JSON.stringify(list)); } catch { /* private mode: for this visit */ } };

export const useFavorites = create<FavoritesStore>((set, get) => ({
  list: [],
  loaded: false,
  message: null,
  load: async () => {
    if (!isCloudConfigured) { set({ list: readLocal(), loaded: true }); return; }
    try {
      // the server's copy (another device may have changed it); the device's session if the server cannot be asked
      const { data, error } = await supabase().auth.getUser();
      const user = !error && data.user ? data.user : (await supabase().auth.getSession()).data.session?.user;
      set({ list: parseFavorites(user?.user_metadata?.[FAV_KEY]), loaded: true });
    } catch { set({ loaded: true }); }
  },
  toggle: async (href) => {
    const before = get().list;
    const r = toggleFavorite(before, href);
    if (r.full) return 'אפשר עד 12 מועדפים — מסירים אחד קודם';
    set({ list: r.list });
    if (!isCloudConfigured) { writeLocal(r.list); return null; }
    try {
      const { error } = await supabase().auth.updateUser({ data: { [FAV_KEY]: r.list } });
      if (!error) return null;
    } catch { /* below */ }
    set({ list: before });
    return 'המועדפים לא נשמרו — בדקו את החיבור ונסו שוב';
  },
}));

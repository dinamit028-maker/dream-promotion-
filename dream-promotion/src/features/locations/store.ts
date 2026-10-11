'use client';
import { create } from 'zustand';
import { NO_LOCATIONS, type LocationState } from './locations';
import { loadLocationState, selectLocation } from './locations-data';

/**
 * The locations of the business the user works in (not kept on the device: the database is asked on every app open).
 * Picking a location reloads the app, like switching business: every list is asked again, and the database answers for that
 * location only.
 */
interface LocationsStore {
  state: LocationState;
  loaded: boolean;
  load: () => Promise<LocationState>;
  /** null on success (the page reloads), else what went wrong */
  select: (id: string | null) => Promise<string | null>;
}
export const useLocations = create<LocationsStore>((set) => ({
  state: NO_LOCATIONS,
  loaded: false,
  load: async () => {
    const state = await loadLocationState();
    set({ state, loaded: true });
    return state;
  },
  select: async (id) => {
    const r = await selectLocation(id);
    if (!r.ok) return r.error;
    window.location.reload();
    return null;
  },
}));

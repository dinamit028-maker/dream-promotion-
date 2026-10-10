import { supabase } from '@/lib/supabase/client';
import { NO_LOCATIONS, locationErrorHe, toLocationState, type LocationInput, type LocationState, type RegisterInput } from './locations';

/**
 * The database's side of locations (migration 20261010004600): what the signed-in user may use and picked (location_state), the
 * switch (location_select), and the owner's changes (location_save / register_save). Before the migration — or with no business —
 * there is nothing: every screen works as before locations.
 */
export async function loadLocationState(): Promise<LocationState> {
  const { data, error } = await supabase().rpc('location_state');
  if (error) return NO_LOCATIONS;
  return toLocationState(data);
}

/** work in one location from now on (null = all of them) — the database then shows only its rows */
export async function selectLocation(id: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase().rpc('location_select', { p_location: id });
  return error ? { ok: false, error: locationErrorHe(error) } : { ok: true };
}

type Saved = { ok: true; id: string; created: boolean } | { ok: false; error: string };
const saved = (data: any, error: any, id: string): Saved =>
  error ? { ok: false, error: locationErrorHe(error) } : { ok: true, id: String(data?.id ?? id), created: Boolean(data?.created) };

/** a location, new (its id chosen here: a second try is the same location) or changed */
export async function saveLocation(i: LocationInput): Promise<Saved> {
  const id = i.id ?? crypto.randomUUID();
  const { data, error } = await supabase().rpc('location_save', {
    p_id: id, p_name: i.name.trim(), p_kind: i.kind, p_address: i.address.trim(), p_phone: i.phone.trim(), p_hours: i.hours.trim(),
    p_active: i.active, p_sort: i.sort,
  });
  return saved(data, error, id);
}

/** a register of a location, new or changed */
export async function saveRegister(i: RegisterInput): Promise<Saved> {
  const id = i.id ?? crypto.randomUUID();
  const { data, error } = await supabase().rpc('register_save', {
    p_id: id, p_location: i.locationId, p_name: i.name.trim(), p_device: i.device.trim(), p_active: i.active, p_sort: i.sort,
  });
  return saved(data, error, id);
}

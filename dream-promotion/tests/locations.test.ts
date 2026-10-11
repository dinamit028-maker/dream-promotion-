import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_LOCATIONS, atLocation, defaultLocation, locationChoices, locationError, locationErrorHe, locationOf, multiLocation, nextRegisterName, onRegister, pickRegister,
  registerError, registerLabel, registerOf, registersHere, showRegisterPicker, showSwitch, switchLabel, switchOptions, toLocationState,
  type LocationState,
} from '../src/features/locations/locations';

// a business (id B) with its main location (id B), a branch L2 and a closed warehouse L3; registers: the main one (id B), two in L2
const B = 'b1', L2 = 'l2', L3 = 'l3', R2 = 'r2', R3 = 'r3';
const answer = {
  business: B, current: null, limited: false, owner: true,
  locations: [
    { id: B, name: 'ראשי', kind: 'store', address: 'הרצל 1', phone: '', hours: '', active: true, sort: 0, main: true },
    { id: L2, name: 'סניף דיזנגוף', kind: 'store', address: 'דיזנגוף 100', phone: '03-5551234', hours: '', active: true, sort: 1, main: false },
    { id: L3, name: 'מחסן', kind: 'warehouse', address: '', phone: '', hours: '', active: false, sort: 2, main: false },
  ],
  registers: [
    { id: B, location: B, name: 'קופה 1', device: '', active: true, sort: 0, main: true },
    { id: R2, location: L2, name: 'קופה 1', device: '', active: true, sort: 0, main: false },
    { id: R3, location: L2, name: 'קופה 2', device: 'טאבלט', active: true, sort: 1, main: false },
  ],
};
const many = toLocationState(answer);
// a business with one location (as before 2.91): its main location and register only
const one = toLocationState({ ...answer, locations: [answer.locations[0]], registers: [answer.registers[0]] });

test('location_state: the database\'s answer → the screens\' state; anything else is "as before locations"', () => {
  assert.equal(many.ready, true);
  assert.equal(many.locations.length, 3);
  assert.deepEqual(many.registers.map((r) => r.locationId), [B, L2, L2]);
  assert.equal(many.locations[2].kind, 'warehouse');
  assert.deepEqual(toLocationState(null), NO_LOCATIONS);
  assert.deepEqual(toLocationState({ error: 'x' }), NO_LOCATIONS);
  assert.equal(toLocationState({ ...answer, locations: [{ ...answer.locations[0], kind: 'office' }] }).locations[0].kind, 'branch', 'an unknown kind: a branch');
});

test('one location: no switch, no location field, no register picker — as before', () => {
  for (const s of [one, NO_LOCATIONS]) {
    assert.equal(multiLocation(s), false);
    assert.equal(showSwitch(s), false);
    assert.deepEqual(locationChoices(s), []);
    assert.equal(showRegisterPicker(s), false);
  }
  assert.equal(registerLabel(one, B), 'קופה 1', 'one location: a register is just its name');
  assert.equal(pickRegister(one, null), B);
});

test('several locations: the switch, its choices and its label', () => {
  assert.equal(showSwitch(many), true);
  assert.deepEqual(switchOptions(many), [{ value: '', label: 'כל הסניפים' }, { value: B, label: 'ראשי' }, { value: L2, label: 'סניף דיזנגוף' }],
    'a closed location is not a choice');
  assert.equal(switchLabel(many), 'כל הסניפים');
  const closedPicked: LocationState = { ...many, current: L3 };
  assert.ok(switchOptions(closedPicked).some((o) => o.value === L3 && o.label === 'מחסן (סגור)'), 'the closed one picked earlier still shows');
  assert.equal(switchLabel({ ...many, current: L2 }), 'סניף דיזנגוף');
  // a member limited to one location: nothing to choose
  const limited = toLocationState({ ...answer, limited: true, owner: false, locations: [answer.locations[1]], registers: answer.registers.slice(1) });
  assert.equal(showSwitch(limited), false);
  assert.equal(defaultLocation(limited), L2);
});

test('where a new row goes; the form\'s location field', () => {
  assert.equal(defaultLocation(many), B, 'all: the main location');
  assert.equal(defaultLocation({ ...many, current: L2 }), L2, 'a location picked: it');
  assert.deepEqual(locationChoices(many).map((l) => l.id), [B, L2], 'all picked: a choice among the active ones');
  assert.deepEqual(locationChoices({ ...many, current: L2 }), [], 'a location picked: no field (the row goes there)');
  const mainClosed = toLocationState({ ...answer, locations: [{ ...answer.locations[0], active: false }, answer.locations[1], answer.locations[2]] });
  assert.equal(defaultLocation(mainClosed), L2, 'the main location closed: the first active one');
});

test('a row\'s location and register: none is the main one (the business\'s id)', () => {
  assert.equal(locationOf({ location_id: null }, B), B);
  assert.equal(locationOf({ location_id: L2 }, B), L2);
  assert.equal(registerOf({}, B), B);
  assert.equal(registerOf({ registerId: R3 }, B), R3);
  const rows = [{ id: 1, register_id: null }, { id: 2, register_id: R2 }, { id: 3, register_id: B }, { id: 4 }];
  assert.deepEqual(onRegister(rows, B, B).map((r) => r.id), [1, 3, 4], 'the main register: its own and the old rows');
  assert.deepEqual(onRegister(rows, R2, B).map((r) => r.id), [2]);
  // a location's rows (the free hours of a new appointment are its location's): none = the main one; no location given = all
  const appts = [{ id: 1, location_id: null }, { id: 2, location_id: L2 }, { id: 3, location_id: B }, { id: 4, locationId: L2 }];
  assert.deepEqual(atLocation(appts, B, B).map((r) => r.id), [1, 3]);
  assert.deepEqual(atLocation(appts, L2, B).map((r) => r.id), [2, 4]);
  assert.deepEqual(atLocation(appts, null, B).map((r) => r.id), [1, 2, 3, 4], 'one location (no field): every row, as before');
});

test('the registers here and this device\'s register', () => {
  assert.deepEqual(registersHere(many).map((r) => r.id), [B, R2, R3], 'all: every active register of an active location');
  assert.deepEqual(registersHere({ ...many, current: L2 }).map((r) => r.id), [R2, R3], 'a location picked: its registers');
  assert.equal(showRegisterPicker(many), true);
  assert.equal(pickRegister(many, R3), R3, 'the device remembers its register');
  assert.equal(pickRegister({ ...many, current: L2 }, B), R2, 'the remembered register is not here: the location\'s first');
  assert.equal(pickRegister(many, 'gone'), B, 'a register that is gone: the main one');
  const closedReg = toLocationState({ ...answer, registers: [answer.registers[0], { ...answer.registers[1], active: false }, answer.registers[2]] });
  assert.deepEqual(registersHere(closedReg).map((r) => r.id), [B, R3], 'a closed register is not offered');
  assert.equal(pickRegister({ ...many, current: L3 }, null), null, 'a location with no register (a warehouse): none');
  assert.equal(registerLabel(many, R3), 'קופה 2 · סניף דיזנגוף');
});

test('the owner\'s screen: what is checked before saving', () => {
  const ok = { name: 'סניף רמת אביב', kind: 'store' as const, address: 'איינשטיין 40', phone: '03-6400000', hours: 'א׳–ה׳ 10–20', active: true, sort: 3 };
  assert.equal(locationError(ok, many.locations), null);
  assert.equal(locationError({ ...ok, name: '  ' }, many.locations), 'צריך שם לסניף.');
  assert.equal(locationError({ ...ok, name: ' סניף דיזנגוף ' }, many.locations), 'כבר יש סניף בשם הזה.');
  assert.equal(locationError({ ...ok, id: L2, name: 'סניף דיזנגוף' }, many.locations), null, 'a location keeps its own name');
  assert.equal(locationError({ ...ok, phone: 'abc' }, many.locations), 'מספר הטלפון לא תקין.');
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...many.locations[0], id: `x${i}`, name: `x${i}` }));
  assert.equal(locationError(ok, ten), 'אפשר עד 10 סניפים לעסק.');
  const reg = { locationId: L2, name: 'קופה 3', device: '', active: true, sort: 2 };
  assert.equal(registerError(reg, many.registers), null);
  assert.equal(registerError({ ...reg, name: 'קופה 2' }, many.registers), 'כבר יש קופה בשם הזה בסניף.');
  assert.equal(registerError({ ...reg, locationId: B, name: 'קופה 2' }, many.registers), null, 'another location may have its own "קופה 2"');
  assert.equal(nextRegisterName(many.registers, L2), 'קופה 3');
  assert.equal(nextRegisterName(many.registers, L3), 'קופה 1');
});

test('the database\'s refusals in Hebrew', () => {
  assert.match(locationErrorHe({ message: 'Could not find the function public.location_state without parameters in the schema cache', code: 'PGRST202' }), /מיגרציה 20261010004600/);
  assert.equal(locationErrorHe({ message: 'locations_limit: up to 10 locations' }), 'אפשר עד 10 סניפים לעסק.');
  assert.equal(locationErrorHe({ message: 'duplicate key value violates unique constraint "business_locations_name_uq"' }), 'כבר יש סניף בשם הזה.');
  assert.equal(locationErrorHe({ message: 'locations_last: one active location stays' }), 'צריך להשאיר לפחות סניף פעיל אחד.');
  assert.equal(locationErrorHe({ message: 'register_open_shift: close its open day first' }), 'יש יום פתוח בקופה הזו — סוגרים אותו קודם.');
  assert.equal(locationErrorHe({ message: 'register_inactive: this register is closed down' }), 'הקופה הזו סגורה. בוחרים קופה אחרת.');
  assert.equal(locationErrorHe({ message: 'not allowed', code: '42501' }), 'אין הרשאה לפעולה הזו.');
});

/**
 * "לחץ לעריכה" (2.61): what each element of a page is, for the dashboard's visual editor — attributes that exist only when
 * the page was opened with a valid edit token (site.edit), so a shopper's page carries none of them.
 *   data-edit-section="<id>"   a section of the home page (its settings open in the editor's panel)
 *   data-edit-field="<key>"    a text of that section; with data-edit-inline it is edited in place, else in the panel
 *   data-edit-image="<key>"    a picture of that section (replaced from the panel)
 *   data-edit-link="<target>"  something the dashboard edits elsewhere: menus:main / menus:footer / settings / announcement /
 *                              page:<page|policy>:<slug or kind> / product:<slug> / collection:<slug>
 */
type Attrs = Record<string, string>;
export const editField = (on: boolean, key: string, inline = true): Attrs => (on ? { 'data-edit-field': key, ...(inline ? { 'data-edit-inline': '' } : {}) } : {});
export const editImage = (on: boolean, key: string): Attrs => (on ? { 'data-edit-image': key } : {});
export const editLink = (on: boolean, target: string): Attrs => (on ? { 'data-edit-link': target } : {});
export const editSection = (on: boolean, id: string, type: string): Attrs => (on ? { 'data-edit-section': id, 'data-edit-type': type } : {});

/** the messages the page and the dashboard exchange (postMessage, each side checks the other's origin) */
export type EditMessage =
  | { type: 'ready'; path: string }
  | { type: 'section'; id: string }
  | { type: 'text'; section: string; field: string; value: string }
  | { type: 'field'; section: string; field: string }
  | { type: 'image'; section: string; field: string }
  | { type: 'open'; target: string }
  | { type: 'navigate'; path: string };

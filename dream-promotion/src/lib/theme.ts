export const THEME_KEY = 'dp-theme';

/** Runs before the first paint so the page never flashes the wrong theme. Dark is the default look. */
export const THEME_BOOT = `try{var t=localStorage.getItem('${THEME_KEY}');document.documentElement.dataset.theme=t==='light'?'light':'dark'}catch(e){document.documentElement.dataset.theme='dark'}`;

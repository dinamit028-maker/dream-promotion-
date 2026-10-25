/**
 * The owner's "lock to the business's location" (QrTab): what to tell them when the phone gives no location. The browser's
 * GeolocationPositionError codes — 1 denied, 2 unavailable, 3 timeout. Each one says what to do, never "something went wrong".
 */
export const GEO_DENIED = 1, GEO_UNAVAILABLE = 2, GEO_TIMEOUT = 3;

export function geoMessage(code: number | null, ios: boolean): string {
  if (code === null) return 'הדפדפן הזה לא נותן מיקום. נסו מהטלפון, בדפדפן Safari או Chrome.';
  if (code === GEO_DENIED) return ios
    ? 'הטלפון לא נתן לאתר את המיקום. באייפון: הגדרות ← פרטיות ואבטחה ← שירותי מיקום — להדליק, ובאותו מסך "אתרי Safari" (או Chrome) ← "בזמן השימוש באפליקציה" ו"מיקום מדויק". אחר כך לרענן את הדף וללחוץ שוב.'
    : 'הטלפון לא נתן לאתר את המיקום. לוחצים על המנעול ליד הכתובת למעלה ← הרשאות ← מיקום ← "לאפשר", ומדליקים את המיקום בטלפון. אחר כך לרענן את הדף וללחוץ שוב.';
  return 'לא הצלחנו לקבל מיקום מהטלפון. בודקים שהמיקום בטלפון דלוק, עומדים ליד חלון או בחוץ, ולוחצים שוב.';
}

/** Retry once, without high accuracy and with a recent position allowed — indoors GPS often times out where Wi-Fi answers. */
export const retryable = (code: number) => code === GEO_UNAVAILABLE || code === GEO_TIMEOUT;

/** Turns provider error codes into something a marketer can act on. */
export function videoErrorMessage(raw?: string, code?: string): { title: string; body: string } {
  const t = `${code ?? ''} ${raw ?? ''}`.toLowerCase();
  if (t.includes('content_policy') || t.includes('flagged') || t.includes('safety') || t.includes('nsfw')) {
    return {
      title: 'המודל חסם את הסצנה',
      body: 'בדיקת התוכן של מנוע הווידאו דחתה את התיאור. זה קורה הרבה עם מפות עולם, רשתות נתונים ומסכים שמציגים ממשקים. לחצו "סצנה אחרת" ותקבלו כיוון ויזואלי חלופי.',
    };
  }
  if (t.includes('balance') || t.includes('402') || t.includes('credit') || t.includes('payment')) {
    return { title: 'אין יתרה בחשבון fal', body: 'הקרדיט נגמר. טענו עוד ב-fal.ai ונסו שוב — הקליף הזה לא חויב.' };
  }
  if (t.includes('access_denied') || t.includes('401')) {
    return { title: 'קוד הגישה שגוי', body: 'עדכנו את קוד הגישה במסך ההגדרות כך שיתאים ל-APP_ACCESS_CODE שבשרת.' };
  }
  if (t.includes('no_fal_key') || t.includes('503')) {
    return { title: 'מנוע הווידאו לא מוגדר', body: 'חסר FAL_KEY במשתני הסביבה, או שלא בוצעה פריסה מחדש אחרי שהוספתם אותו.' };
  }
  if (t.includes('rate') || t.includes('429')) {
    return { title: 'יותר מדי בקשות', body: 'המנוע עמוס כרגע. המתינו דקה ונסו שוב.' };
  }
  if (t.includes('timeout')) {
    return { title: 'היצירה ארכה יותר מדי', body: 'הבקשה לא חזרה בזמן. אם היא הסתיימה בצד של fal היא תופיע בחשבון שלכם שם.' };
  }
  if (t.includes('aborted')) return { title: 'היצירה בוטלה', body: '' };
  return { title: 'היצירה נכשלה', body: raw ? raw.slice(0, 220) : 'שגיאה לא מזוהה מהמנוע.' };
}

export function aiErrorMessage(code?: string): string {
  const t = (code ?? '').toLowerCase();
  if (t.includes('no_api_key')) return 'מנוע ה-AI לא מוגדר — חסר ANTHROPIC_API_KEY בשרת.';
  if (t.includes('access_denied')) return 'קוד הגישה שגוי. עדכנו אותו במסך ההגדרות.';
  if (t.includes('rate')) return 'יותר מדי בקשות כרגע. נסו שוב בעוד רגע.';
  if (t.includes('invalid_json')) return 'המודל החזיר תשובה לא תקינה. נסו שוב עם בריף מפורט יותר.';
  return 'הפעולה נכשלה. נסו שוב.';
}

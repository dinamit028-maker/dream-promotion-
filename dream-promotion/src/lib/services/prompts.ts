import type { BrandProfile, ContentBrief } from '@/types';

/** Every prompt lives here — one place to tune the product's voice. */
export const brandContext = (b: BrandProfile) => `פרטי העסק:
שם: ${b.name || '—'}
תחום: ${b.industry || '—'}
תיאור: ${b.description || '—'}
עיר: ${b.city || '—'}
קהל יעד: ${b.audience || '—'}
מטרות: ${b.goals?.join(', ') || '—'}
טון מותג: ${b.tone || '—'}
קריאה לפעולה מועדפת: ${b.cta || '—'}`;

const KIND_HE: Record<string, string> = { post: 'פוסט', reel: 'ריל', story: 'סטורי', ad: 'מודעה ממומנת' };

export const contentPrompt = (b: BrandProfile, brief: ContentBrief) => `את/ה מנהל/ת שיווק ברשתות חברתיות, כותב/ת בעברית שיווקית טבעית וזורמת (לא מתורגמת).
${brandContext(b)}

צור/י ${brief.count ?? 3} וריאציות שונות באמת של ${KIND_HE[brief.kind]} ל-${brief.platform}.
מטרת התוכן: ${brief.goal}
בקשת המשתמש: ${brief.brief || 'ללא בקשה ספציפית — הצע/י רעיון חזק'}

כללים: כל וריאציה בזווית אחרת לגמרי (לא ניסוח מחדש). שורת פתיחה שעוצרת גלילה. בלי קלישאות, בלי הבטחות רפואיות, בלי המצאת נתונים.

החזר/י JSON בלבד:
{"variants":[{"angle":"","headline":"","caption":"","hashtags":[],"cta":"","emoji":"","palette":["#hex","#hex"],"visual_direction":""}]}`;

export const weeklyPlanPrompt = (b: BrandProfile) => `${brandContext(b)}

בנה/י תוכנית תוכן שבועית. 5 פריטים על ימים שונים (dayOffset בין 0 ל-6), עם גיוון בין סוגי תוכן.
headline: טקסט קצר שיופיע על התמונה (עד 8 מילים). caption: עד 60 מילים. visual_direction: משפט אחד.
החזר/י JSON תקין בלבד, בלי טקסט לפני או אחרי:
{"items":[{"dayOffset":0,"time":"19:30","kind":"post|reel|story","platform":"Instagram|Facebook|TikTok","goal":"","headline":"","caption":"","hashtags":[""],"cta":"","emoji":"","visual_direction":""}]}`;

export const storyboardPrompt = (b: BrandProfile, brief: string, duration: number) => {
  const clips = Math.max(1, Math.round(duration / 15));
  const per = Math.round(duration / clips);
  return `${brandContext(b)}

בנה/י תוכנית לסרטון אנכי (9:16) באורך ${duration} שניות, מחולק ל-${clips} קליפים של ${per} שניות כל אחד.
נושא: ${brief || 'הצע/י נושא חזק לעסק'}
הקליפים מתחברים ברצף לסרטון אחד, אז כל קליף ממשיך את הקודם: אותו מקום, אותה תאורה, אותה דמות או מוצר.
מבנה כולל: הוק ובעיה ← פתרון ← הוכחה וקריאה לפעולה.

לכל קליף:
- onScreen: טקסט קצר בעברית שיופיע כשכבת כיתוב (עד 8 מילים)
- voiceover: קריינות בעברית לקליף
- visual: תיאור קצר בעברית של מה רואים
- videoPrompt: פרומפט באנגלית למודל וידאו — נושא, פעולה, תנועת מצלמה, תאורה, אווירה, עדשה. בלי שום טקסט, כתוביות, אותיות או לוגואים בתוך התמונה. כתוב/י בזמן הווה, 40–80 מילים.

החזר/י JSON בלבד:
{"title":"","scenes":[{"role":"","seconds":${per},"onScreen":"","voiceover":"","visual":"","videoPrompt":""}],"caption":"","hashtags":[]}`;
};

export const brandAnalysisPrompt = (b: BrandProfile) => `${brandContext(b)}

נתח/י את המותג. החזר/י JSON בלבד:
{"voice":"","pillars":[{"name":"","why":""}],"audienceInsight":"","bestTimes":[],"firstMoves":[]}
ארבעה עמודי תוכן.`;

export const adCopyPrompt = (
  b: BrandProfile,
  p: { goal: string; audience: string; budget: number; contentCaption?: string },
) => `${brandContext(b)}

כתוב/י מודעה ממומנת לפייסבוק/אינסטגרם בעברית.
מטרה: ${p.goal} | קהל: ${p.audience} | תקציב יומי: ${p.budget} ₪
התוכן שנבחר: ${p.contentCaption || '—'}
החזר/י JSON בלבד:
{"headline":"","primary":"","description":"","cta":"","audienceSuggestion":""}
בלי הבטחות תוצאה ובלי המצאת נתוני ביצועים.`;

export const assistantPrompt = (b: BrandProfile, recentContent: string, question: string) =>
  `את/ה העוזר/ת השיווקי/ת של Dream Promotion. עונה בעברית, קצר וישים.
${brandContext(b)}
תוכן אחרון במערכת:
${recentContent}

שאלה: ${question}`;

export type RewriteMode = 'shorter' | 'professional' | 'casual' | 'cta' | 'hook';

const REWRITE_HE: Record<RewriteMode, string> = {
  shorter: 'קצר/י משמעותית — בערך חצי מהאורך, בלי לאבד את המסר ואת הקריאה לפעולה.',
  professional: 'הפוך/הפכי את הטון למקצועי ומדויק יותר, בלי להישמע מרוחק.',
  casual: 'הפוך/הפכי את הטון לקליל ומדובר יותר, כמו הודעה לחברה.',
  cta: 'החלף/י את הקריאה לפעולה בניסוח אחר וחזק יותר. שאר הטקסט נשאר כמעט זהה.',
  hook: 'כתוב/י שורת פתיחה אחרת לגמרי שעוצרת גלילה. שאר הטקסט נשאר.',
};

export const rewritePrompt = (b: BrandProfile, mode: RewriteMode, caption: string, cta: string) =>
  `${brandContext(b)}

לפניך טקסט של פוסט. ${REWRITE_HE[mode]}
עברית טבעית, בלי קלישאות ובלי הבטחות רפואיות.

הטקסט:
${caption}

קריאה לפעולה נוכחית: ${cta}

החזר/י JSON בלבד:
{"caption":"","cta":""}`;

/** A fresh visual direction for one clip — used after a content-policy block or a weak result. */
export const scenePrompt = (b: BrandProfile, role: string, onScreen: string, previous: string) =>
  `${brandContext(b)}

אנחנו מייצרים קליפ וידאו אנכי לסצנה "${role}" עם הכיתוב "${onScreen}".
הכיוון הקודם לא התאים או נחסם:
${previous}

כתוב/י כיוון ויזואלי אחר לגמרי. חוקים:
- סצנה אנושית, מקום אמיתי או מוצר מוחשי. בלי מפות עולם, בלי רשתות נתונים ובלי מסכים שמציגים ממשקים — אלה נחסמים בבדיקת התוכן של מנוע הווידאו.
- בלי טקסט, אותיות, לוגואים או כתוביות בתוך התמונה.
- אנגלית, זמן הווה, 40 עד 80 מילים: נושא, פעולה, תנועת מצלמה, תאורה, אווירה.

החזר/י JSON בלבד:
{"videoPrompt":"","visual":"תיאור קצר בעברית"}`;

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

בנה/י תוכנית תוכן שבועית. 5-6 פריטים על ימים שונים, עם גיוון בין סוגי תוכן.
החזר/י JSON בלבד:
{"items":[{"dayOffset":0,"time":"19:30","kind":"post|reel|story","platform":"Instagram|Facebook|TikTok","goal":"","idea":"","headline":"","caption":"","emoji":"","visual_direction":""}]}`;

export const storyboardPrompt = (b: BrandProfile, brief: string, duration: number) => `${brandContext(b)}

בנה/י סטוריבורד לריל אנכי (9:16) באורך ${duration} שניות.
נושא: ${brief || 'הצע/י נושא חזק לעסק'}
מבנה: Hook → בעיה → פתרון → הוכחה → CTA.
החזר/י JSON בלבד:
{"title":"","scenes":[{"role":"","seconds":3,"onScreen":"","voiceover":"","visual":"","emoji":""}],"caption":"","hashtags":[]}`;

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

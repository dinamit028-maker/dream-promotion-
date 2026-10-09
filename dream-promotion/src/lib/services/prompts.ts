import type { BrandProfile, ContentBrief } from '@/types';
import { factsText, legalFacts, type PageFacts, type ShortAsk } from '@/features/store/page-ai';
import { POLICY_LABEL } from '@/features/store/store';

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

/**
 * The shape of a reel the storyboard asks for: how many scenes, about how long each, and how many seconds of them may be AI
 * video (the last scene is a free card). The cost shown before there is a script (estimateVideoCost) reads the same numbers.
 */
export function reelPlan(duration: number) {
  const count = Math.min(10, Math.max(3, Math.round(duration / 5)));
  return { count, per: Math.round(duration / count), videoBudget: Math.max(5, Math.round(duration * 0.35)) };
}

export const storyboardPrompt = (b: BrandProfile, brief: string, duration: number, avoid?: string[]) => {
  const { count, per, videoBudget } = reelPlan(duration);
  return `${brandContext(b)}

בנה/י תוכנית לסרטון אנכי (9:16) באורך ${duration} שניות, ב-${count} סצנות קצרות של בערך ${per} שניות (3–7 שניות כל אחת).
נושא: ${brief || 'הצע/י נושא חזק לעסק'}
${avoid?.length ? `תסריטים שכבר נבנו לנושא הזה ונדחו — בנה/י גרסה שונה בבירור (הוק אחר, מקומות אחרים, מהלך אחר):\n${avoid.map((t) => `- ${t}`).join('\n')}` : ''}
מבנה כולל: הוק ובעיה ← פתרון ← הוכחה ← קריאה לפעולה. הסצנות נראות כמו סרטון אחד: אותו מקום, אותה תאורה, אותה דמות או מוצר.

עקביות: אם יש בסרטון אדם — זה אותו אדם אחד לאורך כל הסרטון. הגדר/י אותו פעם אחת בשדה cast באנגלית (מגדר, גיל, מראה, שיער, לבוש מדויק, 15–30 מילים), ואל תשנה/י אותו בין סצנות. אותו מקום ואותה תאורה לכל אורך הסרטון.
אף אחד לא מדבר למצלמה ואין דיאלוג — הקול הוא הקריינות בעברית בלבד.

החלטה חשובה — ממה עשויה כל סצנה (source). וידאו AI יקר פי 5–10 מתמונה, אז משתמשים בו רק איפה שתנועה אמיתית היא העיקר:
- "ai_video": תנועה שהיא לב הסצנה — פעולה (מזיגה, טיפול, הנחת מוצר ביד, אדם שמסתובב), בדרך כלל ההוק. סך כל סצנות ai_video: עד ${videoBudget} שניות.
- "ai_image": תמונה סטילס עם תנועת מצלמה עדינה (motion) — תוצאה, מוצר, מקום, לפני/אחרי, פרט. ברירת המחדל לרוב הסצנות.
- "graphic": כרטיס טקסט ממותג — לקריאה לפעולה בסוף (תמיד הסצנה האחרונה), או לנתון/הצעה בולטים.
motion לכל סצנה שאינה ai_video: "zoom_in" (התקרבות לפרט/רגש), "zoom_out" (חשיפה), "pan_left" / "pan_right" (מקום, מוצרים בשורה). ל-ai_video ול-graphic: "none".

לכל סצנה:
- onScreen: טקסט קצר בעברית שיופיע על המסך (עד 7 מילים)
- voiceover: קריינות בעברית לסצנה — קצרה, בערך 2.2 מילים לכל שנייה של הסצנה
- visual: תיאור קצר בעברית של מה רואים
- videoPrompt: פרומפט באנגלית — ל-ai_video: נושא, פעולה, תנועת מצלמה, תאורה, אווירה, עדשה (40–80 מילים, זמן הווה). ל-ai_image: תיאור תמונה סטילס מצולמת, קומפוזיציה, תאורה, עדשה (30–60 מילים). בלי שום טקסט, אותיות או לוגואים בתוך התמונה. ל-graphic: מחרוזת ריקה.

החזר/י JSON בלבד:
{"title":"","cast":"","scenes":[{"role":"","seconds":${per},"source":"ai_image","motion":"zoom_in","onScreen":"","voiceover":"","visual":"","videoPrompt":""}],"caption":"","hashtags":[]}`;
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
/** Camera / story angles the "another scene" button rotates through, so each try is really different. */
export const SCENE_ANGLES = [
  'extreme close-up on hands and the product in use',
  'wide establishing shot of the place, the person small in frame',
  'over-the-shoulder point of view',
  'the person reacting — face and emotion first',
  'a different location that still fits the story (outdoors / street / home)',
  'slow tracking shot following the person walking',
  'top-down shot from above',
  'low angle, the person looking confident',
  'golden-hour backlight, warm and cinematic',
  'clean studio look, bright background',
];

export const scenePrompt = (b: BrandProfile, role: string, onScreen: string, previous: string,
  extra: { voiceover?: string; cast?: string; angle?: string } = {}) =>
  `${brandContext(b)}

אנחנו מייצרים קליפ וידאו אנכי לסצנה "${role}" עם הכיתוב "${onScreen}".
${extra.voiceover ? `מה נאמר בסצנה (הקריינות): ${extra.voiceover}\n` : ''}${extra.cast ? `הדמות הקבועה בסרטון (חובה לשמור): ${extra.cast}\n` : ''}
הכיוונים שכבר נוסו ונדחו — אסור לחזור עליהם או על משהו דומה להם:
${previous}

כתוב/י כיוון ויזואלי חדש ושונה בבירור מכל מה שלמעלה (מקום, פעולה, זווית או תאורה אחרים), שעדיין מספר את אותו רגע בסיפור.
${extra.angle ? `זווית מחייבת לניסיון הזה: ${extra.angle}.` : ''}
חוקים:
- סצנה אנושית, מקום אמיתי או מוצר מוחשי. בלי מפות עולם, בלי רשתות נתונים ובלי מסכים שמציגים ממשקים — אלה נחסמים בבדיקת התוכן של מנוע הווידאו.
- בלי טקסט, אותיות, לוגואים או כתוביות בתוך התמונה. אף אחד לא מדבר למצלמה.
- אנגלית, זמן הווה, 40 עד 80 מילים: נושא, פעולה, תנועת מצלמה, תאורה, אווירה.

החזר/י JSON בלבד:
{"videoPrompt":"","visual":"תיאור קצר בעברית"}`;

/** Video ideas for this business: varied formats, nothing the user already made. */
export const ideasPrompt = (b: BrandProfile, p: { recent?: string[]; avoid?: string[]; count?: number }) => `${brandContext(b)}

את/ה קריאייטיב של סושיאל לעסקים קטנים בישראל. הצע/י ${p.count ?? 6} רעיונות לסרטון קצר (ריל / TikTok) לעסק הזה, בעברית טבעית.
כל רעיון בפורמט אחר — בחר/י מתוך: לפני ואחרי, טיפ מקצועי, מיתוס מול אמת, סיפור לקוח, מאחורי הקלעים, מבצע או הצעה, שאלה נפוצה, טרנד, יום בחיים, השוואה.
הרעיונות חייבים להתאים לשירותים, לקהל ולטון של העסק — מוחשיים, לא כלליים.
${p.recent?.length ? `תוכן שכבר נוצר (לא לחזור עליו):\n${p.recent.map((r) => `- ${r}`).join('\n')}\n` : ''}${p.avoid?.length ? `רעיונות שכבר הוצעו (להציע אחרים לגמרי):\n${p.avoid.map((r) => `- ${r}`).join('\n')}\n` : ''}
לכל רעיון:
- title: כותרת קצרה (עד 7 מילים)
- format: שם הפורמט מהרשימה
- hook: המשפט הראשון שעוצר גלילה (עד 12 מילים)
- brief: 2–3 משפטים שמתארים מה רואים בסרטון, מההתחלה עד הסוף — הטקסט הזה ייכנס לתסריט
- why: למה זה יעבוד לעסק הזה (משפט אחד)

החזר/י JSON בלבד:
{"ideas":[{"title":"","format":"","hook":"","brief":"","why":""}]}`;

/** Post text + hashtags for a finished video, from what is actually said and shown in it. */
export const socialPrompt = (b: BrandProfile, p: { title?: string; brief?: string; spoken?: string; platform?: string }) => `את/ה מנהל/ת סושיאל שכותב/ת בעברית טבעית (לא מתורגמת).
${brandContext(b)}

כתוב/י טקסט לפוסט ל-${p.platform || 'Instagram ו-TikTok'} עבור סרטון קצר.
כותרת הסרטון: ${p.title || '—'}
על מה הסרטון: ${p.brief || '—'}
מה נאמר בסרטון: ${p.spoken || '—'}

caption: 2–4 שורות קצרות. שורה ראשונה שעוצרת גלילה, תוכן אמיתי מהסרטון, וקריאה לפעולה בסוף (${b.cta || 'לפי העסק'}). אימוג'י אחד או שניים לכל היותר. בלי האשטגים בתוך ה-caption. בלי הבטחות רפואיות ובלי להמציא מחירים, מבצעים או נתונים.
hashtags: 15–20 האשטגים, בלי כפילויות, כל אחד מתחיל ב-#, בלי רווחים בתוכם. שילוב של: עברית ואנגלית, תחום העסק, העיר והאזור (${b.city || 'לפי העסק'}), נושא הסרטון הספציפי, ו-3–4 כלליים ופופולריים.

החזר/י JSON בלבד:
{"caption":"","hashtags":["#..."]}`;

/**
 * Caption lines of a video, polished: transcription mistakes fixed, key words marked, optional emoji.
 * The number of lines must stay the same — each line keeps its timing.
 */
export const captionPolishPrompt = (b: BrandProfile, p: { lines: string[]; brief?: string; emoji?: boolean; fix?: boolean }) => `${brandContext(b)}

אלה שורות הכתוביות של סרטון (${p.lines.length} שורות), לפי הסדר${p.fix ? ', מתמלול אוטומטי שעלול לכלול טעויות' : ''}.
על מה הסרטון: ${p.brief || '—'}

${p.lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}

לכל שורה החזר/י:
- text: ${p.fix ? 'השורה מתוקנת — שגיאות תמלול, כתיב, שמות מותג ומונחים מקצועיים לפי העסק. בלי לשנות משמעות, בלי לקצר ובלי להוסיף תוכן.' : 'השורה בדיוק כפי שהיא.'}
- hl: מספרי המילים (מ-0, לפי הסדר בשורה שהחזרת) שהן מילות המפתח — 0 עד 2 מילים בשורה, רק מילים שבאמת חשובות (מוצר, תוצאה, מספר, מקום).
${p.emoji ? '- emoji: אימוג\'י אחד שמתאים לשורה, או מחרוזת ריקה. לא יותר מבשליש מהשורות.' : '- emoji: תמיד מחרוזת ריקה.'}

חובה: בדיוק ${p.lines.length} פריטים, באותו סדר.
החזר/י JSON בלבד:
{"lines":[{"text":"","hl":[0],"emoji":""}]}`;

/** CRM: a short, personal follow-up message to one contact, in the business's voice. */
export const followupPrompt = (b: BrandProfile, p: {
  name: string; stage: string; source?: string; notes?: string; history: string[]; goal?: string;
}) => `${brandContext(b)}

כתוב/כתבי הודעת המשך קצרה ללקוח/ה, בעברית טבעית, בטון של העסק — כאילו בעל/ת העסק כותב/ת בוואטסאפ.
איש הקשר: ${p.name}
שלב: ${p.stage}${p.source ? `\nמקור: ${p.source}` : ''}${p.notes ? `\nהערות: ${p.notes}` : ''}
${p.history.length ? `מה קרה עד עכשיו (מהחדש לישן):\n${p.history.map((h) => `- ${h}`).join('\n')}` : 'עוד לא היה קשר.'}
${p.goal ? `מטרת ההודעה: ${p.goal}` : 'מטרת ההודעה: לקדם את הלקוח לצעד הבא בצורה טבעית (לקבוע תור / לחזור לשאלה / להציע עזרה), בלי לחץ.'}

חוקים: 2–4 משפטים. פנייה בשם הפרטי. בלי הבטחות שלא נאמרו, בלי מחירים שלא הופיעו למעלה, בלי סימני קריאה מוגזמים. מקסימום אימוג'י אחד.
החזר/י JSON בלבד: {"message":""}`;

/**
 * Finance: a payment reminder, reworded. The AI never sees the customer, the amount, the document or any date — only a
 * template with {{placeholders}} — and must keep every placeholder and write no number, date, currency or link of its own.
 * The app fills the real values afterwards and rejects any answer that breaks the rule (aiDraftIsSafe).
 */
export const collectionPrompt = (p: { tone: string; template: string; business: string }) => `נסח/י מחדש תזכורת תשלום קצרה בוואטסאפ, בעברית טבעית ומנומסת, בשם העסק "${p.business.slice(0, 80)}".
הטון: ${p.tone === 'final' ? 'תזכורת אחרונה — ברורה ומכבדת, בלי איומים' : p.tone === 'firm' ? 'ברור וענייני' : 'חם ועדין'}.
הנוסח הנוכחי:
${p.template.slice(0, 700)}

חוקים מחייבים:
- להשאיר בדיוק את המצייני מקום האלה, כמו שהם, בלי לשנות אותם: {{name}} {{doc}} {{amount}} {{due}} {{business}} {{link}} — חובה לפחות {{amount}} ו-{{doc}}.
- לא לכתוב שום מספר, סכום, תאריך, מטבע או קישור — רק דרך המצייני מקום.
- 2–4 משפטים, בלי סימני קריאה מוגזמים, מקסימום אימוג'י אחד.
החזר/י JSON בלבד: {"message":""}`;

/**
 * Dream Commerce (2.54): the text of a product page — a suggestion the owner reads, edits and approves before saving.
 * The AI sees the product's own words only (name, kind, options, tags, the business's fields) — never a price, stock or
 * sales — and may not add facts: materials, sizes, ingredients, health claims, delivery, warranty, discounts.
 */
export const productCopyPrompt = (b: BrandProfile, p: {
  name: string; kind?: string; tags?: string[]; options?: { name: string; choices: string[] }[]; fields?: { label: string; value: string }[];
  manufacturer?: string; country?: string; current?: string;
}) => `${brandContext(b)}

כתוב/כתבי טקסט לעמוד מוצר בחנות האונליין של העסק, בעברית טבעית (לא מתורגמת), בטון של העסק.
המוצר: ${String(p.name ?? '').slice(0, 80)}${p.kind ? `\nסוג: ${String(p.kind).slice(0, 30)}` : ''}
${(p.options ?? []).slice(0, 3).map((o) => `${String(o.name).slice(0, 30)}: ${(o.choices ?? []).slice(0, 20).map((c) => String(c).slice(0, 40)).join(', ')}`).join('\n')}
${(p.tags ?? []).length ? `תגיות: ${(p.tags ?? []).slice(0, 30).map((t) => String(t).slice(0, 40)).join(', ')}` : ''}
${(p.fields ?? []).slice(0, 12).map((f) => `${String(f.label).slice(0, 40)}: ${String(f.value).slice(0, 300)}`).join('\n')}
${p.manufacturer ? `יצרן: ${String(p.manufacturer).slice(0, 120)}` : ''}${p.country ? `\nארץ ייצור: ${String(p.country).slice(0, 60)}` : ''}
${p.current ? `הטקסט הנוכחי — לשפר אותו, בלי להוסיף עובדות:\n${String(p.current).slice(0, 1500)}` : ''}

חוקים מחייבים:
- רק עובדות שמופיעות למעלה. לא להמציא חומרים, מידות, רכיבים, יתרונות בריאותיים או רפואיים, אחריות, משלוח, מבצעים או מלאי.
- בלי מחיר, בלי סימן ₪ ובלי אחוזי הנחה.
- description: 2–4 פסקאות קצרות (50–140 מילים), טקסט רגיל בלי HTML ובלי Markdown. מותרת רשימה קצרה עם "• ".
- seoTitle: עד 60 תווים, עם שם המוצר.
- seoDescription: עד 155 תווים, משפט אחד שמזמין להיכנס.
החזר/י JSON בלבד: {"description":"","seoTitle":"","seoDescription":""}`;

/**
 * Dream Commerce (2.59): a page or a policy of the store's site — the store's own details and, for a policy, the law of the
 * store's country (page-ai.ts) in; a draft out, cleaned by cleanPageCopy and read by the owner before anything is saved.
 */
export const storePagePrompt = (b: BrandProfile, f: PageFacts) => {
  const policy = f.kind === 'policy' && f.policy;
  return `${brandContext(b)}

פרטי החנות (רק אלה עובדות; אין להמציא אחרות):
${factsText(f)}

כתוב/כתבי ${policy ? `את "${f.title || POLICY_LABEL[f.policy!]}" של אתר החנות` : `את העמוד "${String(f.title).slice(0, 120) || 'עמוד'}" באתר החנות`}, בעברית טבעית ופשוטה, בגוף ראשון רבים ("אנחנו"), בטון של העסק.
${policy ? `הכללים שהמדיניות נכתבת לפיהם:\n${legalFacts(f.store.country, f.policy!).map((x) => `- ${x}`).join('\n')}\n` : ''}${f.current.trim() ? `הטקסט הנוכחי — לשמור על מה שהעסק כתב בו, ולהשלים את מה שבסוגריים:\n${f.current.slice(0, 6000)}\n` : ''}
חוקים מחייבים:
- רק עובדות מהפרטים למעלה${policy ? ' ומהכללים' : ''}. מה שרק העסק יודע (זמני אספקה, שם רכז/ת נגישות, תאריך) — בסוגריים מרובעים עם הצעה, למשל: [3–5 ימי עסקים — לעדכן].
- אסור לכתוב "האתר נגיש", "עומד בתקן", "מאושר" או כל טענה שלא נבדקה.${policy ? '\n- בסוף: שורה נפרדת "[לבדוק עם עורך דין לפני הפרסום — ואחרי הבדיקה למחוק את השורה הזו.]".' : ''}
- עיצוב: שורה ריקה בין פסקאות, "## " בתחילת שורה לכותרת, "- " לרשימה. בלי HTML, בלי **.
- body: ${policy ? '250–700' : '80–300'} מילים. title: קצר. seoTitle: עד 60 תווים. seoDescription: עד 155 תווים, משפט אחד.
החזר/י JSON בלבד: {"title":"","body":"","seoTitle":"","seoDescription":""}`;
};

/** Dream Commerce (2.59): a category's description, or the store's one sentence — from names only, no facts made up */
export const storeTextPrompt = (b: BrandProfile, store: PageFacts['store'], a: ShortAsk) => `${brandContext(b)}
שם החנות: ${store.name}${store.description ? `\nעל החנות: ${store.description}` : ''}

${a.field === 'collection'
    ? `כתוב/כתבי תיאור לקטגוריה "${String(a.title).slice(0, 80)}" באתר החנות${a.tags.length ? ` (תגיות: ${a.tags.slice(0, 20).map((t) => String(t).slice(0, 40)).join(', ')})` : ''}: 1–3 משפטים שמזמינים לראות את המוצרים.`
    : 'כתוב/כתבי משפט אחד על החנות (עד 160 תווים) — מופיע בגוגל ובתחתית האתר.'}
${a.current.trim() ? `הטקסט הנוכחי — לשפר בלי להוסיף עובדות:\n${a.current.slice(0, 600)}\n` : ''}
חוקים: עברית טבעית, בטון של העסק. רק מה שידוע למעלה — בלי מחירים, מבצעים, משלוח, חומרים או הבטחות. בלי HTML.
החזר/י JSON בלבד: {"text":""${a.field === 'collection' ? ',"seoTitle":"","seoDescription":""' : ''}}`;

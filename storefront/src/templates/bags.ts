import type { Template } from '@/lib/theme';

/**
 * "שקיות ממותגות" — the first template (stage 2, the owner's choice for FollowMe Collection): warm paper and kraft tones,
 * a hero with a drawn bag when there is no picture, the kinds of bags (collections), the best sellers, why a branded bag,
 * how an order works, questions, and a way to talk.
 * Every text here is an example for the business to change in the dashboard (Store → Design); none of it claims a fact
 * about a business (no prices, no delivery times, no materials).
 */
export const BAGS: Template = {
  id: 'bags',
  name: 'שקיות ממותגות',
  colors: {
    background: '#fbf8f3', surface: '#ffffff', text: '#1f1b16', muted: '#5f574e', primary: '#1f1b16',
    accent: '#8a5a2b', accentSoft: '#f1e6d6', border: '#e7ddcf',
  },
  font: 'heebo',
  radius: 'medium',
  announcement: { enabled: true, text: 'שקיות ממותגות לעסקים — עם הלוגו שלכם', href: '/collections/all' },
  product: { related: true, whatsapp: true },
  sections: [
    { id: 'hero', type: 'hero', hidden: false, settings: {
      eyebrow: 'שקיות ממותגות',
      title: 'הלוגו שלכם, על כל שקית',
      subtitle: 'שקיות לעסקים בהדפסה לפי המידה שלכם. בוחרים דגם, שולחים לוגו — ומקבלים שקיות מוכנות.',
      primaryLabel: 'לכל השקיות', primaryHref: '/collections/all',
      secondaryLabel: 'שאלה בוואטסאפ', secondaryHref: 'whatsapp',
      image: '',
    } },
    { id: 'collections', type: 'collections', hidden: false, settings: { title: 'סוגי שקיות', subtitle: '' } },
    { id: 'featured', type: 'products', hidden: false, settings: { title: 'הכי מבוקשות', collection: '', limit: 8, buttonLabel: 'לכל השקיות' } },
    { id: 'about', type: 'imageText', hidden: false, settings: {
      title: 'למה שקית ממותגת?',
      text: 'שקית עם הלוגו ממשיכה ללכת עם הלקוח גם אחרי הקנייה. היא חלק מהחוויה, והיא מזכירה את העסק בכל מקום שהיא מגיעה אליו.',
      image: '', buttonLabel: 'לקטלוג', buttonHref: '/collections/all', imageSide: 'start',
    } },
    { id: 'steps', type: 'steps', hidden: false, settings: {
      title: 'איך זה עובד',
      items: [
        { title: 'בוחרים שקית', text: 'דגם, מידה וצבע מהקטלוג.' },
        { title: 'שולחים לוגו', text: 'קובץ של הלוגו, ואם יש — גם הנחיות להדפסה.' },
        { title: 'מאשרים', text: 'מקבלים את כל הפרטים ומאשרים לפני ההדפסה.' },
        { title: 'מקבלים', text: 'השקיות מגיעות מודפסות ומוכנות.' },
      ],
    } },
    { id: 'faq', type: 'faq', hidden: true, settings: { title: 'שאלות נפוצות', items: [] } },
    { id: 'contact', type: 'contact', hidden: false, settings: { title: 'נדבר?', text: 'שאלה על דגם, כמויות או הדפסה — כתבו לנו ונחזור אליכם.' } },
  ],
};

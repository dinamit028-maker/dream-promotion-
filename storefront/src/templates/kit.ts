import type { Template } from '@/lib/theme';

/**
 * "kit" — the open template of the starter kits (2.58). A kit's own sections, colours and font come in the saved settings
 * (the dashboard writes them when a kit is applied; resolveTheme checks every one). These values are only what a store on
 * this template shows before any settings were saved: a plain, neutral home page. Like every template, no text here claims
 * a fact about a business.
 */
export const KIT: Template = {
  id: 'kit',
  name: 'ערכת הקמה',
  open: true,
  colors: {
    background: '#fafafa', surface: '#ffffff', text: '#1a1a1a', muted: '#595959', primary: '#1a1a1a',
    accent: '#2f5d8a', accentSoft: '#e8eef5', border: '#e2e2e2',
  },
  font: 'heebo',
  art: 'plain',
  radius: 'medium',
  announcement: { enabled: false, text: '', href: '' },
  product: { related: true, whatsapp: true },
  sections: [
    { id: 'hero', type: 'hero', hidden: false, settings: {
      eyebrow: '', title: '', subtitle: '', primaryLabel: 'לכל המוצרים', primaryHref: '/collections/all',
      secondaryLabel: 'שאלה בוואטסאפ', secondaryHref: 'whatsapp', image: '',
    } },
    { id: 'featured', type: 'products', hidden: false, settings: { title: 'חדש באתר', collection: '', limit: 8, buttonLabel: 'לכל המוצרים' } },
    { id: 'collections', type: 'collections', hidden: false, settings: { title: 'קטגוריות', subtitle: '' } },
    { id: 'contact', type: 'contact', hidden: false, settings: { title: 'יצירת קשר', text: '' } },
  ],
};

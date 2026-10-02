import type { Metadata } from 'next';
import { Contact, ContactEn, LegalPage } from '@/features/legal/LegalPage';

export const metadata: Metadata = { title: 'מחיקת מידע · Dream Promotion', description: 'Data deletion instructions — Dream Promotion' };

/** Data deletion instructions — the URL Meta (and TikTok) require in the app settings. */
export default function DataDeletionPage() {
  return (
    <LegalPage title="הוראות מחיקת מידע" en="Data Deletion Instructions" english={<>
      <p>You can remove the data Dream Promotion holds about you at any time.</p>
      <h2>Disconnect Facebook / Instagram / TikTok</h2>
      <ul>
        <li>In Dream Promotion, open <strong>Connections</strong> and press <strong>Disconnect</strong> next to the account. The stored access tokens are deleted immediately.</li>
        <li>Or, on Facebook: Settings &amp; privacy → Settings → <strong>Business Integrations</strong> → select Dream Promotion → <strong>Remove</strong>.</li>
      </ul>
      <h2>Delete imported media and content</h2>
      <ul>
        <li>On the <strong>Media</strong> screen, choose &quot;Instagram posts &amp; reels&quot; or &quot;Instagram stories&quot; and press <strong>Remove all</strong>, or select files and delete them. Files are removed from our storage.</li>
        <li>Content and reels can be deleted from the Content screen.</li>
      </ul>
      <h2>Delete your whole account</h2>
      <p>Email <ContactEn /> from the address you signed up with, with the subject &quot;Delete my account&quot;. We delete your account, content, media, connected-account tokens and usage records within 30 days and confirm by email. Nothing is posted on your social accounts as part of this process, and nothing already published there is changed.</p>
    </>}>
      <p>אפשר למחוק בכל רגע את המידע ש-Dream Promotion שומר עליכם.</p>
      <h2>ניתוק פייסבוק, אינסטגרם או TikTok</h2>
      <ul>
        <li>ב-Dream Promotion, היכנסו ל<strong>חיבורים</strong> ולחצו <strong>ניתוק</strong> ליד החשבון. ההרשאות השמורות נמחקות מיד.</li>
        <li>או בפייסבוק: הגדרות ופרטיות ← הגדרות ← <strong>אינטגרציות עסקיות</strong> ← Dream Promotion ← <strong>הסרה</strong>.</li>
      </ul>
      <h2>מחיקת מדיה ותוכן שיובאו</h2>
      <ul>
        <li>במסך <strong>מדיה</strong>, בחרו &quot;פוסטים ורילס מאינסטגרם&quot; או &quot;סטוריז מאינסטגרם&quot; ולחצו <strong>הסרת כל הקבצים</strong>, או בחרו קבצים ומחקו. הקבצים נמחקים מהאחסון שלנו.</li>
        <li>תוכן ורילים נמחקים ממסך התוכן.</li>
      </ul>
      <h2>מחיקת החשבון כולו</h2>
      <p>שלחו מייל אל <Contact /> מהכתובת שאיתה נרשמתם, עם הנושא &quot;מחיקת חשבון&quot;. נמחק את החשבון, התוכן, המדיה, הרשאות הרשתות ונתוני השימוש תוך 30 יום, ונאשר במייל. התהליך לא מפרסם שום דבר ברשתות שלכם, ולא משנה מה שכבר פורסם שם.</p>
    </LegalPage>
  );
}

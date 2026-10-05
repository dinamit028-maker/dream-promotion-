import type { Metadata } from 'next';
import { Contact, ContactEn, LegalPage } from '@/features/legal/LegalPage';

export const metadata: Metadata = { title: 'מדיניות פרטיות · Dream Promotion', description: 'Privacy Policy — Dream Promotion' };

export default function PrivacyPage() {
  return (
    <LegalPage title="מדיניות פרטיות" en="Privacy Policy" english={<>
      <p>Dream Promotion (&quot;we&quot;, &quot;the service&quot;) helps businesses create marketing content — posts, images, videos and voice-overs — and send it to their own social media accounts. This policy explains what we collect and how we use it.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account details: your email address and sign-in information.</li>
        <li>Content you create or upload: text, images, videos, audio and brand details.</li>
        <li>Connected social accounts: when you connect Facebook, Instagram or TikTok, we receive your basic profile (name, picture, account ID), the Facebook Pages and Instagram business accounts you choose to connect, and access tokens that let us act on your request.</li>
        <li>From connected Instagram accounts: your stories, posts and reels (media files, captions, dates) when you import them into your media library, and the like and comment counts of your own posts, used only to suggest good posting times for you.</li>
        <li>Usage data needed to run the service, such as generation counts for monthly limits.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To generate and store your content, and to show it back to you.</li>
        <li>To publish to your connected Facebook Page, Instagram account or TikTok drafts — only content you chose, and only when you press publish or schedule it for a time you picked. We never post on our own initiative.</li>
        <li>To copy your own Instagram stories, posts and reels into your private media library, so you can reuse them in new content. Imported media is visible only to you.</li>
        <li>We do not sell your data and do not use it for advertising.</li>
      </ul>
      <h2>Service providers</h2>
      <p>We use trusted providers to run the service: Supabase (accounts, database and file storage), Vercel (hosting), Anthropic (text generation), fal.ai (image and video generation) and ElevenLabs (voice). Content is sent to them only as needed to perform the task you asked for. A supplier invoice you attach to an expense is sent to Anthropic only when you press "automatic reading" (it fills the form; nothing is saved until you confirm).</p>
      <h2>Social account tokens</h2>
      <p>Access tokens are stored encrypted on our servers, are never shown in your browser, and are used only for the actions described above. You can disconnect an account at any time on the Connections screen; this deletes the stored tokens. You can also remove Dream Promotion from your Facebook settings (Business Integrations) or your TikTok settings. Data received from Meta is not sold, shared with third parties or used for advertising.</p>
      <h2>Retention and deletion</h2>
      <p>Your data is kept while your account is active. You can delete content and media at any time (imported Instagram media can be removed in one click on the Media screen), and you may ask us to delete your account and all related data — see <a href="/data-deletion">Data deletion instructions</a> or contact us at <ContactEn />.</p>
      <h2>Security</h2>
      <p>Data is transferred over HTTPS, each account can access only its own data, and third-party tokens are encrypted at rest.</p>
      <h2>Contact</h2>
      <p>Questions or requests: <ContactEn />.</p>
    </>}>
      <p>Dream Promotion (&quot;השירות&quot;) עוזר לעסקים ליצור תוכן שיווקי (פוסטים, תמונות, סרטונים וקריינות) ולשלוח אותו לחשבונות הרשתות החברתיות שלהם. כאן מוסבר מה נאסף ואיך משתמשים בזה.</p>
      <h2>מה נאסף</h2>
      <ul>
        <li>פרטי חשבון: כתובת אימייל ופרטי כניסה.</li>
        <li>תוכן שיצרתם או העליתם: טקסטים, תמונות, סרטונים, אודיו ופרטי המותג.</li>
        <li>חשבונות רשתות מחוברים: כשמחברים פייסבוק, אינסטגרם או TikTok, מתקבלים פרטי פרופיל בסיסיים (שם, תמונה, מזהה חשבון), עמודי הפייסבוק וחשבונות האינסטגרם העסקיים שבחרתם לחבר, והרשאות גישה שמאפשרות לפעול לבקשתכם.</li>
        <li>מחשבונות אינסטגרם מחוברים: הסטוריז, הפוסטים והרילס שלכם (קבצים, כיתובים ותאריכים) כשאתם מייבאים אותם לספריית המדיה, ומספרי הלייקים והתגובות של הפוסטים שלכם, רק כדי להציע לכם שעות פרסום טובות.</li>
        <li>נתוני שימוש שנדרשים להפעלת השירות, כמו מספר יצירות לצורך מגבלות חודשיות.</li>
      </ul>
      <h2>איך משתמשים במידע</h2>
      <ul>
        <li>ליצירה ושמירה של התוכן שלכם, ולהצגתו לכם.</li>
        <li>לפרסום בעמוד הפייסבוק, בחשבון האינסטגרם או בטיוטות TikTok שחיברתם: רק תוכן שבחרתם, ורק כשאתם לוחצים "פרסום" או מתזמנים אותו לשעה שבחרתם. אנחנו לא מפרסמים שום דבר ביוזמתנו.</li>
        <li>להעתקת הסטוריז, הפוסטים והרילס שלכם מאינסטגרם לספריית המדיה הפרטית שלכם, כדי שתוכלו להשתמש בהם בתוכן חדש. המדיה שמיובאת גלויה רק לכם.</li>
        <li>איננו מוכרים מידע ולא משתמשים בו לפרסום.</li>
      </ul>
      <h2>ספקי שירות</h2>
      <p>השירות פועל בעזרת ספקים: Supabase (חשבונות, מסד נתונים ואחסון), Vercel (אירוח), Anthropic (יצירת טקסט), fal.ai (יצירת תמונות ווידאו) ו-ElevenLabs (קול). תוכן נשלח אליהם רק כשצריך לבצע פעולה שביקשתם. חשבונית של ספק שמצרפים להוצאה נשלחת ל-Anthropic רק בלחיצה על &quot;קריאה אוטומטית&quot; (היא ממלאת את הטופס; שום דבר לא נשמר בלי אישורכם).</p>
      <h2>הרשאות הרשתות</h2>
      <p>ההרשאות נשמרות מוצפנות בשרת, לא מוצגות בדפדפן, ומשמשות רק לפעולות שתוארו למעלה. אפשר לנתק חשבון בכל רגע במסך &quot;חיבורים&quot;, וזה מוחק את ההרשאות השמורות. אפשר להסיר את Dream Promotion גם מהגדרות הפייסבוק (אינטגרציות עסקיות) או מהגדרות TikTok. מידע שמתקבל מ-Meta לא נמכר, לא מועבר לצד שלישי ולא משמש לפרסום.</p>
      <h2>שמירה ומחיקה</h2>
      <p>המידע נשמר כל עוד החשבון פעיל. אפשר למחוק תוכן ומדיה בכל עת (מדיה שיובאה מאינסטגרם נמחקת בלחיצה אחת במסך המדיה), ולבקש מחיקת החשבון וכל המידע הקשור, ראו <a href="/data-deletion">הוראות מחיקת מידע</a> או פנו אל <Contact />.</p>
      <h2>אבטחה</h2>
      <p>המידע עובר בחיבור מוצפן (HTTPS), כל חשבון רואה רק את המידע שלו, והרשאות הרשתות מוצפנות בשמירה.</p>
      <h2>יצירת קשר</h2>
      <p>שאלות ובקשות: <Contact />.</p>
    </LegalPage>
  );
}

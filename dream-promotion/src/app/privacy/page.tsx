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
        <li>Connected social accounts: when you connect TikTok (and, later, Instagram or Facebook), we receive your basic profile (display name, avatar, account ID) and access tokens that let us upload content on your request.</li>
        <li>Usage data needed to run the service, such as generation counts for monthly limits.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To generate and store your content, and to show it back to you.</li>
        <li>To upload videos to your connected accounts — only when you press the send or publish button. We never post on our own initiative.</li>
        <li>We do not sell your data and do not use it for advertising.</li>
      </ul>
      <h2>Service providers</h2>
      <p>We use trusted providers to run the service: Supabase (accounts, database and file storage), Vercel (hosting), Anthropic (text generation), fal.ai (image and video generation) and ElevenLabs (voice). Content is sent to them only as needed to perform the task you asked for.</p>
      <h2>Social account tokens</h2>
      <p>Access tokens are stored encrypted on our servers, are never shown in your browser, and are used only to upload content you chose to send. You can disconnect an account at any time on the Connections screen; this revokes our access and deletes the stored tokens. You can also revoke access from your TikTok settings.</p>
      <h2>Retention and deletion</h2>
      <p>Your data is kept while your account is active. You can delete content and media at any time, and you may ask us to delete your account and all related data by contacting us at <ContactEn />.</p>
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
        <li>חשבונות רשתות מחוברים: כשמחברים TikTok (ובהמשך אינסטגרם או פייסבוק), מתקבלים פרטי פרופיל בסיסיים (שם תצוגה, תמונה, מזהה חשבון) והרשאות גישה שמאפשרות להעלות תוכן לבקשתכם.</li>
        <li>נתוני שימוש שנדרשים להפעלת השירות, כמו מספר יצירות לצורך מגבלות חודשיות.</li>
      </ul>
      <h2>איך משתמשים במידע</h2>
      <ul>
        <li>ליצירה ושמירה של התוכן שלכם, ולהצגתו לכם.</li>
        <li>להעלאת סרטונים לחשבונות שחיברתם, רק כשאתם לוחצים על כפתור השליחה או הפרסום. אנחנו לא מפרסמים שום דבר ביוזמתנו.</li>
        <li>איננו מוכרים מידע ולא משתמשים בו לפרסום.</li>
      </ul>
      <h2>ספקי שירות</h2>
      <p>השירות פועל בעזרת ספקים: Supabase (חשבונות, מסד נתונים ואחסון), Vercel (אירוח), Anthropic (יצירת טקסט), fal.ai (יצירת תמונות ווידאו) ו-ElevenLabs (קול). תוכן נשלח אליהם רק כשצריך לבצע פעולה שביקשתם.</p>
      <h2>הרשאות הרשתות</h2>
      <p>ההרשאות נשמרות מוצפנות בשרת, לא מוצגות בדפדפן, ומשמשות רק להעלאת תוכן שבחרתם לשלוח. אפשר לנתק חשבון בכל רגע במסך &quot;חיבורים&quot;: זה מבטל את הגישה ומוחק את ההרשאות השמורות. אפשר לבטל גישה גם מהגדרות TikTok.</p>
      <h2>שמירה ומחיקה</h2>
      <p>המידע נשמר כל עוד החשבון פעיל. אפשר למחוק תוכן ומדיה בכל עת, ולבקש מחיקת החשבון וכל המידע הקשור בפנייה אל <Contact />.</p>
      <h2>אבטחה</h2>
      <p>המידע עובר בחיבור מוצפן (HTTPS), כל חשבון רואה רק את המידע שלו, והרשאות הרשתות מוצפנות בשמירה.</p>
      <h2>יצירת קשר</h2>
      <p>שאלות ובקשות: <Contact />.</p>
    </LegalPage>
  );
}

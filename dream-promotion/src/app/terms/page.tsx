import type { Metadata } from 'next';
import { Contact, ContactEn, LegalPage } from '@/features/legal/LegalPage';

export const metadata: Metadata = { title: 'תנאי שימוש · Dream Promotion', description: 'Terms of Service — Dream Promotion' };

export default function TermsPage() {
  return (
    <LegalPage title="תנאי שימוש" en="Terms of Service" english={<>
      <p>By using Dream Promotion you agree to these terms.</p>
      <h2>The service</h2>
      <p>Dream Promotion provides tools to create marketing content with AI and to send it to social media accounts you connect. Features may change as the service develops.</p>
      <h2>Your account and content</h2>
      <ul>
        <li>You are responsible for your account and for keeping your sign-in details safe.</li>
        <li>You keep ownership of the content you upload and create. You grant us the rights needed to store, process and deliver it for you.</li>
        <li>You must have the rights to anything you upload (images, videos, music, logos), and your content must follow the law and the rules of each platform you publish to, including TikTok&apos;s Terms of Service and Community Guidelines.</li>
        <li>AI-generated content can contain mistakes. Review everything before publishing; you are responsible for what is published from your accounts.</li>
      </ul>
      <h2>Connected social accounts</h2>
      <p>When you connect a social account you authorize us to upload the content you choose. We act only on your explicit request. You can disconnect at any time from the Connections screen.</p>
      <h2>Fair use and limits</h2>
      <p>Generation features may have monthly limits. Abuse, spam, or attempts to misuse third-party platforms may lead to suspension.</p>
      <h2>Liability</h2>
      <p>The service is provided &quot;as is&quot;. To the extent permitted by law, we are not liable for indirect damages, lost profits, or actions taken by third-party platforms.</p>
      <h2>Changes and contact</h2>
      <p>We may update these terms and will note the date above. Contact: <ContactEn />.</p>
    </>}>
      <p>השימוש ב-Dream Promotion מהווה הסכמה לתנאים האלה.</p>
      <h2>השירות</h2>
      <p>Dream Promotion מספק כלים ליצירת תוכן שיווקי בעזרת AI ולשליחתו לחשבונות רשתות חברתיות שחיברתם. היכולות עשויות להשתנות עם התפתחות השירות.</p>
      <h2>החשבון והתוכן שלכם</h2>
      <ul>
        <li>אתם אחראים לחשבון ולשמירה על פרטי הכניסה.</li>
        <li>התוכן שהעליתם ויצרתם נשאר שלכם. אתם מעניקים לנו את ההרשאות הנדרשות כדי לשמור, לעבד ולספק אותו עבורכם.</li>
        <li>צריכות להיות לכם הזכויות לכל מה שמועלה (תמונות, סרטונים, מוזיקה, לוגואים), והתוכן חייב לעמוד בחוק ובכללי כל רשת שבה מפרסמים, כולל תנאי השימוש וכללי הקהילה של TikTok.</li>
        <li>תוכן שנוצר ב-AI עלול לכלול טעויות. בדקו כל פרסום לפני שהוא יוצא; האחריות למה שמתפרסם מהחשבונות שלכם היא שלכם.</li>
      </ul>
      <h2>חשבונות רשתות מחוברים</h2>
      <p>כשמחברים חשבון, אתם מאשרים לנו להעלות את התוכן שתבחרו. אנחנו פועלים רק לפי בקשה מפורשת שלכם. אפשר לנתק בכל רגע ממסך &quot;חיבורים&quot;.</p>
      <h2>שימוש הוגן ומגבלות</h2>
      <p>ליצירת תוכן עשויות להיות מגבלות חודשיות. ניצול לרעה, ספאם או שימוש לא תקין ברשתות צד שלישי עלולים להוביל להשעיה.</p>
      <h2>אחריות</h2>
      <p>השירות ניתן &quot;כמות שהוא&quot;. במידה המותרת בחוק, איננו אחראים לנזקים עקיפים, אובדן רווחים או פעולות של רשתות צד שלישי.</p>
      <h2>שינויים ויצירת קשר</h2>
      <p>התנאים עשויים להתעדכן, והתאריך למעלה ישתנה בהתאם. יצירת קשר: <Contact />.</p>
    </LegalPage>
  );
}

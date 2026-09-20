'use client';
import { useState } from 'react';
import { SocialPublishingService } from '@/lib/services';
import { Button, Card, PageHead, Pill } from '@/components/ui/primitives';
import { AdapterNote, IntegrationDialog } from '@/components/ui/feedback';

export default function IntegrationsPage() {
  const [dialog, setDialog] = useState<string | null>(null);
  return (
    <>
      <PageHead title="חיבורים" sub="כל חיבור מחייב OAuth אמיתי. אין כאן חיבור מדומה." />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
        {SocialPublishingService.providers.map((p) => (
          <Card key={p}>
            <div className="flex items-center justify-between">
              <strong className="text-[17px]">{p}</strong><Pill tone="warn">לא מחובר</Pill>
            </div>
            <p className="my-2.5 text-sm text-muted">
              {p === 'WhatsApp' ? 'קבלת לידים ושליחת הודעות דרך WhatsApp Business API' : 'פרסום, תזמון ומשיכת נתוני ביצועים'}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setDialog(p)}>חיבור חשבון</Button>
          </Card>
        ))}
      </div>
      <div className="mt-6">
        <AdapterNote title="מה נדרש לפרודקשן:">
          Meta App עם <code>instagram_content_publish</code>, <code>pages_manage_posts</code>,{' '}
          <code>ads_management</code>, <code>leads_retrieval</code>, וחשבון WhatsApp Business.
        </AdapterNote>
      </div>
      <IntegrationDialog open={!!dialog} onClose={() => setDialog(null)} provider={dialog || ''} what="חיבור החשבון" />
    </>
  );
}

'use client';
import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Button, Card, Field, Input, PageHead, Select } from '@/components/ui/primitives';
import { AdapterNote, EmptyState, Modal } from '@/components/ui/feedback';
import { today } from '@/lib/utils';
import type { LeadStatus } from '@/types';

const STATUSES: LeadStatus[] = ['חדש', 'נוצר קשר', 'מעוניין', 'נקבע תור', 'נסגר', 'לא רלוונטי'];

export default function LeadsPage() {
  const { leads, addLead, updateLead } = useApp();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', source: 'ידני' });

  return (
    <>
      <PageHead title="לידים" sub={`${leads.length} פניות`}
        action={<Button variant="primary" onClick={() => setOpen(true)}>+ ליד ידני</Button>} />
      <div className="mb-6">
        <AdapterNote>לידים אוטומטיים מגיעים אחרי חיבור Meta Lead Ads או WhatsApp. עד אז אפשר לנהל פניות ידנית.</AdapterNote>
      </div>
      {leads.length ? (
        <Card className="overflow-x-auto p-3">
          <table className="w-full text-sm">
            <thead><tr className="text-xs font-bold text-muted">
              {['שם', 'טלפון', 'מקור', 'תאריך', 'סטטוס'].map((h) => <th key={h} className="p-2.5 text-start">{h}</th>)}
            </tr></thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="p-2.5"><strong>{l.name}</strong></td>
                  <td className="p-2.5 text-muted">{l.phone || '—'}</td>
                  <td className="p-2.5 text-muted">{l.source}</td>
                  <td className="p-2.5 text-muted">{l.date}</td>
                  <td className="p-2.5">
                    <Select value={l.status} className="px-2.5 py-1.5 text-[13px]"
                      onChange={(e) => updateLead(l.id, { status: e.target.value as LeadStatus })}>
                      {STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState emoji="☺" title="אין לידים עדיין" body="כאן ינחתו הפניות מהקמפיינים ומהוואטסאפ."
          action={<Button variant="primary" onClick={() => setOpen(true)}>הוספת ליד ידני</Button>} />
      )}

      <Modal open={open} onClose={() => setOpen(false)}>
        <h3 className="mb-4 font-display text-xl font-extrabold">ליד חדש</h3>
        <Field label="שם"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="טלפון"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="מקור"><Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></Field>
        <div className="flex gap-3">
          <Button variant="primary" onClick={() => {
            if (!form.name.trim()) return;
            addLead({ ...form, date: today(), status: 'חדש' });
            setForm({ name: '', phone: '', source: 'ידני' }); setOpen(false);
          }}>הוספה</Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button>
        </div>
      </Modal>
    </>
  );
}

'use client';
import { use } from 'react';
import { Form101Wizard } from '@/features/attendance/Form101Wizard';

/** the employee's טופס 101 (docs/FORM101_REQUIREMENTS_HE.md) — the personal link, no sign-in, nothing of Dream */
export default function Form101Page(props: { params: Promise<{ token: string }> }) {
  const { token } = use(props.params);
  return <Form101Wizard token={token} />;
}

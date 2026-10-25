'use client';
import { use } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { EmployeeMonth } from '@/features/attendance/EmployeeMonth';
import { EmployeeForm101 } from '@/features/attendance/EmployeeForm101';
import { useAtt } from '@/features/attendance/AttendanceLayout';
import { seesPrivate } from '@/features/attendance/people';
import { attendanceHref } from '@/features/attendance/routes';
import { cx } from '@/lib/utils';

/** one employee: the monthly report, and טופס 101 (the admin and payroll only — 2.108) */
export default function AttendanceEmployeePage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);   // Next 15: a page's params arrive as a promise
  const att = useAtt();
  const search = useSearchParams();
  const emp = att.setup.employees.find((e) => e.id === params.id) ?? null;
  const forms = seesPrivate(att.role) && emp;
  const tab = forms && search.get('tab') === 'form101' ? 'form101' : 'month';
  const base = `/attendance/employees/${encodeURIComponent(params.id)}`;
  return (
    <>
      <Link href={attendanceHref('employees')} className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-module">→ כל העובדים</Link>
      {forms && (
        <nav className="mb-4 flex gap-2" aria-label="תיק העובד/ת">
          {([['month', 'דוח שעות', base], ['form101', 'טופס 101', `${base}?tab=form101`]] as const).map(([k, label, href]) => (
            <Link key={k} href={href} aria-current={tab === k ? 'page' : undefined}
              className={cx('inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold', tab === k ? 'border-module bg-module-soft text-module' : 'border-line text-ink-2')}>{label}</Link>
          ))}
        </nav>
      )}
      {tab === 'form101' && emp ? <EmployeeForm101 employee={emp} /> : <EmployeeMonth id={params.id} />}
    </>
  );
}

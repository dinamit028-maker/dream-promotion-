'use client';
import { use } from 'react';
import Link from 'next/link';
import { EmployeeMonth } from '@/features/attendance/EmployeeMonth';
import { attendanceHref } from '@/features/attendance/routes';

/** one employee's monthly report, on its own page */
export default function AttendanceEmployeePage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);   // Next 15: a page's params arrive as a promise
  return (
    <>
      <Link href={attendanceHref('employees')} className="mb-3 inline-flex min-h-11 items-center text-sm font-semibold text-module">→ כל העובדים</Link>
      <EmployeeMonth id={params.id} />
    </>
  );
}

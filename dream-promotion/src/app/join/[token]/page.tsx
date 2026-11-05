'use client';
import { use } from 'react';
import { JoinScreen } from '@/features/admin/JoinScreen';

/** an invited person's link (2.114) — sign in once, choose a password */
export default function JoinPage(props: { params: Promise<{ token: string }> }) {
  const { token } = use(props.params);
  return <JoinScreen token={token} />;
}

/** Version, commit and build date — changes on every deploy, so it is always clear what is live. */
export function VersionTag({ className = '' }: { className?: string }) {
  const v = process.env.NEXT_PUBLIC_APP_VERSION || '';
  const sha = (process.env.NEXT_PUBLIC_BUILD_ID || '').slice(0, 7);
  const date = (process.env.NEXT_PUBLIC_BUILD_DATE || '').split('-').reverse().join('.');
  return (
    <span className={className} dir="ltr">
      v{v}{sha && /^[0-9a-f]{7}$/.test(sha) ? ` · ${sha}` : ''}{date ? ` · ${date}` : ''}
    </span>
  );
}

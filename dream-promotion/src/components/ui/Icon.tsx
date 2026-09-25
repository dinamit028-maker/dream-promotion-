/**
 * The only place icons are imported from. One family (Phosphor), one stroke language.
 * The /ssr entry works in both server and client components.
 * Rule: decorative icons next to visible text get aria-hidden; icon-only controls
 * get an aria-label on the control itself.
 */
import {
  Image as ImageGlyph, FilmReel, DeviceMobile, Megaphone,
} from '@phosphor-icons/react/dist/ssr';
import type { ComponentProps } from 'react';
import type { ContentKind } from '@/types';

export {
  House, PencilSimpleLine, FilmSlate, SquaresFour, CalendarBlank, Images, Compass, Megaphone,
  UsersThree, ChartLineUp, PlugsConnected, GearSix, Sparkle, Plus, X, Check, CaretLeft, CaretRight,
  ArrowsClockwise, SunHorizon, CalendarPlus, Play, FilmReel, DeviceMobile, Warning, ChatCircleDots,
  Storefront, Diamond, ForkKnife, Barbell, Dress, HouseLine, Clock, Trash, Copy, PaperPlaneTilt,
  UploadSimple, Lightning, ShieldCheck, WhatsappLogo, Target, UserCircle, MagicWand, TrendUp, SignOut,
} from '@phosphor-icons/react/dist/ssr';
export { ImageGlyph };

type P = ComponentProps<typeof ImageGlyph>;
const KIND = { post: ImageGlyph, reel: FilmReel, story: DeviceMobile, ad: Megaphone } as const;

export function KindIcon({ kind, ...p }: { kind: ContentKind } & P) {
  const I = KIND[kind] ?? ImageGlyph;
  return <I aria-hidden {...p} />;
}

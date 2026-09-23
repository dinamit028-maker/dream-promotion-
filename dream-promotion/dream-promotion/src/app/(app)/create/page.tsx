import { CreateStudio } from '@/features/create/CreateStudio';
import { PageHead } from '@/components/ui/primitives';

export default function CreatePage() {
  return (
    <>
      <PageHead title="אולפן היצירה" sub="מגדירים בריף, ה-AI מייצר כמה זוויות, בוחרים ומתזמנים." />
      <CreateStudio />
    </>
  );
}

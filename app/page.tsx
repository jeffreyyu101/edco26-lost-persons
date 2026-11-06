import { currentSession } from '@/lib/server';
import App from './ui';
export const dynamic = 'force-dynamic';
export default async function Page() { const session = await currentSession(); return <App initialStaff={session?.staffName || null} initialDepartment={session?.department || null} />; }

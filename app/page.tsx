import { currentStaff } from '@/lib/server';
import App from './ui';
export const dynamic = 'force-dynamic';
export default async function Page() { const staff = await currentStaff(); return <App initialStaff={staff} />; }

// Any other /api/* path (including Jeffrey's removed /api/login, /api/logout, /api/patients/**): a JSON
// 404 with no-store instead of the HTML not-found page, so clients always get the ApiError shape.
import { json } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notFound(): Response {
  return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;

import { currentStaff, db, isUuid, jsonError } from '@/lib/server';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentStaff())) return jsonError('Session expired. Sign in again.', 401);
  const { id } = await params;
  if (!isUuid(id)) return jsonError('Photo not found.', 404);
  const client = db();
  const { data, error } = await client.from('patient_photos').select('storage_path').eq('id', id).eq('is_active', true).maybeSingle();
  if (error) return jsonError('Could not load photo.', 503);
  if (!data) return jsonError('Photo not found.', 404);
  const { data: signed, error: signError } = await client.storage.from('patient-photos').createSignedUrl(data.storage_path, 60);
  if (signError || !signed) return jsonError('Could not create private photo access.', 503);
  return new Response(null, { status: 302, headers: { Location: signed.signedUrl, 'Cache-Control': 'private, no-store' } });
}

import { randomUUID } from 'node:crypto';
import { currentStaff, db, isUuid, jsonError } from '@/lib/server';

const bucket = 'patient-photos';
const maxBytes = 5 * 1024 * 1024;
const types: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await currentStaff();
  if (!staff) return jsonError('Session expired. Sign in again.', 401);
  const { id } = await params;
  if (!isUuid(id)) return jsonError('Inquiry not found.', 404);
  const form = await req.formData().catch(() => null);
  const file = form?.get('photo');
  const timing = form?.get('photo_timing');
  if (!(file instanceof File) || !types[file.type]) return jsonError('Choose a JPEG, PNG, or WebP photo.');
  if (file.size <= 0 || file.size > maxBytes) return jsonError('Photo must be smaller than 5 MB.');
  if (!['older', 'today', 'unsure'].includes(String(timing))) return jsonError('Choose when the photo was taken.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const matchesType = file.type === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : file.type === 'image/png'
      ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!matchesType) return jsonError('Photo content does not match its file type.');

  const client = db();
  const { data: patient, error: patientError } = await client.from('patients').select('id').eq('id', id).maybeSingle();
  if (patientError) return jsonError('Could not verify inquiry.', 503);
  if (!patient) return jsonError('Inquiry not found.', 404);
  const { count, error: countError } = await client.from('patient_photos').select('id', { count: 'exact', head: true }).eq('patient_id', id).eq('is_active', true);
  if (countError) return jsonError('Could not verify photo limit.', 503);
  if ((count || 0) >= 3) return jsonError('This inquiry already has three active photos.');

  const path = `${id}/${randomUUID()}.${types[file.type]}`;
  const { error: uploadError } = await client.storage.from(bucket).upload(path, bytes, { contentType: file.type, upsert: false });
  if (uploadError) return jsonError('Could not store photo in the private bucket. Check that patient-photos exists and is private.', 503);
  const { data: photo, error: metadataError } = await client.from('patient_photos').insert({ patient_id: id, storage_path: path, photo_timing: timing, uploaded_by: staff }).select('id,photo_timing,created_at').single();
  if (metadataError) {
    await client.storage.from(bucket).remove([path]);
    return jsonError('Could not save photo record.', 500);
  }
  const { error: auditError } = await client.from('audit_events').insert({ patient_id: id, staff_name: staff, action_type: 'photo_uploaded', new_value: { photo_id: photo.id, photo_timing: timing } });
  if (auditError) return jsonError('Photo was saved, but its audit event failed. Notify the supervisor.', 500);
  return Response.json({ photo }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

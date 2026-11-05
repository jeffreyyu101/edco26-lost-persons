import { currentStaff, db, isUuid, jsonError } from '@/lib/server';
export async function GET() {
  if (!(await currentStaff())) return jsonError('Session expired. Sign in again.', 401);
  const { data, error } = await db().from('patients').select('*,patient_photos(id,photo_timing,created_at),audit_events(id,action_type,occurred_at,staff_name,previous_value,new_value)').order('created_at', { ascending: false }).limit(500);
  if (error) return jsonError('Could not load the log. Check the Supabase project URL, Data API access, and schema setup.', 503);
  return Response.json({ patients: data });
}
export async function POST(req: Request) {
  const staff = await currentStaff(); if (!staff) return jsonError('Session expired. Sign in again.', 401);
  const body = await req.json().catch(() => null); if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid request.');
  if (body.client_mutation_id !== undefined) {
    if (!isUuid(body.client_mutation_id)) return jsonError('Invalid client mutation ID.');
    const { data: existing, error: lookupError } = await db().from('patients').select('*').eq('client_mutation_id', body.client_mutation_id).maybeSingle();
    if (lookupError) return jsonError('Could not verify whether this inquiry was already saved.', 503);
    if (existing) return Response.json({ patient: existing, already_saved: true });
  }
  if (body.reporting_location === 'Other' && !String(body.other_location || '').trim()) return jsonError('Please specify the other reporting location.');
  const allowed = ['first_name','last_name','age','gender','height_build','hair','identifying_features','physical_description','clothing','additional_notes','reporting_location','other_location','contact_name','contact_phone','contact_relationship','contact_notes'];
  const record: Record<string, unknown> = {}; for (const k of allowed) if (body[k] !== undefined) record[k] = body[k];
  if (record.age !== undefined && record.age !== null && (!Number.isInteger(record.age) || Number(record.age) < 0 || Number(record.age) > 120)) return jsonError('Age must be between 0 and 120.');
  for (const [k, v] of Object.entries(record)) if (v !== null && typeof v !== 'string' && k !== 'age') return jsonError('Invalid inquiry field.');
  for (const [k, v] of Object.entries(record)) if (typeof v === 'string' && v.length > (k.includes('notes') || k === 'physical_description' ? 2000 : 300)) return jsonError('One or more fields are too long.');
  if (body.client_mutation_id) record.client_mutation_id = body.client_mutation_id;
  record.created_by = staff; record.updated_by = staff; record.status = 'Added';
  const { data, error } = await db().from('patients').insert(record).select('*').single();
  if (error) return jsonError(error.message.includes('duplicate') ? 'Possible duplicate inquiry.' : 'Could not save the inquiry.', 500);
  const { error: auditError } = await db().from('audit_events').insert({ patient_id: data.id, staff_name: staff, action_type: 'patient_created', new_value: record });
  if (auditError) return jsonError('Inquiry was saved, but its audit event failed. Notify the supervisor.', 500);
  return Response.json({ patient: data }, { status: 201 });
}

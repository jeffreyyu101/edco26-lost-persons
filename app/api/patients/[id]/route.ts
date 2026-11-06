import { currentStaff, db, isUuid, jsonError } from '@/lib/server';
import { STATUSES } from '@/lib/types';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) return jsonError('Inquiry not found.', 404);

  const staff = await currentStaff();
  if (!staff) return jsonError('Session expired.', 401);

  const body = await req.json().catch(() => null);
  if (!body) return jsonError('Invalid request.');
  if (body.audit_note !== undefined && (typeof body.audit_note !== 'string' || body.audit_note.length > 1000)) return jsonError('Invalid audit note.');

  if (body.status && !STATUSES.includes(body.status)) {
    return jsonError('Invalid status.');
  }

  const { data: old } = await db()
    .from('patients')
    .select('*')
    .eq('id', id)
    .single();

  if (!old) return jsonError('Inquiry not found.', 404);
  if (body.expected_status !== undefined && body.expected_status !== old.status) {
    return jsonError('Status changed by another staff member. The latest status is shown; choose again if needed.', 409);
  }

  const allowed = [
    'first_name',
    'last_name',
    'age',
    'gender',
    'height_build',
    'hair',
    'identifying_features',
    'physical_description',
    'last_seen',
    'clothing',
    'additional_notes',
    'reporting_location',
    'other_location',
    'contact_name',
    'contact_phone',
    'contact_relationship',
    'contact_notes',
    'status',
  ];

  const patch: Record<string, unknown> = {
    updated_by: staff,
    updated_at: new Date().toISOString(),
  };

  for (const k of allowed) {
    if (body[k] !== undefined) patch[k] = body[k];
  }

  const now = new Date().toISOString();
  if (body.status && body.status !== old.status) {
    if (['Found – Awaiting Reunion', 'Found – Discharged', 'Bring friend to medical'].includes(String(body.status)) && !old.found_at) patch.found_at = now;
    if (body.status === 'Found – Awaiting Reunion' && old.status !== 'Found – Awaiting Reunion') patch.reunion_started_at = now;
    if (['Reunited – Closed', 'Found – Discharged', 'Cancelled'].includes(String(body.status))) patch.closed_at = now;
    else patch.closed_at = null;
  }

  const { data, error } = await db()
    .from('patients')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return jsonError('Could not update inquiry.', 500);

  const { error: auditError } = await db().from('audit_events').insert({
    patient_id: id,
    staff_name: staff,
    action_type: body.status === old.status && body.status === 'Checked – Not Found'
      ? 'check_completed'
      : body.status && body.status !== old.status ? 'status_changed' : 'patient_updated',
    previous_value: old,
    new_value: patch,
    notes: body.audit_note || null,
  });
  if (auditError) return jsonError('Inquiry was updated, but its audit event failed. Notify the supervisor.', 500);

  return Response.json({ patient: data });
}

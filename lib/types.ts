export const STATUSES = ['Added','Checked – Not Found','Found – Awaiting Reunion','Reunited – Closed','Found – Discharged','Bring friend to medical','Cancelled'] as const;
export type PatientStatus = typeof STATUSES[number];
export const LOCATIONS = ['FA 3 – Kinetic','FA 4 – Oasis','Command','Base','Other'] as const;
export const DEPARTMENTS = ['GC/HX - Dispatch','GC/HX - Special Operations/Med Transpo','GC/HX - Base','Prevent','Other'] as const;

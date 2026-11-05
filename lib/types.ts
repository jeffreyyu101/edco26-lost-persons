export const STATUSES = ['Added','Checked – Not Found','Found – Awaiting Reunion','Reunited – Closed','Found – Discharged','Found – Transported','Cancelled'] as const;
export type PatientStatus = typeof STATUSES[number];
export const LOCATIONS = ['FA 3 – Kinetic','FA 4 – Oasis','Other'] as const;

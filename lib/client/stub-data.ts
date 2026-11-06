// Synthetic rows for the stub store, mirroring supabase/seed.sql and the mockups (all invented).
// Times are relative to `now` so wait badges look right.
import type { RequestDetail, RequestSummary } from '../api-types';
import { STATUS, joinName, postShort, type StatusValue } from '../domain';

const STAFF = {
  dana: 'Dana Kim · GC/HX - Dispatch',
  lee: 'Lee Park · GC/HX - Base',
  rae: 'Rae Chen · GC/HX - Special Operations/Med Transpo',
  sam: 'Sam Ortiz · Medical',
  alex: 'Alex Rivera · GC/HX - Dispatch',
} as const;

/** The stub's signed-in staff (front of house, like the mockups' "DK"). */
export const STUB_SESSION = { staffName: 'Dana Kim', team: 'GC/HX - Dispatch', staff: STAFF.dana } as const;

interface Spec {
  n: number;
  first: string;
  last?: string;
  age: number;
  gender: 'Male' | 'Female';
  post: string;
  other?: string;
  clothing: string;
  lastSeen?: string;
  desc?: string;
  hair?: string;
  features?: string;
  contact?: [string, string, string];
  status: StatusValue;
  by: keyof typeof STAFF;
  upd: keyof typeof STAFF;
  created: number;
  updated: number;
  found?: number;
  reunion?: number;
  closed?: number;
  version: number;
  photos?: number;
}

const SPECS: Spec[] = [
  { n: 1013, first: 'T.R.', age: 24, gender: 'Male', post: 'FA 4 – Oasis', clothing: 'Red hoodie, blond buzz cut, green wristband', lastSeen: 'Near the circuitGROUNDS entrance', contact: ['Chris P.', '(407) 555-0110', 'Friend'], status: STATUS.waiting, by: 'lee', upd: 'lee', created: 1, updated: 1, version: 0 },
  { n: 1012, first: 'Kayla', last: 'Martinez', age: 19, gender: 'Female', post: 'FA 3 – Kinetic', clothing: 'Pink cowboy hat, silver fringe top, white shorts', lastSeen: 'kineticFIELD rail, ~10:30', desc: 'Pink cowboy hat, silver fringe top, braids. Last seen Kinetic Field rail.', hair: 'Blond, two braids', contact: ['Maya R.', '(407) 555-0142', 'Best friend'], status: STATUS.waiting, by: 'dana', upd: 'dana', created: 12, updated: 9, version: 3, photos: 2 },
  { n: 1011, first: 'D.F.', age: 28, gender: 'Male', post: 'Command', clothing: 'Black cap, glow necklace, cargo shorts', lastSeen: 'Ferris wheel line', contact: ['Priya S.', '407-555-0123', 'Sister'], status: STATUS.waiting, by: 'lee', upd: 'lee', created: 16, updated: 16, version: 0 },
  { n: 1010, first: 'B.W.', age: 23, gender: 'Female', post: 'FA 4 – Oasis', clothing: 'Neon green bikini top, white platform boots, red bandana', lastSeen: 'stereoBLOOM, left side', contact: ['Tasha W.', '(407) 555-0177', 'Cousin'], status: STATUS.waiting, by: 'lee', upd: 'lee', created: 24, updated: 24, version: 0 },
  { n: 1009, first: 'A.N.', age: 21, gender: 'Female', post: 'FA 3 – Kinetic', clothing: 'Light-up butterfly wings, black shorts', lastSeen: 'neonGARDEN', contact: ['Jo N.', '(407) 555-0164', 'Partner'], status: STATUS.notInMedical, by: 'dana', upd: 'rae', created: 38, updated: 20, version: 1 },
  { n: 1008, first: 'N.G.', age: 27, gender: 'Male', post: 'FA 4 – Oasis', clothing: 'White tee, camo pants', hair: 'Black, curly', status: STATUS.notInMedical, by: 'lee', upd: 'sam', created: 45, updated: 30, version: 1 },
  { n: 1007, first: 'Jordan', last: 'Diaz', age: 22, gender: 'Male', post: 'FA 4 – Oasis', clothing: 'Kandi to elbows, white tank, sleeve tattoo', lastSeen: 'Taken to medical', features: 'Sleeve tattoo, left arm', contact: ['Ty B.', '(407) 555-0131', 'Friend'], status: STATUS.inMedical, by: 'lee', upd: 'rae', created: 32, updated: 2, found: 2, reunion: 2, version: 1 },
  { n: 1005, first: 'M.P.', age: 26, gender: 'Male', post: 'FA 3 – Kinetic', clothing: 'Gold sequin jacket, round glasses', features: 'Round glasses', contact: ['Ana P.', '(407) 555-0105', 'Girlfriend'], status: STATUS.legacyBringFriend, by: 'alex', upd: 'alex', created: 80, updated: 60, found: 60, version: 3, photos: 2 },
  { n: 1004, first: 'S.L.', age: 20, gender: 'Female', post: 'FA 3 – Kinetic', clothing: 'Green bucket hat, mesh top', lastSeen: 'kineticFIELD, near the bridge', contact: ['Jess T.', '(407) 555-0187', 'Friend'], status: STATUS.inMedical, by: 'dana', upd: 'rae', created: 51, updated: 3, found: 3, reunion: 3, version: 2, photos: 1 },
  { n: 1006, first: 'L.W.', age: 25, gender: 'Female', post: 'Command', clothing: 'Blue sequin dress', status: STATUS.reunited, by: 'lee', upd: 'sam', created: 70, updated: 40, found: 55, reunion: 55, closed: 40, version: 2 },
  { n: 1003, first: 'C.H.', age: 25, gender: 'Male', post: 'FA 4 – Oasis', clothing: 'Orange jersey, silver chain', status: STATUS.reunited, by: 'lee', upd: 'sam', created: 65, updated: 34, found: 50, reunion: 50, closed: 34, version: 2 },
  { n: 1002, first: 'Dani', last: 'V.', age: 20, gender: 'Female', post: 'FA 3 – Kinetic', clothing: 'Holographic skirt, white sneakers', status: STATUS.discharged, by: 'dana', upd: 'sam', created: 82, updated: 45, found: 70, reunion: 70, closed: 45, version: 2 },
  { n: 1001, first: 'R.K.', age: 31, gender: 'Male', post: 'Base', clothing: 'Grey hoodie', status: STATUS.cancelled, by: 'lee', upd: 'lee', created: 93, updated: 90, closed: 90, version: 1 },
  { n: 1000, first: 'Z.A.', age: 22, gender: 'Female', post: 'FA 3 – Kinetic', clothing: 'White fringe jacket', status: STATUS.reunited, by: 'dana', upd: 'sam', created: 1500, updated: 1460, found: 1480, reunion: 1480, closed: 1460, version: 2 },
  { n: 999, first: 'O.B.', age: 24, gender: 'Male', post: 'FA 4 – Oasis', clothing: 'Black mesh shirt', status: STATUS.reunited, by: 'lee', upd: 'rae', created: 1530, updated: 1490, found: 1510, reunion: 1510, closed: 1490, version: 2 },
  { n: 998, first: 'J.H.', age: 27, gender: 'Female', post: 'FA 4 – Oasis', clothing: 'Black tank, pink hair, glitter on face', desc: 'Black tank, pink hair, glitter on face', hair: 'Pink', status: STATUS.reunited, by: 'lee', upd: 'rae', created: 1560, updated: 1500, found: 1530, reunion: 1530, closed: 1500, version: 2 },
  { n: 997, first: 'Q.T.', age: 30, gender: 'Male', post: 'Other', other: 'Info booth', clothing: 'Tie-dye shirt', lastSeen: 'Near the info booth by the main gate', status: STATUS.reunited, by: 'alex', upd: 'alex', created: 1620, updated: 1540, found: 1570, reunion: 1570, closed: 1540, version: 4 },
  { n: 996, first: 'G.M.', age: 19, gender: 'Female', post: 'FA 4 – Oasis', clothing: 'Purple wig', status: STATUS.reunited, by: 'alex', upd: 'alex', created: 1650, updated: 1580, found: 1610, reunion: 1610, closed: 1580, version: 3, photos: 1 },
  { n: 995, first: 'Sky', last: 'N.', age: 23, gender: 'Female', post: 'Command', clothing: 'Silver bodysuit', status: STATUS.reunited, by: 'lee', upd: 'sam', created: 1680, updated: 1620, found: 1650, reunion: 1650, closed: 1620, version: 2 },
  { n: 994, first: 'Ben', last: 'A.', age: 26, gender: 'Male', post: 'FA 3 – Kinetic', clothing: 'Yellow raincoat', status: STATUS.reunited, by: 'dana', upd: 'sam', created: 1700, updated: 1640, found: 1670, reunion: 1670, closed: 1640, version: 2 },
  { n: 993, first: 'Mo', last: 'E.', age: 21, gender: 'Male', post: 'Base', clothing: 'Green visor', status: STATUS.reunited, by: 'lee', upd: 'rae', created: 1720, updated: 1660, found: 1690, reunion: 1690, closed: 1660, version: 2 },
];

export const stubId = (caseNumber: number) => `5eed0000-0000-4000-8000-${String(caseNumber).padStart(12, '0')}`;
export const stubPhotoId = (caseNumber: number, n: number) => `f0f0f0f0-0000-4000-8000-${String(caseNumber * 10 + n).padStart(12, '0')}`;

export function stubRows(now: number = Date.now()): RequestSummary[] {
  const at = (minutesAgo: number | undefined) =>
    minutesAgo === undefined ? null : new Date(now - minutesAgo * 60_000).toISOString();
  return SPECS.map((s) => ({
    id: stubId(s.n),
    clientMutationId: null,
    caseNumber: s.n,
    firstName: s.first,
    lastName: s.last ?? null,
    age: s.age,
    gender: s.gender,
    heightBuild: null,
    hair: s.hair ?? null,
    identifyingFeatures: s.features ?? null,
    physicalDescription: s.desc ?? null,
    lastSeen: s.lastSeen ?? null,
    clothing: s.clothing,
    additionalNotes: null,
    reportingLocation: s.post,
    otherLocation: s.other ?? null,
    contactName: s.contact?.[0] ?? null,
    contactPhone: s.contact?.[1] ?? null,
    contactRelationship: s.contact?.[2] ?? null,
    contactNotes: null,
    status: s.status,
    createdBy: STAFF[s.by],
    updatedBy: STAFF[s.upd],
    createdAt: at(s.created) as string,
    updatedAt: at(s.updated) as string,
    foundAt: at(s.found),
    reunionStartedAt: at(s.reunion),
    closedAt: at(s.closed),
    rowVersion: s.version,
    firstPhotoId: s.photos ? stubPhotoId(s.n, 1) : null,
    photoCount: s.photos ?? 0,
    name: joinName(s.first, s.last ?? null),
    postShort: postShort(s.post, s.other ?? null),
  }));
}

/** A plausible detail for a stub row: its photos and a minimal audit trail. */
export function stubDetail(row: RequestSummary): RequestDetail {
  const photos = Array.from({ length: row.photoCount }, (_, i) => ({
    id: stubPhotoId(row.caseNumber, i + 1),
    timing: 'today' as const,
    createdAt: row.createdAt,
    uploadedBy: row.createdBy,
    hasThumb: true,
  }));
  const audit: RequestDetail['audit'] = [
    {
      id: `${row.id}-created`,
      action: 'created',
      at: row.createdAt,
      staff: row.createdBy,
      notes: null,
      previous: null,
      next: { reportingLocation: row.reportingLocation, otherLocation: row.otherLocation },
    },
  ];
  if (row.status !== STATUS.waiting) {
    audit.push({
      id: `${row.id}-status`,
      action: 'status',
      at: row.updatedAt,
      staff: row.updatedBy,
      notes: null,
      previous: { status: STATUS.waiting },
      next: { status: row.status, kind: 'answer' },
    });
  }
  return { ...row, photos, audit };
}

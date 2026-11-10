export interface FlatTest {
  project: string;
  file: string;
  line: number;
  title: string;
  status: string;
  ran: boolean;
  outcome: string | undefined;
  durationMs: number;
  error: string;
}
export interface Unit {
  id: string;
  file: string;
  project: string;
  tests: number;
}
export interface WeighedUnit extends Unit {
  weight: number;
  measured: boolean;
}
export interface Lane {
  units: WeighedUnit[];
  weight: number;
}
export interface Invocation {
  project: string;
  files: string[];
  patterns: string[];
}
export interface Tally {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  other: number;
}
export interface RunComparison {
  missing: string[];
  duplicated: string[];
  unexpected: string[];
  identical: boolean;
}
export declare function stripAnsi(text: string): string;
export declare function testKey(t: Pick<FlatTest, 'project' | 'file' | 'line' | 'title'>): string;
export declare function flattenReport(report: unknown): FlatTest[];
export declare function unitId(file: string, project: string): string;
export declare function unitsFrom(tests: FlatTest[]): Map<string, Unit>;
export declare function weigh(units: Unit[], timings: Record<string, number>): WeighedUnit[];
export declare function partition(units: WeighedUnit[], lanes: number, projectOrder: string[]): Lane[];
export declare function filePattern(file: string): string;
export declare function laneInvocations(lane: Lane): Invocation[];
export declare function tally(tests: FlatTest[]): Tally;
export declare function failuresOf(tests: FlatTest[]): FlatTest[];
export declare function compareRuns(listed: FlatTest[], ran: FlatTest[]): RunComparison;
export declare function updateTimings(old: Record<string, number>, ran: FlatTest[], round?: number): Record<string, number>;
export declare function fmtDuration(ms: number): string;
export declare function availableMemoryBytes(vmStat: string): number;
export declare function parseSize(text: string): number;
export declare function dockerUsedBytes(lines: string): number;
export declare function parseMeminfo(text: string): { total: number; available: number };
export interface ResourceSnapshot {
  hostAvailable: number;
  vmTotal: number;
  vmAvailable: number;
  diskFree: number;
  lanes: number;
  newStacks: number;
}
export declare function resourceProblems(
  r: ResourceSnapshot,
  limits?: { perLaneHost?: number; hostReserve?: number; perStackVm?: number; vmReserve?: number; minDisk?: number },
): string[];

export declare const ROOT: string;
export declare const LOCAL_HOSTS: readonly string[];
export declare function parseEnv(text: string): Record<string, string>;
export declare function hostOf(url: string): string;
export declare function assertLocalUrl(label: string, url: string | undefined): void;
export declare function loadTestEnv(): Record<string, string>;
export declare function childTestEnv(extra?: Record<string, string>): Record<string, string>;
export declare function testBaseUrl(): string;
export declare const NO_DOTENV_PRELOAD: string;

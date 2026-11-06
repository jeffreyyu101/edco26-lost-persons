export declare const SW_MANIFEST_FILE: string;
export declare const STATIC_URL_PREFIX: string;
export declare function staticAssetUrls(distDir: string): Promise<string[]>;
export declare function writeSwManifest(metadata: { projectDir: string; distDir: string }): Promise<string[]>;

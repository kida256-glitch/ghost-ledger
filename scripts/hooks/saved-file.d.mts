export declare const PAYLOAD_LOG: string;
export declare function extractSavedPath(payload: unknown): string | undefined;
export declare function toWorkspaceRelative(filePath: string, workspaceRoot: string): string | null;
export declare function resolveSavedFile(
  stdinText: string,
  options: { cwd: string; fallbackPath?: string },
): { ok: true; root: string; relative: string } | { ok: false; error: string };
export declare function parseArgs(argv: string[]): { fallbackPath?: string; commands: string[] };
export declare function fillCommand(command: string, relative: string): string;

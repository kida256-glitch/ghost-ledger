export declare const PAYLOAD_LOG: string;
export declare function extractSavedPath(payload: unknown): string | undefined;
export declare function toWorkspaceRelative(filePath: string, workspaceRoot: string): string | null;
export declare function resolveSavedFile(
  stdinText: string,
  options: { cwd: string; fallbackPath?: string },
): { ok: true; root: string; relative: string } | { ok: false; error: string };
export declare function parseArgs(argv: string[]): { fallbackPath?: string; commands: string[] };
export declare const RUN_LOG: string;
export declare const RUN_LOG_TAIL_LINES: number;
export type HookRun = { at: string; file: string; command: string; exitCode: number; output: string };
export declare function formatRun(run: HookRun): string;
export declare function appendRunLog(logPath: string, run: HookRun): void;
export declare function acquireRunLock(key: string, waitMs?: number): { release: () => void } | null;
export declare function fillCommand(command: string, relative: string): string;

export type Mutation = [rule: string, file: string, from: string, to: string, prop: string];
export declare const MUTATIONS: Mutation[];
export declare function makeCopy(repo?: string): string;
export declare function writeInCopy(copyRoot: string, file: string, text: string, repo?: string): void;
export declare function runMutation(
  copyRoot: string,
  mutation: Mutation,
): { rule: string; file: string; prop: string; error?: string; caughtByProperty?: boolean; failedTests?: number; failed?: string[] };

// Lets `tsc --noEmit` accept global CSS imports on a fresh clone, before
// `next build` has generated next-env.d.ts.
declare module "*.css";

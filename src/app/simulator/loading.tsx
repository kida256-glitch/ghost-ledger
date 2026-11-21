import { Skeleton } from "../../components/ui";

export default function Loading() {
  return (
    <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[22rem_1fr]" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-[34rem]" />
      <Skeleton className="h-96" />
    </main>
  );
}

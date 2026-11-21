"use client";
import { ErrorState } from "../../components/ErrorState";

export default function SimulatorError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <ErrorState reset={reset} />
    </main>
  );
}

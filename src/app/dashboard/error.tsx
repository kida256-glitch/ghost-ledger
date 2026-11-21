"use client";
import { ErrorState } from "../../components/ErrorState";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState reset={reset} />;
}

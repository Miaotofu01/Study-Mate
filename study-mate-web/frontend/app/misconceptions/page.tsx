import { Suspense } from "react";
import { MisconceptionsView } from "@/components/MisconceptionsView";

export default function MisconceptionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm opacity-50">
          加载中…
        </div>
      }
    >
      <MisconceptionsView />
    </Suspense>
  );
}

import { Suspense } from "react";
import { LessonView } from "@/components/LessonView";

export default function LessonPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm opacity-50">
          加载中…
        </div>
      }
    >
      <LessonView />
    </Suspense>
  );
}

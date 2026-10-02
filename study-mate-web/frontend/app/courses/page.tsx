import { Suspense } from "react";
import { CourseGraphView } from "@/components/CourseGraphView";

export default function CoursesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm opacity-50">
          加载中…
        </div>
      }
    >
      <CourseGraphView />
    </Suspense>
  );
}

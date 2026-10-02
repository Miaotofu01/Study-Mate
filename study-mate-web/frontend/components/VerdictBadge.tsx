import clsx from "clsx";

const VERDICT_STYLE: Record<string, string> = {
  通过: "bg-green-500/15 text-green-600 dark:text-green-400",
  部分通过: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  不通过: "bg-red-500/15 text-red-600 dark:text-red-400",
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span
      className={clsx(
        "inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        VERDICT_STYLE[verdict] ?? "bg-[var(--muted)]",
      )}
    >
      {verdict}
    </span>
  );
}

import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
} from "react";
import { Button } from "./ui/button";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const hintId = useId();
  const childWithDescribedBy =
    hint && isValidElement<{ "aria-describedby"?: string; id?: string }>(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string; id?: string }>, {
          "aria-describedby": children.props["aria-describedby"]
            ? `${children.props["aria-describedby"]} ${hintId}`
            : hintId,
        })
      : children;

  return (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {childWithDescribedBy}
      </label>
      {hint && (
        <span id={hintId} className="block text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Centered card shared by the login and signup forms. */
export function AuthShell({
  title,
  submitLabel,
  pending,
  error,
  onSubmit,
  alternative,
  footer,
  children,
}: {
  title: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  /** Another way to finish the same task, shown under the submit button. */
  alternative?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-card [--primary:#b45309] [--ring:#b45309]"
      >
        <div className="flex items-center gap-3 border-b border-[#f3dcb4] bg-[#fff4df] px-6 py-5">
          <img className="size-9 rounded-[9px]" src="/favicon-192.png" alt="" />
          <h1 className="text-[19px] font-[650] tracking-[-0.01em] text-[#242427]">{title}</h1>
        </div>
        <div className="space-y-3 p-6">
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending} className="w-full">
            {submitLabel}
          </Button>
          {alternative}
          <p className="text-xs text-muted-foreground">{footer}</p>
        </div>
      </form>
    </div>
  );
}

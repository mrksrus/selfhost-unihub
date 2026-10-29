import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A radio choice as a row: the native input stays for keyboard, form and
 * assistive technology, drawn as a 16 px ring that follows the accent; the
 * whole row is the tap target (44 px on touch screens).
 */
const RadioRow = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: React.ReactNode; rowClassName?: string }>(
  ({ className, label, description, rowClassName, id, ...props }, ref) => (
    <label htmlFor={id} className={cn("flex min-h-10 cursor-pointer items-start gap-3 rounded-md px-2 py-2 touch:min-h-11 hover:bg-muted/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", rowClassName)}>
      <input ref={ref} id={id} type="radio" className={cn("peer sr-only", className)} {...props} />
      <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-input bg-background peer-checked:border-accent peer-checked:[&>span]:scale-100">
        <span className="h-2 w-2 scale-0 rounded-full bg-accent transition-transform motion-reduce:transition-none" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  ),
);
RadioRow.displayName = "RadioRow";

export { RadioRow };

import * as React from "react"
import { cn } from "@/lib/utils"

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement> {}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        "text-xs font-semibold tracking-wide text-slate-300 flex items-center gap-1.5",
        className
      )}
      {...props}
    />
  )
)
Label.displayName = "Label"

export { Label }


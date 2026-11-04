import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative w-full">
        <select
          ref={ref}
          className={cn(
            "flex h-10 w-full appearance-none rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2 pr-9 text-sm text-white focus-visible:outline-none focus-visible:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-400/20 disabled:cursor-not-allowed disabled:opacity-50 transition-all cursor-pointer",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
      </div>
    )
  }
)
Select.displayName = "Select"

export { Select }


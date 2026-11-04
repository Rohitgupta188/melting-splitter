import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-amber-500 text-slate-950 font-bold shadow hover:bg-amber-400",
        secondary:
          "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10",
        destructive:
          "border-rose-500/30 bg-rose-500/10 text-rose-400",
        outline: "border-white/20 text-slate-200",
        gold: "border-amber-400/40 bg-amber-400/15 text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.2)]",
        success: "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }


import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-tiny",
    "font-sans text-[13px] font-medium leading-none",
    "transition-[transform,background-color,border-color,color,text-decoration-color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:size-3.5 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-ink text-paper hover:bg-ink/88 data-focus-ring:invert",
        secondary: "border border-line-2 bg-transparent text-ink hover:border-ink hover:bg-paper-deep/60",
        ghost: "text-ink underline-offset-4 hover:underline hover:decoration-line-2",
        destructive: "bg-danger text-paper hover:bg-danger/90",
        link: "text-accent underline decoration-1 underline-offset-2 hover:text-accent-deep",
      },
      size: {
        sm: "h-6 px-2 gap-1 text-[12px]",
        md: "h-7 px-3",
        lg: "h-9 px-4 text-[13.5px]",
        icon: "h-7 w-7",
        "icon-sm": "h-6 w-6",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} data-focus-ring="invert" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };

import * as React from "react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  children?: ReactNode;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-ink/88",
  secondary: "border border-line-2 bg-transparent text-ink hover:border-ink hover:bg-paper-deep/60",
  ghost: "text-ink underline-offset-4 hover:underline hover:decoration-line-2",
  destructive: "bg-danger text-paper hover:bg-danger/90",
  link: "text-accent underline decoration-1 underline-offset-2 hover:text-accent-deep",
};
const sizes: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 text-[12px]",
  md: "h-7 px-3",
  lg: "h-9 px-4 text-[13.5px]",
  icon: "h-7 w-7",
  "icon-sm": "h-6 w-6",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "secondary",
      size = "md",
      asChild = false,
      children,
      type = "button",
      ...props
    },
    ref,
  ) => {
    const classes = cn(
      "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-tiny font-sans font-medium leading-none",
      "text-[13px]",
      "transition-[transform,background-color,border-color,color,text-decoration-color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[.97] disabled:pointer-events-none disabled:opacity-45",
      "[&_svg]:size-3.5 [&_svg]:shrink-0 motion-reduce:transition-none motion-reduce:active:scale-100",
      variants[variant],
      sizes[size],
      className,
    );
    if (asChild && typeof children === "object" && children !== null && "type" in children) {
      const child = children as React.ReactElement<{
        className?: string;
        ref?: unknown;
        onClick?: React.MouseEventHandler;
      }>;
      const childOnClick = child.props.onClick;
      const buttonOnClick = props.onClick;
      return React.cloneElement(child, {
        className: cn(classes, child.props.className),
        "data-focus-ring": "invert",
        ref,
        type,
        ...props,
        onClick: (event: React.MouseEvent) => {
          childOnClick?.(event as React.MouseEvent<HTMLElement>);
          if (!event.defaultPrevented)
            buttonOnClick?.(event as React.MouseEvent<HTMLButtonElement>);
        },
      } as never);
    }
    return (
      <button ref={ref} type={type} data-focus-ring="invert" className={classes} {...props}>
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";

export const buttonVariants = ({
  variant = "secondary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) =>
  cn(variants[variant], sizes[size], className);

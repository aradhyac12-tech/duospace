import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // GLASS UI FIX ("annoying box" root cause, completed here): Button is the
  // single most-used interactive primitive in the app (every action button,
  // icon button, dialog/sheet action) and still had the old detached
  // ring-offset-2 rectangle on focus after the earlier pass fixed
  // Input/Textarea/Select but stopped short of this component — meaning the
  // exact same complaint kept resurfacing anywhere a button (not a text
  // field) got focus, since this is the shared component every button in
  // the app renders through. Same fix as everywhere else: border/ring
  // response, no offset.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[colors,transform,box-shadow] duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // Text links shouldn't shrink on tap — that reads as a button press,
        // not a link tap — so this variant cancels the base active:scale.
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        // Default/icon meet the 44px minimum practical mobile touch target
        // (--touch-target-min); sm is deliberately smaller and should only
        // be used inside already-generous-hit-area rows (e.g. paired with
        // extra vertical padding on its container), never as a lone tap
        // target on its own.
        default: "h-11 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-12 rounded-md px-8",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

import { useEffect, useState, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";

export const editableFieldChromeClass =
  "rounded-sm border border-rule/70 bg-paper/35 outline-none transition-colors duration-fast hover:border-rule hover:bg-paper/70 focus:border-ring focus:bg-paper focus:ring-2 focus:ring-ring/20";

type InlineEditableFieldBaseProps = {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  commitDelayMs?: number;
};

export type InlineEditableFieldProps = InlineEditableFieldBaseProps &
  (
    | ({
        multiline?: false;
      } & Omit<
        ComponentPropsWithoutRef<"input">,
        "aria-label" | "className" | "defaultValue" | "onChange" | "value"
      > & {
          className?: string;
        })
    | ({
        multiline: true;
      } & Omit<
        ComponentPropsWithoutRef<"textarea">,
        "aria-label" | "className" | "defaultValue" | "onChange" | "value"
      > & {
          className?: string;
        })
  );

export function InlineEditableField(props: InlineEditableFieldProps) {
  const {
    value,
    ariaLabel,
    multiline,
    onChange,
    commitDelayMs = 150,
    className,
    ...fieldProps
  } = props;
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(value);
    }
  }, [focused, value]);

  useEffect(() => {
    if (draft === value) return;
    const timeout = window.setTimeout(() => onChange(draft), commitDelayMs);
    return () => window.clearTimeout(timeout);
  }, [commitDelayMs, draft, onChange, value]);

  function commit() {
    if (draft !== value) onChange(draft);
  }

  if (multiline) {
    const textareaProps = fieldProps as Omit<
      ComponentPropsWithoutRef<"textarea">,
      "aria-label" | "className" | "defaultValue" | "onChange" | "value"
    >;

    return (
      <textarea
        {...textareaProps}
        value={draft}
        rows={focused ? 4 : 1}
        onBlur={(event) => {
          setFocused(false);
          commit();
          textareaProps.onBlur?.(event);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setFocused(true);
          textareaProps.onFocus?.(event);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
          textareaProps.onKeyDown?.(event);
        }}
        className={cn(
          editableFieldChromeClass,
          "w-full resize-none px-2 py-1 text-sm leading-5 text-ink",
          focused ? "min-h-24" : "min-h-7 truncate",
          className,
        )}
        aria-label={ariaLabel}
      />
    );
  }

  const inputProps = fieldProps as Omit<
    ComponentPropsWithoutRef<"input">,
    "aria-label" | "className" | "defaultValue" | "onChange" | "value"
  >;

  return (
    <input
      {...inputProps}
      value={draft}
      onBlur={(event) => {
        setFocused(false);
        commit();
        inputProps.onBlur?.(event);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setFocused(true);
        inputProps.onFocus?.(event);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
        inputProps.onKeyDown?.(event);
      }}
      className={cn(editableFieldChromeClass, "w-full px-1 py-0.5 text-sm text-ink", className)}
      aria-label={ariaLabel}
    />
  );
}

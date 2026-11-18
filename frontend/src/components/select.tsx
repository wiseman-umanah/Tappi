"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "./ui";

type Option = { value: string; label: string; hint?: string };

export function Select({
  id,
  name,
  options,
  defaultValue,
  className,
}: {
  id: string;
  name: string;
  options: Option[];
  defaultValue: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === defaultValue)));
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function openList() {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function choose(index: number) {
    setValue(options[index].value);
    setOpen(false);
    button.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) return openList();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + options.length) % options.length);
        break;
      }
      case "Home":
      case "End":
        if (!open) return;
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(active);
        else openList();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <input type="hidden" name={name} value={value} />
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          "flex h-10 w-full items-center justify-between gap-3 rounded-full border bg-linear-to-r from-white to-[#e4ecfd] pr-3 pl-4 text-left text-sm text-neutral-900 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-brand",
          open ? "border-brand ring-2 ring-brand/40" : "border-white/40",
        )}
      >
        <span className="truncate">{selected.label}</span>
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand transition-transform duration-200",
            open && "rotate-180",
          )}
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </span>
      </button>

      <ul
        id={listId}
        role="listbox"
        aria-labelledby={id}
        className={cn(
          "absolute inset-x-0 top-[calc(100%+0.5rem)] z-20 origin-top rounded-2xl border border-white/10 bg-[#0f1f3d]/95 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl transition duration-150",
          open ? "visible scale-100 opacity-100" : "invisible scale-95 opacity-0",
        )}
      >
        {options.map((option, index) => {
          const isSelected = option.value === value;
          return (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={isSelected}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(index)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-colors",
                index === active ? "bg-white/10" : "bg-transparent",
              )}
            >
              <span>
                <span className={cn("block text-sm", isSelected ? "font-medium text-white" : "text-white/85")}>
                  {option.label}
                </span>
                {option.hint && <span className="mt-0.5 block text-xs text-white/50">{option.hint}</span>}
              </span>
              <svg
                className={cn("size-4 shrink-0 text-brand transition-opacity", isSelected ? "opacity-100" : "opacity-0")}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 8.5l3 3 7-7" />
              </svg>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

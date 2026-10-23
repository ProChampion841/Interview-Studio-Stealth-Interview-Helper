import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

/**
 * In-app dropdown that replaces the native <select> popup: OS-rendered select
 * menus appear in screen shares even when the window itself is excluded from
 * capture, while this menu is part of the protected window.
 */
export default function MenuSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  id,
  describedBy,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  id?: string;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keyboardFocus = useRef(false);
  const listId = useId();

  useEffect(() => {
    if (!open || !keyboardFocus.current) return;
    rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[activeIndex]?.focus({ preventScroll: true });
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const selected = options.find((option) => option.value === value);
  const openMenu = (fromKeyboard = false, last = false) => {
    if (disabled || !options.length) return;
    keyboardFocus.current = fromKeyboard;
    const current = options.findIndex(option => option.value === value);
    setActiveIndex(current >= 0 ? current : last ? options.length - 1 : 0);
    if (rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const estimate = options.length * 30 + 14;
      setDropUp(rect.bottom + estimate > window.innerHeight && rect.top - estimate > 0);
    }
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (disabled || !option) return;
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    onChange(option.value);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault(); openMenu(true, event.key === 'ArrowUp');
      }
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false); triggerRef.current?.focus({ preventScroll: true });
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); keyboardFocus.current = true;
      setActiveIndex(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); choose(activeIndex);
    }
  };

  return (
    <div ref={rootRef} className={`menu-select ${dropUp ? "up" : ""}`} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onClick={() => open ? setOpen(false) : openMenu()}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div id={listId} className="menu-select-list" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              className={option.value === value ? "selected" : ""}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

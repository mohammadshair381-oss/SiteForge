import { useId, type ReactElement, type ReactNode, cloneElement } from "react";

export const inputClass = "block w-full min-h-10 rounded-lg border px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:bg-slate-50 disabled:text-slate-500";
export const labelClass = "mb-1.5 block text-sm font-medium text-slate-800";

/** One field's message from the server, for forms that lay out their own fields. */
export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null;
  return (
    <span id={id} className="mt-1.5 block text-xs font-medium text-red-700">
      {message}
    </span>
  );
}

/** A labelled form control: the label, hint and error are connected to the input it wraps. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }> }) {
  const generated = useId();
  const id = children.props.id ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

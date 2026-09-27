import { useId } from 'react';

/**
 * One labelled input. The label is bound by id rather than wrapped, because a
 * screen reader announces a bound label and ignores a neighbour that merely
 * happens to sit above the field.
 */
export default function Field({
  label,
  type = 'text',
  value,
  onChange,
  hint,
  error,
  autoComplete,
  required,
  placeholder,
  inputMode,
  maxLength,
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      />
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

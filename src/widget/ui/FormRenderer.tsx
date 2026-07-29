import { useState } from 'react';
import type { FormField } from '../../types/chat';
import { FIXED } from '../copy';

/**
 * The one form renderer.
 *
 * The pre-tenant widget had three near-identical implementations — pre-chat,
 * starter intake and bot collect — which is why validation was inconsistent
 * between them (one used `alert()`, one silently refused to submit, one let
 * empty required fields through). They are the same thing: a server-supplied
 * field list, in, and a flat record of answers, out. Anything that differs
 * between the three is a prop.
 */

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function FormRenderer({
  heading,
  description,
  fields,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  cancelLabel,
}: {
  heading?: string;
  description?: string;
  fields: FormField[];
  submitLabel: string;
  busy?: boolean;
  onSubmit(values: Record<string, string>): void;
  onCancel?(): void;
  cancelLabel?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    const answers: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.name] ?? '').trim();
      if (field.required && !value) found[field.name] = FIXED.requiredField;
      else if (field.type === 'email' && value && !EMAIL.test(value)) found[field.name] = FIXED.invalidEmail;
      if (value) answers[field.name] = value;
    }
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(answers);
  };

  return (
    // noValidate is load-bearing. With `type="email"` the browser runs its own
    // constraint check first and silently refuses to fire submit — so the inline
    // errors below never render, and the visitor gets an unstyled native bubble
    // in the browser's language instead of the customer's copy.
    <form className="n-form" onSubmit={submit} noValidate>
      {heading && <p className="n-hero-title">{heading}</p>}
      {description && <p className="n-card-sub">{description}</p>}

      {fields.map((field) => {
        const id = `n-f-${field.name}`;
        const shared = {
          id,
          className: 'n-input',
          value: values[field.name] ?? '',
          placeholder: field.placeholder,
          'aria-invalid': Boolean(errors[field.name]),
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setValues((prev) => ({ ...prev, [field.name]: e.target.value })),
        };
        return (
          <div className="n-field" key={field.name}>
            <label className="n-label" htmlFor={id}>
              {field.label}
              {field.required && <span className="n-required"> *</span>}
            </label>
            {field.type === 'textarea' ? (
              <textarea {...shared} rows={4} />
            ) : (
              <input {...shared} type={field.type === 'email' || field.type === 'tel' ? field.type : 'text'} />
            )}
            {errors[field.name] && <p className="n-error">{errors[field.name]}</p>}
          </div>
        );
      })}

      <button className="n-button" type="submit" disabled={busy}>
        {submitLabel}
      </button>
      {onCancel && (
        <button className="n-button" data-variant="ghost" type="button" onClick={onCancel}>
          {cancelLabel ?? FIXED.cancel}
        </button>
      )}
    </form>
  );
}

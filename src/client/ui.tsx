import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import {
  ShadcnSwitch,
  ShadcnRadioGroup,
  ShadcnRadioGroupItem,
  ShadcnCollapsible,
  ShadcnCollapsibleTrigger,
  ShadcnCollapsibleContent,
} from './shadcn.js';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', type = 'button', className = '', ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`cr-button cr-button--${variant} ${className}`.trim()}
    />
  );
});

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}
const FieldContext = React.createContext<FieldContextValue | null>(null);

function joinIds(...values: Array<string | undefined>): string | undefined {
  const ids = values.flatMap((value) => value?.split(/\s+/u).filter(Boolean) ?? []);
  return ids.length ? [...new Set(ids)].join(' ') : undefined;
}

/** Only the matching primary control inherits a Field's id, help and error. */
function useFieldAttributes(
  id?: string,
  describedBy?: string,
  invalid?: React.AriaAttributes['aria-invalid'],
) {
  const field = React.useContext(FieldContext);
  const associated = field && (id === undefined || id === field.id) ? field : null;
  return {
    id: id ?? field?.id,
    'aria-describedby': joinIds(describedBy, associated?.describedBy),
    'aria-invalid': invalid ?? (associated?.invalid ? true : undefined),
  };
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input(
  { id, className = '', 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props },
  ref,
) {
  const fieldAttributes = useFieldAttributes(id, describedBy, invalid);
  return (
    <input {...props} {...fieldAttributes} ref={ref} className={`cr-input ${className}`.trim()} />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea(
  { id, className = '', 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props },
  ref,
) {
  const fieldAttributes = useFieldAttributes(id, describedBy, invalid);
  return (
    <textarea
      {...props}
      {...fieldAttributes}
      ref={ref}
      className={`cr-textarea ${className}`.trim()}
    />
  );
});

export interface FieldProps {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
}

export function Field({ id, label, description, error, children }: FieldProps) {
  const hasDescription = !!description;
  const hasError = !!error;
  const context = React.useMemo<FieldContextValue>(
    () => ({
      id,
      describedBy: joinIds(
        hasDescription ? `${id}-help` : undefined,
        hasError ? `${id}-error` : undefined,
      ),
      invalid: hasError,
    }),
    [id, hasDescription, hasError],
  );
  return (
    <div className="cr-field" data-invalid={hasError ? '' : undefined}>
      <label id={`${id}-label`} className="cr-label" htmlFor={id}>
        {label}
      </label>
      <FieldContext.Provider value={context}>{children}</FieldContext.Provider>
      {hasDescription && (
        <p className="cr-muted cr-description" id={`${id}-help`}>
          {description}
        </p>
      )}
      {hasError && (
        <p className="cr-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export interface FieldSetProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function FieldSet({ title, description, children, className = '' }: FieldSetProps) {
  const descriptionId = `${React.useId()}-help`;
  return (
    <fieldset
      className={`cr-section cr-fieldset ${className}`.trim()}
      aria-describedby={description ? descriptionId : undefined}
    >
      <legend className="cr-section-title">{title}</legend>
      {description && (
        <p className="cr-muted cr-section-description" id={descriptionId}>
          {description}
        </p>
      )}
      <div className="cr-fields">{children}</div>
    </fieldset>
  );
}

export interface ToggleProps {
  id: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
}

export function Toggle({ id, checked, onChange, disabled, label, description }: ToggleProps) {
  return (
    <div className="cr-toggle" data-disabled={disabled ? '' : undefined}>
      <div className="cr-toggle-copy">
        <label id={`${id}-label`} htmlFor={id} className="cr-label">
          {label}
        </label>
        {description && (
          <p id={`${id}-help`} className="cr-muted cr-description">
            {description}
          </p>
        )}
      </div>
      <ShadcnSwitch
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-help` : undefined}
      />
    </div>
  );
}

export interface CheckboxProps {
  id?: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** Original Base UI wrapper, not copied from the shadcn/ui Checkbox registry. */
export function Checkbox({ id, checked, onChange, disabled, label, description }: CheckboxProps) {
  const generatedId = React.useId();
  const controlId = id ?? `cr-checkbox-${generatedId.replace(/:/gu, '')}`;
  return (
    <div className="cr-checkbox" data-disabled={disabled ? '' : undefined}>
      <CheckboxPrimitive.Root
        id={controlId}
        checked={checked}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled}
        className="cr-checkbox-control"
        data-slot="cr-checkbox"
        aria-labelledby={`${controlId}-label`}
        aria-describedby={description ? `${controlId}-help` : undefined}
      >
        <CheckboxPrimitive.Indicator
          className="cr-checkbox-indicator"
          data-slot="cr-checkbox-indicator"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="m3 8 3.2 3.2L13 4.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <div className="cr-checkbox-copy">
        <label id={`${controlId}-label`} htmlFor={controlId} className="cr-checkbox-label">
          {label}
        </label>
        {description && (
          <div id={`${controlId}-help`} className="cr-muted cr-description">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}
export interface ChoiceCardsProps {
  id: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  options: readonly ChoiceOption[];
}

/** Place in Field with the same id, or supply an external `${id}-label`. */
export function ChoiceCards({ id, value, onChange, disabled, options }: ChoiceCardsProps) {
  const fieldAttributes = useFieldAttributes(id);
  return (
    <ShadcnRadioGroup
      {...fieldAttributes}
      id={id}
      value={value}
      onValueChange={(next) => onChange(next)}
      disabled={disabled}
      aria-labelledby={`${id}-label`}
      data-disabled={disabled ? '' : undefined}
    >
      {options.map((option, index) => {
        const optionId = `${id}-option-${index}`;
        return (
          <label
            className="cr-radio-card"
            key={option.value}
            htmlFor={optionId}
            data-selected={value === option.value ? '' : undefined}
            data-disabled={disabled ? '' : undefined}
          >
            <ShadcnRadioGroupItem
              id={optionId}
              value={option.value}
              aria-labelledby={`${optionId}-label`}
              aria-describedby={option.description ? `${optionId}-help` : undefined}
            />
            <span className="cr-choice-copy">
              <span id={`${optionId}-label`} className="cr-choice-title">
                {option.label}
              </span>
              {option.description && (
                <span id={`${optionId}-help`} className="cr-muted cr-description">
                  {option.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </ShadcnRadioGroup>
  );
}

export interface AdvancedProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}

export function Advanced({ title, description, children }: AdvancedProps) {
  const id = React.useId();
  return (
    <ShadcnCollapsible className="cr-advanced">
      <ShadcnCollapsibleTrigger
        className="cr-advanced-trigger"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-help` : undefined}
      >
        <span className="cr-advanced-copy">
          <span id={`${id}-title`} className="cr-section-title">
            {title}
          </span>
          {description && (
            <span id={`${id}-help`} className="cr-muted cr-description">
              {description}
            </span>
          )}
        </span>
        <svg
          className="cr-advanced-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </ShadcnCollapsibleTrigger>
      <ShadcnCollapsibleContent className="cr-advanced-panel">{children}</ShadcnCollapsibleContent>
    </ShadcnCollapsible>
  );
}

export interface NoticeProps {
  kind?: 'info' | 'error' | 'success' | 'warning';
  children: React.ReactNode;
}

export function Notice({ kind = 'info', children }: NoticeProps) {
  return (
    <div
      className={`cr-notice cr-notice--${kind}`}
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      {children}
    </div>
  );
}

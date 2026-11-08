// Adapted via the supplied Dream reference from the shadcn/ui Base UI registry.
// Copyright (c) 2023 shadcn (MIT). See NOTICE.md and SHADCN_LICENSE.txt.
// Changes: scoped Host-token CSS replaces cn/Tailwind; all slots use cr- names;
// the Switch uses a reset native button. React remains a shared Host external.
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';

function scopedClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
): string | ((state: State) => string) {
  return typeof className === 'function'
    ? (state) => `${base} ${className(state) ?? ''}`.trim()
    : `${base} ${className ?? ''}`.trim();
}

export function ShadcnSwitch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & { size?: 'sm' | 'default' }) {
  return (
    <SwitchPrimitive.Root
      {...props}
      nativeButton
      render={<button type="button" />}
      data-slot="cr-switch"
      data-size={size}
      className={scopedClassName('cr-switch', className)}
    >
      <SwitchPrimitive.Thumb data-slot="cr-switch-thumb" className="cr-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export function ShadcnCollapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      {...props}
      data-slot="cr-collapsible"
      className={scopedClassName('cr-collapsible', className)}
    />
  );
}

export function ShadcnCollapsibleTrigger({
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      {...props}
      type="button"
      data-slot="cr-collapsible-trigger"
      className={scopedClassName('cr-collapsible-trigger', className)}
    />
  );
}

export function ShadcnCollapsibleContent({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      {...props}
      data-slot="cr-collapsible-content"
      className={scopedClassName('cr-collapsible-content', className)}
    />
  );
}

export function ShadcnRadioGroup({ className, ...props }: RadioGroupPrimitive.Props<string>) {
  return (
    <RadioGroupPrimitive
      {...props}
      data-slot="cr-radio-group"
      className={scopedClassName('cr-choice-group', className)}
    />
  );
}

export function ShadcnRadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props<string>) {
  return (
    <RadioPrimitive.Root
      {...props}
      data-slot="cr-radio-group-item"
      className={scopedClassName('cr-radio', className)}
    >
      <RadioPrimitive.Indicator data-slot="cr-radio-group-indicator" className="cr-radio-indicator">
        <span data-slot="cr-radio-group-indicator-icon" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

import React from 'react';

// Editing the title is local until blur/Enter; an in-progress suffix is not a
// committed file type and must not unmount the body editor on each keystroke.
export default function NoteTitleInput({ resource, onRename, disabled, label }) {
  return <input key={JSON.stringify([resource.id, resource.title])} aria-label={label} defaultValue={resource.title} maxLength={160} disabled={disabled}
    onBlur={event => {
      const field = event.currentTarget;
      if (field.value === resource.title) return;
      const next = field.value.trim();
      if (!onRename?.(resource.id, next)) field.value = resource.title;
      else field.value = next;
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') event.currentTarget.value = resource.title;
        event.currentTarget.blur();
      }
    }} />;
}

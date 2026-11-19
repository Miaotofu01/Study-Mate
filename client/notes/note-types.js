// Display-name recognition is separate from the stable storage type and id.
// Existing notes without a file suffix are display titles, not converted files.
const MARKDOWN_SUFFIXES = new Set(['md', 'markdown', 'txt']);

export function noteExtension(title) {
  const name = String(title ?? '').trim();
  const match = /\.([a-z0-9][a-z0-9_-]*)$/i.exec(name);
  return match && match.index > 0 ? match[1].toLowerCase() : '';
}

export function isMarkdownResource(resource) {
  if (resource?.type !== 'note') return false;
  const suffix = noteExtension(resource.title);
  return !suffix || MARKDOWN_SUFFIXES.has(suffix);
}

export function isUnsupportedNote(resource) {
  return resource?.type === 'note' && !isMarkdownResource(resource);
}

export function copyNoteTitle(title) {
  const name = String(title ?? '').trim();
  const suffix = noteExtension(name);
  const base = suffix ? name.slice(0, -(suffix.length + 1)) : name;
  return Array.from(base || '未命名').slice(0, 145).join('') + '（副本）.md';
}

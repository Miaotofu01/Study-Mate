// Optional host dictionaries: locale changes never remount the consuming editor.
export function createLocaleScope(namespace, dictionaries) {
  let translate = null;
  let revision = 0;
  const listeners = new Set();
  const emit = () => { revision++; for (const listener of [...listeners]) listener(); };
  const scope = {
    t(key, params = {}) {
      if (translate) return translate(key, params);
      return Object.entries(params).reduce((text, [name, value]) => text.split('{' + name + '}').join(String(value)), dictionaries.zh[key] ?? key);
    },
    getSnapshot: () => revision,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    attach(ctx) {
      const start = owner => {
        const locale = owner?.locale || ctx.get?.('locale');
        if (!locale?.register || !locale?.bind || !owner?.effect) return;
        owner.effect(() => {
          const unregister = locale.register(namespace, dictionaries);
          let off;
          try {
            translate = locale.bind(namespace);
            off = locale.subscribe?.(emit);
            emit();
          } catch (error) {
            off?.();
            translate = null;
            unregister();
            throw error;
          }
          let disposed = false;
          return () => {
            if (disposed) return;
            disposed = true;
            off?.();
            translate = null;
            unregister();
            emit();
          };
        }, namespace + ': locale');
      };
      const optional = owner => {
        try { start(owner); }
        catch (error) { console.warn('[StudyMate] Notes locale unavailable:', error); }
      };
      try {
        if (typeof ctx.inject === 'function') ctx.inject(['locale'], optional);
        else optional(ctx);
      } catch { optional(ctx); }
    },
  };
  return scope;
}

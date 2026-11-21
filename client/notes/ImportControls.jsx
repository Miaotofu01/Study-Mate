import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Import, Copy, Link2 } from 'lucide-react';
import { useNotesLocale } from './locale.js';

export default function ImportControls({ onChooseMode, getPortalHost }) {
  const t = useNotesLocale();
  const [open, setOpen] = useState(false), [position, setPosition] = useState({});
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const button = trigger.current.getBoundingClientRect(), host = getPortalHost()?.getBoundingClientRect();
      if (!host) return;
      setPosition({ position: 'absolute', left: Math.max(8, Math.min(button.left - host.left, host.width - 248)), top: button.bottom - host.top + 6 });
    };
    const outside = (event) => { if (!root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false); };
    place();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', place);
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); };
  }, [open, getPortalHost]);
  const choose = (mode) => { setOpen(false); trigger.current?.focus(); onChooseMode(mode); };
  const keys = (event) => {
    const items = [...(menu.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
      event.preventDefault(); event.stopPropagation();
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
    if (event.key === 'Tab') setOpen(false);
  };
  return <div className="import-menu" ref={root} onKeyDown={keys}>
    <button ref={trigger} className="icon-button import-menu-button" aria-label={t('import')} title={t('import')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Import size={17} /></button>
    {open && getPortalHost() && createPortal(<div ref={menu} className="import-menu-items" role="menu" aria-label={t('import_mode')} style={position} onKeyDown={keys}>
      <button role="menuitem" onClick={() => choose('copy')}><Copy size={15} /><span><b>{t('copy')}</b><small>{t('copy_description')}</small></span></button>
      <button role="menuitem" onClick={() => choose('reference')}><Link2 size={15} /><span><b>{t('reference')}</b><small>{t('reference_description')}</small></span></button>
    </div>, getPortalHost())}
  </div>;
}

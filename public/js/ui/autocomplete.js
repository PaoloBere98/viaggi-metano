// Autocompletamento indirizzi su un <input>, con elenco <ul> sottostante.
import { esc } from './format.js';

/**
 * @param {HTMLInputElement} input
 * @param {HTMLUListElement} list
 * @param {object} o
 * @param {(text: string, signal: AbortSignal) => Promise<Array<{label, lat, lon}>>} o.search
 * @param {(place: {label, lat, lon}) => void} o.onSelect
 * @param {(err: Error) => void} [o.onError]
 */
export function attachAutocomplete(input, list, { search, onSelect, onError = () => {} }) {
  let timer = null;
  let ctrl = null;
  let items = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  const render = () => {
    if (!items.length) {
      list.innerHTML = '<li class="muted">Nessun risultato</li>';
    } else {
      list.innerHTML = items
        .map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${esc(it.label)}</li>`)
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    close();
    onSelect(it);
  };

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('input', () => {
    onSelect(null); // il testo è cambiato: la scelta precedente non vale più
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 3) {
      close();
      return;
    }
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        items = await search(text, ctrl.signal);
        active = -1;
        if (document.activeElement === input) render();
      } catch (e) {
        if (e.name !== 'AbortError') {
          close();
          onError(e);
        }
      }
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  // pointerdown: scatta prima del blur dell'input
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      choose(Number(li.dataset.i));
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));

  return {
    /** Prima proposta per il testo attuale (se l'utente non ha scelto dall'elenco). */
    async resolveFirst() {
      const text = input.value.trim();
      if (text.length < 3) return null;
      const res = await search(text, new AbortController().signal);
      if (res[0]) {
        input.value = res[0].label;
        return res[0];
      }
      return null;
    },
  };
}

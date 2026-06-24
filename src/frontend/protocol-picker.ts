export type ProtocolBrand = 'raydium' | 'meteora' | 'pump' | 'sanctum';

export function protocolValueToBrand(value: string): ProtocolBrand | null {
  const v = value.trim().toUpperCase();
  if (!v) return null;
  if (v.startsWith('RAYDIUM')) return 'raydium';
  if (v.startsWith('METEORA')) return 'meteora';
  if (v === 'PUMPFUN' || v === 'PUMPSWAP') return 'pump';
  if (v === 'SANCTUM') return 'sanctum';
  return null;
}

export function protocolBrandIconSrc(brand: ProtocolBrand): string {
  if (brand === 'raydium') return '/images/raydium-logo.png';
  if (brand === 'meteora') return '/images/meteora-logo.png';
  if (brand === 'sanctum') return '/images/sanctum-logo.png';
  return '/images/pump-logo.png';
}

export type ProtocolPickerHandle = {
  trigger: HTMLButtonElement;
  syncFromSelect: () => void;
  setDisabled: (disabled: boolean, lockedTitle?: string) => void;
  closeMenu: () => void;
};

function renderPickerIconMarkup(brand: ProtocolBrand | null): string {
  if (!brand) return '';
  const src = protocolBrandIconSrc(brand);
  return `<img class="swap-protocol-picker__icon" src="${src}" alt="" width="14" height="14" decoding="async" />`;
}

/** Compact label in the closed picker; dropdown keeps the full option text. */
export function protocolSelectedDisplayLabel(fullLabel: string, brand: ProtocolBrand | null): string {
  const label = fullLabel.trim();
  if (!label || !brand) return label;
  if (brand === 'raydium' && label.toLowerCase().startsWith('raydium ')) {
    return label.slice('raydium '.length);
  }
  if (brand === 'meteora' && label.toLowerCase().startsWith('meteora ')) {
    return label.slice('meteora '.length);
  }
  return label;
}

export function wireSwapProtocolPicker(
  select: HTMLSelectElement,
  pickerRoot: HTMLElement,
): ProtocolPickerHandle {
  const trigger = pickerRoot.querySelector<HTMLButtonElement>('.swap-protocol-picker__trigger');
  const menu = pickerRoot.querySelector<HTMLElement>('.swap-protocol-picker__menu');
  const valueEl = pickerRoot.querySelector<HTMLElement>('.swap-protocol-picker__value');
  const triggerEl = trigger;
  const menuEl = menu;
  const valueElNode = valueEl;
  if (!triggerEl || !menuEl || !valueElNode) {
    throw new Error('swap protocol picker markup incomplete');
  }

  const placeholderLabel =
    Array.from(select.options).find((o) => !o.value.trim())?.textContent?.trim() || 'Select DEX';

  menuEl.innerHTML = '';
  for (const option of Array.from(select.options)) {
    const value = option.value.trim();
    if (!value) continue;
    const brand = protocolValueToBrand(value);
    const item = document.createElement('li');
    item.className = 'swap-protocol-picker__option';
    item.setAttribute('role', 'option');
    item.dataset.value = value;
    item.innerHTML = `${brand ? renderPickerIconMarkup(brand) : ''}<span class="swap-protocol-picker__option-label">${option.textContent ?? value}</span>`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncFromSelect();
      closeMenu();
    });
    menuEl.appendChild(item);
  }

  function syncFromSelect(): void {
    const value = select.value.trim();
    const selectedOption = value ? select.options[select.selectedIndex] : null;
    const fullLabel = selectedOption?.textContent?.trim() || placeholderLabel;
    const brand = protocolValueToBrand(value);
    const displayLabel = value ? protocolSelectedDisplayLabel(fullLabel, brand) : fullLabel;
    valueElNode.innerHTML = brand
      ? `${renderPickerIconMarkup(brand)}<span class="swap-protocol-picker__label">${displayLabel}</span>`
      : `<span class="swap-protocol-picker__label">${displayLabel}</span>`;
    if (value && displayLabel !== fullLabel) triggerEl.title = fullLabel;
    else triggerEl.removeAttribute('title');
    if (value) triggerEl.dataset.protocol = value;
    else delete triggerEl.dataset.protocol;
    triggerEl.classList.toggle('swap-protocol-picker__trigger--placeholder', !value);
    for (const item of menuEl.querySelectorAll<HTMLElement>('.swap-protocol-picker__option')) {
      const selected = item.dataset.value === value;
      item.classList.toggle('swap-protocol-picker__option--selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  function closeMenu(): void {
    menuEl.hidden = true;
    triggerEl.setAttribute('aria-expanded', 'false');
    pickerRoot.classList.remove('swap-protocol-picker--open');
  }

  function openMenu(): void {
    if (triggerEl.disabled) return;
    menuEl.hidden = false;
    triggerEl.setAttribute('aria-expanded', 'true');
    pickerRoot.classList.add('swap-protocol-picker--open');
  }

  function toggleMenu(): void {
    if (menuEl.hidden) openMenu();
    else closeMenu();
  }

  triggerEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  select.addEventListener('change', syncFromSelect);

  document.addEventListener('click', () => {
    if (!menuEl.hidden) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  function setDisabled(disabled: boolean, lockedTitle = ''): void {
    triggerEl.disabled = disabled;
    if (disabled && lockedTitle) triggerEl.title = lockedTitle;
    else triggerEl.removeAttribute('title');
    if (disabled) closeMenu();
  }

  syncFromSelect();

  return { trigger: triggerEl, syncFromSelect, setDisabled, closeMenu };
}

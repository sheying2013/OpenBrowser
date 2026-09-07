(() => {
  'use strict';

  // ========== Internationalization helper ==========
  function translate(text) {
    if (!text || typeof text !== 'string') return text || '';
    if (typeof window.tx === 'function') {
      try {
        const res = window.tx(text);
        if (res) return res;
      } catch (_) {}
    }
    if (typeof window.t === 'function') {
      try {
        const res = window.t(text);
        if (res) return res;
      } catch (_) {}
    }
    return text;
  }

  // ========== Confirm Dialog DOM Management (Pure DOM API, no innerHTML) ==========
  function ensureConfirmDialog() {
    let dlg = document.getElementById('app-confirm-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'app-confirm-dialog';
      dlg.className = 'app-confirm-dialog';

      const form = document.createElement('form');
      form.setAttribute('method', 'dialog');
      form.id = 'app-confirm-form';

      const head = document.createElement('div');
      head.className = 'dialog-head';

      const headTextWrap = document.createElement('div');
      const title = document.createElement('h2');
      title.id = 'app-confirm-title';
      const meta = document.createElement('p');
      meta.id = 'app-confirm-meta';
      meta.className = 'field-hint';
      meta.hidden = true;
      headTextWrap.append(title, meta);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.value = 'cancel';
      closeBtn.id = 'app-confirm-close';
      closeBtn.textContent = '×';
      closeBtn.setAttribute('aria-label', translate('关闭'));
      closeBtn.setAttribute('data-i18n-aria', '关闭');
      closeBtn.setAttribute('data-i18n-aria-label', '关闭');

      head.append(headTextWrap, closeBtn);

      const body = document.createElement('div');
      body.className = 'app-confirm-body';
      body.id = 'app-confirm-message';

      const warn = document.createElement('div');
      warn.className = 'delete-warning';
      warn.id = 'app-confirm-warning';
      warn.hidden = true;

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.value = 'cancel';
      cancelBtn.className = 'outline';
      cancelBtn.id = 'app-confirm-cancel';
      cancelBtn.textContent = translate('取消');

      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.value = 'confirm';
      submitBtn.className = 'primary';
      submitBtn.id = 'app-confirm-submit';
      submitBtn.textContent = translate('确定');

      actions.append(cancelBtn, submitBtn);
      form.append(head, body, warn, actions);
      dlg.append(form);
      document.body.appendChild(dlg);
    }
    return dlg;
  }

  /**
   * Unified confirmation dialog returning a Promise<boolean>.
   *
   * @param {Object|string} options
   * @param {string} [options.title] - Dialog title, default: '操作确认'
   * @param {string} [options.message] - Main message text
   * @param {string} [options.text] - Alias for message
   * @param {string} [options.content] - Alias for message
   * @param {string} [options.actionLabel] - Action button text, default: '确定'
   * @param {string} [options.confirmText] - Alias for actionLabel
   * @param {string} [options.cancelLabel] - Cancel button text, default: '取消'
   * @param {string} [options.cancelText] - Alias for cancelLabel
   * @param {string} [options.details] - Secondary detail / hint text
   * @param {string} [options.warning] - Optional alert warning text
   * @param {boolean} [options.danger] - Whether the action is destructive
   * @param {boolean} [options.isDanger] - Alias for danger
   * @param {string} [options.type] - If 'danger', sets danger mode
   * @returns {Promise<boolean>}
   */
  function confirmDialog(options = {}) {
    if (typeof options === 'string') {
      const msg = options;
      const ttl = typeof arguments[1] === 'string' ? arguments[1] : undefined;
      options = { message: msg, title: ttl };
    }

    return new Promise((resolve) => {
      const triggerEl = document.activeElement;
      const dlg = ensureConfirmDialog();
      const form = dlg.querySelector('#app-confirm-form');
      const titleEl = dlg.querySelector('#app-confirm-title');
      const metaEl = dlg.querySelector('#app-confirm-meta');
      const msgEl = dlg.querySelector('#app-confirm-message');
      const warnEl = dlg.querySelector('#app-confirm-warning');
      const cancelBtn = dlg.querySelector('#app-confirm-cancel');
      const submitBtn = dlg.querySelector('#app-confirm-submit');
      const closeBtn = dlg.querySelector('#app-confirm-close');

      const isDanger = Boolean(options.danger || options.isDanger || options.type === 'danger' || options.tone === 'danger');
      const rawTitle = options.title || '操作确认';
      const rawMsg = options.message || options.text || options.content || '';
      const rawAction = options.actionLabel || options.confirmLabel || options.confirmText || '确定';
      const rawCancel = options.cancelLabel || options.cancelText || '取消';
      const rawMeta = options.details || options.meta || '';
      const rawWarn = options.warning || '';

      if (titleEl) titleEl.textContent = translate(rawTitle);
      if (msgEl) msgEl.textContent = translate(rawMsg);
      if (submitBtn) {
        submitBtn.textContent = translate(rawAction);
        submitBtn.className = isDanger ? 'danger' : 'primary';
      }
      if (cancelBtn) {
        cancelBtn.textContent = translate(rawCancel);
        cancelBtn.className = 'outline';
      }
      if (metaEl) {
        if (rawMeta) {
          metaEl.textContent = translate(rawMeta);
          metaEl.hidden = false;
        } else {
          metaEl.textContent = '';
          metaEl.hidden = true;
        }
      }
      if (warnEl) {
        if (rawWarn || (isDanger && options.warning !== false)) {
          warnEl.textContent = rawWarn ? translate(rawWarn) : translate('此操作不可撤销，请谨慎操作。');
          warnEl.hidden = false;
        } else {
          warnEl.textContent = '';
          warnEl.hidden = true;
        }
      }

      if (isDanger) {
        dlg.classList.add('confirm-danger');
      } else {
        dlg.classList.remove('confirm-danger');
      }

      let settled = false;

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (dlg.open) dlg.close();
        } catch (_) {}
        if (triggerEl && typeof triggerEl.focus === 'function' && document.contains(triggerEl)) {
          try {
            triggerEl.focus();
          } catch (_) {}
        }
        resolve(result);
      }

      function onCancel(e) {
        if (e) e.preventDefault();
        finish(false);
      }

      function onSubmit(e) {
        if (e) e.preventDefault();
        finish(true);
      }

      function onFormSubmit(e) {
        e.preventDefault();
        if (document.activeElement === cancelBtn) finish(false);
        else finish(true);
      }

      function onDialogCancel(e) {
        e.preventDefault();
        finish(false);
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
          return;
        }
        if (e.key === 'Tab') {
          const focusables = Array.from(
            dlg.querySelectorAll('button:not([disabled]), [tabindex="0"]')
          ).filter((el) => !el.hidden && el.offsetParent !== null);
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }

      function cleanup() {
        cancelBtn?.removeEventListener('click', onCancel);
        submitBtn?.removeEventListener('click', onSubmit);
        closeBtn?.removeEventListener('click', onCancel);
        form?.removeEventListener('submit', onFormSubmit);
        dlg.removeEventListener('cancel', onDialogCancel);
        dlg.removeEventListener('keydown', onKeyDown);
      }

      cancelBtn?.addEventListener('click', onCancel);
      submitBtn?.addEventListener('click', onSubmit);
      closeBtn?.addEventListener('click', onCancel);
      form?.addEventListener('submit', onFormSubmit);
      dlg.addEventListener('cancel', onDialogCancel);
      dlg.addEventListener('keydown', onKeyDown);

      try {
        if (typeof dlg.showModal === 'function') {
          dlg.showModal();
        } else {
          dlg.setAttribute('open', '');
        }
      } catch (_) {
        dlg.setAttribute('open', '');
      }

      // Accessible initial focus:
      // Destructive/danger action defaults focus to Cancel to prevent accidental confirmation;
      // Normal confirmation defaults focus to Submit.
      setTimeout(() => {
        try {
          if (isDanger && cancelBtn) {
            cancelBtn.focus();
          } else if (submitBtn) {
            submitBtn.focus();
          }
        } catch (_) {}
      }, 20);
    });
  }

  const confirmAction = confirmDialog;

  // ========== Toast Accessibility & Error Type Support ==========
  const originalToast = (window.OpenBrowserApp && window.OpenBrowserApp.toast) || window.toast;
  let toastTimer = null;

  function enhancedToast(message, optionsOrTone = {}) {
    let messageText = message;
    if (message instanceof Error) {
      messageText = message.message || String(message);
    } else {
      messageText = String(message ?? '');
    }

    let tone = 'status';
    let duration = 2400;

    if (typeof optionsOrTone === 'string') {
      tone = optionsOrTone;
    } else if (optionsOrTone && typeof optionsOrTone === 'object') {
      tone = optionsOrTone.tone || optionsOrTone.type || 'status';
      if (typeof optionsOrTone.duration === 'number') {
        duration = optionsOrTone.duration;
      }
    }

    const isError = tone === 'error' || tone === 'danger';
    const isSuccess = tone === 'success';
    const isWarning = tone === 'warning';

    const el = document.getElementById('toast');
    if (!el) {
      if (typeof originalToast === 'function') {
        return originalToast(messageText, { tone });
      }
      return;
    }

    el.textContent = translate(messageText);
    el.dataset.tone = tone;
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');

    el.classList.remove('toast-error', 'toast-success', 'toast-warning');
    if (isError) el.classList.add('toast-error');
    if (isSuccess) el.classList.add('toast-success');
    if (isWarning) el.classList.add('toast-warning');

    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, duration);
  }

  enhancedToast.error = (msg, opts) => enhancedToast(msg, Object.assign({}, typeof opts === 'object' ? opts : {}, { tone: 'error' }));
  enhancedToast.success = (msg, opts) => enhancedToast(msg, Object.assign({}, typeof opts === 'object' ? opts : {}, { tone: 'success' }));
  enhancedToast.info = (msg, opts) => enhancedToast(msg, Object.assign({}, typeof opts === 'object' ? opts : {}, { tone: 'status' }));
  enhancedToast.warning = (msg, opts) => enhancedToast(msg, Object.assign({}, typeof opts === 'object' ? opts : {}, { tone: 'warning' }));

  // ========== Global Dialog Focus Preservation ==========
  if (typeof HTMLDialogElement !== 'undefined' && HTMLDialogElement.prototype) {
    const nativeShowModal = HTMLDialogElement.prototype.showModal;
    if (nativeShowModal && !HTMLDialogElement.prototype._openBrowserWrapped) {
      HTMLDialogElement.prototype.showModal = function (...args) {
        if (document.activeElement && document.activeElement !== document.body) {
          this._lastTriggerElement = document.activeElement;
        }
        return nativeShowModal.apply(this, args);
      };
      HTMLDialogElement.prototype._openBrowserWrapped = true;
    }
  }

  document.addEventListener('close', (e) => {
    if (e.target && e.target.nodeName === 'DIALOG') {
      const trigger = e.target._lastTriggerElement;
      if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
        e.target._lastTriggerElement = null;
        try { trigger.focus(); } catch (_) {}
      }
    }
  }, true);

  // Auto-fill aria-label for existing dialog close buttons
  function applyDialogCloseAria(root = document) {
    const closeButtons = root.querySelectorAll('dialog .dialog-head button');
    closeButtons.forEach((btn) => {
      if (!btn.getAttribute('aria-label') && /^[×\u00d7&times;]+$/.test(btn.textContent.trim())) {
        btn.setAttribute('aria-label', translate('关闭'));
        btn.setAttribute('data-i18n-aria', '关闭');
        btn.setAttribute('data-i18n-aria-label', '关闭');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyDialogCloseAria());
  } else {
    applyDialogCloseAria();
  }

  // ========== Exports ==========
  window.confirmAction = confirmAction;
  window.confirmDialog = confirmDialog;
  window.toast = enhancedToast;

  if (window.OpenBrowserApp) {
    window.OpenBrowserApp.confirmAction = confirmAction;
    window.OpenBrowserApp.confirmDialog = confirmDialog;
    window.OpenBrowserApp.toast = enhancedToast;
  }
})();

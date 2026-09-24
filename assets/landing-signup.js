/**
 * Landing signup: mirrors submissions to a Google Sheet.
 *
 * Shopify's {% form 'customer' %} tag posts natively and reloads the page, and it
 * only persists email/first_name/last_name/tags. So the flow is:
 *
 *   1. on submit  -> stash the full payload (including Sheet-only fields) in sessionStorage
 *   2. native POST -> Shopify creates the customer and reloads the page
 *   3. on reload  -> if Shopify reported success, POST the stash to Apps Script, then clear it
 *
 * Writing the row only in step 3 means the Sheet never gains a row for a submission
 * Shopify rejected. If the form came back with errors the stash is replayed into the
 * inputs instead, so the customer does not have to retype the Sheet-only answers.
 */
class LandingSignup extends HTMLElement {
  connectedCallback() {
    this.form = this.querySelector('form');
    this.endpoint = this.dataset.endpoint;
    this.storageKey = `landing-signup:${this.dataset.sectionId}`;

    if (this.querySelector('[data-signup-success]')) {
      this.flush();
      return;
    }

    if (!this.form) return;
    this.restore();
    this.initUpload();
    this.initValidation();
    this.form.addEventListener('submit', (event) => {
      if (!this.validate() || !this.validateUpload()) {
        event.preventDefault();
        return;
      }
      this.form.classList.add('is-submitting');
      this.stash();
    });
  }

  /* -- validation -------------------------------------------------------- */

  initValidation() {
    // Phone inputs reject stray characters as they are typed. `type="tel"` does
    // no validation of its own, so without this a phone field accepts prose.
    this.form.querySelectorAll('[data-validate="phone"]').forEach((input) => {
      input.addEventListener('input', () => {
        const cleaned = input.value.replace(/[^0-9+()\-.\s]/g, '');
        if (cleaned !== input.value) {
          // Preserve the caret, which would otherwise jump to the end.
          const at = input.selectionStart - (input.value.length - cleaned.length);
          input.value = cleaned;
          input.setSelectionRange(at, at);
        }
      });
    });

    // Re-check a field once it has been corrected, but never before the first
    // submit — warning someone mid-type about an email they are still writing
    // is noise, not help.
    this.form.addEventListener(
      'blur',
      (event) => {
        if (this.submitted && event.target.matches('input, select, textarea')) {
          this.checkField(event.target);
        }
      },
      true
    );
  }

  validate() {
    this.submitted = true;

    const fields = this.form.querySelectorAll('input, select, textarea');
    let firstInvalid = null;

    fields.forEach((field) => {
      if (!this.checkField(field) && !firstInvalid) firstInvalid = field;
    });

    if (firstInvalid) {
      firstInvalid.focus();
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  }

  /** Returns true when valid; paints or clears the message either way. */
  checkField(field) {
    const message = this.errorFor(field);
    this.setFieldError(field, message);
    return !message;
  }

  errorFor(field) {
    const value = field.value.trim();
    const label = this.labelFor(field);

    if (field.type === 'checkbox') {
      return field.required && !field.checked ? 'Please tick this box to continue.' : '';
    }

    if (field.required && !value) return `${label} is required.`;
    if (!value) return '';

    switch (field.dataset.validate) {
      case 'email':
        // Deliberately loose: something@something.tld. Anything stricter starts
        // rejecting valid addresses.
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? '' : 'Enter a valid email address.';

      case 'phone': {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 7) return 'Enter a valid phone number.';
        if (digits.length > 15) return 'That phone number is too long.';
        return '';
      }

      case 'postal':
        return /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(value) ? '' : 'Enter a valid zip code.';

      default:
        return '';
    }
  }

  labelFor(field) {
    const wrapper = field.closest('.field') || field.parentElement;
    const label = wrapper && wrapper.querySelector('.field__label');
    const text = label ? label.textContent : field.placeholder;
    return (text || 'This field').replace('*', '').trim();
  }

  /** Inserts the message element on demand rather than bloating the markup. */
  setFieldError(field, message) {
    const wrapper = field.closest('.field') || field.closest('.landing-signup__consent');
    if (!wrapper) return;

    let error = wrapper.querySelector('[data-field-error]');

    if (!message) {
      wrapper.classList.remove('field--error');
      field.removeAttribute('aria-invalid');
      if (error) error.remove();
      return;
    }

    if (!error) {
      error = document.createElement('small');
      error.className = 'landing-signup__error';
      error.setAttribute('data-field-error', '');
      error.setAttribute('role', 'alert');
      wrapper.appendChild(error);
    }

    error.textContent = message;
    wrapper.classList.add('field--error');
    field.setAttribute('aria-invalid', 'true');
  }

  /* -- image upload ------------------------------------------------------ */

  initUpload() {
    this.upload = this.querySelector('[data-upload]');
    if (!this.upload) return;

    this.uploadInput = this.upload.querySelector('[data-upload-input]');
    this.uploadUrl = this.upload.querySelector('[data-upload-url]');
    this.uploadError = this.upload.querySelector('[data-upload-error]');
    this.uploadBar = this.upload.querySelector('[data-upload-bar]');
    this.uploadPreview = this.upload.querySelector('[data-upload-preview]');

    this.uploadInput.addEventListener('change', () => {
      const file = this.uploadInput.files[0];
      if (file) this.send(file);
    });

    this.upload.querySelector('[data-upload-remove]').addEventListener('click', () => this.resetUpload());

    // Drag and drop over the whole drop zone.
    const drop = this.upload.querySelector('.landing-signup__upload-drop');
    ['dragenter', 'dragover'].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        this.upload.classList.add('is-dragging');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        this.upload.classList.remove('is-dragging');
      })
    );
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer.files[0];
      if (file) this.send(file);
    });
  }

  /** Blocks submit when an image is required but none finished uploading. */
  validateUpload() {
    if (!this.upload || !this.upload.hasAttribute('data-upload-required')) return true;
    if (this.uploadUrl.value) return true;

    this.setUploadError('Please add an image before submitting.');
    this.upload.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }

  setUploadError(message) {
    this.uploadError.textContent = message || '';
  }

  resetUpload() {
    this.uploadInput.value = '';
    this.uploadUrl.value = '';
    this.uploadPreview.hidden = true;
    this.uploadBar.hidden = true;
    this.upload.classList.remove('is-busy', 'is-done');
    this.setUploadError('');
  }

  async send(file) {
    this.setUploadError('');

    const maxBytes = Number(this.upload.dataset.maxMb || 10) * 1024 * 1024;
    if (file.size > maxBytes) {
      this.resetUpload();
      this.setUploadError(`That image is ${(file.size / 1048576).toFixed(1)}MB. The limit is ${this.upload.dataset.maxMb}MB.`);
      return;
    }

    const accepted = (this.upload.dataset.accept || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (accepted.length && !accepted.includes(file.type)) {
      this.resetUpload();
      this.setUploadError('That file type is not supported.');
      return;
    }

    if (!this.endpoint) {
      this.setUploadError('Uploads are not configured yet.');
      return;
    }

    // Show the preview straight away from the local file, before the round trip.
    this.upload.querySelector('[data-upload-thumb]').src = URL.createObjectURL(file);
    this.upload.querySelector('[data-upload-name]').textContent = file.name;
    this.upload.querySelector('[data-upload-state]').textContent = 'Uploading…';
    this.uploadPreview.hidden = false;
    this.uploadBar.hidden = false;
    this.upload.classList.add('is-busy');

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'upload',
          filename: file.name,
          mimeType: file.type,
          data: await this.toBase64(file),
        }),
        redirect: 'follow',
      });
      const result = await response.json();
      if (result.status !== 'ok' || !result.url) throw new Error(result.message || 'Upload failed');

      this.uploadUrl.value = result.url;
      this.upload.querySelector('[data-upload-state]').textContent = 'Added';
      this.upload.classList.remove('is-busy');
      this.upload.classList.add('is-done');
    } catch (error) {
      this.resetUpload();
      this.setUploadError('That image could not be uploaded. Please try again.');
      console.warn('landing-signup: upload failed', error);
    } finally {
      this.uploadBar.hidden = true;
    }
  }

  /** Strips the `data:<mime>;base64,` prefix Apps Script does not want. */
  toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** Reads every field, including the ones Shopify will drop. */
  collect() {
    const payload = {
      // Stable across retries, so Apps Script can reject a duplicate append.
      'Submission ID': this.submissionId(),
      'Submitted at': new Date().toISOString(),
      'Landing page': window.location.pathname,
    };

    const named = {
      'First name': 'contact[first_name]',
      'Last name': 'contact[last_name]',
      Email: 'contact[email]',
    };

    for (const [column, name] of Object.entries(named)) {
      const input = this.form.querySelector(`[name="${name}"]`);
      if (input) payload[column] = input.value.trim();
    }

    this.form.querySelectorAll('[data-extra-field]').forEach((input) => {
      const column = input.dataset.key;
      if (!column) return;
      payload[column] = input.type === 'checkbox' ? (input.checked ? 'Yes' : 'No') : input.value.trim();
    });

    return payload;
  }

  submissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  stash() {
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.collect()));
    } catch (error) {
      // Private browsing or a full quota. The customer record still gets created.
      console.warn('landing-signup: could not stash submission', error);
    }
  }

  /** Repopulates Sheet-only fields after Shopify bounces the form with errors. */
  restore() {
    const stashed = this.read();
    if (!stashed) return;

    this.form.querySelectorAll('[data-extra-field]').forEach((input) => {
      const value = stashed[input.dataset.key];
      if (value === undefined) return;
      if (input.type === 'checkbox') {
        input.checked = value === 'Yes';
      } else {
        input.value = value;
      }
    });

    // An already-uploaded image survives the bounce; show it as done.
    const upload = this.querySelector('[data-upload]');
    const url = upload && upload.querySelector('[data-upload-url]').value;
    if (url) {
      upload.querySelector('[data-upload-thumb]').src = url;
      upload.querySelector('[data-upload-name]').textContent = 'Uploaded image';
      upload.querySelector('[data-upload-state]').textContent = 'Added';
      upload.querySelector('[data-upload-preview]').hidden = false;
      upload.classList.add('is-done');
    }
  }

  read() {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  clear() {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch (error) {
      /* nothing to do */
    }
  }

  /** Shopify accepted the customer, so the row is safe to write. */
  async flush() {
    const payload = this.read();
    if (!payload) return;

    if (!this.endpoint) {
      this.clear();
      return;
    }

    try {
      // text/plain keeps this a simple request: Apps Script web apps answer the
      // CORS preflight with a redirect that browsers refuse to follow.
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: 'append' }, payload)),
        redirect: 'follow',
        keepalive: true,
      });
      this.clear();
    } catch (error) {
      // Leave the stash in place so a refresh retries it.
      console.warn('landing-signup: Sheet sync failed', error);
    }
  }
}

customElements.define('landing-signup', LandingSignup);
